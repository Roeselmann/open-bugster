import MarkdownIt from 'markdown-it'

/*
 * Descriptions and comments are Markdown. Raw HTML is switched off, so a `<script>` in the
 * source comes out as visible text; `validateLink` (markdown-it's default) drops
 * `javascript:`, `vbscript:` and `data:` hrefs. That makes the output safe to put through
 * `v-html` without a DOM-based sanitizer, which is what lets this run in SSR and in the
 * node-only test suite alike.
 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: false })

// Every link leaves the app in a new tab, and never hands the opener to the target.
md.core.ruler.push('external_links', state => {
  for (const token of state.tokens) {
    for (const child of token.children || []) {
      if (child.type !== 'link_open') continue
      child.attrSet('target', '_blank')
      child.attrSet('rel', 'noopener noreferrer')
    }
  }
})

export function renderMarkdown(source: string): string {
  if (!source.trim()) return ''
  return md.render(source)
}
