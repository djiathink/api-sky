#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OdooClient } from "./odoo-client.js";
import { registerTools } from "./tools.js";

const { ODOO_URL, ODOO_DB, ODOO_LOGIN, ODOO_API_KEY } = process.env;

if (!ODOO_URL || !ODOO_DB || !ODOO_LOGIN || !ODOO_API_KEY) {
  console.error("Missing required env vars: ODOO_URL, ODOO_DB, ODOO_LOGIN, ODOO_API_KEY");
  process.exit(1);
}

const odoo = new OdooClient({
  url: ODOO_URL,
  db: ODOO_DB,
  login: ODOO_LOGIN,
  apiKey: ODOO_API_KEY,
});

const server = new McpServer({
  name: "odoo-mcp-server",
  version: "1.0.0",
});

registerTools(server, odoo);

async function main() {
  try {
    const uid = await odoo.authenticate();
    console.error(`Odoo authenticated: UID=${uid} on ${ODOO_URL} (db: ${ODOO_DB})`);
  } catch (err) {
    console.error("Failed to authenticate with Odoo:", err);
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Odoo MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
