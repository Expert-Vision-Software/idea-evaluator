// /mcp/: static docs page. Styles, the site header, copy buttons and one-click install links.
import '@fontsource-variable/inter-tight'
import '@fontsource-variable/jetbrains-mono'
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Header } from './components/Header'
import { StatsModal } from './components/StatsModal'
import { fetchStats, type Stats } from './lib/stats'
import { ideaStore } from './lib/storage'
import './index.css'

/** Same buttons as the app. History lives on the home page, so it links there with the drawer open. */
function McpHeader() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [statsOpen, setStatsOpen] = useState(false)
  const [historyCount, setHistoryCount] = useState(0)

  useEffect(() => {
    void fetchStats().then(setStats)
    void ideaStore.list().then((items) => setHistoryCount(items.length))
  }, [])

  return (
    <>
      <Header
        showLogo
        active="mcp"
        historyCount={historyCount}
        killedCount={stats?.count ?? null}
        onHome={() => window.location.assign('/')}
        onHistory={() => window.location.assign('/?open=history')}
        onStats={() => setStatsOpen(true)}
      />
      <StatsModal open={statsOpen} stats={stats} onClose={() => setStatsOpen(false)} />
    </>
  )
}

// Replaces the static fallback header that crawlers and no-JS visitors see.
createRoot(document.getElementById('site-header')!).render(
  <StrictMode>
    <McpHeader />
  </StrictMode>,
)

const endpoint = document.getElementById('mcp-url')?.textContent?.trim() ?? ''

const deeplinks: Record<string, string> = {
  cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=killmyidea&config=${btoa(JSON.stringify({ url: endpoint }))}`,
  vscode: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: 'killmyidea', type: 'http', url: endpoint }))}`,
}
for (const a of document.querySelectorAll<HTMLAnchorElement>('[data-deeplink]')) {
  const href = deeplinks[a.dataset.deeplink ?? '']
  if (href) a.href = href
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
  const label = button.textContent
  button.addEventListener('click', async () => {
    const text = document.getElementById(button.dataset.copy ?? '')?.textContent?.trim() ?? ''
    try {
      await navigator.clipboard.writeText(text)
      button.textContent = 'Copied'
    } catch {
      button.textContent = 'Copy failed'
    }
    setTimeout(() => (button.textContent = label), 1500)
  })
}
