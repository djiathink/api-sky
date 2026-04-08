import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OdooClient } from "./odoo-client.js";

export function registerTools(server: McpServer, odoo: OdooClient, companyId: number) {
  // Append company filter to every domain
  function co(domain: any[]): any[] {
    return [...domain, ["company_id", "=", companyId]];
  }

  // ─── Tool 1: Créer une demande d'approvisionnement ───
  server.tool(
    "passer_demande_approvisionnement",
    "Passer une demande d'approvisionnement. Paramètres requis: code_station (stock.location.code). Paramètres optionnels: produits_quantites (liste des produits et quantités à commander).",
    {
      code_station: z.string().describe("Code de la station (stock.location.code) - REQUIS"),
      produits_quantites: z.array(z.object({
        product_id: z.number().describe("ID du produit dans Odoo"),
        product_name: z.string().optional().describe("Nom du produit"),
        quantity: z.number().describe("Quantité à commander"),
        unit_of_measure_id: z.number().optional().describe("ID de l'unité de mesure (par défaut: unité standard du produit)"),
      })).optional().describe("Liste des produits et quantités. Correspond à stock.move"),
    },
    async ({ code_station, produits_quantites }) => {
      try {
        // Vérifier que la station existe
        const stations = await odoo.searchRead("stock.location", co([["code", "=", code_station]]), ["id", "name"], 1);
        if (!stations || (stations as any[]).length === 0) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Station avec le code '${code_station}' non trouvée` }, null, 2) }] };
        }

        const stationId = (stations as any[])[0].id;
        const pickingValues: Record<string, any> = {
          location_dest_id: stationId,
          picking_type_id: null,
          origin: `Approvisionnement depuis ${code_station}`,
          company_id: companyId,
        };

        // Chercher le type de picking pour les transferts entrants
        const pickingTypes = await odoo.searchRead("stock.picking.type", co([["code", "=", "incoming"]]), ["id"], 1);
        if (pickingTypes && (pickingTypes as any[]).length > 0) {
          pickingValues.picking_type_id = (pickingTypes as any[])[0].id;
        }

        // Créer le picking
        const pickingId = await odoo.create("stock.picking", pickingValues);

        // Ajouter les mouvements de stock si fournis
        if (produits_quantites && produits_quantites.length > 0) {
          for (const item of produits_quantites) {
            // Auto-resolve product ID from name if not provided or 0
            let productId = item.product_id;
            if (!productId || productId === 0) {
              if (!item.product_name) throw new Error("product_id ou product_name requis");
              const found = await odoo.searchRead("product.product", co([["name", "ilike", item.product_name]]), ["id", "name"], 5);
              if (!found || (found as any[]).length === 0) throw new Error(`Produit "${item.product_name}" introuvable dans Odoo`);
              productId = (found as any[])[0].id;
            }
            // Auto-resolve unit of measure if not provided
            let uomId = item.unit_of_measure_id;
            if (!uomId) {
              const prod = await odoo.read("product.product", [productId], ["uom_id"]);
              uomId = ((prod as any[])[0]?.uom_id?.[0]) || 1;
            }
            const moveValues = {
              picking_id: pickingId,
              product_id: productId,
              quantity: item.quantity,
              product_uom_qty: item.quantity,
              product_uom: uomId,
              location_id: 8,
              location_dest_id: stationId,
              name: item.product_name || String(productId),
              company_id: companyId,
            };
            await odoo.create("stock.move", moveValues);
          }
        }

        // Lire le picking créé pour obtenir son numéro (name)
        const pickingData = await odoo.read("stock.picking", [pickingId as number], ["name"]);
        const pickingNumber = ((pickingData as any[])[0]?.name) || `Picking #${pickingId}`;

        return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, picking_id: pickingId, numero_demande: pickingNumber, message: `Demande d'approvisionnement créée: ${pickingNumber}` }, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }, null, 2) }] };
      }
    }
  );

  // ─── Tool 2: Suivre le statut de la demande d'approvisionnement ───
  server.tool(
    "suivre_statut_approvisionnement",
    "Suivre le statut d'une demande d'approvisionnement. Paramètre requis: numero_demande (le champ 'name' du stock.picking).",
    {
      numero_demande: z.string().describe("Numéro de la demande d'approvisionnement (stock.picking.name) - REQUIS"),
    },
    async ({ numero_demande }) => {
      try {
        const pickings = await odoo.searchRead(
          "stock.picking",
          co([["name", "=", numero_demande]]),
          ["id", "name", "state", "picking_type_id", "location_id", "location_dest_id", "scheduled_date", "date_done"],
          1
        );

        if (!pickings || (pickings as any[]).length === 0) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Demande d'approvisionnement '${numero_demande}' non trouvée` }, null, 2) }] };
        }

        const picking = (pickings as any[])[0];
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, picking }, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }, null, 2) }] };
      }
    }
  );

  // ─── Tool 3: Effectuer un relevé de cuve ───
  server.tool(
    "releve_cuve",
    "Effectuer un relevé de cuve (stock.quant). Paramètre requis: quantite_inventoriee (inventory_quantity du model stock.quant). Paramètres optionnels: code_produit ou code_location.",
    {
      quantite_inventoriee: z.number().describe("Quantité inventoriée (stock.quant.inventory_quantity) - REQUIS"),
      code_produit: z.string().optional().describe("Code du produit (product.product.default_code) pour filtrer"),
      code_location: z.string().optional().describe("Code de la localisation (stock.location.code) pour filtrer"),
      product_id: z.number().optional().describe("ID du produit si connu"),
      location_id: z.number().optional().describe("ID de la localisation si connu"),
    },
    async ({ quantite_inventoriee, code_produit, code_location, product_id, location_id }) => {
      try {
        const domain: any[] = [["company_id", "=", companyId]];

        if (product_id) {
          domain.push(["product_id", "=", product_id]);
        } else if (code_produit) {
          domain.push(["product_id.default_code", "=", code_produit]);
        }

        if (location_id) {
          domain.push(["location_id", "=", location_id]);
        } else if (code_location) {
          domain.push(["location_id.code", "=", code_location]);
        }

        if (domain.length === 1) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Vous devez fournir au minimum le code_produit OU code_location, ou les IDs correspondants" }, null, 2) }] };
        }

        // Rechercher les quants
        const quants = await odoo.searchRead("stock.quant", domain, ["id", "product_id", "location_id", "quantity", "inventory_quantity"], 100);

        if (!quants || (quants as any[]).length === 0) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Aucun quant trouvé avec les critères fournis" }, null, 2) }] };
        }

        // Mettre à jour la quantité inventoriée pour tous les quants trouvés
        const quantIds = (quants as any[]).map((q) => q.id);
        await odoo.write("stock.quant", quantIds, { inventory_quantity: quantite_inventoriee });

        return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, updated_count: quantIds.length, message: `${quantIds.length} relevé(s) de cuve mis à jour avec la quantité ${quantite_inventoriee}` }, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }, null, 2) }] };
      }
    }
  );

  // ─── Tool 4: Effectuer un relevé de pompe ───
  server.tool(
    "releve_pompe",
    "Effectuer un relevé de pompe. Paramètre requis: code_pompe (stock.location.code). Paramètres optionnels: indices_pompe (liste des lectures) et encaissements (montants collectés par méthode de paiement).",
    {
      code_pompe: z.string().describe("Code de la pompe (stock.location.code) - REQUIS"),
      indices_pompe: z.array(z.object({
        product_id: z.number().describe("ID du produit"),
        index_initial: z.number().optional().describe("Index initial du compteur"),
        index_final: z.number().describe("Index final du compteur (gas.pump.index.line)"),
        quantite: z.number().optional().describe("Quantité délivrée"),
      })).optional().describe("Liste des indices de pompe (gas.pump.index.line)"),
      encaissements: z.array(z.object({
        payment_method_id: z.number().describe("ID de la méthode de paiement (account.payment.method.line)"),
        montant: z.number().describe("Montant encaissé par cette méthode"),
      })).optional().describe("Liste des encaissements par méthode de paiement (gas.pump.money.collected)"),
    },
    async ({ code_pompe, indices_pompe, encaissements }) => {
      try {
        // Vérifier que la pompe existe
        const pompes = await odoo.searchRead("stock.location", co([["code", "=", code_pompe]]), ["id", "name"], 1);
        if (!pompes || (pompes as any[]).length === 0) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Pompe avec le code '${code_pompe}' non trouvée` }, null, 2) }] };
        }

        const pompeId = (pompes as any[])[0].id;
        const results: any = { success: true, pump_id: pompeId, indices_created: [] as number[], money_collected_created: [] as number[] };

        // Enregistrer les indices de pompe
        if (indices_pompe && indices_pompe.length > 0) {
          for (const index of indices_pompe) {
            const indexValues = {
              pump_id: pompeId,
              product_id: index.product_id,
              index_initial: index.index_initial || 0,
              index_final: index.index_final,
              quantity: index.quantite || 0,
              company_id: companyId,
            };
            const indexId = await odoo.create("gas.pump.index.line", indexValues);
            results.indices_created.push(indexId);
          }
        }

        // Enregistrer les encaissements
        if (encaissements && encaissements.length > 0) {
          for (const encaissement of encaissements) {
            const moneyValues = {
              pump_id: pompeId,
              payment_method_id: encaissement.payment_method_id,
              amount: encaissement.montant,
              company_id: companyId,
            };
            const moneyId = await odoo.create("gas.pump.money.collected", moneyValues);
            results.money_collected_created.push(moneyId);
          }
        }

        results.message = `Relevé de pompe enregistré: ${results.indices_created.length} indice(s) et ${results.money_collected_created.length} encaissement(s)`;
        return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }, null, 2) }] };
      }
    }
  );

  // ─── Tool pour les opérations non autorisées ───
  server.tool(
    "unauthorized_operation",
    "Tentative d'effectuer une opération non autorisée.",
    {
      operation: z.string().describe("Nom de l'opération tentée"),
    },
    async ({ operation }) => {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: "Opération non autorisée",
              message: `L'opération '${operation}' n'est pas autorisée par ce MCP. Les seules opérations autorisées sont: passer_demande_approvisionnement, suivre_statut_approvisionnement, releve_cuve, releve_pompe`,
            }, null, 2),
          },
        ],
      };
    }
  );
}
