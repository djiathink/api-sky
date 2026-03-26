export interface OdooConfig {
  url: string;
  db: string;
  login: string;
  apiKey: string;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data: { name: string; message: string; debug: string };
  };
}

export class OdooClient {
  private config: OdooConfig;
  private uid: number | null = null;
  private requestId = 0;

  constructor(config: OdooConfig) {
    this.config = config;
  }

  async authenticate(): Promise<number> {
    const body = `<?xml version='1.0'?>
<methodCall>
  <methodName>authenticate</methodName>
  <params>
    <param><value><string>${this.config.db}</string></value></param>
    <param><value><string>${this.config.login}</string></value></param>
    <param><value><string>${this.config.apiKey}</string></value></param>
    <param><value><struct></struct></value></param>
  </params>
</methodCall>`;

    const res = await fetch(`${this.config.url}/xmlrpc/2/common`, {
      method: "POST",
      headers: { "Content-Type": "text/xml" },
      body,
    });

    const text = await res.text();
    const uidMatch = text.match(/<int>(\d+)<\/int>/);
    if (uidMatch) {
      this.uid = parseInt(uidMatch[1], 10);
      return this.uid;
    }

    const falseMatch = text.match(/<boolean>0<\/boolean>/);
    if (falseMatch) {
      throw new Error("Authentication failed: invalid credentials");
    }

    const faultMatch = text.match(/<faultString>[\s\S]*?<\/faultString>/);
    throw new Error(
      `Authentication failed: ${faultMatch ? faultMatch[0] : text.slice(0, 200)}`
    );
  }

  private async jsonRpc(
    service: string,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    if (this.uid === null) {
      await this.authenticate();
    }

    const res = await fetch(`${this.config.url}/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        params: { service, method, args },
        id: ++this.requestId,
      }),
    });

    const data = (await res.json()) as JsonRpcResponse;

    if (data.error) {
      const msg = data.error.data?.message || data.error.message;
      throw new Error(`Odoo Error: ${msg}`);
    }

    return data.result;
  }

  private executeKw(
    model: string,
    method: string,
    args: unknown[],
    kwargs: Record<string, unknown> = {}
  ): Promise<unknown> {
    return this.jsonRpc("object", "execute_kw", [
      this.config.db,
      this.uid!,
      this.config.apiKey,
      model,
      method,
      args,
      kwargs,
    ]);
  }

  async searchRead(
    model: string,
    domain: unknown[] = [],
    fields?: string[],
    limit?: number,
    offset?: number,
    order?: string
  ): Promise<unknown> {
    const kwargs: Record<string, unknown> = {};
    if (fields) kwargs.fields = fields;
    if (limit !== undefined) kwargs.limit = limit;
    if (offset !== undefined) kwargs.offset = offset;
    if (order) kwargs.order = order;
    return this.executeKw(model, "search_read", [domain], kwargs);
  }

  async read(
    model: string,
    ids: number[],
    fields?: string[]
  ): Promise<unknown> {
    const kwargs: Record<string, unknown> = {};
    if (fields) kwargs.fields = fields;
    return this.executeKw(model, "read", [ids], kwargs);
  }

  async create(
    model: string,
    values: Record<string, unknown>
  ): Promise<unknown> {
    return this.executeKw(model, "create", [values]);
  }

  async write(
    model: string,
    ids: number[],
    values: Record<string, unknown>
  ): Promise<unknown> {
    return this.executeKw(model, "write", [ids, values]);
  }

  async unlink(model: string, ids: number[]): Promise<unknown> {
    return this.executeKw(model, "unlink", [ids]);
  }

  async searchCount(
    model: string,
    domain: unknown[] = []
  ): Promise<unknown> {
    return this.executeKw(model, "search_count", [domain]);
  }

  async fieldsGet(
    model: string,
    attributes?: string[]
  ): Promise<unknown> {
    const kwargs: Record<string, unknown> = {};
    if (attributes) kwargs.attributes = attributes;
    return this.executeKw(model, "fields_get", [], kwargs);
  }

  async listModels(filter?: string): Promise<unknown> {
    const domain: unknown[] = [["state", "=", "installed"]];
    if (filter) {
      domain.push("|");
      domain.push(["name", "ilike", filter]);
      domain.push(["shortdesc", "ilike", filter]);
    }
    return this.searchRead(
      "ir.model",
      filter
        ? [
            "&",
            ["transient", "=", false],
            "|",
            ["name", "ilike", filter],
            ["model", "ilike", filter],
          ]
        : [["transient", "=", false]],
      ["model", "name"],
      100
    );
  }
}
