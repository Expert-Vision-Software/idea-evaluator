import { useEffect, useState } from 'react'
import { REPO_URL } from '../lib/features'
import { GitHubIcon } from './GitHubIcon'
import { Logo } from './Logo'

export function Header({
  showLogo,
  historyCount,
  killedCount,
  onHome,
  onHistory,
  onStats,
  active,
}: {
  showLogo: boolean
  historyCount: number
  killedCount: number | null
  onHome: () => void
  onHistory: () => void
  onStats: () => void
  /** Highlights the button of the page being shown. */
  active?: 'mcp'
}) {
  const [stars, setStars] = useState<number | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetch('https://api.github.com/repos/monteduro/killmyidea', {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error('Could not load GitHub stars')
        return response.json()
      })
      .then((repo: { stargazers_count?: unknown }) => {
        if (typeof repo.stargazers_count === 'number') setStars(repo.stargazers_count)
      })
      .catch(() => {})

    return () => controller.abort()
  }, [])

  return (
    <header className="flex flex-wrap items-start justify-between gap-4 px-5 pt-5 sm:px-8 sm:pt-7">
      {showLogo ? (
        <button onClick={onHome} aria-label="Kill another idea" className="cursor-pointer text-left">
          <Logo className="text-xl" />
        </button>
      ) : (
        <span className="pt-1 font-mono text-[11px] uppercase tracking-widest opacity-60">v1 / jev-latest</span>
      )}
      <nav className="flex w-full items-stretch gap-1 sm:ml-auto sm:w-auto sm:gap-2">
        {killedCount !== null && (
          <button
            onClick={onStats}
            title="Verdict breakdown of all analyzed ideas"
            className="animate-rise flex-1 cursor-pointer whitespace-nowrap border-2 border-ink bg-ink px-2 py-1.5 sm:flex-none sm:px-3 font-mono text-xs uppercase tracking-widest text-paper transition-colors hover:bg-kill hover:text-ink"
          >
            Analyzed<span className="ml-2 opacity-70 tabular-nums">{killedCount.toLocaleString('en-US')}</span>
          </button>
        )}
        <button
          onClick={onHistory}
          className="flex-1 cursor-pointer whitespace-nowrap border-2 border-current px-2 py-1.5 sm:flex-none sm:px-3 font-mono text-xs uppercase tracking-widest hover:bg-current/10"
        >
          History{historyCount > 0 && <span className="ml-2 opacity-60">{historyCount}</span>}
        </button>
        <a
          href="/mcp/"
          title="Free MCP server for AI agents"
          aria-current={active === 'mcp' ? 'page' : undefined}
          className={`flex flex-1 items-center justify-center border-2 border-current px-2 py-1.5 sm:flex-none sm:px-3 font-mono text-xs uppercase tracking-widest ${
            active === 'mcp' ? 'border-kill bg-kill text-ink' : 'hover:bg-current/10'
          }`}
        >
          MCP
        </a>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={stars === null ? 'Source code on GitHub' : `Source code on GitHub, ${stars.toLocaleString('en-US')} stars`}
          title="Source code on GitHub"
          className="flex min-h-8 flex-1 shrink-0 items-center justify-center gap-1.5 sm:flex-none border-2 border-current px-2 font-mono text-xs tabular-nums hover:bg-current/10"
        >
          <GitHubIcon className="size-4" />
          {stars !== null && (
            <span className="flex items-center gap-1" aria-hidden="true">
              <svg viewBox="0 0 16 16" fill="currentColor" className="size-3.5">
                <path d="m8 1.25 2.08 4.22 4.67.68-3.38 3.29.8 4.65L8 11.9l-4.17 2.19.8-4.65-3.38-3.29 4.67-.68L8 1.25Z" />
              </svg>
              {stars.toLocaleString('en-US')}
            </span>
          )}
        </a>
      </nav>
    </header>
  )
}
