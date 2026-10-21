import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: object;
  /**
   * From the tool's MCP annotations (readOnlyHint): true if the server declares
   * the tool does not modify anything. undefined when the server gives no hint.
   */
  readOnly?: boolean;
}

/**
 * Connection parameters for a single MCP server. All servers are reached over
 * HTTP (Streamable HTTP, with an automatic fallback to SSE).
 */
export interface McpServerOptions {
  name: string;
  /** HTTP(S) endpoint of the MCP server (e.g. http://localhost:30030/mcp). */
  url: string;
  /** Optional headers (e.g. Authorization) sent with HTTP requests. */
  headers?: Record<string, string>;
}

/**
 * Wraps one MCP client connected to a remote/local HTTP MCP server.
 */
export class McpServer {
  private client: Client | undefined;
  private transport: Transport | undefined;

  constructor(private readonly opts: McpServerOptions) {}

  get name(): string {
    return this.opts.name;
  }

  private buildHeaders(): Record<string, string> | undefined {
    const headers = this.opts.headers;
    return headers && Object.keys(headers).length > 0 ? headers : undefined;
  }

  async connect(): Promise<void> {
    const url = this.opts.url?.trim();
    if (!url) {
      throw new Error(
        `MCP server '${this.opts.name}' has no 'url'. Every server must define an HTTP url.`
      );
    }

    const headers = this.buildHeaders();
    const requestInit = headers ? { headers } : undefined;
    const target = new URL(url);

    this.client = new Client(
      { name: "junos-whatsapp-bridge", version: "0.1.0" },
      { capabilities: {} }
    );

    // Prefer modern Streamable HTTP; fall back to the older SSE transport if
    // the server doesn't speak it.
    try {
      this.transport = new StreamableHTTPClientTransport(target, {
        requestInit,
      });
      await this.client.connect(this.transport);
    } catch {
      try {
        await this.transport?.close?.();
      } catch {
        // ignore
      }
      this.transport = new SSEClientTransport(target, { requestInit });
      await this.client.connect(this.transport);
    }
  }


  async listTools(): Promise<McpTool[]> {
    if (!this.client) {
      throw new Error("MCP client not connected");
    }
    const res = await this.client.listTools();
    return res.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: (t.inputSchema as object) ?? { type: "object", properties: {} },
      readOnly: (t.annotations as { readOnlyHint?: boolean } | undefined)
        ?.readOnlyHint,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.client) {
      throw new Error("MCP client not connected");
    }
    const res = await this.client.callTool({ name, arguments: args ?? {} });
    const content = (res.content as Array<{ type: string; text?: string }>) ?? [];
    const parts = content
      .map((c) => (c.type === "text" && c.text ? c.text : ""))
      .filter(Boolean);
    const text = parts.join("\n").trim();
    if (res.isError) {
      return "Tool error: " + (text || "unknown error");
    }
    return text || "(no output)";
  }

  async dispose(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      // ignore
    }
    this.client = undefined;
    this.transport = undefined;
  }
}

/**
 * Connects to and aggregates one or more MCP servers, presenting a single tool
 * list and routing each tool call to the server that owns it.
 */
export class McpManager {
  private readonly servers: McpServer[];
  /** tool name -> owning server */
  private readonly owner = new Map<string, McpServer>();
  private tools: McpTool[] = [];

  constructor(serverOpts: McpServerOptions[]) {
    this.servers = serverOpts.map((o) => new McpServer(o));
  }

  /** Connects every server and builds the combined tool list. */
  async connect(log?: (text: string) => void): Promise<void> {
    for (const server of this.servers) {
      await server.connect();
      const tools = await server.listTools();
      for (const tool of tools) {
        if (this.owner.has(tool.name)) {
          log?.(
            `Duplicate tool '${tool.name}' from server '${server.name}' ignored; already provided by another server.`
          );
          continue;
        }
        this.owner.set(tool.name, server);
        this.tools.push(tool);
      }
      log?.(
        `MCP server '${server.name}' connected. Tools: ${tools
          .map((t) => t.name)
          .join(", ")}`
      );
    }
  }

  listTools(): McpTool[] {
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const server = this.owner.get(name);
    if (!server) {
      return `Tool '${name}' is not provided by any connected MCP server.`;
    }
    return server.callTool(name, args);
  }

  async dispose(): Promise<void> {
    for (const server of this.servers) {
      await server.dispose();
    }
    this.owner.clear();
    this.tools = [];
  }
}

