import { defineTool } from '@deepseek-ai/dsh-tools'

/**
 * Register the session_search agent tool into the cordis tools context.
 *
 * Provides historical full-text search across sessions using the core
 * SQLite FTS5 engine (@deepseek-ai/dsh-session-query).
 *
 * @param {object} ctx - Cordis context with tools and sessionQuery injected.
 * @param {Function} getConfig - Getter returning current plugin settings.
 * @returns {Function|undefined} Cleanup disposer if returned by ctx.effect.
 */
export function registerSearchTool(ctx, getConfig) {
  if (!ctx?.tools || !ctx?.sessionQuery) {
    return undefined
  }

  const initialCfg = (typeof getConfig === 'function' ? getConfig() : {}) || {}
  const defaultTimeoutMs = initialCfg.searchTimeoutMs ?? 30000

  const toolDef = defineTool({
    name: 'session_search',
    description: 'Full-text search across historical DSH sessions (conversation history with the agent). Use to recall past solutions, lessons learned, decisions made, or context from previous sessions.',
    timeoutMs: defaultTimeoutMs,
    isConcurrencySafe: () => true,
    parameters: {
      query: { type: 'string', required: true, description: 'Search query text (search terms and keywords).' },
      limit: { type: 'integer', description: `Maximum matching sessions to return (default ${initialCfg.searchMaxResults ?? 20}).` },
    },
    output: {
      schema: { type: 'string' },
      render: (_a, v) => [{ type: 'text', text: String(v ?? '') }],
    },
    async execute(args, execCtx) {
      const liveCfg = (typeof getConfig === 'function' ? getConfig() : {}) || {}
      const maxResults = liveCfg.searchMaxResults ?? 20
      const snippetLength = liveCfg.searchSnippetLength ?? 200
      const signal = execCtx?.signal
      const rawQuery = typeof args?.query === 'string' ? args.query.trim() : ''
      if (!rawQuery) {
        return 'session_search: error: query must be a non-empty string.'
      }
      const limit = Math.min(Math.max(args.limit ?? maxResults, 1), 100)
      let page
      try {
        page = await ctx.sessionQuery.searchSessions(
          { query: rawQuery, limit },
          signal ? { signal } : undefined,
        )
      } catch (error) {
        return `session_search: error: ${error instanceof Error ? error.message : String(error)}`
      }
      const items = Array.isArray(page?.items) ? page.items : []
      if (items.length === 0) return 'session_search: no matches found.'
      const lines = items.map((hit) => {
        const rawSnippet = hit.bestMatch?.snippet ?? ''
        const snippet = rawSnippet.replace(/\s+/g, ' ').trim().slice(0, snippetLength)
        const header = hit.header ?? {}
        const id = header.id ?? ''
        const title = (typeof header.title === 'string' && header.title) ? header.title : id
        const rawDate = header.updated_at || header.created_at || hit.bestMatch?.time
        let dateStr = ''
        if (rawDate) {
          const d = new Date(rawDate)
          if (!Number.isNaN(d.getTime())) {
            dateStr = d.toISOString().slice(0, 10)
          }
        }
        const headerLine = `• ${title} [${id}]${dateStr ? ` (${dateStr})` : ''}`
        return snippet ? `${headerLine}\n  ${snippet}` : headerLine
      })
      const more = page?.nextCursor ? '\n(more results available — refine your query)' : ''
      return lines.join('\n') + more
    },
  })

  if (typeof ctx.effect === 'function') {
    return ctx.effect(() => ctx.tools.register(toolDef))
  }
  return ctx.tools.register(toolDef)
}
