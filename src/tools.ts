import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OdooClient } from "./odoo-client.js";

export function registerTools(server: McpServer, odoo: OdooClient) {
  server.tool(
    "odoo_search_read",
    "Search and read records from an Odoo model. Use domain filters like [[\"field\", \"=\", \"value\"]]. Returns matching records with specified fields.",
    {
      model: z.string().describe("Odoo model name, e.g. 'res.partner', 'sale.order', 'account.move'"),
      domain: z.array(z.unknown()).default([]).describe("Odoo domain filter, e.g. [[\"state\",\"=\",\"draft\"]]"),
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
      values: z.object({}).passthrough().describe("Field values for the new record, e.g. {\"name\": \"John\", \"email\": \"john@example.com\"}"),
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
      values: z.object({}).passthrough().describe("Field values to update"),
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
      domain: z.array(z.unknown()).default([]).describe("Odoo domain filter"),
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

  // ─── Batch tool: execute multiple read operations in a single HTTP request ───
  server.tool(
    "odoo_batch",
    "Execute multiple Odoo read operations in a single request. Returns all results at once, reducing HTTP round trips.",
    {
      operations: z.array(z.object({
        id: z.string().describe("Unique identifier for this operation"),
        method: z.enum(["search_read", "read", "search_count", "fields_get"]).describe("Odoo method"),
        model: z.string().describe("Odoo model name"),
        domain: z.array(z.unknown()).optional().default([]).describe("Domain filter"),
        fields: z.array(z.string()).optional().describe("Fields to return"),
        limit: z.number().optional().describe("Max records"),
        offset: z.number().optional().describe("Records to skip"),
        order: z.string().optional().describe("Sort order"),
      })).describe("Array of operations to execute in parallel"),
    },
    async ({ operations }) => {
      const results = await Promise.all(
        operations.map(async (op) => {
          try {
            let result: unknown;
            switch (op.method) {
              case "search_read":
                result = await odoo.searchRead(op.model, op.domain, op.fields, op.limit, op.offset, op.order);
                break;
              case "read":
                result = await odoo.read(op.model, op.domain as unknown as number[], op.fields);
                break;
              case "search_count":
                result = await odoo.searchCount(op.model, op.domain);
                break;
              case "fields_get":
                result = await odoo.fieldsGet(op.model, op.fields);
                break;
            }
            return { id: op.id, result };
          } catch (err: any) {
            return { id: op.id, error: err.message };
          }
        })
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    }
  );

  // ─── Resolve multiple user emails in a single query ───
  server.tool(
    "odoo_resolve_users",
    "Resolve multiple user emails/logins to Odoo user records in a single query. Much faster than looking up users one by one.",
    {
      emails: z.array(z.string()).describe("List of user emails/logins to resolve"),
      fields: z.array(z.string()).optional().default(["id", "name", "login", "email"]).describe("Fields to return"),
    },
    async ({ emails, fields }) => {
      if (emails.length === 0) {
        return { content: [{ type: "text" as const, text: "[]" }] };
      }
      const result = await odoo.searchRead(
        "res.users",
        [["login", "in", emails]],
        fields,
        emails.length
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );
}
