import type { Verdict } from './verdict.js'

/** GET /api/usage: public numbers for /stats/. */
export type PublicUsage = {
  totals: { web: number; mcp: number; connections: number; toolCalls: number }
  /** Exactly USAGE_DAYS entries, oldest first, including empty days. */
  days: { day: string; web: number; mcp: number; toolCalls: number }[]
  tools: { tool: string; calls: number }[]
  clients: { client: string; connections: number }[]
  verdicts: { web: Record<Verdict, number>; mcp: Record<Verdict, number> }
}
