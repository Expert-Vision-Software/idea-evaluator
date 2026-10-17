// /stats/: public usage numbers, from GET /api/usage.
import '@fontsource-variable/inter-tight'
import '@fontsource-variable/jetbrains-mono'
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Footer } from './components/Footer'
import { Header } from './components/Header'
import { StatsModal } from './components/StatsModal'
import { fetchStats, type Stats } from './lib/stats'
import { ideaStore } from './lib/storage'
import type { PublicUsage } from './lib/usage'
import { verdictBg } from './lib/ui'
import type { Verdict } from './lib/verdict'
import './index.css'

/** Validated categorical pair on the paper surface (dataviz validator: CVD ΔE 24.7). */
const SERIES = { web: { label: 'Website', color: '#2a78d6' }, mcp: { label: 'MCP', color: '#eb6834' } } as const

const n = (v: number) => v.toLocaleString('en-US')
const shortDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

function StatsPage() {
  const [usage, setUsage] = useState<PublicUsage | null>(null)
  const [failed, setFailed] = useState(false)
  const [stats, setStats] = useState<Stats | null>(null)
  const [statsOpen, setStatsOpen] = useState(false)
  const [historyCount, setHistoryCount] = useState(0)

  useEffect(() => {
    fetch('/api/usage')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error())))
      .then(setUsage)
      .catch(() => setFailed(true))
    void fetchStats().then(setStats)
    void ideaStore.list().then((items) => setHistoryCount(items.length))
  }, [])

  return (
    <div className="flex min-h-dvh flex-col">
      <Header
        showLogo
        historyCount={historyCount}
        killedCount={stats?.count ?? null}
        onHome={() => window.location.assign('/')}
        onHistory={() => window.location.assign('/?open=history')}
        onStats={() => setStatsOpen(true)}
      />
      <main className="mx-auto w-full max-w-4xl flex-1 px-5 pb-16 pt-10 sm:px-8 sm:pt-14">
        <p className="font-mono text-[11px] uppercase tracking-widest opacity-60">Open numbers · updated every 5 minutes</p>
        <h1 className="mt-3 text-[clamp(3rem,11vw,6.5rem)] font-black uppercase leading-[0.85] tracking-[-0.05em]">
          In numbers
        </h1>
        {failed && <p className="mt-8 border-2 border-kill px-4 py-3 font-mono text-sm">Numbers unavailable right now.</p>}
        {!usage && !failed && <p className="mt-8 font-mono text-sm opacity-60">Loading…</p>}
        {usage && <Report usage={usage} />}
      </main>
      <Footer />
      <StatsModal open={statsOpen} stats={stats} onClose={() => setStatsOpen(false)} />
    </div>
  )
}

function Report({ usage }: { usage: PublicUsage }) {
  const { totals } = usage
  return (
    <>
      <section className="mt-10 grid grid-cols-2 gap-0.5 border-2 border-ink bg-ink sm:grid-cols-4" aria-label="Totals, all time">
        <Tile label="Ideas analyzed" value={totals.web + totals.mcp} />
        <Tile label="Via MCP" value={totals.mcp} swatch={SERIES.mcp.color} />
        <Tile label="MCP connections" value={totals.connections} />
        <Tile label="MCP tool calls" value={totals.toolCalls} />
      </section>
      <p className="mt-2 font-mono text-[11px] uppercase tracking-widest opacity-60">All time. Ideas analyzed: archived evaluations.</p>

      <Section title={`Ideas analyzed per day · last ${usage.days.length} days`}>
        <DailyChart days={usage.days} />
      </Section>

      <div className="grid gap-x-12 md:grid-cols-2">
        <Section title="MCP tools · all time">
          <Table head={['Tool', 'Calls']} rows={usage.tools.map((t) => [<code className="font-mono">{t.tool}</code>, n(t.calls)])} />
        </Section>
        <Section title="MCP clients · all time">
          {usage.clients.length ? (
            <Table head={['Client', 'Connections']} rows={usage.clients.map((c) => [c.client, n(c.connections)])} />
          ) : (
            <p className="font-mono text-sm opacity-60">No connections yet.</p>
          )}
        </Section>
      </div>

      <Section title="Verdicts · all time">
        <div className="grid gap-8 md:grid-cols-2">
          <VerdictBar label="Website" verdicts={usage.verdicts.web} />
          <VerdictBar label="MCP" verdicts={usage.verdicts.mcp} />
        </div>
      </Section>

      <p className="mt-14 border-t-2 border-ink pt-6 leading-snug">
        Want your agent in these numbers? <a href="/mcp/" className="font-bold underline">Add the free MCP server</a>. Raw data:{' '}
        <a href="/api/usage" className="font-mono underline">/api/usage</a>.
      </p>
    </>
  )
}

function Tile({ label, value, swatch }: { label: string; value: number; swatch?: string }) {
  return (
    <div className="bg-paper p-4">
      <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest opacity-60">
        {swatch && <span aria-hidden className="inline-block size-2.5" style={{ background: swatch }} />}
        {label}
      </p>
      <p className="mt-1 text-4xl font-black tabular-nums tracking-tight sm:text-5xl">{n(value)}</p>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-14 border-t-2 border-ink pt-6">
      <h2 className="mb-5 font-mono text-[11px] uppercase tracking-widest opacity-60">{title}</h2>
      {children}
    </section>
  )
}

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <table className="w-full text-left text-sm">
      <thead className="font-mono text-[11px] uppercase tracking-widest opacity-60">
        <tr>
          {head.map((h, i) => (
            <th key={h} className={`pb-2 font-normal ${i ? 'text-right' : ''}`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, r) => (
          <tr key={r} className="border-t border-ink/20">
            {row.map((cell, i) => (
              <td key={i} className={`py-2 ${i ? 'text-right font-mono tabular-nums' : ''}`}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Stacked bars: website below, MCP on top, 2px surface gap between segments. */
function DailyChart({ days }: { days: PublicUsage['days'] }) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(1, ...days.map((d) => d.web + d.mcp))
  const H = 180
  const active = hover === null ? null : days[hover]

  return (
    <figure>
      <div className="mb-3 flex flex-wrap gap-4 font-mono text-[11px] uppercase tracking-widest">
        {Object.values(SERIES).map((s) => (
          <span key={s.label} className="flex items-center gap-2">
            <span aria-hidden className="inline-block size-3" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>

      <div className="relative">
        <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed border-ink/25" />
        <span className="pointer-events-none absolute right-0 -top-5 font-mono text-[11px] tabular-nums opacity-60">{n(max)}</span>
        <div className="flex items-end border-b-2 border-ink" style={{ height: H }} onMouseLeave={() => setHover(null)}>
          {days.map((d, i) => {
            const web = (d.web / max) * H
            const mcp = (d.mcp / max) * H
            return (
              <button
                key={d.day}
                type="button"
                aria-label={`${shortDay(d.day)}: ${d.web} website, ${d.mcp} MCP`}
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                className={`flex h-full flex-1 cursor-default flex-col-reverse items-stretch px-px outline-none sm:px-0.5 ${hover === i ? 'bg-ink/5' : ''}`}
              >
                {d.web > 0 && <span className="block" style={{ height: web, background: SERIES.web.color, borderRadius: d.mcp ? 0 : '4px 4px 0 0' }} />}
                {d.mcp > 0 && (
                  <span className="block" style={{ height: mcp, background: SERIES.mcp.color, borderRadius: '4px 4px 0 0', marginBottom: d.web ? 2 : 0 }} />
                )}
              </button>
            )
          })}
        </div>
        {active && hover !== null && (
          <div
            role="status"
            className="pointer-events-none absolute -top-2 z-10 whitespace-nowrap border-2 border-ink bg-paper px-3 py-2 font-mono text-xs"
            style={{ left: `${((hover + 0.5) / days.length) * 100}%`, transform: `translate(${hover > days.length / 2 ? '-100%' : '0'}, -100%)` }}
          >
            <p className="font-bold">{shortDay(active.day)}</p>
            <p className="tabular-nums">
              Website {n(active.web)} · MCP {n(active.mcp)}
            </p>
            <p className="tabular-nums opacity-60">{n(active.toolCalls)} MCP tool calls</p>
          </div>
        )}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[11px] opacity-60">
        <span>{shortDay(days[0].day)}</span>
        <span>{shortDay(days[days.length - 1].day)}</span>
      </div>

      <details className="mt-4">
        <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-widest underline">Show as table</summary>
        <div className="mt-3">
          <Table
            head={['Day', 'Website', 'MCP', 'MCP tool calls']}
            rows={[...days].reverse().map((d) => [shortDay(d.day), n(d.web), n(d.mcp), n(d.toolCalls)])}
          />
        </div>
      </details>
    </figure>
  )
}

const ORDER: Verdict[] = ['SHIP', 'FIX', 'KILL']

function VerdictBar({ label, verdicts }: { label: string; verdicts: Record<Verdict, number> }) {
  const total = ORDER.reduce((sum, v) => sum + verdicts[v], 0)
  return (
    <div>
      <p className="flex justify-between font-mono text-xs uppercase tracking-widest">
        <span className="font-bold">{label}</span>
        <span className="tabular-nums opacity-60">{n(total)} judged</span>
      </p>
      {total === 0 ? (
        <p className="mt-2 font-mono text-sm opacity-60">Nothing judged yet.</p>
      ) : (
        <>
          <div aria-hidden className="mt-2 flex h-4 gap-0.5">
            {ORDER.filter((v) => verdicts[v]).map((v) => (
              <div key={v} className={verdictBg[v]} style={{ width: `${(verdicts[v] / total) * 100}%` }} />
            ))}
          </div>
          <ul className="mt-2 space-y-1 font-mono text-xs uppercase tracking-widest">
            {ORDER.map((v) => (
              <li key={v} className="flex justify-between">
                <span className="flex items-center gap-2">
                  <span aria-hidden className={`inline-block size-3 border border-ink ${verdictBg[v]}`} />
                  {v} IT
                </span>
                <span className="tabular-nums">
                  {Math.round((verdicts[v] / total) * 100)}% · {n(verdicts[v])}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StatsPage />
  </StrictMode>,
)
