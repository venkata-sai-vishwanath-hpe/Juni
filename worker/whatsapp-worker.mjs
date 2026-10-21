// WhatsApp worker: runs as a standalone Node ESM process spawned by the
// VS Code extension. It owns the Baileys connection and speaks a simple
// newline-delimited JSON protocol over stdin/stdout with the extension.
//
// Worker -> Extension messages (stdout, one JSON per line):
//   { "type": "qr", "dataUrl": "...", "ascii": "..." }
//   { "type": "ready" }
//   { "type": "status", "connection": "open"|"close"|"connecting" }
//   { "type": "log", "level": "info"|"error", "text": "..." }
//   { "type": "message", "from": "<jid>", "number": "<digits>", "name": "...", "text": "..." }
//
// Extension -> Worker messages (stdin, one JSON per line):
//   { "type": "send", "to": "<jid>", "text": "..." }
//   { "type": "logout" }
//
// Config via environment:
//   WA_AUTH_DIR     directory for multi-file auth state (required)
//   WA_TRIGGER      trigger prefix for self/outgoing messages (default "@juni")
//   WA_ALLOWED      comma-separated allowed numbers (digits only). Empty = none.

import { Boom } from "@hapi/boom";
import baileys, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import pino from "pino";
import readline from "node:readline";

const makeWASocket = baileys.default || baileys;

const AUTH_DIR = process.env.WA_AUTH_DIR;
const TRIGGER = (process.env.WA_TRIGGER || "@juni").trim();
const WORKER_START_TIMESTAMP_SECONDS = Math.floor(Date.now() / 1000);
const ALLOWED = (process.env.WA_ALLOWED || "")
  .split(",")
  .map((s) => s.replace(/[^0-9]/g, ""))
  .filter(Boolean);

if (!AUTH_DIR) {
  process.stderr.write("WA_AUTH_DIR is required\n");
  process.exit(1);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function logInfo(text) {
  emit({ type: "log", level: "info", text });
}
function logError(text) {
  emit({ type: "log", level: "error", text });
}

let sock = null;
const processedMessages = new Set(); // Track message IDs to prevent duplicates
const MAX_TRACKED_MESSAGES = 1000;

function jidToNumber(jid) {
  return (jid || "").split("@")[0].split(":")[0].replace(/[^0-9]/g, "");
}

function extractText(message) {
  if (!message) return "";
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    ""
  );
}

function getMessageTimestampSeconds(msg) {
  const raw = msg?.messageTimestamp;
  if (raw === undefined || raw === null) return undefined;
  const parsed = Number(String(raw));
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
        const ascii = await QRCode.toString(qr, { type: "terminal", small: true });
        emit({ type: "qr", dataUrl, ascii });
      } catch (e) {
        logError("Failed to render QR: " + e);
      }
    }

    if (connection) {
      emit({ type: "status", connection });
    }

    if (connection === "open") {
      emit({ type: "ready" });
      logInfo("WhatsApp connection open");
    }

    if (connection === "close") {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      logInfo(
        "Connection closed (code=" + statusCode + ", loggedOut=" + loggedOut + ")"
      );
      if (!loggedOut) {
        setTimeout(() => {
          start().catch((e) => logError("Reconnect failed: " + e));
        }, 2000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    // 'notify' = new incoming messages. 'append' = messages synced from your
    // primary device (this is how your own 'message yourself' texts arrive on
    // a linked device). Accept both; ignore bulk history syncs.
    if (type !== "notify" && type !== "append") return;
    for (const msg of messages) {
      try {
        await handleIncoming(msg);
      } catch (e) {
        const errorStr = String(e);
        
        // Bad MAC errors are normal during initial sync of old messages with different
        // session keys; suppress these as noise. Only log critical session issues.
        if (errorStr.includes("Bad MAC")) {
          logInfo("Skipped message (decryption mismatch, likely old cached message)");
          continue;
        }
        
        logError("handleIncoming error: " + errorStr);
        
        // Session desynchronization errors - indicate auth state out of sync
        if (errorStr.includes("MessageCounterError")) {
          logError(
            "Session decryption failed. This usually means the auth state is out of sync. " +
            "Clear WA_AUTH_DIR and re-authenticate by running the login again."
          );
        }
      }
    }
  });
}

async function handleIncoming(msg) {
  if (!msg.message) return;

  // Skip historical messages replayed by sync when the worker reconnects.
  const timestampSeconds = getMessageTimestampSeconds(msg);
  if (
    timestampSeconds !== undefined &&
    timestampSeconds < WORKER_START_TIMESTAMP_SECONDS - 5
  ) {
    return;
  }
  
  // Deduplicate: skip if we've already processed this message ID
  const msgId = msg.key.id;
  if (!msgId || processedMessages.has(msgId)) {
    if (msgId) {
      logInfo(`Skipped duplicate message (id=${msgId})`);
    }
    return;
  }
  processedMessages.add(msgId);
  
  // Clean up the tracking set to avoid unbounded growth
  if (processedMessages.size > MAX_TRACKED_MESSAGES) {
    const allIds = Array.from(processedMessages);
    const toRemove = allIds.slice(0, allIds.length - MAX_TRACKED_MESSAGES);
    toRemove.forEach((id) => processedMessages.delete(id));
  }
  
  const jid = msg.key.remoteJid;
  if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast") return; // ignore groups/status

  const rawText = extractText(msg.message).trim();
  const number = jidToNumber(jid);
  const name = msg.pushName || number;

  logInfo(
    "Saw message fromMe=" + !!msg.key.fromMe + " number=" + number +
      " text=" + JSON.stringify(rawText.slice(0, 60))
  );

  if (!rawText) return;

  if (msg.key.fromMe) {
    // Messages you send from your own phone. Only act on trigger-prefixed text
    // so normal chats are not intercepted.
    if (!rawText.toLowerCase().startsWith(TRIGGER.toLowerCase())) return;
    const text = rawText.slice(TRIGGER.length).trim();
    if (!text) return;
    emit({ type: "message", from: jid, number, name, text });
    return;
  }

  // Inbound message from someone else: require allowlist.
  if (ALLOWED.length === 0) return;
  if (!ALLOWED.includes(number)) {
    logInfo("Ignored message from non-allowed number: " + number);
    return;
  }
  emit({ type: "message", from: jid, number, name, text: rawText });
}

async function sendText(to, text) {
  if (!sock) return;
  try {
    await sock.sendMessage(to, { text });
  } catch (e) {
    logError("sendMessage failed: " + e);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let cmd;
  try {
    cmd = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (cmd.type === "send" && cmd.to && typeof cmd.text === "string") {
    await sendText(cmd.to, cmd.text);
  } else if (cmd.type === "logout") {
    try {
      await sock?.logout();
    } catch (e) {
      logError("logout failed: " + e);
    }
  }
});

process.on("uncaughtException", (e) => logError("uncaughtException: " + e));
process.on("unhandledRejection", (e) => logError("unhandledRejection: " + e));

start().catch((e) => {
  logError("Fatal start error: " + e);
  process.exit(1);
});
