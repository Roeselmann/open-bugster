import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { toWebRequest, sendWebResponse } from 'h3'
import { registerTools } from '~~/server/mcp/tools'
import { sessionActor } from '~~/server/utils/actor'

/**
 * The MCP endpoint.
 *
 * Authentication has already happened: the auth middleware accepts a bearer token on this path
 * and leaves the resolved actor on the event, so the tools below act with exactly the reach of
 * that token — an agent can never do more than the principal it acts for.
 *
 * **Stateless.** No `sessionIdGenerator`, so every request builds its own server and transport
 * and throws them away. Nothing here needs server-initiated notifications, and a session map
 * in a self-hosted single-process app is a memory leak waiting for the first client that
 * disconnects without saying goodbye. The cost is one small object per request.
 */
export default defineEventHandler(async (event) => {
  const actor = sessionActor(event)

  const server = new McpServer(
    { name: 'open-bugster', version: '1.0.0' },
    {
      instructions: [
        'Open-Bugster is a Kanban board. Boards hold lanes, lanes hold tickets, and a ticket has',
        'a priority, an assignee, labels, a category, a to-do list and a comment thread.',
        '',
        'Start with list_boards, then board_overview for the board you want — lane ids, member ids',
        'and the label and category names all come from there, and inventing one will fail.',
        '',
        'Every ticket also carries a number, unique across the instance and how people refer to',
        'one in conversation. get_ticket takes it directly, so "ticket 42" needs no board.',
        '',
        'Search before creating. A comment on the ticket that already reports something is worth',
        'more than a second ticket reporting it again.',
        '',
        'Everything you do is recorded against the person this token acts for, with your agent',
        'label beside it. Call whoami if a write is refused: the token may be more restricted',
        'than the person is.'
      ].join('\n')
    }
  )

  registerTools(server, actor)

  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless: see above.
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  })

  try {
    await server.connect(transport)
    const response = await transport.handleRequest(toWebRequest(event))
    return sendWebResponse(event, response)
  } finally {
    // Both directions, so a client that vanishes mid-request leaves nothing behind.
    await transport.close().catch(() => undefined)
    await server.close().catch(() => undefined)
  }
})
