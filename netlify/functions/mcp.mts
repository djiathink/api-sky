import type { Context, Config } from "@netlify/functions";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { OdooClient } from "../../src/odoo-client.js";
import { registerTools } from "../../src/tools.js";

/**
 * Custom transport that processes JSON-RPC messages directly,
 * bypassing the need for Node.js IncomingMessage/ServerResponse objects.
 */
class InlineTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private _resolve?: (msg: JSONRPCMessage) => void;

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    this._resolve?.(message);
  }

  async close(): Promise<void> {
    this.onclose?.();
  }

  /**
   * Pass a JSON-RPC message to the server and wait for the response.
   * For notifications (no id), returns null immediately.
   */
  processRequest(msg: JSONRPCMessage): Promise<JSONRPCMessage | null> {
    if (!("id" in msg)) {
      this.onmessage?.(msg);
      return Promise.resolve(null);
    }
    return new Promise<JSONRPCMessage>((resolve, reject) => {
      this._resolve = resolve;
      setTimeout(() => reject(new Error("MCP request timed out")), 25000);
      this.onmessage?.(msg);
    });
  }
}

function getEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing env var: ${key}`);
  return value;
}

export default async (req: Request, _context: Context) => {
  if (req.method === "DELETE") {
    return new Response(null, { status: 200 });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();

    const odoo = new OdooClient({
      url: getEnv("ODOO_URL"),
      db: getEnv("ODOO_DB"),
      login: getEnv("ODOO_LOGIN"),
      apiKey: getEnv("ODOO_API_KEY"),
    });
    await odoo.authenticate();

    const server = new McpServer({ name: "odoo-mcp-server", version: "1.0.0" });
    registerTools(server, odoo);

    const transport = new InlineTransport();
    await server.connect(transport);

    const response = await transport.processRequest(body);

    await server.close();

    if (response === null) {
      return new Response(null, { status: 202 });
    }

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32603, message: err.message },
        id: null,
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};

export const config: Config = {
  path: "/mcp",
};
