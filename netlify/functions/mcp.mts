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

// ─── Module-scope cache: survives across warm invocations ───
let cachedOdoo: OdooClient | null = null;
let cachedUidTs = 0;
const UID_TTL = 30 * 60 * 1000; // 30 min

async function getOdooClient(): Promise<OdooClient> {
  const now = Date.now();
  if (cachedOdoo && (now - cachedUidTs) < UID_TTL) {
    return cachedOdoo;
  }
  const odoo = new OdooClient({
    url: getEnv("ODOO_URL"),
    db: getEnv("ODOO_DB"),
    login: getEnv("ODOO_LOGIN"),
    apiKey: getEnv("ODOO_API_KEY"),
  });
  await odoo.authenticate();
  cachedOdoo = odoo;
  cachedUidTs = now;
  return odoo;
}

function resetOdooClient() {
  cachedOdoo = null;
  cachedUidTs = 0;
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

    let odoo: OdooClient;
    try {
      odoo = await getOdooClient();
    } catch {
      // Auth failed — reset cache and retry once
      resetOdooClient();
      odoo = await getOdooClient();
    }

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
    // If Odoo auth error during tool execution, reset cache for next request
    if (err.message?.includes("Authentication") || err.message?.includes("Access Denied")) {
      resetOdooClient();
    }
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
