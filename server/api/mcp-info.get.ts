import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerTools } from '~~/server/mcp/tools'
import { sessionActor } from '~~/server/utils/actor'

/**
 * What the MCP endpoint offers, for the connection panel in the UI.
 *
 * The list is produced by registering the real tools against a collector rather than being
 * written out again here, so the panel cannot describe a tool that does not exist or miss one
 * that does — the same reason the OpenAPI document is generated from the route table.
 *
 * Only the declarations are read; no handler is called, so the actor is never acted on.
 */
export default defineEventHandler((event) => {
  const actor = sessionActor(event)
  const tools: Array<{ name: string; title: string; description: string }> = []

  const collector = {
    registerTool(name: string, config: { title?: string; description?: string }) {
      tools.push({ name, title: config.title ?? name, description: config.description ?? '' })
    }
  }
  registerTools(collector as unknown as McpServer, actor)

  return {
    url: new URL('/mcp', getRequestURL(event).origin).toString(),
    transport: 'streamable-http',
    tools: tools.sort((a, b) => a.name.localeCompare(b.name))
  }
})
