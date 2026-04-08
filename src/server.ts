import "dotenv/config";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { OdooClient } from "./odoo-client.js";
import { registerTools } from "./tools.js";
import { randomUUID } from "crypto";

class InlineTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private _resolve?: (msg: JSONRPCMessage) => void;

  async start(): Promise<void> {}
  async send(message: JSONRPCMessage): Promise<void> { this._resolve?.(message); }
  async close(): Promise<void> { this.onclose?.(); }

  processRequest(msg: JSONRPCMessage): Promise<JSONRPCMessage | null> {
    if (!("id" in msg)) { this.onmessage?.(msg); return Promise.resolve(null); }
    return new Promise<JSONRPCMessage>((resolve, reject) => {
      this._resolve = resolve;
      setTimeout(() => reject(new Error("MCP request timed out")), 25000);
      this.onmessage?.(msg);
    });
  }
}

let cachedOdoo: OdooClient | null = null;
let cachedUidTs = 0;
const UID_TTL = 30 * 60 * 1000;

function getEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing env var: ${key}`);
  return value;
}

async function getOdooClient(): Promise<OdooClient> {
  const now = Date.now();
  if (cachedOdoo && now - cachedUidTs < UID_TTL) return cachedOdoo;
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

function resetOdooClient() { cachedOdoo = null; cachedUidTs = 0; }

const sessions = new Map<string, { createdAt: number }>();
const SESSION_TTL = 60 * 60 * 1000;

function cleanupSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL) sessions.delete(id);
  }
}

const app = express();
app.use(express.json());

app.all("/mcp", async (req: express.Request, res: express.Response) => {
  const origin = (req.headers.origin as string) ?? "*";
  res.set("Access-Control-Allow-Origin", origin);
  res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, mcp-session-id, Accept");
  res.set("Access-Control-Expose-Headers", "mcp-session-id");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "DELETE") {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    if (sid) sessions.delete(sid);
    return res.status(200).end();
  }
  if (req.method === "GET") {
    if (!(req.headers.accept ?? "").includes("text/event-stream"))
      return res.status(406).json({ error: "Expected Accept: text/event-stream" });
    const sid = (req.headers["mcp-session-id"] as string) ?? randomUUID();
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "mcp-session-id": sid });
    return res.status(200).send(": ping\n\n");
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = req.body;
    const accept = (req.headers.accept as string) ?? "";
    const isInit = body?.method === "initialize";

    let sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (isInit) { sessionId = randomUUID(); cleanupSessions(); sessions.set(sessionId, { createdAt: Date.now() }); }
    else if (!sessionId || !sessions.has(sessionId)) { sessionId = randomUUID(); sessions.set(sessionId, { createdAt: Date.now() }); }

    let odoo: OdooClient;
    try { odoo = await getOdooClient(); }
    catch { resetOdooClient(); odoo = await getOdooClient(); }

    const server = new McpServer({ name: "odoo-mcp-server", version: "1.0.0" });
    registerTools(server, odoo);

    const transport = new InlineTransport();
    await server.connect(transport);
    const response = await transport.processRequest(body);
    await server.close();


    res.set("mcp-session-id", sessionId!);
    if (response === null) return res.status(202).end();

    const useSSE = accept.includes("text/event-stream") && !accept.includes("application/json");
    if (useSSE) {
      res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      return res.status(200).send(`data: ${JSON.stringify(response)}\n\n`);
    }
    return res.status(200).json(response);
  } catch (err: any) {
    if (err.message?.includes("Authentication") || err.message?.includes("Access Denied")) resetOdooClient();
    return res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: err.message }, id: null });
  }
});

app.get("/", (_req: express.Request, res: express.Response) => res.json({ status: "ok" }));

const PORT = parseInt(process.env.PORT ?? "3000", 10);

async function main() {
  try {
    await getOdooClient();
    console.log("Odoo authenticated successfully");
  } catch (err) {
    console.error("Odoo authentication failed:", err);
    process.exit(1);
  }
  app.listen(PORT, () => console.log(`MCP server listening on port ${PORT}`));
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
