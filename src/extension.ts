import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as readline from "readline";
import { McpManager, McpServerOptions, McpTool } from "./mcpClient";
import { runAgentTurn } from "./agent";
import {
  BridgeConfig,
  loadConfig,
  resolveConfigPath,
  updateModelInConfig,
} from "./config";

let bridge: Bridge | undefined;

interface WorkerMessage {
  type: string;
  dataUrl?: string;
  ascii?: string;
  connection?: string;
  level?: string;
  text?: string;
  from?: string;
  number?: string;
  name?: string;
}

function shouldSuppressWorkerStderr(text: string): boolean {
  const normalized = text.toLowerCase();
  const hasBadMac = normalized.includes("bad mac");
  const hasDecryptNoise =
    normalized.includes("failed to decrypt message with any known session") ||
    normalized.includes("session error:");
  return hasBadMac && hasDecryptNoise;
}

function resetAuthStateDir(authDir: string): void {
  // Force a clean WhatsApp session so each start gets a fresh QR login.
  fs.rmSync(authDir, { recursive: true, force: true });
  fs.mkdirSync(authDir, { recursive: true });
}

class Bridge {
  private worker: cp.ChildProcess | undefined;
  private mcp: McpManager | undefined;
  private tools: McpTool[] = [];
  private config: BridgeConfig | undefined;
  private configPath = "";
  private qrPanel: vscode.WebviewPanel | undefined;
  private lastQrDataUrl: string | undefined;
  private queue: Promise<void> = Promise.resolve();
  private readonly output: vscode.OutputChannel;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel("Junos WhatsApp Bridge");
  }

  private log(text: string): void {
    const ts = new Date().toISOString();
    this.output.appendLine(`[${ts}] ${text}`);
  }

  private cfg<T>(key: string, fallback: T): T {
    return vscode.workspace
      .getConfiguration("junosWhatsapp")
      .get<T>(key, fallback);
  }

  /** Validates and turns config server entries into HTTP connection options. */
  private buildServerOptions(config: BridgeConfig): McpServerOptions[] {
    return config.mcp.servers.map((s) => {
      const url = s.url.trim();
      if (!url) {
        throw new Error(
          `MCP server '${s.name}' has no 'url'. Every server must define an HTTP url in bridge.config.json.`
        );
      }
      return {
        name: s.name,
        url,
        headers: s.headers,
      };
    });
  }

  async start(): Promise<void> {
    if (this.worker) {
      vscode.window.showInformationMessage("Junos WhatsApp Bridge is already running.");
      return;
    }
    this.output.show(true);

    // 0. Load the central config file (created with defaults if missing).
    const loaded = loadConfig(this.context);
    this.config = loaded.config;
    this.configPath = loaded.configPath;
    this.log(`Loaded config: ${this.configPath}`);
    this.log(
      `AI provider: ${this.config.ai.provider} | model: ${this.config.ai.model} | tools: ${this.config.mcp.enabledTools}`
    );

    // 1. Connect to the configured MCP server(s) over HTTP.
    const serverOptions = this.buildServerOptions(this.config);

    this.log(
      `Starting MCP server(s): ${serverOptions
        .map((s) => `${s.name} [http ${s.url}]`)
        .join("; ")}`
    );
    this.mcp = new McpManager(serverOptions);
    await this.mcp.connect((t) => this.log(t));
    this.tools = this.mcp.listTools();
    this.log(`MCP ready. Tools: ${this.tools.map((t) => t.name).join(", ")}`);

    // 2. Spawn the WhatsApp worker.
    const authDir = path.join(this.context.globalStorageUri.fsPath, "wa-auth");
    const resetAuthOnStart = this.cfg<boolean>("resetAuthOnStart", true);
    if (resetAuthOnStart) {
      this.log("Resetting WhatsApp auth state for a fresh login on start.");
      resetAuthStateDir(authDir);
    } else {
      fs.mkdirSync(authDir, { recursive: true });
    }
    const workerPath = path.join(this.context.extensionPath, "worker", "whatsapp-worker.mjs");

    this.log(`Starting WhatsApp worker: node ${workerPath}`);
    this.worker = cp.spawn("node", [workerPath], {
      cwd: this.context.extensionPath,
      env: {
        ...process.env,
        WA_AUTH_DIR: authDir,
        WA_TRIGGER: this.config.whatsapp.triggerPrefix,
        WA_ALLOWED: this.config.whatsapp.allowedNumbers.join(","),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.worker.on("error", (e) => {
      this.log(`Worker process error: ${e}`);
      vscode.window.showErrorMessage(
        `WhatsApp worker failed to start: ${e.message}. Is Node.js installed and on PATH?`
      );
    });
    this.worker.on("exit", (code) => {
      this.log(`Worker exited with code ${code}`);
      this.worker = undefined;
    });

    if (this.worker.stderr) {
      this.worker.stderr.on("data", (d) => {
        const text = String(d);
        if (shouldSuppressWorkerStderr(text)) {
          return;
        }
        this.log(`worker stderr: ${text}`);
      });
    }

    const rl = readline.createInterface({ input: this.worker.stdout! });
    rl.on("line", (line) => this.handleWorkerLine(line));

    vscode.window.showInformationMessage(
      "Junos WhatsApp Bridge starting. Scan the QR code to link WhatsApp."
    );
  }

  private handleWorkerLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let msg: WorkerMessage;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.log(`worker (raw): ${trimmed}`);
      return;
    }

    switch (msg.type) {
      case "qr":
        this.lastQrDataUrl = msg.dataUrl;
        if (msg.ascii) {
          this.log("Scan this QR in WhatsApp > Linked Devices:\n" + msg.ascii);
        }
        this.showQr();
        break;
      case "ready":
        this.log("WhatsApp linked and ready.");
        vscode.window.showInformationMessage("WhatsApp is linked and ready.");
        if (this.qrPanel) {
          this.qrPanel.dispose();
          this.qrPanel = undefined;
        }
        break;
      case "status":
        this.log(`WhatsApp connection: ${msg.connection}`);
        break;
      case "log":
        this.log(`worker: ${msg.text}`);
        break;
      case "message":
        this.enqueueMessage(msg);
        break;
      default:
        this.log(`worker (unknown): ${trimmed}`);
    }
  }

  private enqueueMessage(msg: WorkerMessage): void {
    if (!msg.from || !msg.text) {
      return;
    }
    // Serialize turns so model/tool calls don't interleave.
    this.queue = this.queue.then(() => this.processMessage(msg));
  }

  private async processMessage(msg: WorkerMessage): Promise<void> {
    const from = msg.from!;
    const text = msg.text!.trim();
    this.log(`Incoming from ${msg.name || msg.number}: ${text}`);

    if (!this.mcp) {
      this.sendReply(from, "Bridge is not connected to the Junos server.");
      return;
    }

    const tokenSource = new vscode.CancellationTokenSource();
    const timeout = setTimeout(() => tokenSource.cancel(), 120_000);

    try {
      const reply = await runAgentTurn(
        text,
        {
          mcp: this.mcp,
          tools: this.tools,
          config: this.config!,
          log: (t) => this.log(t),
        },
        tokenSource.token
      );
      this.sendReply(from, reply);
    } catch (e) {
      this.log(`Agent error: ${e}`);
      const detail = e instanceof Error ? e.message : String(e);
      this.sendReply(from, `Sorry, something went wrong: ${detail}`);
    } finally {
      clearTimeout(timeout);
      tokenSource.dispose();
    }
  }

  private sendReply(to: string, text: string): void {
    if (!this.worker || !this.worker.stdin) {
      return;
    }
    this.log(`Reply to ${to}: ${text.slice(0, 200)}`);
    this.worker.stdin.write(JSON.stringify({ type: "send", to, text }) + "\n");
  }

  showQr(): void {
    if (!this.lastQrDataUrl) {
      vscode.window.showInformationMessage(
        "No QR available yet. It appears when the bridge needs to link WhatsApp."
      );
      return;
    }
    if (!this.qrPanel) {
      this.qrPanel = vscode.window.createWebviewPanel(
        "junosWhatsappQr",
        "WhatsApp Login QR",
        vscode.ViewColumn.Active,
        { enableScripts: false }
      );
      this.qrPanel.onDidDispose(() => {
        this.qrPanel = undefined;
      });
    }
    this.qrPanel.webview.html = `<!DOCTYPE html>
<html><body style="display:flex;flex-direction:column;align-items:center;font-family:sans-serif;padding:24px;">
<h2>Link WhatsApp</h2>
<p>Open WhatsApp &gt; Settings &gt; Linked Devices &gt; Link a Device, then scan:</p>
<img src="${this.lastQrDataUrl}" alt="QR code" style="width:320px;height:320px;" />
</body></html>`;
    this.qrPanel.reveal();
  }

  logout(): void {
    if (this.worker?.stdin) {
      this.worker.stdin.write(JSON.stringify({ type: "logout" }) + "\n");
    }
  }

  async stop(): Promise<void> {
    this.log("Stopping bridge...");
    if (this.worker) {
      this.worker.kill();
      this.worker = undefined;
    }
    if (this.mcp) {
      await this.mcp.dispose();
      this.mcp = undefined;
    }
    if (this.qrPanel) {
      this.qrPanel.dispose();
      this.qrPanel = undefined;
    }
    vscode.window.showInformationMessage("Junos WhatsApp Bridge stopped.");
  }
}

/**
 * Lets the user pick which Copilot model the bot uses, listing only the model
 * families their Copilot subscription actually exposes (e.g. GPT and Claude).
 * The choice is written to the central config file (ai.provider = "copilot",
 * ai.model = chosen family) and a restart applies it.
 */
async function selectModelCommand(context: vscode.ExtensionContext): Promise<void> {
  let models: readonly vscode.LanguageModelChat[];
  try {
    models = await vscode.lm.selectChatModels({ vendor: "copilot" });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(`Could not list Copilot models: ${detail}`);
    return;
  }

  if (models.length === 0) {
    vscode.window.showErrorMessage(
      "No Copilot chat models are available. Make sure GitHub Copilot Chat is installed and signed in."
    );
    return;
  }

  const configPath = resolveConfigPath(context);

  // Several models can share a family; de-duplicate for a clean picker.
  const seen = new Set<string>();
  const items: Array<vscode.QuickPickItem & { family: string }> = [];
  for (const m of models) {
    if (seen.has(m.family)) {
      continue;
    }
    seen.add(m.family);
    items.push({
      label: m.name,
      description: m.family,
      detail: `${m.vendor} \u00b7 max input ${m.maxInputTokens} tokens`,
      family: m.family,
    });
  }

  const pick = await vscode.window.showQuickPick(items, {
    title: "Select the Copilot model for the WhatsApp bot",
    placeHolder: "This sets ai.provider = copilot and ai.model in bridge.config.json",
    matchOnDescription: true,
  });
  if (!pick) {
    return;
  }

  try {
    updateModelInConfig(configPath, pick.family);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(`Could not update config: ${detail}`);
    return;
  }

  vscode.window.showInformationMessage(
    `Saved model '${pick.family}' to bridge.config.json. Restart the bridge to apply.`
  );
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("junosWhatsapp.start", async () => {
      try {
        bridge = bridge ?? new Bridge(context);
        await bridge.start();
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Failed to start bridge: ${detail}`);
      }
    }),
    vscode.commands.registerCommand("junosWhatsapp.stop", async () => {
      await bridge?.stop();
    }),
    vscode.commands.registerCommand("junosWhatsapp.showQr", () => {
      bridge?.showQr();
    }),
    vscode.commands.registerCommand("junosWhatsapp.logout", () => {
      bridge?.logout();
    }),
    vscode.commands.registerCommand("junosWhatsapp.selectModel", async () => {
      await selectModelCommand(context);
    }),
    vscode.commands.registerCommand("junosWhatsapp.openConfig", async () => {
      const configPath = resolveConfigPath(context);
      if (!fs.existsSync(configPath)) {
        // Create defaults so there's something to open.
        loadConfig(context);
      }
      const doc = await vscode.workspace.openTextDocument(configPath);
      await vscode.window.showTextDocument(doc);
    })
  );
}


export async function deactivate(): Promise<void> {
  await bridge?.stop();
}
