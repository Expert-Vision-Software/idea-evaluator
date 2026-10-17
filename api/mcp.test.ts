import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { evaluationStats, logMcpRequest, saveEvaluation } from './_analytics-db'
import { GET, OPTIONS, POST, PROTOCOL_VERSIONS } from './mcp'

vi.mock('./_analytics-db', () => ({
  saveEvaluation: vi.fn(),
  logMcpRequest: vi.fn(),
  evaluationStats: vi.fn(() => ({ count: 12, verdicts: { KILL: 7, FIX: 3, SHIP: 2 } })),
}))

beforeEach(() => {
  vi.stubEnv('TYPESAFE_MOCK', '1')
  vi.stubEnv('VERCEL', '')
})

afterEach(() => {
  vi.mocked(saveEvaluation).mockClear()
  vi.mocked(logMcpRequest).mockClear()
  vi.unstubAllEnvs()
})

const rpc = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers,
    }),
  )

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  return (await res.json()).result
}

describe('MCP lifecycle', () => {
  it('negotiates the protocol version and advertises tools', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } })
    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    const { result } = await res.json()
    expect(result.protocolVersion).toBe('2025-06-18')
    expect(result.capabilities).toHaveProperty('tools')
    expect(result.serverInfo.name).toBe('killmyidea')

    const unknown = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })).json()
    expect(unknown.result.protocolVersion).toBe(PROTOCOL_VERSIONS[0])
  })

  it('acknowledges notifications with 202 and no body', async () => {
    const res = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(res.status).toBe(202)
    expect(await res.text()).toBe('')
  })

  it('lists judge_idea and get_stats', async () => {
    const { result } = await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).json()
    expect(result.tools.map((t: { name: string }) => t.name)).toEqual(['judge_idea', 'get_stats'])
  })

  it('reports JSON-RPC errors', async () => {
    expect((await rpc('{nope')).status).toBe(400)
    expect((await (await rpc({ jsonrpc: '2.0', id: 4, method: 'nope' })).json()).error.code).toBe(-32601)
    expect((await (await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } })).json()).error.code).toBe(-32602)
  })

  it('answers batches', async () => {
    const res = await rpc([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
    ])
    expect(await res.json()).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }])
  })

  it('has no GET stream and answers CORS preflight', async () => {
    expect(GET().status).toBe(405)
    expect(OPTIONS().status).toBe(204)
  })
})

describe('judge_idea', () => {
  it('returns the verdict without debug data and archives with source mcp', async () => {
    const result = await call('judge_idea', { idea: 'A Slack bot that turns standups into a weekly changelog for clients.' })
    expect(result.isError).toBe(false)
    const out = result.structuredContent
    expect(out.dimensions).toHaveLength(8)
    expect(out.goal).toBe('money')
    expect(out).not.toHaveProperty('debug')
    if (!out.needs_detail) {
      expect(['KILL', 'FIX', 'SHIP']).toContain(out.verdict)
      expect(out.best_signal.note).toBeTruthy()
    }
    expect(result.content[0].type).toBe('text')
    expect(vi.mocked(saveEvaluation).mock.calls[0][0]).toMatchObject({ source: 'mcp' })
  })

  it('honours goal and do_not_archive', async () => {
    const result = await call('judge_idea', {
      idea: 'An open source CLI that lints Dockerfiles for security issues.',
      goal: 'open_source',
      do_not_archive: true,
    })
    expect(result.structuredContent.dimensions.map((d: { key: string }) => d.key)).toContain('adoption')
    expect(saveEvaluation).not.toHaveBeenCalled()
  })

  it('returns validation problems as tool errors', async () => {
    const result = await call('judge_idea', { idea: 'too short' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/at least/i)
  })
})

describe('usage tracking', () => {
  it('logs the client on initialize', async () => {
    await rpc(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code', version: '2.1.0' } } },
      { 'user-agent': 'claude-code/2.1.0' },
    )
    expect(vi.mocked(logMcpRequest).mock.calls[0][0]).toMatchObject({
      method: 'initialize',
      clientName: 'claude-code',
      clientVersion: '2.1.0',
      userAgent: 'claude-code/2.1.0',
      protocolVersion: '2025-06-18',
      ok: true,
    })
  })

  it('logs tool calls, tool errors and RPC errors without arguments', async () => {
    await rpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'judge_idea', arguments: { idea: 'A private idea for a startup.', do_not_archive: true } } },
      { 'mcp-protocol-version': '2025-11-25' },
    )
    await call('judge_idea', { idea: 'short' })
    await rpc({ jsonrpc: '2.0', id: 3, method: 'nope' })

    const [ok, toolError, rpcError] = vi.mocked(logMcpRequest).mock.calls.map((c) => c[0])
    expect(ok).toMatchObject({ method: 'tools/call', tool: 'judge_idea', protocolVersion: '2025-11-25', ok: true })
    expect(JSON.stringify(ok)).not.toContain('private idea')
    expect(toolError).toMatchObject({ tool: 'judge_idea', ok: false, error: expect.stringMatching(/at least/i) })
    expect(rpcError).toMatchObject({ method: 'nope', ok: false, error: '-32601' })
  })

  it('keeps answering when the log fails', async () => {
    vi.mocked(logMcpRequest).mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' })
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
  })
})

describe('get_stats', () => {
  it('returns the analyzed count and verdict split', async () => {
    const result = await call('get_stats')
    expect(result.structuredContent).toEqual({ analyzed: 12, verdicts: { KILL: 7, FIX: 3, SHIP: 2 } })
    expect(evaluationStats).toHaveBeenCalled()
  })
})
