// MCP server usage from the analytics archive: `npm run mcp:usage` (optionally `-- 30` for the last 30 days).
// Reads ANALYTICS_DB_PATH, like the server.
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const days = Number(process.argv[2] || 7)
const path = process.env.ANALYTICS_DB_PATH || resolve('data', 'analytics.sqlite')
const db = new DatabaseSync(path, { readOnly: true })
if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'mcp_requests'").get()) {
  console.log(`No MCP requests yet in ${path}.`)
  process.exit(0)
}
const since = new Date(Date.now() - days * 86_400_000).toISOString()
const all = (sql) => db.prepare(sql).all(since)

console.log(`MCP usage, last ${days} days (${path})\n`)

console.log('Per day')
console.table(
  all(`SELECT substr(created_at, 1, 10) AS day,
              SUM(method = 'initialize') AS connections,
              SUM(method = 'tools/call') AS tool_calls,
              SUM(method = 'tools/call' AND NOT ok) AS failed_calls
       FROM mcp_requests WHERE created_at >= ? GROUP BY day ORDER BY day`),
)

console.log('Tools')
console.table(
  all(`SELECT tool, COUNT(*) AS calls, SUM(NOT ok) AS failed, ROUND(AVG(latency_ms)) AS avg_ms
       FROM mcp_requests WHERE created_at >= ? AND method = 'tools/call' GROUP BY tool ORDER BY calls DESC`),
)

console.log('Clients (from initialize)')
console.table(
  all(`SELECT COALESCE(client_name, '?') AS client, COUNT(*) AS connections, MAX(client_version) AS latest_version
       FROM mcp_requests WHERE created_at >= ? AND method = 'initialize' GROUP BY client ORDER BY connections DESC`),
)

console.log('Errors')
console.table(
  all(`SELECT method, tool, error, COUNT(*) AS n
       FROM mcp_requests WHERE created_at >= ? AND NOT ok GROUP BY method, tool, error ORDER BY n DESC LIMIT 10`),
)

console.log('MCP verdicts (archived judge_idea calls only)')
console.table(
  all(`SELECT verdict, COUNT(*) AS n FROM evaluations WHERE created_at >= ? AND source = 'mcp' GROUP BY verdict`),
)

db.close()
