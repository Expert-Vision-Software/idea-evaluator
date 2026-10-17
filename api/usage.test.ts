import { describe, expect, it, vi } from 'vitest'
import { publicUsage } from './_analytics-db'
import { buildUsage, clientLabel, USAGE_DAYS } from './usage'

vi.mock('./_analytics-db', () => ({ COUNT_TTL_MS: 300_000, publicUsage: vi.fn(), logMcpRequest: vi.fn(), evaluationStats: vi.fn() }))

describe('clientLabel', () => {
  it('maps known MCP clients and hides the rest', () => {
    expect(clientLabel('claude-code')).toBe('Claude Code')
    expect(clientLabel('claude-ai')).toBe('Claude')
    expect(clientLabel('cursor-vscode')).toBe('Cursor')
    expect(clientLabel('Visual Studio Code')).toBe('VS Code')
    expect(clientLabel('codex-mcp-client')).toBe('Codex')
    expect(clientLabel('openai-mcp')).toBe('ChatGPT')
    expect(clientLabel('buy cheap pills at example.com')).toBe('Other')
    expect(clientLabel('')).toBe('Other')
  })
})

describe('buildUsage', () => {
  it('fills empty days, publishes only known tools and groups clients', () => {
    vi.mocked(publicUsage).mockReturnValue({
      totals: { web: 10, mcp: 3, connections: 4, toolCalls: 5 },
      days: [{ day: '2026-10-17', web: 2, mcp: 1, toolCalls: 2 }],
      tools: [
        { tool: 'judge_idea', calls: 4 },
        { tool: '<script>alert(1)</script>', calls: 9 },
      ],
      clients: [
        { client: 'claude-code', connections: 2 },
        { client: 'spam client', connections: 1 },
        { client: 'another spam', connections: 1 },
      ],
      verdicts: [
        { source: 'web', verdict: 'KILL', n: 7 },
        { source: 'mcp', verdict: 'SHIP', n: 2 },
      ],
    })

    const usage = buildUsage(new Date('2026-10-17T15:00:00Z'))
    expect(vi.mocked(publicUsage).mock.calls[0][0]).toBe('2026-09-18T00:00:00.000Z')
    expect(usage.days).toHaveLength(USAGE_DAYS)
    expect(usage.days[0]).toEqual({ day: '2026-09-18', web: 0, mcp: 0, toolCalls: 0 })
    expect(usage.days.at(-1)).toEqual({ day: '2026-10-17', web: 2, mcp: 1, toolCalls: 2 })
    expect(usage.tools).toEqual([
      { tool: 'judge_idea', calls: 4 },
      { tool: 'get_stats', calls: 0 },
    ])
    expect(usage.clients).toEqual([
      { client: 'Claude Code', connections: 2 },
      { client: 'Other', connections: 2 },
    ])
    expect(usage.verdicts).toEqual({ web: { KILL: 7, FIX: 0, SHIP: 0 }, mcp: { KILL: 0, FIX: 0, SHIP: 2 } })
  })
})
