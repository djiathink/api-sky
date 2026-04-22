import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OdooClient } from "./odoo-client.js";

export function registerTools(server: McpServer, odoo: OdooClient) {
  // ─── Tool: Rechercher une station ───
  server.tool(
    "rechercher_stations",
    "Rechercher une ou plusieurs stations (stock.location) par nom ou code. Retourne id, name, code des stations trouvées.",
    {
      nom: z.string().optional().describe("Nom ou partie du nom de la station"),
      code: z.string().optional().describe("Code exact de la station (stock.location.code)"),
    },
    async ({ nom, code }) => {
      try {
        const domain: any[] = [["is_gas_oil_location", "=", true], ["gas_oil_location_type", "=", "station"]];
        if (code) {
          domain.push(["code", "=", code]);
        } else if (nom) {
          domain.push(["name", "ilike", nom]);
        } else {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Fournir nom ou code" }, null, 2) }] };
        }

        const stations = await odoo.searchRead("stock.location", domain, ["id", "name", "complete_name", "code"], 20);
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, stations }, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }, null, 2) }] };
      }
    }
  );

  // ─── Tool: Lister les cuves d'une station ───
  server.tool(
    "lister_cuves",
    "Lister les cuves (stock.location enfants) d'une station. Paramètre requis: station_id (id de la station parente).",
    {
      station_id: z.number().describe("ID de la station parente (stock.location.id)"),
    },
    async ({ station_id }) => {
      try {
        const cuves = await odoo.searchRead(
          "stock.location",
          [["location_id", "=", station_id], ["is_gas_oil_location", "=", true], ["gas_oil_location_type", "=", "tank"]],
          ["id", "name", "complete_name", "code"],
          50
        );
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, cuves }, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }, null, 2) }] };
      }
    }
  );

  // ─── Tool: Lister les pompes d'une station ───
  server.tool(
    "lister_pompes",
    "Lister les pompes (gas.pump) d'une station. Paramètre requis: station_id.",
    {
      station_id: z.number().describe("ID de la station (stock.location.id ou gas.pump.station_id)"),
    },
    async ({ station_id }) => {
      try {
        const pompes = await odoo.searchRead(
          "gas.pump",
          [["station_id", "=", station_id]],
          ["id", "name", "code", "station_id"],
          50
        );
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, pompes }, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }, null, 2) }] };
      }
    }
  );

  // ─── Tool 1: Créer une demande d'approvisionnement ───
  server.tool(
    "passer_demande_approvisionnement",
    "Créer une demande d'approvisionnement (stock.picking) pour une station. code_station correspond à stock.location.code.",
    {
      code_station: z.string().describe("Code de la station (stock.location.code) - REQUIS"),
      produits_quantites: z.array(z.object({
        product_id: z.number().describe("ID du produit Odoo"),
        product_name: z.string().optional().describe("Nom du produit (utilisé si product_id inconnu)"),
        quantity: z.number().describe("Quantité à commander"),
        unit_of_measure_id: z.number().optional().describe("ID de l'unité de mesure — déduit du produit si absent"),
      })).optional().describe("Liste des produits et quantités (stock.move)"),
    },
    async ({ code_station, produits_quantites }) => {
      try {
        const stations = await odoo.searchRead("stock.location", [["code", "=", code_station]], ["id", "name"], 1);
        if (!stations || (stations as any[]).length === 0) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Station '${code_station}' introuvable` }, null, 2) }] };
        }

        const stationId = (stations as any[])[0].id;
        const now = new Date().toISOString().replace("T", " ").substring(0, 19);
        const pickingValues: Record<string, any> = {
          location_dest_id: stationId,
          picking_type_id: null,
          origin: `Approvisionnement depuis ${code_station}`,
          scheduled_date: now,
        };

        const pickingTypes = await odoo.searchRead("stock.picking.type", [["code", "=", "incoming"]], ["id"], 1);
        if (pickingTypes && (pickingTypes as any[]).length > 0) {
          pickingValues.picking_type_id = (pickingTypes as any[])[0].id;
        }

        const pickingId = await odoo.create("stock.picking", pickingValues);

        if (produits_quantites && produits_quantites.length > 0) {
          for (const item of produits_quantites) {
            let productId = item.product_id;
            if (!productId || productId === 0) {
              if (!item.product_name) throw new Error("product_id ou product_name requis");
              const found = await odoo.searchRead("product.product", [["name", "ilike", item.product_name]], ["id", "name"], 5);
              if (!found || (found as any[]).length === 0) throw new Error(`Produit "${item.product_name}" introuvable`);
              productId = (found as any[])[0].id;
            }
            let uomId = item.unit_of_measure_id;
            if (!uomId) {
              const prod = await odoo.read("product.product", [productId], ["uom_id"]);
              uomId = ((prod as any[])[0]?.uom_id?.[0]) || 1;
            }
            await odoo.create("stock.move", {
              picking_id: pickingId,
              product_id: productId,
              quantity: item.quantity,
              product_uom_qty: item.quantity,
              product_uom: uomId,
              location_id: 8,
              location_dest_id: stationId,
              name: item.product_name || String(productId),
            });
          }
        }

        const pickingData = await odoo.read("stock.picking", [pickingId as number], ["name"]);
        const pickingNumber = ((pickingData as any[])[0]?.name) || `#${pickingId}`;

        return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, picking_id: pickingId, numero_demande: pickingNumber, message: `Demande créée: ${pickingNumber}` }, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }, null, 2) }] };
      }
    }
  );

  // ─── Tool 2: Suivre le statut d'une demande d'approvisionnement ───
  server.tool(
    "suivre_statut_approvisionnement",
    "Suivre le statut d'une demande d'approvisionnement. numero_demande = champ name du stock.picking.",
    {
      numero_demande: z.string().describe("Numéro de la demande (stock.picking.name) — ex: WH/IN/00001"),
    },
    async ({ numero_demande }) => {
      try {
        const pickings = await odoo.searchRead(
          "stock.picking",
          [["name", "=", numero_demande]],
          ["id", "name", "state", "picking_type_id", "location_id", "location_dest_id", "scheduled_date", "date_done"],
          1
        );
        if (!pickings || (pickings as any[]).length === 0) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Demande '${numero_demande}' introuvable` }, null, 2) }] };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, picking: (pickings as any[])[0] }, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }, null, 2) }] };
      }
    }
  );

  // ─── Tool 3: Relevé de cuve ───
  server.tool(
    "releve_cuve",
    "Effectuer un relevé de cuve (stock.quant). Paramètre requis: quantite_inventoriee. Fournir location_id ou code_location pour identifier la cuve.",
    {
      quantite_inventoriee: z.number().describe("Quantité relevée (stock.quant.inventory_quantity) - REQUIS"),
      location_id: z.number().optional().describe("ID de la cuve (stock.location.id)"),
      code_location: z.string().optional().describe("Code de la cuve (stock.location.code)"),
      product_id: z.number().optional().describe("ID du produit"),
      code_produit: z.string().optional().describe("Code interne du produit (product.product.default_code)"),
    },
    async ({ quantite_inventoriee, location_id, code_location, product_id, code_produit }) => {
      try {
        const domain: any[] = [];

        if (location_id) {
          domain.push(["location_id", "=", location_id]);
        } else if (code_location) {
          domain.push(["location_id.code", "=", code_location]);
        } else {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "location_id ou code_location requis" }, null, 2) }] };
        }

        if (product_id) {
          domain.push(["product_id", "=", product_id]);
        } else if (code_produit) {
          domain.push(["product_id.default_code", "=", code_produit]);
        }

        const quants = await odoo.searchRead("stock.quant", domain, ["id", "product_id", "location_id", "quantity", "inventory_quantity"], 100);
        if (!quants || (quants as any[]).length === 0) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Aucun quant trouvé avec les critères fournis" }, null, 2) }] };
        }

        const quantIds = (quants as any[]).map((q) => q.id);
        await odoo.write("stock.quant", quantIds, { inventory_quantity: quantite_inventoriee });

        return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, updated_count: quantIds.length, message: `${quantIds.length} relevé(s) de cuve mis à jour avec ${quantite_inventoriee} L` }, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }, null, 2) }] };
      }
    }
  );

  // ─── Tool 4: Relevé de pompe ───
  server.tool(
    "releve_pompe",
    "Effectuer un relevé de pompe. Paramètre requis: pump_id (gas.pump.id). Optionnel: indices_pompe et encaissements.",
    {
      pump_id: z.number().describe("ID de la pompe (gas.pump.id) - REQUIS"),
      indices_pompe: z.array(z.object({
        product_id: z.number().describe("ID du produit"),
        index_initial: z.number().optional().describe("Index début"),
        index_final: z.number().describe("Index fin"),
        quantite: z.number().optional().describe("Quantité délivrée"),
      })).optional().describe("Indices de pompe (gas.pump.index.line)"),
      encaissements: z.array(z.object({
        payment_method_id: z.number().describe("ID de la méthode de paiement"),
        montant: z.number().describe("Montant encaissé"),
      })).optional().describe("Encaissements par méthode de paiement (gas.pump.money.collected)"),
    },
    async ({ pump_id, indices_pompe, encaissements }) => {
      try {
        const results: any = { success: true, pump_id, indices_created: [] as number[], money_collected_created: [] as number[] };

        if (indices_pompe && indices_pompe.length > 0) {
          for (const index of indices_pompe) {
            const indexId = await odoo.create("gas.pump.index.line", {
              pump_id,
              product_id: index.product_id,
              index_initial: index.index_initial || 0,
              index_final: index.index_final,
              quantity: index.quantite || 0,
            });
            results.indices_created.push(indexId);
          }
        }

        if (encaissements && encaissements.length > 0) {
          for (const enc of encaissements) {
            const moneyId = await odoo.create("gas.pump.money.collected", {
              pump_id,
              payment_method_id: enc.payment_method_id,
              amount: enc.montant,
            });
            results.money_collected_created.push(moneyId);
          }
        }

        results.message = `Relevé enregistré: ${results.indices_created.length} indice(s), ${results.money_collected_created.length} encaissement(s)`;
        return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }, null, 2) }] };
      }
    }
  );

  // ─── Outils Odoo génériques (requis par std-performer) ───

  server.tool(
    "odoo_search_read",
    "Recherche et lecture d'enregistrements Odoo. Supporte tous les modèles (sale.order, account.move, crm.lead, res.users, etc.).",
    {
      model: z.string().describe("Nom du modèle Odoo, ex: 'sale.order', 'account.move', 'crm.lead'"),
      domain: z.array(z.any()).optional().default([]).describe("Filtre domaine Odoo, ex: [[\"state\",\"=\",\"posted\"]]"),
      fields: z.array(z.string()).optional().describe("Champs à retourner"),
      limit: z.number().optional().default(100).describe("Nombre max d'enregistrements"),
      offset: z.number().optional().describe("Décalage pour la pagination"),
      order: z.string().optional().describe("Tri, ex: 'date_order desc'"),
    },
    async ({ model, domain, fields, limit, offset, order }) => {
      try {
        const result = await odoo.searchRead(model, domain ?? [], fields, limit, offset, order);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }) }], isError: true };
      }
    }
  );

  server.tool(
    "odoo_read",
    "Lecture d'enregistrements Odoo par leurs IDs.",
    {
      model: z.string().describe("Nom du modèle Odoo"),
      ids: z.array(z.number()).describe("Liste d'IDs à lire"),
      fields: z.array(z.string()).optional().describe("Champs à retourner"),
    },
    async ({ model, ids, fields }) => {
      try {
        const result = await odoo.read(model, ids, fields);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }) }], isError: true };
      }
    }
  );

  server.tool(
    "odoo_count",
    "Compte le nombre d'enregistrements correspondant au domaine.",
    {
      model: z.string().describe("Nom du modèle Odoo"),
      domain: z.array(z.any()).optional().default([]).describe("Filtre domaine Odoo"),
    },
    async ({ model, domain }) => {
      try {
        const result = await odoo.searchCount(model, domain ?? []);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }) }], isError: true };
      }
    }
  );

  server.tool(
    "odoo_create",
    "Crée un ou plusieurs enregistrements dans un modèle Odoo.",
    {
      model: z.string().describe("Nom du modèle Odoo"),
      values: z.record(z.any()).describe("Valeurs à créer"),
    },
    async ({ model, values }) => {
      try {
        const result = await odoo.create(model, values);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }) }], isError: true };
      }
    }
  );

  server.tool(
    "odoo_update",
    "Met à jour des enregistrements Odoo.",
    {
      model: z.string().describe("Nom du modèle Odoo"),
      ids: z.array(z.number()).describe("Liste d'IDs à mettre à jour"),
      values: z.record(z.any()).describe("Valeurs à mettre à jour"),
    },
    async ({ model, ids, values }) => {
      try {
        const result = await odoo.write(model, ids, values);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }) }], isError: true };
      }
    }
  );

  server.tool(
    "odoo_delete",
    "Supprime des enregistrements Odoo.",
    {
      model: z.string().describe("Nom du modèle Odoo"),
      ids: z.array(z.number()).describe("Liste d'IDs à supprimer"),
    },
    async ({ model, ids }) => {
      try {
        const result = await odoo.unlink(model, ids);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }) }], isError: true };
      }
    }
  );

  server.tool(
    "odoo_get_fields",
    "Retourne les définitions des champs d'un modèle Odoo.",
    {
      model: z.string().describe("Nom du modèle Odoo"),
      attributes: z.array(z.string()).optional().describe("Attributs à retourner (string, type, required, etc.)"),
    },
    async ({ model, attributes }) => {
      try {
        const result = await odoo.fieldsGet(model, attributes);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }) }], isError: true };
      }
    }
  );

  server.tool(
    "odoo_list_models",
    "Liste les modèles disponibles dans Odoo. Filtre optionnel par nom.",
    {
      filter: z.string().optional().describe("Filtre optionnel par nom de modèle"),
    },
    async ({ filter }) => {
      try {
        const result = await odoo.listModels(filter);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }) }], isError: true };
      }
    }
  );

  server.tool(
    "odoo_resolve_users",
    "Résout les utilisateurs Odoo par login (email) ou ID. Accepte 'logins' ou 'emails' comme paramètre.",
    {
      logins: z.array(z.string()).optional().describe("Liste d'emails/logins à résoudre"),
      emails: z.array(z.string()).optional().describe("Alias de logins"),
      ids: z.array(z.number()).optional().describe("Liste d'IDs utilisateurs"),
      fields: z.array(z.string()).optional().describe("Champs à retourner"),
    },
    async ({ logins, emails, ids, fields }) => {
      try {
        const loginList = logins ?? emails ?? [];
        const domain: unknown[] = [];
        if (loginList.length) domain.push(["login", "in", loginList]);
        else if (ids?.length) domain.push(["id", "in", ids]);
        else {
          return { content: [{ type: "text" as const, text: "[]" }] };
        }
        const returnFields = fields ?? ["id", "name", "login", "email"];
        const result = await odoo.searchRead("res.users", domain, returnFields, 500);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }) }], isError: true };
      }
    }
  );

  server.tool(
    "odoo_batch",
    "Exécute plusieurs requêtes odoo_search_read en parallèle.",
    {
      requests: z.array(z.object({
        model: z.string(),
        domain: z.array(z.any()).optional(),
        fields: z.array(z.string()).optional(),
        limit: z.number().optional(),
        order: z.string().optional(),
      })).describe("Liste de requêtes à exécuter en parallèle"),
    },
    async ({ requests }) => {
      try {
        const results = await Promise.all(
          requests.map(r => odoo.searchRead(r.model, r.domain ?? [], r.fields, r.limit, undefined, r.order))
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(results) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }) }], isError: true };
      }
    }
  );
}
