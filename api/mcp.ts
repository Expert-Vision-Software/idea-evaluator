// POST /api/mcp — free, public MCP server (Streamable HTTP, stateless, no auth).
// Every request is one JSON-RPC message answered with plain JSON: no sessions, no SSE.
// Docs for humans and agents: /mcp/ and /mcp.md.
import { SITE_URL } from '../src/lib/features.js'
import { DECISION_COUNT, DIMENSION_HINTS, DIMENSION_LABELS, GOALS, GOAL_LABELS, type DimensionKey } from '../src/lib/questions.js'
import { dimensionCopy, LOW_CLARITY_COPY } from '../src/lib/copy.js'
import { IDEA_MAX, IDEA_MIN } from '../src/lib/evaluate.js'
import { WEIGHTS } from '../src/lib/scoring.js'
import { bestAndWorst } from '../src/lib/share.js'
import type { Evaluation } from '../src/lib/types.js'
import { VERDICT_THRESHOLDS, verdictLabel } from '../src/lib/verdict.js'
import { evaluationStats, logMcpRequest } from './_analytics-db.js'
import { judge } from './_judge.js'

/** Newest first. An unknown requested version gets the newest one. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

const SERVER_INFO = { name: 'killmyidea', title: 'Kill My Idea', version: '1.0.0', websiteUrl: `${SITE_URL}/mcp/` }

const INSTRUCTIONS = `Kill My Idea judges startup and side-project ideas with Jev (TypeSafe AI), a classifier, not a chatbot.
Call judge_idea with a concrete description: who it is for, what it does, how it makes money or spreads.
It returns KILL IT (<${VERDICT_THRESHOLDS.fix}), FIX IT (${VERDICT_THRESHOLDS.fix}-${VERDICT_THRESHOLDS.ship - 1}) or SHIP IT (${VERDICT_THRESHOLDS.ship}+), a 0-100 score and eight 0-100 sub-scores.
If needs_detail is true, ask the user for more detail instead of inventing a verdict.
Ideas are archived anonymously for product analytics unless do_not_archive is true: set it for confidential ideas.`

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, Mcp-Protocol-Version',
}

const TOOLS = [
  {
    name: 'judge_idea',
    title: 'Judge a startup idea',
    description: `Judge a startup or side-project idea. Returns a verdict (KILL IT, FIX IT or SHIP IT), a 0-100 score, the best signal, the biggest risk and eight 0-100 sub-scores. ${DECISION_COUNT} Jev decisions in about a second. Deterministic rubric, no generated prose.`,
    inputSchema: {
      type: 'object',
      properties: {
        idea: {
          type: 'string',
          minLength: IDEA_MIN,
          maxLength: IDEA_MAX,
          description: 'The idea in plain words: who it is for, what it does, how it makes money or spreads. More detail, better verdict.',
        },
        goal: {
          type: 'string',
          enum: [...GOALS],
          default: 'money',
          description: `What the idea is for. ${GOALS.map((g) => `"${g}" = ${GOAL_LABELS[g]}`).join(', ')}. open_source swaps Money for Adoption; fun swaps Real problem and Money for Immediate appeal and Fun.`,
        },
        do_not_archive: {
          type: 'boolean',
          default: false,
          description: 'Set true for confidential ideas: the idea text is then not stored. Otherwise it is archived anonymously (no IP, no identity).',
        },
      },
      required: ['idea'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        verdict: { type: ['string', 'null'], enum: ['KILL', 'FIX', 'SHIP', null] },
        verdict_label: { type: ['string', 'null'] },
        score: { type: ['integer', 'null'], minimum: 0, maximum: 100 },
        needs_detail: { type: 'boolean' },
        message: { type: 'string' },
        goal: { type: 'string', enum: [...GOALS] },
        category: { type: 'string' },
        best_signal: { type: ['object', 'null'] },
        biggest_risk: { type: ['object', 'null'] },
        dimensions: { type: 'array', items: { type: 'object' } },
        thresholds: { type: 'object' },
        scoring_version: { type: 'integer' },
        latency_ms: { type: 'integer' },
        judged_by: { type: 'string' },
        try_it: { type: 'string' },
      },
      required: ['verdict', 'score', 'needs_detail', 'goal', 'dimensions'],
    },
    annotations: { title: 'Judge a startup idea', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'get_stats',
    title: 'Kill My Idea stats',
    description: 'How many ideas Kill My Idea has analyzed so far and how many were killed, fixed or shipped. Cached for 5 minutes.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: {
        analyzed: { type: 'integer' },
        verdicts: {
          type: 'object',
          properties: { KILL: { type: 'integer' }, FIX: { type: 'integer' }, SHIP: { type: 'integer' } },
        },
      },
      required: ['analyzed', 'verdicts'],
    },
    annotations: { title: 'Kill My Idea stats', readOnlyHint: true, openWorldHint: false },
  },
]

/** Tool names safe to publish: tools/call can carry any string. */
export const TOOL_NAMES = TOOLS.map((t) => t.name)

type JsonRpcId = string | number | null
type JsonRpcMessage = { jsonrpc?: unknown; id?: JsonRpcId; method?: unknown; params?: Record<string, unknown> }

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

const label = (key: string) => DIMENSION_LABELS[key as DimensionKey] ?? key

/** The agent-facing view of an evaluation: no raw Jev response, no debug. */
export function toToolResult(evaluation: Evaluation) {
  const { best, worst } = bestAndWorst(evaluation)
  const signal = (kind: 'strength' | 'risk', d: typeof best) => ({
    dimension: d.key,
    label: d.label,
    score: d.value,
    note: dimensionCopy(kind, d.key),
  })
  const hidden = evaluation.needsDetail
  return {
    verdict: hidden ? null : evaluation.verdict,
    verdict_label: hidden ? null : verdictLabel(evaluation.verdict),
    score: hidden ? null : evaluation.score,
    needs_detail: hidden,
    message: hidden ? LOW_CLARITY_COPY.join(' ') : `${verdictLabel(evaluation.verdict)}. ${evaluation.score}/100.`,
    goal: evaluation.goal,
    category: evaluation.category,
    best_signal: hidden ? null : signal('strength', best),
    biggest_risk: hidden ? null : signal('risk', worst),
    dimensions: Object.entries(evaluation.dimensions).map(([key, score]) => ({
      key,
      label: label(key),
      question: DIMENSION_HINTS[key as DimensionKey] ?? '',
      score,
      weight: WEIGHTS[key as DimensionKey] ?? 1,
    })),
    thresholds: { kill: `<${VERDICT_THRESHOLDS.fix}`, fix: `${VERDICT_THRESHOLDS.fix}-${VERDICT_THRESHOLDS.ship - 1}`, ship: `${VERDICT_THRESHOLDS.ship}+` },
    scoring_version: evaluation.scoringVersion,
    latency_ms: evaluation.latencyMs,
    judged_by: 'Jev by TypeSafe AI (typesafe.ai)',
    try_it: SITE_URL,
  }
}

/** Short Markdown for clients that only read text content. */
function toText(result: ReturnType<typeof toToolResult>): string {
  const lines = result.needs_detail
    ? [`**${result.message}**`, '', 'Describe who it is for, what it does and how it makes money or spreads.']
    : [
        `**${result.verdict_label}** — ${result.score}/100 (goal: ${result.goal}, category: ${result.category})`,
        '',
        `Best signal: ${result.best_signal!.label} ${result.best_signal!.score} — ${result.best_signal!.note}`,
        `Biggest risk: ${result.biggest_risk!.label} ${result.biggest_risk!.score} — ${result.biggest_risk!.note}`,
      ]
  return [
    ...lines,
    '',
    ...result.dimensions.map((d) => `- ${d.label}: ${d.score}${d.weight > 1 ? ` (×${d.weight})` : ''}`),
    '',
    `Judged by Jev (TypeSafe AI) in ${result.latency_ms}ms. Try it: ${result.try_it}`,
  ].join('\n')
}

async function callTool(name: unknown, args: Record<string, unknown> = {}) {
  if (name === 'judge_idea') {
    const result = await judge({ idea: args.idea, goal: args.goal, doNotArchive: args.do_not_archive, source: 'mcp' })
    if (!result.ok) return { content: [{ type: 'text', text: result.error }], isError: true }
    const structured = toToolResult(result.evaluation)
    return { content: [{ type: 'text', text: toText(structured) }], structuredContent: structured, isError: false }
  }
  if (name === 'get_stats') {
    const { count, verdicts } = evaluationStats()
    const structured = { analyzed: count, verdicts }
    const text = `${count.toLocaleString('en-US')} ideas analyzed: ${verdicts.KILL} killed, ${verdicts.FIX} to fix, ${verdicts.SHIP} shipped.`
    return { content: [{ type: 'text', text }], structuredContent: structured, isError: false }
  }
  throw new RpcError(-32602, `Unknown tool: ${String(name)}`)
}

async function dispatch(message: JsonRpcMessage): Promise<unknown> {
  const params = message.params ?? {}
  switch (message.method) {
    case 'initialize': {
      const requested = params.protocolVersion
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested as string) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      }
    }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS }
    case 'tools/call':
      return callTool(params.name, (params.arguments as Record<string, unknown>) ?? {})
    case 'resources/list':
      return { resources: [] }
    case 'prompts/list':
      return { prompts: [] }
    default:
      throw new RpcError(-32601, `Method not found: ${String(message.method)}`)
  }
}

/** Request headers worth keeping for usage analytics. */
type RequestContext = { userAgent?: string; protocolVersion?: string }

type RpcResponse = { jsonrpc: '2.0'; id: JsonRpcId; result?: unknown; error?: { code: number; message: string } }

/** One JSON-RPC message → its response, or null for notifications and client responses. */
async function handle(message: JsonRpcMessage, context: RequestContext = {}): Promise<RpcResponse | null> {
  const started = performance.now()
  const response = await respond(message)
  track(message, response, context, performance.now() - started)
  return response
}

async function respond(message: JsonRpcMessage): Promise<RpcResponse | null> {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }
  }
  if (message.id === undefined || typeof message.method !== 'string') return null
  try {
    return { jsonrpc: '2.0', id: message.id, result: await dispatch(message) }
  } catch (err) {
    const code = err instanceof RpcError ? err.code : -32603
    if (!(err instanceof RpcError)) console.error('[mcp] failed:', err instanceof Error ? err.name : 'unknown')
    return { jsonrpc: '2.0', id: message.id, error: { code, message: err instanceof RpcError ? err.message : 'Internal error' } }
  }
}

const short = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : undefined)

/** One row per message in mcp_requests. Never stores arguments, so no idea text. */
function track(message: JsonRpcMessage, response: RpcResponse | null, context: RequestContext, latencyMs: number) {
  try {
    const method = typeof message?.method === 'string' ? message.method : 'invalid'
    const params = message?.params ?? {}
    const client = method === 'initialize' ? (params.clientInfo as Record<string, unknown> | undefined) : undefined
    const result = response?.result as { isError?: boolean; content?: { text?: string }[] } | undefined
    const error = response?.error ? String(response.error.code) : result?.isError ? short(result.content?.[0]?.text) : undefined
    logMcpRequest({
      createdAt: new Date().toISOString(),
      method: short(method, 100)!,
      tool: method === 'tools/call' ? short(params.name, 100) : undefined,
      clientName: short(client?.name, 100),
      clientVersion: short(client?.version, 50),
      userAgent: context.userAgent?.slice(0, 200),
      protocolVersion: short(method === 'initialize' ? params.protocolVersion : context.protocolVersion, 20),
      ok: !error,
      error,
      latencyMs,
    })
  } catch (err) {
    // Tracking must never break the server.
    console.error('[mcp] usage log failed:', err instanceof Error ? err.message : 'unknown')
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
  })

export async function POST(request: Request): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400)
  }

  const context: RequestContext = {
    userAgent: request.headers.get('user-agent') ?? undefined,
    protocolVersion: request.headers.get('mcp-protocol-version') ?? undefined,
  }

  // Batches were allowed in 2025-03-26; answering them costs nothing.
  if (Array.isArray(body)) {
    if (body.length === 0) return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }, 400)
    const responses = (await Promise.all(body.map((m) => handle(m, context)))).filter((r) => r !== null)
    return responses.length ? json(responses) : new Response(null, { status: 202, headers: CORS })
  }

  const response = await handle(body as JsonRpcMessage, context)
  return response === null ? new Response(null, { status: 202, headers: CORS }) : json(response)
}

/** No server-initiated stream: the spec says answer GET with 405. Browsers get a pointer to the docs. */
export function GET(): Response {
  return new Response(`Kill My Idea MCP server. POST JSON-RPC here. Setup: ${SITE_URL}/mcp/\n`, {
    status: 405,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'POST, OPTIONS', ...CORS },
  })
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Max-Age': '86400' } })
}
