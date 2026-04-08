import type { Context, Config } from "@netlify/functions";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { OdooClient } from "../../src/odoo-client.js";
import { registerTools } from "../../src/tools.js";
import { randomUUID } from "crypto";

/**
 * Streamable HTTP Transport (MCP spec 2025-03-26)
 * - Gestion des sessions via mcp-session-id
 * - Support SSE (text/event-stream) et JSON selon Accept header
 * - GET pour établir un flux SSE
 * - DELETE pour fermer une session
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

// ─── Odoo client cache (module-scope, survives warm invocations) ───
let cachedOdoo: OdooClient | null = null;
let cachedUidTs = 0;
const UID_TTL = 30 * 60 * 1000; // 30 min

async function getOdooClient(): Promise<OdooClient> {
  const now = Date.now();
  if (cachedOdoo && now - cachedUidTs < UID_TTL) {
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

// ─── Session store ───
const sessions = new Map<string, { createdAt: number }>();
const SESSION_TTL = 60 * 60 * 1000; // 1h

function cleanupSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL) sessions.delete(id);
  }
}

// ─── SSE helper ───
function formatSSE(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

// ─── CORS headers ───
function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, mcp-session-id, Accept",
    "Access-Control-Expose-Headers": "mcp-session-id",
  };
}

export default async (req: Request, _context: Context) => {
  const origin = req.headers.get("origin") ?? "*";
  const cors = corsHeaders(origin);

  // ── CORS preflight ──
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  // ── DELETE : fermeture de session ──
  if (req.method === "DELETE") {
    const sid = req.headers.get("mcp-session-id");
    if (sid) sessions.delete(sid);
    return new Response(null, { status: 200, headers: cors });
  }

  // ── GET : établissement du flux SSE ──
  if (req.method === "GET") {
    const accept = req.headers.get("accept") ?? "";
    if (!accept.includes("text/event-stream")) {
      return new Response(JSON.stringify({ error: "Expected Accept: text/event-stream" }), {
        status: 406,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const sid = req.headers.get("mcp-session-id") ?? randomUUID();
    return new Response(": ping\n\n", {
      status: 200,
      headers: {
        ...cors,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "mcp-session-id": sid,
      },
    });
  }

  // ── POST : traitement des messages MCP ──
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  try {
    const rawBody = await req.text();
    const body = JSON.parse(rawBody);
    const accept = req.headers.get("accept") ?? "";
    const useSSE = accept.includes("text/event-stream");
    const isInit = body?.method === "initialize";

    // Gestion de session
    let sessionId = req.headers.get("mcp-session-id");
    if (isInit) {
      sessionId = randomUUID();
      cleanupSessions();
      sessions.set(sessionId, { createdAt: Date.now() });
    } else if (!sessionId || !sessions.has(sessionId)) {
      // Session inconnue : on crée une nouvelle session à la volée
      sessionId = randomUUID();
      sessions.set(sessionId, { createdAt: Date.now() });
    }

    let odoo: OdooClient;
    try {
      odoo = await getOdooClient();
    } catch {
      resetOdooClient();
      odoo = await getOdooClient();
    }

    const server = new McpServer({
      name: "odoo-mcp-server",
      version: "1.0.0",
      instructions: `À la création d'une demande d'approvisionnement, recherche le code de station dans le modèle stock.location, dans le champ 'code'.`,
    });
    registerTools(server, odoo);

    const transport = new InlineTransport();
    await server.connect(transport);

    const response = await transport.processRequest(body);
    await server.close();

    const responseHeaders = {
      ...cors,
      "mcp-session-id": sessionId,
    };

    if (response === null) {
      return new Response(null, { status: 202, headers: responseHeaders });
    }

    // Spec MCP 2025-03-26 : pour une réponse unique, toujours répondre en JSON.
    // Le SSE n'est utilisé que si le client n'accepte PAS application/json
    // (i.e. Accept: text/event-stream uniquement, sans application/json).
    const acceptsJson = !useSSE || accept.includes("application/json");

    if (!acceptsJson) {
      return new Response(formatSSE(response), {
        status: 200,
        headers: {
          ...responseHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
    }

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...responseHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    if (err.message?.includes("Authentication") || err.message?.includes("Access Denied")) {
      resetOdooClient();
    }
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32603, message: err.message },
        id: null,
      }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
};

export const config: Config = {
  path: "/mcp",
};
