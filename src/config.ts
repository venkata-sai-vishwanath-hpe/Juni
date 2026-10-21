import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

/** Supported AI back ends. "copilot" uses VS Code's Language Model API. */
export type AiProvider = "copilot" | "openai" | "anthropic" | "gemini";

export interface McpServerConfig {
  /** Friendly identifier, also used to disambiguate tool names if needed. */
  name: string;
  /** HTTP(S) endpoint of the MCP server (e.g. http://localhost:30030/mcp). */
  url: string;
  /** Optional headers (e.g. Authorization) sent with HTTP requests. */
  headers: Record<string, string>;
}

export interface BridgeConfig {
  ai: {
    provider: AiProvider;
    /** Copilot: model family (e.g. gpt-4o). Others: provider model id. */
    model: string;
    apiKeys: {
      openai: string;
      anthropic: string;
      gemini: string;
    };
  };
  /** Effective system prompt (built-in default if the file left it blank). */
  systemPrompt: string;
  mcp: {
    enabledTools: "readonly" | "all";
    readOnlyToolNames: string[];
    servers: McpServerConfig[];
  };
  whatsapp: {
    triggerPrefix: string;
    allowedNumbers: string[];
  };
}

/** File name of the central, user-editable configuration. */
export const CONFIG_FILE_NAME = "bridge.config.json";

/**
 * General-purpose assistant prompt. The bot answers ordinary questions on its
 * own and automatically calls an MCP tool whenever the request needs live data
 * or an action the tools can perform.
 */
export const DEFAULT_SYSTEM_PROMPT = [
  "You are Juni, a helpful network assistant reachable over WhatsApp.",
  "Answer general questions directly and conversationally using your own knowledge.",
  "You are connected to one or more MCP (Model Context Protocol) servers that expose tools.",
  "Whenever a request needs live data, a lookup, or an action that a tool can perform, call the appropriate tool automatically instead of guessing or asking the user to do it.",
  "Never invent tool output, device names, IPs, or results. Only state facts you got from a tool or that are general knowledge.",
  "If no available tool fits the request, say so plainly and answer as best you can.",
  "If a tool returns an error, explain it briefly and suggest a likely cause.",
  "Keep replies short and easy to read on a phone: plain text, short lines, and simple '-' bullet points. Do not use Markdown tables or code fences. Summarize long output instead of pasting all of it.",
].join(" ");

const DEFAULT_READONLY_TOOLS = [
  "get_router_list",
  "get_junos_config",
  "junos_config_diff",
  "gather_device_facts",
];

function defaultConfig(): BridgeConfig {
  return {
    ai: {
      provider: "copilot",
      model: "gpt-4o",
      apiKeys: { openai: "", anthropic: "", gemini: "" },
    },
    systemPrompt: "",
    mcp: {
      enabledTools: "readonly",
      readOnlyToolNames: [...DEFAULT_READONLY_TOOLS],
      servers: [
        {
          name: "junos",
          url: "http://localhost:30030/mcp",
          headers: {},
        }
      ],
    },
    whatsapp: { triggerPrefix: "@juni", allowedNumbers: [] },
  };
}

/**
 * Resolves where the central config file lives. Priority:
 *   1. The 'junosWhatsapp.configPath' setting (if set).
 *   2. <first workspace folder>/bridge.config.json
 *   3. <extension folder>/bridge.config.json
 * The first existing file wins; otherwise the extension-folder path is used so
 * a default can be written there.
 */
export function resolveConfigPath(context: vscode.ExtensionContext): string {
  const configured = vscode.workspace
    .getConfiguration("junosWhatsapp")
    .get<string>("configPath", "")
    .trim();
  if (configured) {
    return configured;
  }

  const candidates: string[] = [];
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    candidates.push(path.join(folder.uri.fsPath, CONFIG_FILE_NAME));
  }
  const extPath = path.join(context.extensionPath, CONFIG_FILE_NAME);
  candidates.push(extPath);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return extPath;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-merges file values onto defaults so partial config files still work. */
function mergeConfig(base: BridgeConfig, raw: unknown): BridgeConfig {
  if (!isObject(raw)) {
    return base;
  }
  const out: BridgeConfig = JSON.parse(JSON.stringify(base));

  if (isObject(raw.ai)) {
    const ai = raw.ai;
    if (typeof ai.provider === "string") {
      out.ai.provider = ai.provider as AiProvider;
    }
    if (typeof ai.model === "string" && ai.model.trim()) {
      out.ai.model = ai.model.trim();
    }
    if (isObject(ai.apiKeys)) {
      const k = ai.apiKeys;
      if (typeof k.openai === "string") out.ai.apiKeys.openai = k.openai;
      if (typeof k.anthropic === "string") out.ai.apiKeys.anthropic = k.anthropic;
      if (typeof k.gemini === "string") out.ai.apiKeys.gemini = k.gemini;
    }
  }

  if (typeof raw.systemPrompt === "string") {
    out.systemPrompt = raw.systemPrompt;
  }

  if (isObject(raw.mcp)) {
    const mcp = raw.mcp;
    if (mcp.enabledTools === "readonly" || mcp.enabledTools === "all") {
      out.mcp.enabledTools = mcp.enabledTools;
    }
    if (Array.isArray(mcp.readOnlyToolNames)) {
      out.mcp.readOnlyToolNames = mcp.readOnlyToolNames.filter(
        (n): n is string => typeof n === "string"
      );
    }
    if (Array.isArray(mcp.servers)) {
      out.mcp.servers = mcp.servers
        .filter(isObject)
        .map((s) => ({
          name: typeof s.name === "string" ? s.name : "mcp",
          url: typeof s.url === "string" ? s.url : "",
          headers: isObject(s.headers)
            ? Object.fromEntries(
                Object.entries(s.headers).filter(
                  ([, v]) => typeof v === "string"
                ) as [string, string][]
              )
            : {},
        }));
    }
  }

  if (isObject(raw.whatsapp)) {
    const wa = raw.whatsapp;
    if (typeof wa.triggerPrefix === "string") {
      out.whatsapp.triggerPrefix = wa.triggerPrefix;
    }
    if (Array.isArray(wa.allowedNumbers)) {
      out.whatsapp.allowedNumbers = wa.allowedNumbers.filter(
        (n): n is string => typeof n === "string"
      );
    }
  }

  return out;
}

/**
 * Loads and validates the central config file, applying defaults for anything
 * missing. If the file does not exist, a default one is written so the user has
 * something to edit. The returned systemPrompt is always non-empty.
 */
export function loadConfig(context: vscode.ExtensionContext): {
  config: BridgeConfig;
  configPath: string;
} {
  const configPath = resolveConfigPath(context);
  const base = defaultConfig();

  let config: BridgeConfig;
  if (fs.existsSync(configPath)) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (e) {
      throw new Error(
        `Failed to parse ${configPath}: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }
    config = mergeConfig(base, raw);
  } else {
    config = base;
    try {
      fs.writeFileSync(configPath, JSON.stringify(base, null, 2) + "\n", "utf8");
    } catch {
      // Non-fatal: fall back to in-memory defaults.
    }
  }

  if (!config.systemPrompt.trim()) {
    config.systemPrompt = DEFAULT_SYSTEM_PROMPT;
  }

  return { config, configPath };
}

/**
 * Persists a single AI model choice back into the config file, preserving all
 * other user-edited values and formatting-friendly indentation.
 */
export function updateModelInConfig(configPath: string, model: string): void {
  let raw: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (isObject(parsed)) {
        raw = parsed;
      }
    } catch {
      // Overwrite an unparseable file with a fresh default below.
    }
  }
  const ai = isObject(raw.ai) ? raw.ai : {};
  ai.model = model;
  raw.ai = ai;
  fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n", "utf8");
}
