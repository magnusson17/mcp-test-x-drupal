import "dotenv/config"
import express from "express"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import {
    ListToolsRequestSchema,
    CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"

// vedi README.md
const DRUPAL_JSONAPI_BASE = process.env.DRUPAL_JSONAPI_BASE
const DRUPAL_BASIC_AUTH = process.env.DRUPAL_BASIC_AUTH
const MCP_API_KEY = process.env.MCP_API_KEY

if (!DRUPAL_JSONAPI_BASE) throw new Error("Missing DRUPAL_JSONAPI_BASE in .env")
if (!MCP_API_KEY) throw new Error("Missing MCP_API_KEY in .env")

async function httpGetJson(url) {

    const res = await fetch(url, {
        headers: {
            Accept: "application/vnd.api+json", // il formato ufficiale per JSON:API media type
            ...(DRUPAL_BASIC_AUTH
                ? {
                    Authorization:
                        "Basic " +
                        Buffer.from(DRUPAL_BASIC_AUTH).toString("base64")
                }
                : {})
        }
    })

    if (res.status === 404) return { _status: "not_found" }
    if (!res.ok) throw new Error(`Drupal JSON:API error ${res.status}`)

    return res.json()
}

// prendo l'obj, lo lavoro e ritorno solo i fields che voglio
function flattenItem(payload) {

    const item = payload?.data
    if (!item?.id || !item?.type) throw new Error("Invalid JSON:API payload (missing data.id/type)")

    const attrs = item.attributes || {}
    const included = Array.isArray(payload.included) ? payload.included : []

    // ottengo i dati di entity ref delle taglie
    const termNameById = new Map(
        included
            .filter(r => typeof r?.type === "string" && r.type.startsWith("taxonomy_term--"))
            .map(t => [t.id, t.attributes?.name])
    )

    const tagRefs = item.relationships?.field_taglie?.data || []
    const taglie_ids = Array.isArray(tagRefs) ? tagRefs.map(r => r.id).filter(Boolean) : []
    const taglie = taglie_ids.map(id => termNameById.get(id)).filter(Boolean)

    // ottengo i dati di entity ref dell'img
    const includedByKey = new Map(
        included
            .filter(r => r?.id && r?.type)
            .map(r => [`${r.type}:${r.id}`, r])
    )

    const imgRel = item.relationships?.field_immagine?.data || null
    let immagine = null

    if (imgRel?.id && imgRel?.type?.startsWith("file--")) {
        const file = includedByKey.get(`${imgRel.type}:${imgRel.id}`) || null
        const relUrl = file?.attributes?.uri?.url || null

        // make absolute (Drupal usually returns a relative path)
        const url = relUrl ? new URL(relUrl, DRUPAL_JSONAPI_BASE).toString() : null

        immagine = {
            url,
            alt: imgRel?.meta?.alt ?? null,
            width: imgRel?.meta?.width ?? null,
            height: imgRel?.meta?.height ?? null
        }
    }

    return {
        id: item.id,
        type: item.type,
        title: attrs.title ?? null,
        categoria: attrs.field_categoria ?? null,
        materiale: attrs.field_materiale ?? null,
        prezzo: attrs.field_prezzo ?? null,
        valuta: attrs.field_valuta ?? null,
        taglie,
        taglie_ids,
        immagine
    }
}

function buildMcpServer() {

    const server = new Server(
        { name: "drupal-products-mcp", version: "1.0.0" },
        { capabilities: { tools: {} } }
    )

    // setto i tools che voglio
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: [
                {
                    name: "get_product_by_id",
                    description: "Get a product (node item) by UUID from Drupal JSON:API and return a flattened object",
                    inputSchema: {
                        type: "object",
                        properties: { id: { type: "string" } },
                        required: ["id"]
                    }
                }
            ]
        }
    })

    // definisco cosa succede quando uso uno specifico tool
    server.setRequestHandler(CallToolRequestSchema, async (req) => {

        const {
            name,
            arguments: args
        } = req.params

        try {

            if (name !== "get_product_by_id") throw new Error(`Unknown tool: ${name}`)

            // valido gli args tramite uno schema e, se valido, estraggo id dal risultato
            const { id } = z.object({ id: z.string().min(1) }).parse(args)
            console.log("[get_product_by_id] request", { id })

            // aggiungo filtri all'url per prendere tutti i campi di entity ref
            const url = new URL(`${DRUPAL_JSONAPI_BASE}/node/item/${id}`)
            url.searchParams.set("include", "field_taglie,field_immagine")

            const payload = await httpGetJson(url.toString())

            if (payload?._status === "not_found") {
                console.log("[get_product_by_id] not_found", { id })
                return {
                    content: [{ type: "text", text: JSON.stringify({ ok: false, error: "not_found", id }) }]
                }
            }

            const product = flattenItem(payload)
            console.log("[get_product_by_id] ok", { id, product })

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(product)
                    }
                ]
            }

        } catch (e) {
            console.error("[get_product_by_id] error", e)

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            ok: false,
                            error: "internal_error",
                            message: e?.message ?? String(e)
                        })
                    }
                ]
            }
        }
    })

    return server
}

// --- HTTP host (Render) ---
const app = express()

function requireApiKey(req, res, next) {

    if (req.path === "/" || req.path === "/health") return next()
    if (req.method === "OPTIONS") return res.sendStatus(204)

    const auth = req.headers.authorization || ""
    const [scheme, token] = auth.split(" ")

    const ok = scheme === "Bearer" && token && token === MCP_API_KEY
    if (!ok) return res.status(401).json({ error: "Unauthorized" })

    next()
}

app.use(requireApiKey)
app.use(express.json({ limit: "2mb" }))

app.get("/", (req, res) => {
    res.send("OK. Use GET /health")
})

// Healthcheck
app.get("/health", (req, res) => res.json({ ok: true }))

// MCP endpoint
app.post("/mcp", async (req, res) => {
    try {
        req.headers.accept = req.headers.accept || "application/json, text/event-stream"

        const server = buildMcpServer()
        const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true })

        await server.connect(transport)
        await transport.handleRequest(req, res, req.body)

    } catch (e) {
        console.error("MCP error:", e)
        res.status(500).json({ ok: false, error: String(e) })
    }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
    console.log(`MCP server listening on :${PORT} (POST /mcp)`)
})
