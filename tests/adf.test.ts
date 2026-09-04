import { describe, expect, it } from 'vitest'
import { adfToMarkdown } from '../server/utils/adf'

const text = (value: string, marks?: Array<{ type: string; attrs?: Record<string, unknown> }>) => ({ type: 'text', text: value, ...(marks ? { marks } : {}) })
const paragraph = (...content: unknown[]) => ({ type: 'paragraph', content })
const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content })

describe('Atlassian Document Format to Markdown', () => {
  it('passes plain text through and ignores what is not a document', () => {
    expect(adfToMarkdown('already text')).toBe('already text')
    expect(adfToMarkdown(null)).toBe('')
    expect(adfToMarkdown(42)).toBe('')
    expect(adfToMarkdown([])).toBe('')
  })

  it('renders paragraphs, headings and inline marks', () => {
    const markdown = adfToMarkdown(doc(
      { type: 'heading', attrs: { level: 2 }, content: [text('Steps')] },
      paragraph(text('Tap '), text('Login', [{ type: 'strong' }]), text(' then '), text('wait', [{ type: 'em' }]), text(' for '), text('init()', [{ type: 'code' }])),
      paragraph(text('See '), text('the spec', [{ type: 'link', attrs: { href: 'https://example.com/spec' } }]), text(' '), text('old', [{ type: 'strike' }]))
    ))
    expect(markdown).toBe([
      '## Steps',
      '',
      'Tap **Login** then _wait_ for `init()`',
      '',
      'See [the spec](https://example.com/spec) ~~old~~'
    ].join('\n'))
  })

  it('renders lists, nested lists and task lists', () => {
    const item = (...content: unknown[]) => ({ type: 'listItem', content })
    const markdown = adfToMarkdown(doc(
      { type: 'bulletList', content: [
        item(paragraph(text('one'))),
        item(paragraph(text('two')), { type: 'bulletList', content: [item(paragraph(text('nested')))] })
      ] },
      { type: 'orderedList', attrs: { order: 3 }, content: [item(paragraph(text('third'))), item(paragraph(text('fourth')))] },
      { type: 'taskList', content: [
        { type: 'taskItem', attrs: { state: 'DONE' }, content: [text('done')] },
        { type: 'taskItem', attrs: { state: 'TODO' }, content: [text('open')] }
      ] }
    ))
    expect(markdown).toBe([
      '- one',
      '- two',
      '  - nested',
      '',
      '3. third',
      '4. fourth',
      '',
      '- [x] done',
      '- [ ] open'
    ].join('\n'))
  })

  it('renders code blocks, quotes, panels and rules', () => {
    const markdown = adfToMarkdown(doc(
      { type: 'codeBlock', attrs: { language: 'swift' }, content: [text('fatalError("boom")')] },
      { type: 'blockquote', content: [paragraph(text('quoted'))] },
      { type: 'panel', attrs: { panelType: 'info' }, content: [paragraph(text('note'))] },
      { type: 'rule' }
    ))
    expect(markdown).toBe('```swift\nfatalError("boom")\n```\n\n> quoted\n\n> note\n\n---')
  })

  it('renders tables as pipe tables and escapes pipes in cells', () => {
    const cell = (type: string, value: string) => ({ type, content: [paragraph(text(value))] })
    const markdown = adfToMarkdown(doc({
      type: 'table',
      content: [
        { type: 'tableRow', content: [cell('tableHeader', 'Device'), cell('tableHeader', 'Result')] },
        { type: 'tableRow', content: [cell('tableCell', 'iPhone'), cell('tableCell', 'a | b')] }
      ]
    }))
    expect(markdown).toBe('| Device | Result |\n| --- | --- |\n| iPhone | a \\| b |')
  })

  it('renders mentions, emoji, cards, dates, statuses and media placeholders', () => {
    const markdown = adfToMarkdown(doc(
      paragraph(
        { type: 'mention', attrs: { id: '5b10a', text: '@Grace Hopper' } },
        text(' '),
        { type: 'emoji', attrs: { shortName: ':tada:', text: '🎉' } },
        text(' '),
        { type: 'inlineCard', attrs: { url: 'https://example.com' } },
        text(' '),
        { type: 'date', attrs: { timestamp: '1756684800000' } },
        text(' '),
        { type: 'status', attrs: { text: 'BLOCKED' } },
        { type: 'hardBreak' },
        text('next line')
      ),
      { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'abc', type: 'file', alt: 'screen.png' } }] }
    ))
    expect(markdown).toBe('@Grace Hopper 🎉 <https://example.com> 2025-09-01 [BLOCKED]  \nnext line\n\n*[attachment: screen.png]*')
  })

  it('keeps the words of nodes it does not know', () => {
    const markdown = adfToMarkdown(doc(
      { type: 'layoutSection', content: [{ type: 'layoutColumn', content: [paragraph(text('in a column'))] }] },
      { type: 'expand', attrs: { title: 'Details' }, content: [paragraph(text('hidden text'))] },
      { type: 'somethingNew', content: [text('unknown inline')] }
    ))
    expect(markdown).toBe('in a column\n\n**Details**\n\nhidden text\n\nunknown inline')
  })
})
