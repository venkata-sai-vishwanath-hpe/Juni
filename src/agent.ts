import * as vscode from "vscode";
import { McpManager, McpTool } from "./mcpClient";
import {
  createProvider,
  LlmMessage,
  LlmProvider,
  LlmTool,
  LlmToolResult,
} from "./llm";
import type { BridgeConfig } from "./config";

const MAX_TOOL_ROUNDS = 6;

export interface AgentDeps {
  mcp: McpManager;
  tools: McpTool[];
  config: BridgeConfig;
  log: (text: string) => void;
}

function wantsRawToolOutput(userText: string): boolean {
  const normalized = userText.toLowerCase();
  return (
    normalized.includes("actual output only") ||
    normalized.includes("raw output") ||
    normalized.includes("verbatim output") ||
    normalized.includes("don't modify the output") ||
    normalized.includes("do not modify the output")
  );
}

function looksLikeToolFailure(resultText: string): boolean {
  const normalized = resultText.toLowerCase();
  return (
    normalized.startsWith("tool execution failed:") ||
    normalized.includes("unknown tool") ||
    normalized.includes("error:")
  );
}

function selectTools(deps: AgentDeps): McpTool[] {
  if (deps.config.mcp.enabledTools === "all") {
    return deps.tools;
  }
  // "readonly" mode: a tool is allowed if the server marks it read-only
  // (MCP readOnlyHint) OR it is explicitly listed in readOnlyToolNames.
  // The manual list is an optional override for servers that give no hint.
  const allow = new Set(deps.config.mcp.readOnlyToolNames);
  return deps.tools.filter((t) => t.readOnly === true || allow.has(t.name));
}

function toLlmTools(tools: McpTool[]): LlmTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

/**
 * Runs one user turn: sends the question to the configured AI provider,
 * executes any requested MCP tool calls, and returns the final
 * natural-language answer.
 */
export async function runAgentTurn(
  userText: string,
  deps: AgentDeps,
  token: vscode.CancellationToken
): Promise<string> {
  const provider: LlmProvider = createProvider(deps.config);
  const activeTools = selectTools(deps);
  const llmTools = toLlmTools(activeTools);
  const allowed = new Set(activeTools.map((t) => t.name));

  const messages: LlmMessage[] = [
    { role: "system", content: deps.config.systemPrompt },
    { role: "user", content: userText },
  ];
  const returnRawOutput = wantsRawToolOutput(userText);

  let finalText = "";
  let lastSuccessfulToolResult = "";

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let turn;
    try {
      turn = await provider.send(messages, llmTools, token);
    } catch (e) {
      if (returnRawOutput && lastSuccessfulToolResult) {
        deps.log(
          `Model follow-up failed after tool execution; returning raw tool output instead: ${String(e)}`
        );
        return lastSuccessfulToolResult;
      }
      throw e;
    }

    if (turn.toolCalls.length === 0) {
      finalText = turn.text.trim();
      break;
    }

    // Record the assistant's tool-call turn.
    messages.push({
      role: "assistant",
      content: turn.text,
      toolCalls: turn.toolCalls,
    });

    // Execute each tool call and feed results back.
    const results: LlmToolResult[] = [];
    for (const call of turn.toolCalls) {
      let resultText: string;
      if (!allowed.has(call.name)) {
        resultText = `Tool '${call.name}' is not enabled. Allowed tools: ${[
          ...allowed,
        ].join(", ")}.`;
      } else {
        deps.log(`Tool call: ${call.name}(${JSON.stringify(call.input)})`);
        try {
          resultText = await deps.mcp.callTool(call.name, call.input ?? {});
        } catch (e) {
          resultText = "Tool execution failed: " + String(e);
        }
      }
      if (!looksLikeToolFailure(resultText)) {
        lastSuccessfulToolResult = resultText;
      }
      results.push({ id: call.id, name: call.name, content: resultText });
    }

    if (returnRawOutput && results.length === 1 && lastSuccessfulToolResult) {
      return lastSuccessfulToolResult;
    }

    messages.push({ role: "tool", results });
  }

  if (!finalText) {
    finalText =
      "Sorry, I couldn't complete that request (too many tool steps). Please try rephrasing.";
  }

  return finalText;
}

