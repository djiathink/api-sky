import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OdooClient } from "./odoo-client.js";

export function registerTools(server: McpServer, odoo: OdooClient) {
  server.tool(
    "odoo_search_read",
    "Search and read records from an Odoo model. Use domain filters like [[\"field\", \"=\", \"value\"]]. Returns matching records with specified fields.",
    {
      model: z.string().describe("Odoo model name, e.g. 'res.partner', 'sale.order', 'account.move'"),
      domain: z.array(z.any()).default([]).describe("Odoo domain filter, e.g. [[\"state\",\"=\",\"draft\"]]"),
      fields: z.array(z.string()).optional().describe("Fields to return, e.g. [\"name\", \"email\"]"),
      limit: z.number().optional().default(10).describe("Max records to return (default 10)"),
      offset: z.number().optional().describe("Number of records to skip"),
      order: z.string().optional().describe("Sort order, e.g. 'name asc' or 'id desc'"),
    },
    async ({ model, domain, fields, limit, offset, order }) => {
      const result = await odoo.searchRead(model, domain, fields, limit, offset, order);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "odoo_read",
    "Read specific records by their IDs from an Odoo model.",
    {
      model: z.string().describe("Odoo model name"),
      ids: z.array(z.number()).describe("List of record IDs to read"),
      fields: z.array(z.string()).optional().describe("Fields to return"),
    },
    async ({ model, ids, fields }) => {
      const result = await odoo.read(model, ids, fields);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "odoo_create",
    "Create a new record in an Odoo model. Returns the new record ID.",
    {
      model: z.string().describe("Odoo model name"),
      values: z.record(z.any()).describe("Field values for the new record, e.g. {\"name\": \"John\", \"email\": \"john@example.com\"}"),
    },
    async ({ model, values }) => {
      const result = await odoo.create(model, values);
      return { content: [{ type: "text" as const, text: JSON.stringify({ id: result }, null, 2) }] };
    }
  );

  server.tool(
    "odoo_update",
    "Update existing records in an Odoo model.",
    {
      model: z.string().describe("Odoo model name"),
      ids: z.array(z.number()).describe("List of record IDs to update"),
      values: z.record(z.any()).describe("Field values to update"),
    },
    async ({ model, ids, values }) => {
      const result = await odoo.write(model, ids, values);
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: result }, null, 2) }] };
    }
  );

  server.tool(
    "odoo_delete",
    "Delete records from an Odoo model. Use with caution.",
    {
      model: z.string().describe("Odoo model name"),
      ids: z.array(z.number()).describe("List of record IDs to delete"),
    },
    async ({ model, ids }) => {
      const result = await odoo.unlink(model, ids);
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: result }, null, 2) }] };
    }
  );

  server.tool(
    "odoo_count",
    "Count records matching a domain filter in an Odoo model.",
    {
      model: z.string().describe("Odoo model name"),
      domain: z.array(z.any()).default([]).describe("Odoo domain filter"),
    },
    async ({ model, domain }) => {
      const result = await odoo.searchCount(model, domain);
      return { content: [{ type: "text" as const, text: JSON.stringify({ count: result }, null, 2) }] };
    }
  );

  server.tool(
    "odoo_list_models",
    "List available Odoo models. Optionally filter by name.",
    {
      filter: z.string().optional().describe("Optional filter to search models by name"),
    },
    async ({ filter }) => {
      const result = await odoo.listModels(filter);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "odoo_get_fields",
    "Get field definitions for an Odoo model. Useful to discover available fields before querying.",
    {
      model: z.string().describe("Odoo model name"),
      attributes: z.array(z.string()).optional().default(["string", "type", "required", "readonly", "relation"]).describe("Field attributes to return"),
    },
    async ({ model, attributes }) => {
      const result = await odoo.fieldsGet(model, attributes);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );
}
