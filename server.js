import "dotenv/config"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const DRUPAL_JSONAPI_BASE = process.env.DRUPAL_JSONAPI_BASE
const DRUPAL_TOKEN = process.env.DRUPAL_TOKEN

if (!DRUPAL_JSONAPI_BASE) throw new Error("Missing DRUPAL_JSONAPI_BASE in .env")

async function httpGetJson(url) {
    const res = await fetch(url, {
        headers: {
            Accept: "application/vnd.api+json",
            ...(DRUPAL_TOKEN ? { Authorization: `Bearer ${DRUPAL_TOKEN}` } : {})
        }
    })

    if (res.status === 404) return { _status: "not_found" }
    if (!res.ok) throw new Error(`Drupal JSON:API error ${res.status}`)

    return res.json()
}

function toNumberMaybe(value) {
    if (value === null || value === undefined) return null
    if (typeof value === "number") return value
    if (typeof value !== "string") return null

    // handle "129.00" (dot) and "129,00" (comma)
    const normalized = value.replace(",", ".").trim()
    const n = Number(normalized)
    return Number.isFinite(n) ? n : null
}

function flattenItem(payload) {
    const item = payload?.data
    if (!item?.id || !item?.type) throw new Error("Invalid JSON:API payload (missing data.id/type)")

    const attrs = item.attributes || {}

    // taxonomy include mapping (multi-value)
    const included = Array.isArray(payload.included) ? payload.included : []
    const termNameById = new Map(
        included
            .filter(r => typeof r?.type === "string" && r.type.startsWith("taxonomy_term--"))
            .map(t => [t.id, t.attributes?.name])
    )

    const tagRefs = item.relationships?.field_taglie?.data || []
    const taglie_ids = Array.isArray(tagRefs) ? tagRefs.map(r => r.id).filter(Boolean) : []
    const taglie = taglie_ids.map(id => termNameById.get(id)).filter(Boolean)

    return {
        id: item.id,
        type: item.type,
        title: attrs.title ?? null,
        categoria: attrs.field_categoria ?? null,
        materiale: attrs.field_materiale ?? null,
        prezzo: toNumberMaybe(attrs.field_prezzo),
        valuta: attrs.field_valuta ?? null,
        taglie,
        taglie_ids
    }
}

const server = new Server(
    { name: "drupal-products-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
)

server.setRequestHandler("tools/list", async () => {
    return {
        tools: [
            {
                name: "get_product_by_id",
                description: "Get a product (node item) by UUID from Drupal JSON:API and return a flattened object",
                inputSchema: {
                    type: "object",
                    properties: {
                        id: { type: "string", description: "UUID from JSON:API data.id" }
                    },
                    required: ["id"]
                }
            }
        ]
    }
})

server.setRequestHandler("tools/call", async (req) => {
    const { name, arguments: args } = req.params

    if (name !== "get_product_by_id") {
        throw new Error(`Unknown tool: ${name}`)
    }

    const { id } = z.object({ id: z.string().min(1) }).parse(args)

    console.log("[get_product_by_id] request", { id })

    const url = new URL(`${DRUPAL_JSONAPI_BASE}/node/item/${id}`)
    url.searchParams.set("include", "field_taglie")

    const payload = await httpGetJson(url.toString())

    if (payload?._status === "not_found") {
        console.log("[get_product_by_id] not_found", { id })
        return {
            content: [{ type: "text", text: JSON.stringify({ ok: false, error: "not_found", id }) }]
        }
    }

    const product = flattenItem(payload)

    console.log("[get_product_by_id] ok", { id, title: product.title })
    return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, product }) }]
    }
})

const transport = new StdioServerTransport()
await server.connect(transport)
console.log("Drupal products MCP server running (stdio)")
