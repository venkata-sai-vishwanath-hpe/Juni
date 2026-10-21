import * as vscode from "vscode";
import type { AiProvider, BridgeConfig } from "./config";

/** A tool the model may call, in provider-neutral form. */
export interface LlmTool {
  name: string;
  description: string;
  inputSchema: object;
}

/** A model's request to invoke a tool. */
export interface LlmToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** The result of running a tool, fed back to the model. */
export interface LlmToolResult {
  id: string;
  name: string;
  content: string;
}

/** Provider-neutral conversation message. */
export type LlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: LlmToolCall[] }
  | { role: "tool"; results: LlmToolResult[] };

/** One model turn: free text plus any tool calls it wants to make. */
export interface LlmTurnResult {
  text: string;
  toolCalls: LlmToolCall[];
}

/** Common interface every back end implements. */
export interface LlmProvider {
  readonly label: string;
  send(
    messages: LlmMessage[],
    tools: LlmTool[],
    token: vscode.CancellationToken
  ): Promise<LlmTurnResult>;
}

/** Builds the right provider from the central config. */
export function createProvider(config: BridgeConfig): LlmProvider {
  const provider: AiProvider = config.ai.provider;
  const model = config.ai.model;
  switch (provider) {
    case "openai":
      return new OpenAiProvider(model, requireKey(config, "openai"));
    case "anthropic":
      return new AnthropicProvider(model, requireKey(config, "anthropic"));
    case "gemini":
      return new GeminiProvider(model, requireKey(config, "gemini"));
    case "copilot":
    default:
      return new CopilotProvider(model);
  }
}

function requireKey(
  config: BridgeConfig,
  key: "openai" | "anthropic" | "gemini"
): string {
  const value = config.ai.apiKeys[key].trim();
  if (!value) {
    throw new Error(
      `No API key set for provider '${key}'. Add it under ai.apiKeys.${key} in bridge.config.json.`
    );
  }
  return value;
}

function genId(): string {
  return "call_" + Math.random().toString(36).slice(2, 12);
}

/* ------------------------------------------------------------------ */
/* Copilot (VS Code Language Model API)                                */
/* ------------------------------------------------------------------ */

class CopilotProvider implements LlmProvider {
  readonly label = "GitHub Copilot";
  constructor(private readonly family: string) {}

  private async pickModel(): Promise<vscode.LanguageModelChat> {
    let models = await vscode.lm.selectChatModels({
      vendor: "copilot",
      family: this.family,
    });
    if (models.length === 0) {
      models = await vscode.lm.selectChatModels({ vendor: "copilot" });
    }
    if (models.length === 0) {
      throw new Error(
        "No Copilot chat models are available. Make sure GitHub Copilot Chat is installed and signed in."
      );
    }
    return models[0];
  }

  private toVsMessages(
    messages: LlmMessage[]
  ): vscode.LanguageModelChatMessage[] {
    const out: vscode.LanguageModelChatMessage[] = [];
    for (const m of messages) {
      if (m.role === "system" || m.role === "user") {
        out.push(vscode.LanguageModelChatMessage.User(m.content));
      } else if (m.role === "assistant") {
        const parts: Array<
          vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart
        > = [];
        if (m.content.trim()) {
          parts.push(new vscode.LanguageModelTextPart(m.content));
        }
        for (const c of m.toolCalls ?? []) {
          parts.push(
            new vscode.LanguageModelToolCallPart(c.id, c.name, c.input)
          );
        }
        if (parts.length > 0) {
          out.push(vscode.LanguageModelChatMessage.Assistant(parts));
        }
      } else {
        const parts = m.results.map(
          (r) =>
            new vscode.LanguageModelToolResultPart(r.id, [
              new vscode.LanguageModelTextPart(r.content),
            ])
        );
        out.push(vscode.LanguageModelChatMessage.User(parts));
      }
    }
    return out;
  }

  async send(
    messages: LlmMessage[],
    tools: LlmTool[],
    token: vscode.CancellationToken
  ): Promise<LlmTurnResult> {
    const model = await this.pickModel();
    const lmTools: vscode.LanguageModelChatTool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));

    const response = await model.sendRequest(
      this.toVsMessages(messages),
      {
        tools: lmTools,
        toolMode: vscode.LanguageModelChatToolMode.Auto,
      },
      token
    );

    let text = "";
    const toolCalls: LlmToolCall[] = [];
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        text += part.value;
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push({
          id: part.callId,
          name: part.name,
          input: (part.input as Record<string, unknown>) ?? {},
        });
      }
    }
    return { text: text.trim(), toolCalls };
  }
}

/* ------------------------------------------------------------------ */
/* Shared HTTP helper                                                  */
/* ------------------------------------------------------------------ */

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown
): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const textBody = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}: ${textBody.slice(0, 500)}`);
  }
  try {
    return JSON.parse(textBody);
  } catch {
    throw new Error(`Non-JSON response from ${url}: ${textBody.slice(0, 200)}`);
  }
}

/* ------------------------------------------------------------------ */
/* OpenAI (Chat Completions)                                           */
/* ------------------------------------------------------------------ */

class OpenAiProvider implements LlmProvider {
  readonly label = "OpenAI";
  constructor(
    private readonly model: string,
    private readonly apiKey: string
  ) {}

  async send(messages: LlmMessage[], tools: LlmTool[]): Promise<LlmTurnResult> {
    const oaMessages: any[] = [];
    for (const m of messages) {
      if (m.role === "system") {
        oaMessages.push({ role: "system", content: m.content });
      } else if (m.role === "user") {
        oaMessages.push({ role: "user", content: m.content });
      } else if (m.role === "assistant") {
        const msg: any = { role: "assistant", content: m.content || null };
        if (m.toolCalls && m.toolCalls.length > 0) {
          msg.tool_calls = m.toolCalls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.input) },
          }));
        }
        oaMessages.push(msg);
      } else {
        for (const r of m.results) {
          oaMessages.push({
            role: "tool",
            tool_call_id: r.id,
            content: r.content,
          });
        }
      }
    }

    const body: any = { model: this.model, messages: oaMessages };
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
      body.tool_choice = "auto";
    }

    const data = await postJson(
      "https://api.openai.com/v1/chat/completions",
      { authorization: `Bearer ${this.apiKey}` },
      body
    );

    const choice = data.choices?.[0]?.message ?? {};
    const toolCalls: LlmToolCall[] = (choice.tool_calls ?? []).map(
      (c: any) => ({
        id: c.id ?? genId(),
        name: c.function?.name ?? "",
        input: safeParse(c.function?.arguments),
      })
    );
    return { text: (choice.content ?? "").trim(), toolCalls };
  }
}

/* ------------------------------------------------------------------ */
/* Anthropic (Messages API)                                            */
/* ------------------------------------------------------------------ */

class AnthropicProvider implements LlmProvider {
  readonly label = "Anthropic Claude";
  constructor(
    private readonly model: string,
    private readonly apiKey: string
  ) {}

  async send(messages: LlmMessage[], tools: LlmTool[]): Promise<LlmTurnResult> {
    let system = "";
    const anthMessages: any[] = [];
    for (const m of messages) {
      if (m.role === "system") {
        system = system ? `${system}\n\n${m.content}` : m.content;
      } else if (m.role === "user") {
        anthMessages.push({
          role: "user",
          content: [{ type: "text", text: m.content }],
        });
      } else if (m.role === "assistant") {
        const content: any[] = [];
        if (m.content.trim()) {
          content.push({ type: "text", text: m.content });
        }
        for (const c of m.toolCalls ?? []) {
          content.push({
            type: "tool_use",
            id: c.id,
            name: c.name,
            input: c.input,
          });
        }
        anthMessages.push({ role: "assistant", content });
      } else {
        anthMessages.push({
          role: "user",
          content: m.results.map((r) => ({
            type: "tool_result",
            tool_use_id: r.id,
            content: r.content,
          })),
        });
      }
    }

    const body: any = {
      model: this.model,
      max_tokens: 1024,
      messages: anthMessages,
    };
    if (system) {
      body.system = system;
    }
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }

    const data = await postJson(
      "https://api.anthropic.com/v1/messages",
      { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      body
    );

    let text = "";
    const toolCalls: LlmToolCall[] = [];
    for (const block of data.content ?? []) {
      if (block.type === "text") {
        text += block.text ?? "";
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id ?? genId(),
          name: block.name ?? "",
          input: (block.input as Record<string, unknown>) ?? {},
        });
      }
    }
    return { text: text.trim(), toolCalls };
  }
}

/* ------------------------------------------------------------------ */
/* Google Gemini (generateContent)                                     */
/* ------------------------------------------------------------------ */

class GeminiProvider implements LlmProvider {
  readonly label = "Google Gemini";
  constructor(
    private readonly model: string,
    private readonly apiKey: string
  ) {}

  async send(messages: LlmMessage[], tools: LlmTool[]): Promise<LlmTurnResult> {
    let systemText = "";
    const contents: any[] = [];
    for (const m of messages) {
      if (m.role === "system") {
        systemText = systemText ? `${systemText}\n\n${m.content}` : m.content;
      } else if (m.role === "user") {
        contents.push({ role: "user", parts: [{ text: m.content }] });
      } else if (m.role === "assistant") {
        const parts: any[] = [];
        if (m.content.trim()) {
          parts.push({ text: m.content });
        }
        for (const c of m.toolCalls ?? []) {
          parts.push({
            functionCall: { name: c.name, args: c.input },
          });
        }
        contents.push({ role: "model", parts });
      } else {
        contents.push({
          role: "user",
          parts: m.results.map((r) => ({
            functionResponse: {
              name: r.name,
              response: { result: r.content },
            },
          })),
        });
      }
    }

    const body: any = { contents };
    if (systemText) {
      body.systemInstruction = { parts: [{ text: systemText }] };
    }
    if (tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          })),
        },
      ];
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      this.model
    )}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const data = await postJson(url, {}, body);

    let text = "";
    const toolCalls: LlmToolCall[] = [];
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      if (typeof part.text === "string") {
        text += part.text;
      } else if (part.functionCall) {
        toolCalls.push({
          id: genId(),
          name: part.functionCall.name ?? "",
          input: (part.functionCall.args as Record<string, unknown>) ?? {},
        });
      }
    }
    return { text: text.trim(), toolCalls };
  }
}

function safeParse(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
