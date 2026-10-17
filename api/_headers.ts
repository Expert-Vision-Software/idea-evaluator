import type { IncomingHttpHeaders } from 'node:http'

/** Headers the handlers read: the MCP server logs the client's user agent and protocol version. */
export function forwardedHeaders(h: IncomingHttpHeaders): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  for (const name of ['user-agent', 'mcp-protocol-version']) {
    const value = h[name]
    if (typeof value === 'string') headers[name] = value
  }
  return headers
}
