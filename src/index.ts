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

const CA_INSTRUCTIONS = `
## Requêtes Chiffre d'Affaires — Accès direct aux tables Odoo

Lorsqu'une demande concerne le chiffre d'affaires (CA), les ventes, les revenus,
les factures clients ou les commandes, interroge DIRECTEMENT les tables suivantes
via les outils RPC plutôt que de naviguer dans les menus Odoo.

### Tables prioritaires

**Factures clients (source de vérité comptable du CA)**
- Modèle : \`account.move\`
- Filtres obligatoires :
  - move_type IN ('out_invoice', 'out_refund') — factures et avoirs clients
  - state = 'posted' — uniquement les pièces validées
- Champs clés : name, invoice_date, amount_untaxed, amount_tax,
  amount_total, partner_id, currency_id, payment_state

**Lignes de facture (détail par produit/service)**
- Modèle : \`account.move.line\`
- Filtres : display_type NOT IN ('line_section', 'line_note'), exclude_from_invoice_tab = false
- Champs clés : product_id, quantity, price_unit, price_subtotal, account_id, tax_ids

**Commandes de vente (CA prévisionnel/opérationnel)**
- Modèle : \`sale.order\`
- Filtres : state IN ('sale', 'done')
- Champs clés : name, date_order, amount_untaxed, amount_total, partner_id, user_id, team_id

**Lignes de commande**
- Modèle : \`sale.order.line\`
- Filtres : state IN ('sale', 'done'), display_type IS NULL
- Champs clés : product_id, product_uom_qty, price_unit, price_subtotal

**Point de vente (si applicable)**
- Modèle : \`pos.order\` / \`pos.order.line\`
- Filtres : state IN ('done', 'invoiced', 'paid')

### Règles de calcul du CA

- CA HT période : SUM(amount_untaxed) sur account.move (factures - avoirs)
- CA TTC : SUM(amount_total)
- CA net : out_invoice - out_refund
- CA par client : GROUP BY partner_id avec JOIN sur res.partner
- CA par produit : via account.move.line GROUP BY product_id
- CA par vendeur : JOIN sale.order sur user_id → res.users

### Règle importante
Pour toute question de CA : utilise odoo_search_read sur \`account.move\`
avec les filtres move_type et state = 'posted', puis affine avec odoo_batch
si tu as besoin de données croisées (lignes + en-têtes).
Ne navigue JAMAIS dans les menus Odoo pour des données comptables — requête directement.
`;

const server = new McpServer(
  { name: "odoo-mcp-server", version: "1.0.0" },
  { instructions: CA_INSTRUCTIONS }
);

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
