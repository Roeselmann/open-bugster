/**
 * Atlassian Document Format to Markdown.
 *
 * Jira's v3 API hands out descriptions and comments as ADF, a JSON tree. The board renders
 * Markdown, so an import translates the common nodes and flattens everything else to its text
 * rather than dropping it. Good enough to read; not a round trip.
 */

type AdfMark = { type?: string; attrs?: Record<string, unknown> }
type AdfNode = {
  type?: string
  text?: string
  content?: AdfNode[]
  attrs?: Record<string, unknown>
  marks?: AdfMark[]
}

export function adfToMarkdown(value: unknown): string {
  if (typeof value === 'string') return value
  if (!isNode(value)) return ''
  return renderBlocks(value.type === 'doc' ? value.content || [] : [value]).trim()
}

function isNode(value: unknown): value is AdfNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function children(node: AdfNode): AdfNode[] {
  return Array.isArray(node.content) ? node.content.filter(isNode) : []
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
}

function renderBlocks(nodes: AdfNode[]): string {
  return nodes.map(renderBlock).filter(block => block.length).join('\n\n')
}

function renderBlock(node: AdfNode): string {
  switch (node.type) {
    case 'paragraph':
      return renderInline(children(node))
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1))
      return `${'#'.repeat(level)} ${renderInline(children(node))}`
    }
    case 'bulletList':
      return children(node).map(item => listItem('- ', item)).join('\n')
    case 'orderedList': {
      const start = Number(node.attrs?.order) || 1
      return children(node).map((item, index) => listItem(`${start + index}. `, item)).join('\n')
    }
    case 'taskList':
      return children(node).map(item => listItem(item.attrs?.state === 'DONE' ? '- [x] ' : '- [ ] ', item)).join('\n')
    case 'decisionList':
      return children(node).map(item => listItem('- ', item)).join('\n')
    case 'codeBlock': {
      const language = text(node.attrs?.language)
      const body = children(node).map(child => text(child.text)).join('')
      return `\`\`\`${language}\n${body}\n\`\`\``
    }
    case 'blockquote':
    case 'panel':
      return quote(renderBlocks(children(node)))
    case 'rule':
      return '---'
    case 'table':
      return renderTable(node)
    case 'mediaSingle':
    case 'mediaGroup':
    case 'mediaInline':
      return children(node).map(renderMedia).filter(Boolean).join('\n')
    case 'media':
      return renderMedia(node)
    case 'expand':
    case 'nestedExpand': {
      const title = text(node.attrs?.title)
      const body = renderBlocks(children(node))
      return title ? `**${title}**${body ? `\n\n${body}` : ''}` : body
    }
    case 'hardBreak':
      return ''
    case 'text':
      return renderInline([node])
    default:
      // Layouts, extensions and whatever ADF grows next: keep the words, lose the wrapper.
      return node.content ? renderBlocks(children(node)) : renderInline([node])
  }
}

/** A list item's first block sits on the marker's line; anything after it is indented under it. */
function listItem(marker: string, item: AdfNode): string {
  const blocks = children(item).map(renderBlock).filter(block => block.length)
  if (!blocks.length) return marker.trimEnd()
  const indent = ' '.repeat(marker.length)
  const [first, ...rest] = blocks
  const tail = rest.map(block => block.split('\n').map(line => (line ? indent + line : line)).join('\n'))
  return [marker + first!.split('\n').join(`\n${indent}`), ...tail].join('\n')
}

function quote(body: string): string {
  return body.split('\n').map(line => (line ? `> ${line}` : '>')).join('\n')
}

function renderTable(node: AdfNode): string {
  const rows = children(node).filter(row => row.type === 'tableRow').map(row =>
    children(row).map(cell => renderBlocks(children(cell)).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim())
  )
  if (!rows.length) return ''
  const width = Math.max(...rows.map(row => row.length))
  const pad = (row: string[]) => [...row, ...Array<string>(width - row.length).fill('')]
  const [header, ...body] = rows.map(pad)
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`
  return [line(header!), line(Array<string>(width).fill('---')), ...body.map(line)].join('\n')
}

function renderMedia(node: AdfNode): string {
  if (node.type !== 'media') return renderBlock(node)
  const label = text(node.attrs?.alt) || text(node.attrs?.id)
  return label ? `*[attachment: ${label}]*` : '*[attachment]*'
}

function renderInline(nodes: AdfNode[]): string {
  return nodes.map(renderInlineNode).join('')
}

function renderInlineNode(node: AdfNode): string {
  switch (node.type) {
    case 'text':
      return applyMarks(text(node.text), node.marks || [])
    case 'hardBreak':
      return '  \n'
    case 'mention': {
      const name = text(node.attrs?.text).replace(/^@/, '') || text(node.attrs?.id)
      return name ? `@${name}` : ''
    }
    case 'emoji':
      return text(node.attrs?.text) || text(node.attrs?.shortName)
    case 'inlineCard':
    case 'blockCard':
    case 'embedCard': {
      const url = text(node.attrs?.url)
      return url ? `<${url}>` : ''
    }
    case 'date': {
      const stamp = Number(node.attrs?.timestamp)
      return Number.isFinite(stamp) && stamp > 0 ? new Date(stamp).toISOString().slice(0, 10) : ''
    }
    case 'status':
      return text(node.attrs?.text) ? `[${text(node.attrs?.text)}]` : ''
    case 'mediaInline':
      return renderMedia({ ...node, type: 'media' })
    default:
      return node.content ? renderInline(children(node)) : ''
  }
}

function applyMarks(value: string, marks: AdfMark[]): string {
  if (!value) return ''
  let out = value
  const has = (type: string) => marks.some(mark => mark.type === type)
  if (has('code')) return `\`${out}\``
  if (has('strong')) out = `**${out}**`
  if (has('em')) out = `_${out}_`
  if (has('strike')) out = `~~${out}~~`
  const link = marks.find(mark => mark.type === 'link')
  const href = text(link?.attrs?.href)
  if (href) out = `[${out}](${href})`
  return out
}
