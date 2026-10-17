// POST /api/evaluate — the website's endpoint. Holds TYPESAFE_API_KEY (via _judge.ts).
import { judge } from './_judge.js'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

export async function POST(request: Request): Promise<Response> {
  let payload: { idea?: unknown; goal?: unknown; doNotArchive?: unknown }
  try {
    payload = await request.json()
  } catch {
    return json({ error: 'Invalid JSON.' }, 400)
  }

  const result = await judge({ idea: payload?.idea, goal: payload?.goal, doNotArchive: payload?.doNotArchive, source: 'web' })
  return result.ok ? json(result.evaluation) : json({ error: result.error }, result.status)
}
