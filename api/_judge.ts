// Shared by POST /api/evaluate and the MCP server: validate → Jev → score → archive.
import { randomUUID } from 'node:crypto'
import { buildState, composeEvaluation, validateGoal, validateIdea } from '../src/lib/evaluate.js'
import { questionsFor } from '../src/lib/questions.js'
import { TypeSafeError, askJev } from '../src/lib/typesafe.js'
import type { Evaluation } from '../src/lib/types.js'
import { saveEvaluation, type EvaluationSource } from './_analytics-db.js'
import { mockJev } from './_mock.js'

export type JudgeResult = { ok: true; evaluation: Evaluation } | { ok: false; status: number; error: string }

export async function judge(input: {
  idea: unknown
  goal: unknown
  doNotArchive?: unknown
  source: EvaluationSource
}): Promise<JudgeResult> {
  const valid = validateIdea(input.idea)
  if (!valid.ok) return { ok: false, status: 400, error: valid.error }
  const goal = validateGoal(input.goal)
  if (!goal.ok) return { ok: false, status: 400, error: goal.error }

  const useMock = process.env.TYPESAFE_MOCK === '1' && !process.env.VERCEL
  const apiKey = process.env.TYPESAFE_API_KEY
  if (!apiKey && !useMock) return { ok: false, status: 500, error: 'TYPESAFE_API_KEY is not configured.' }

  try {
    const { response, latencyMs } = useMock
      ? await mockJev(valid.idea, goal.goal)
      : await askJev({ apiKey: apiKey!, state: buildState(valid.idea), questions: questionsFor(goal.goal) })

    const evaluation = composeEvaluation(response, latencyMs, useMock, goal.goal)

    if (input.doNotArchive !== true) {
      try {
        saveEvaluation({
          requestId: randomUUID(),
          createdAt: new Date().toISOString(),
          idea: valid.idea,
          source: input.source,
          evaluation,
        })
      } catch (err) {
        // Archiving must not make a successful evaluation fail.
        console.error('[judge] analytics archive failed:', err instanceof Error ? err.message : 'unknown')
      }
    }

    return { ok: true, evaluation }
  } catch (err) {
    if (err instanceof TypeSafeError) {
      console.error('[judge] TypeSafe error', err.status)
      const busy = err.status === 429 || err.status === 529
      return busy
        ? { ok: false, status: 503, error: 'Jev is busy. Try again in a moment.' }
        : { ok: false, status: 502, error: 'Jev could not judge this one.' }
    }
    console.error('[judge] failed:', err instanceof Error ? err.name : 'unknown')
    return { ok: false, status: 502, error: 'Jev could not judge this one.' }
  }
}
