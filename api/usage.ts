// GET /api/usage — public usage numbers for /stats/: ideas analyzed (web vs MCP) and MCP activity.
// Client and tool names come from callers, so only known ones are published; the rest is "Other".
import { COUNT_TTL_MS, publicUsage } from './_analytics-db.js'
import type { PublicUsage } from '../src/lib/usage.js'
import { TOOL_NAMES } from './mcp.js'

export const USAGE_DAYS = 30

/** clientInfo.name → public label. First match wins; unknown names become "Other". */
const CLIENTS: [RegExp, string][] = [
  [/claude[-\s]?code/i, 'Claude Code'],
  [/claude|anthropic/i, 'Claude'],
  [/cursor/i, 'Cursor'],
  [/visual studio code|vscode|copilot/i, 'VS Code'],
  [/codex/i, 'Codex'],
  [/openai|chatgpt/i, 'ChatGPT'],
  [/windsurf|codeium/i, 'Windsurf'],
  [/gemini/i, 'Gemini CLI'],
  [/inspector/i, 'MCP Inspector'],
  [/mcp-remote/i, 'mcp-remote'],
]

export const clientLabel = (name: string) => CLIENTS.find(([pattern]) => pattern.test(name))?.[1] ?? 'Other'

type Verdicts = PublicUsage['verdicts']['web']

/** UTC day keys, oldest first, ending today. */
function lastDays(n: number, now = new Date()): string[] {
  return Array.from({ length: n }, (_, i) => new Date(now.getTime() - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10))
}

export function buildUsage(now = new Date()): PublicUsage {
  const keys = lastDays(USAGE_DAYS, now)
  const rows = publicUsage(`${keys[0]}T00:00:00.000Z`)

  const byDay = new Map(rows.days.map((d) => [d.day, d]))
  const clients = new Map<string, number>()
  for (const { client, connections } of rows.clients) {
    const label = clientLabel(client)
    clients.set(label, (clients.get(label) ?? 0) + connections)
  }
  const verdicts = { web: { KILL: 0, FIX: 0, SHIP: 0 }, mcp: { KILL: 0, FIX: 0, SHIP: 0 } }
  for (const { source, verdict, n } of rows.verdicts) {
    const bucket = verdicts[source as keyof typeof verdicts]
    if (bucket && verdict in bucket) bucket[verdict as keyof Verdicts] += n
  }

  return {
    totals: rows.totals,
    days: keys.map((day) => {
      const d = byDay.get(day)
      return { day, web: d?.web ?? 0, mcp: d?.mcp ?? 0, toolCalls: d?.toolCalls ?? 0 }
    }),
    tools: TOOL_NAMES.map((tool) => ({ tool, calls: rows.tools.find((t) => t.tool === tool)?.calls ?? 0 })),
    clients: [...clients].map(([client, connections]) => ({ client, connections })).sort((a, b) => b.connections - a.connections),
    verdicts,
  }
}

let cached: { value: PublicUsage; at: number } | undefined

export async function GET(): Promise<Response> {
  try {
    if (!cached || Date.now() - cached.at >= COUNT_TTL_MS) cached = { value: buildUsage(), at: Date.now() }
    return new Response(JSON.stringify(cached.value), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
    })
  } catch (err) {
    console.error('[usage] failed:', err instanceof Error ? err.name : 'unknown')
    return new Response(JSON.stringify({ error: 'Usage unavailable.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    })
  }
}
