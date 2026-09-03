import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../shared/utils/markdown'

describe('renderMarkdown', () => {
  it('renders headings, lists and fenced code', () => {
    const html = renderMarkdown('## Steps\n\n- one\n- two\n\n```js\nconst a = 1\n```')
    expect(html).toContain('<h2>Steps</h2>')
    expect(html).toContain('<li>one</li>')
    expect(html).toContain('<pre><code class="language-js">const a = 1\n</code></pre>')
  })

  it('returns nothing for empty or whitespace-only input', () => {
    expect(renderMarkdown('')).toBe('')
    expect(renderMarkdown('  \n\t')).toBe('')
  })

  it('escapes raw HTML instead of rendering it', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n<b>bold</b>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<b>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
  })

  it('drops script-scheme links but keeps their text', () => {
    const html = renderMarkdown('[click](javascript:alert(1)) and [data](data:text/html,x) and [vb](vbscript:x)')
    expect(html).not.toContain('<a')
    expect(html).not.toContain('href=')
    expect(html).toContain('click')
  })

  it('opens links in a new tab without handing over the opener', () => {
    const html = renderMarkdown('[docs](https://example.com/docs)')
    expect(html).toContain('<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer">docs</a>')
  })

  it('links bare URLs', () => {
    const html = renderMarkdown('See https://example.com/x for details.')
    expect(html).toContain('<a href="https://example.com/x" target="_blank" rel="noopener noreferrer">https://example.com/x</a>')
  })

  it('does not turn a single newline into a line break', () => {
    expect(renderMarkdown('one\ntwo')).toBe('<p>one\ntwo</p>\n')
  })
})
