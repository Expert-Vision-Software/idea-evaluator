import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Evaluation } from '../src/lib/types.js'

const DEFAULT_DB_PATH = resolve(process.cwd(), 'data', 'analytics.sqlite')

const table = (name: string) => `
  CREATE TABLE IF NOT EXISTS ${name} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    idea TEXT NOT NULL,
    idea_length INTEGER NOT NULL,
    score INTEGER NOT NULL,
    verdict TEXT NOT NULL,
    category TEXT NOT NULL,
    understandable REAL NOT NULL,
    decisions INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL,
    model TEXT NOT NULL,
    mock INTEGER NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    scoring_version INTEGER NOT NULL DEFAULT 1,
    needs_detail INTEGER NOT NULL DEFAULT 0,
    goal TEXT NOT NULL DEFAULT 'money',
    source TEXT NOT NULL DEFAULT 'web',
    problem INTEGER,
    appeal INTEGER,
    customer INTEGER NOT NULL,
    demand INTEGER NOT NULL,
    money INTEGER,
    adoption INTEGER,
    fun INTEGER,
    reach INTEGER NOT NULL,
    different INTEGER NOT NULL,
    buildable INTEGER NOT NULL,
    shareable INTEGER NOT NULL,
    debug_json TEXT NOT NULL
  ) STRICT;
`

/** One row per MCP JSON-RPC message: usage analytics for the MCP server. No IP, no idea text. */
const MCP_REQUESTS = `
  CREATE TABLE IF NOT EXISTS mcp_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    method TEXT NOT NULL,
    tool TEXT,
    client_name TEXT,
    client_version TEXT,
    user_agent TEXT,
    protocol_version TEXT,
    ok INTEGER NOT NULL,
    error TEXT,
    latency_ms INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS mcp_requests_created_at_idx ON mcp_requests(created_at);
  CREATE INDEX IF NOT EXISTS mcp_requests_method_tool_idx ON mcp_requests(method, tool);
`

const indexes = `
  CREATE INDEX IF NOT EXISTS evaluations_created_at_idx ON evaluations(created_at);
  CREATE INDEX IF NOT EXISTS evaluations_verdict_idx ON evaluations(verdict);
  CREATE INDEX IF NOT EXISTS evaluations_category_idx ON evaluations(category);
  CREATE INDEX IF NOT EXISTS evaluations_goal_idx ON evaluations(goal);
  CREATE INDEX IF NOT EXISTS evaluations_scoring_version_idx ON evaluations(scoring_version);
  CREATE INDEX IF NOT EXISTS evaluations_source_idx ON evaluations(source);
`

/** Columns shared by the pre-goal table and the current one. */
const LEGACY_COLUMNS = `request_id, created_at, idea, idea_length, score, verdict, category,
  understandable, decisions, latency_ms, model, mock, input_tokens, output_tokens,
  problem, customer, demand, money, reach, different, buildable, shareable, debug_json`

const GOAL_V1_COLUMNS = `request_id, created_at, idea, idea_length, score, verdict, category,
  understandable, decisions, latency_ms, model, mock, input_tokens, output_tokens, goal,
  problem, customer, demand, money, adoption, fun, reach, different, buildable, shareable, debug_json`

/** Tables created before goals had `money NOT NULL` and no goal columns: rebuild them once. */
function migrateLegacyGoalTable(db: DatabaseSync) {
  const columns = db.prepare(`PRAGMA table_info(evaluations)`).all() as { name: string }[]
  if (columns.length === 0 || columns.some((c) => c.name === 'goal')) return
  db.exec('BEGIN')
  try {
    db.exec(table('evaluations_next'))
    db.exec(`INSERT INTO evaluations_next (${LEGACY_COLUMNS}) SELECT ${LEGACY_COLUMNS} FROM evaluations`)
    db.exec('DROP TABLE evaluations')
    db.exec('ALTER TABLE evaluations_next RENAME TO evaluations')
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/** Scoring v2 lets Fun replace Problem with Appeal, so Problem must become nullable. */
function migrateFunAppealTable(db: DatabaseSync) {
  const columns = db.prepare(`PRAGMA table_info(evaluations)`).all() as { name: string; notnull: number }[]
  const problem = columns.find((column) => column.name === 'problem')
  if (!problem?.notnull || !columns.some((column) => column.name === 'goal')) return
  db.exec('BEGIN')
  try {
    db.exec(table('evaluations_next'))
    db.exec(`INSERT INTO evaluations_next (${GOAL_V1_COLUMNS}) SELECT ${GOAL_V1_COLUMNS} FROM evaluations`)
    db.exec('DROP TABLE evaluations')
    db.exec('ALTER TABLE evaluations_next RENAME TO evaluations')
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/** Additive migrations for later scoring revisions. Existing rows belong to scoring v1. */
function migrateScoringColumns(db: DatabaseSync) {
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(evaluations)`).all() as { name: string }[]).map((column) => column.name),
  )
  if (!columns.has('scoring_version')) {
    db.exec('ALTER TABLE evaluations ADD COLUMN scoring_version INTEGER NOT NULL DEFAULT 1')
  }
  if (!columns.has('needs_detail')) {
    db.exec('ALTER TABLE evaluations ADD COLUMN needs_detail INTEGER NOT NULL DEFAULT 0')
  }
  if (!columns.has('appeal')) db.exec('ALTER TABLE evaluations ADD COLUMN appeal INTEGER')
  // Rows from before the MCP server all came from the website.
  if (!columns.has('source')) db.exec("ALTER TABLE evaluations ADD COLUMN source TEXT NOT NULL DEFAULT 'web'")
  db.exec('UPDATE evaluations SET needs_detail = understandable < 0.3 WHERE scoring_version = 1')
}

/** Where an evaluation was requested: the website form or the MCP server. */
export type EvaluationSource = 'web' | 'mcp'

export type ArchivedEvaluation = {
  requestId: string
  createdAt: string
  idea: string
  /** Defaults to 'web'. */
  source?: EvaluationSource
  evaluation: Evaluation
}

export type McpRequestLog = {
  createdAt: string
  method: string
  /** Only for tools/call. */
  tool?: string
  /** clientInfo, only sent with initialize. */
  clientName?: string
  clientVersion?: string
  userAgent?: string
  protocolVersion?: string
  ok: boolean
  /** JSON-RPC error code or the tool's error message. */
  error?: string
  latencyMs: number
}

export class EvaluationArchive {
  readonly path: string
  private readonly db: DatabaseSync

  constructor(path = process.env.ANALYTICS_DB_PATH || DEFAULT_DB_PATH) {
    this.path = path
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
    migrateLegacyGoalTable(this.db)
    migrateFunAppealTable(this.db)
    this.db.exec(table('evaluations'))
    migrateScoringColumns(this.db)
    this.db.exec(indexes)
    this.db.exec(MCP_REQUESTS)
  }

  save({ requestId, createdAt, idea, source = 'web', evaluation }: ArchivedEvaluation) {
    const d = evaluation.dimensions
    this.db
      .prepare(`
        INSERT INTO evaluations (
          request_id, created_at, idea, idea_length, score, verdict, category,
          understandable, decisions, latency_ms, model, mock, input_tokens, output_tokens,
          scoring_version, needs_detail, goal, source, problem, appeal, customer, demand, money, adoption, fun,
          reach, different, buildable, shareable, debug_json
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `)
      .run(
        requestId,
        createdAt,
        idea,
        idea.length,
        evaluation.score,
        evaluation.verdict,
        evaluation.category,
        evaluation.understandable,
        evaluation.decisions,
        evaluation.latencyMs,
        evaluation.debug.model,
        evaluation.debug.mock ? 1 : 0,
        evaluation.debug.usage?.input_tokens ?? null,
        evaluation.debug.usage?.output_tokens ?? null,
        evaluation.scoringVersion,
        evaluation.needsDetail ? 1 : 0,
        evaluation.goal ?? 'money',
        source,
        d.problem ?? null,
        d.appeal ?? null,
        d.customer,
        d.demand,
        d.money ?? null,
        d.adoption ?? null,
        d.fun ?? null,
        d.reach,
        d.different,
        d.buildable,
        d.shareable,
        JSON.stringify(evaluation.debug),
      )
  }

  logMcpRequest(r: McpRequestLog) {
    this.db
      .prepare(`
        INSERT INTO mcp_requests (
          created_at, method, tool, client_name, client_version, user_agent, protocol_version, ok, error, latency_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        r.createdAt,
        r.method,
        r.tool ?? null,
        r.clientName ?? null,
        r.clientVersion ?? null,
        r.userAgent ?? null,
        r.protocolVersion ?? null,
        r.ok ? 1 : 0,
        r.error ?? null,
        Math.round(r.latencyMs),
      )
  }

  /** Total archived evaluations. Cheap on SQLite, still cached by the caller. */
  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM evaluations').get() as { n: number }
    return row.n
  }

  /** Verdict totals across all archived evaluations. */
  verdictCounts(): { KILL: number; FIX: number; SHIP: number } {
    const rows = this.db.prepare('SELECT verdict, COUNT(*) AS n FROM evaluations GROUP BY verdict').all() as {
      verdict: string
      n: number
    }[]
    const verdicts = { KILL: 0, FIX: 0, SHIP: 0 }
    for (const row of rows) if (row.verdict in verdicts) verdicts[row.verdict as keyof typeof verdicts] = row.n
    return verdicts
  }

  /** Aggregates for the public /stats/ page. Daily rows start at `since` (ISO); everything else is all-time. */
  publicUsage(since: string): PublicUsageRows {
    const all = <T>(sql: string, params: Record<string, string> = {}) => this.db.prepare(sql).all(params) as T[]
    const one = <T>(sql: string) => this.db.prepare(sql).get() as T
    return {
      totals: {
        ...one<{ web: number; mcp: number }>(`
          SELECT COALESCE(SUM(source = 'web'), 0) AS web, COALESCE(SUM(source = 'mcp'), 0) AS mcp FROM evaluations`),
        ...one<{ connections: number; toolCalls: number }>(`
          SELECT COALESCE(SUM(method = 'initialize'), 0) AS connections, COALESCE(SUM(method = 'tools/call' AND ok), 0) AS toolCalls
          FROM mcp_requests`),
      },
      days: all(
        `SELECT day, SUM(web) AS web, SUM(mcp) AS mcp, SUM(tool_calls) AS toolCalls
         FROM (
           SELECT substr(created_at, 1, 10) AS day, source = 'web' AS web, source = 'mcp' AS mcp, 0 AS tool_calls
           FROM evaluations WHERE created_at >= :since
           UNION ALL
           SELECT substr(created_at, 1, 10), 0, 0, method = 'tools/call' AND ok
           FROM mcp_requests WHERE created_at >= :since
         ) GROUP BY day ORDER BY day`,
        { since },
      ),
      tools: all(`
        SELECT tool, COUNT(*) AS calls FROM mcp_requests
        WHERE method = 'tools/call' AND ok GROUP BY tool ORDER BY calls DESC`),
      clients: all(`
        SELECT COALESCE(client_name, '') AS client, COUNT(*) AS connections FROM mcp_requests
        WHERE method = 'initialize' GROUP BY client`),
      verdicts: all(`
        SELECT source, verdict, COUNT(*) AS n FROM evaluations WHERE NOT needs_detail GROUP BY source, verdict`),
    }
  }

  close() {
    this.db.close()
  }
}

export type PublicUsageRows = {
  totals: { web: number; mcp: number; connections: number; toolCalls: number }
  days: { day: string; web: number; mcp: number; toolCalls: number }[]
  /** Raw tool and client names: callers must filter them before publishing. */
  tools: { tool: string | null; calls: number }[]
  clients: { client: string; connections: number }[]
  verdicts: { source: string; verdict: string; n: number }[]
}

let archive: EvaluationArchive | undefined

/** How long the in-memory idea count stays fresh. */
export const COUNT_TTL_MS = 5 * 60 * 1000

export type EvaluationStats = { count: number; verdicts: { KILL: number; FIX: number; SHIP: number } }

let cachedStats: { value: EvaluationStats; at: number } | undefined

/** Lazily opens one connection per server process. */
export function saveEvaluation(record: ArchivedEvaluation) {
  archive ??= new EvaluationArchive()
  archive.save(record)
}

export function logMcpRequest(record: McpRequestLog) {
  archive ??= new EvaluationArchive()
  archive.logMcpRequest(record)
}

/** Idea count and verdict totals with a 5-minute in-memory cache: at most one query per process per interval. */
export function evaluationStats(): EvaluationStats {
  if (cachedStats && Date.now() - cachedStats.at < COUNT_TTL_MS) return cachedStats.value
  archive ??= new EvaluationArchive()
  cachedStats = { value: { count: archive.count(), verdicts: archive.verdictCounts() }, at: Date.now() }
  return cachedStats.value
}

/** Uncached; api/usage.ts caches the published result. */
export function publicUsage(since: string): PublicUsageRows {
  archive ??= new EvaluationArchive()
  return archive.publicUsage(since)
}
