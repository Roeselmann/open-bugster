/**
 * A built-in API reference.
 *
 * Deliberately not Swagger UI or Scalar. The instance's own CSP is `script-src 'self'`, so a
 * CDN-loaded viewer renders a blank page — and vendoring a megabyte of JavaScript into a
 * project this size to render thirty endpoints is a poor trade. This reads
 * `/api/v1/openapi.json`, which `connect-src 'self'` allows, and renders it.
 *
 * Anyone who wants "try it out" can point a self-hosted Swagger UI at the same document; that
 * is what publishing a spec is for.
 */
export function docsPage(): string {
  return `<!doctype html>
<html lang="en" data-theme="auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Open-Bugster API</title>
<style>
:root {
  --ground: #f6f7f8; --surface: #fff; --ink: #14181c; --ink-2: #59646d; --ink-3: #8a949c;
  --rule: #e2e6e9; --accent: #16697e; --get: #1f7a4d; --post: #1d5fa8; --patch: #8a6320;
  --put: #6b4ea8; --delete: #a8443f; --code-bg: #f0f2f4;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ground: #0b0d10; --surface: #12171b; --ink: #e4e9ec; --ink-2: #a0abb3; --ink-3: #6d7982;
    --rule: #232b32; --accent: #62b6c9; --get: #63b98c; --post: #6ba7e0; --patch: #d2a354;
    --put: #a892e0; --delete: #d98189; --code-bg: #171d22;
  }
}
* { box-sizing: border-box }
body {
  margin: 0; background: var(--ground); color: var(--ink);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
.wrap { max-width: 62rem; margin: 0 auto; padding: 2.5rem 1.25rem 6rem }
h1 { font-size: 1.75rem; margin: 0 0 .35rem; letter-spacing: -.02em }
.lede { color: var(--ink-2); margin: 0 0 1.5rem; max-width: 46rem; white-space: pre-line }
h2 {
  font-size: .78rem; text-transform: uppercase; letter-spacing: .11em; color: var(--ink-3);
  margin: 2.25rem 0 .6rem; font-weight: 600;
}
.op {
  background: var(--surface); border: 1px solid var(--rule); border-radius: 7px;
  margin-bottom: .5rem; overflow: hidden;
}
.head {
  display: flex; gap: .7rem; align-items: baseline; padding: .7rem .9rem; cursor: pointer;
  width: 100%; background: none; border: 0; text-align: left; color: inherit; font: inherit;
}
.head:hover { background: var(--code-bg) }
.head:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px }
.m {
  font: 600 .7rem/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .06em;
  padding: .32rem .45rem; border-radius: 4px; border: 1px solid currentColor; flex: none; min-width: 4.2rem; text-align: center;
}
.m.get { color: var(--get) } .m.post { color: var(--post) } .m.patch { color: var(--patch) }
.m.put { color: var(--put) } .m.delete { color: var(--delete) }
.p { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .86rem; flex: none }
.s { color: var(--ink-2); font-size: .86rem; margin-left: auto; text-align: right }
.body { padding: 0 .9rem 1rem; border-top: 1px solid var(--rule); display: none }
.op[open] .body, .op.open .body { display: block }
h3 { font-size: .72rem; text-transform: uppercase; letter-spacing: .09em; color: var(--ink-3); margin: 1rem 0 .4rem }
table { width: 100%; border-collapse: collapse; font-size: .86rem }
td { padding: .3rem .5rem .3rem 0; vertical-align: top; border-bottom: 1px solid var(--rule) }
tr:last-child td { border-bottom: 0 }
td.n { font-family: ui-monospace, monospace; white-space: nowrap; width: 1%; padding-right: 1rem }
td.t { color: var(--ink-2); white-space: nowrap; width: 1%; padding-right: 1rem }
.req { color: var(--delete); font-size: .78rem }
pre {
  background: var(--code-bg); border: 1px solid var(--rule); border-radius: 5px;
  padding: .7rem .8rem; overflow-x: auto; font-size: .8rem; margin: 0;
}
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace }
.note {
  background: var(--surface); border: 1px solid var(--rule); border-left: 3px solid var(--accent);
  border-radius: 0 6px 6px 0; padding: .8rem .95rem; margin-bottom: 1.5rem; font-size: .9rem; color: var(--ink-2);
}
.note code { background: var(--code-bg); padding: .1em .3em; border-radius: 3px; color: var(--ink) }
a { color: var(--accent) }
</style>
</head>
<body>
<div class="wrap">
  <h1>Open-Bugster API</h1>
  <p class="lede" id="lede">Loading…</p>
  <div class="note">
    Machine-readable spec: <a href="./openapi.json"><code>/api/v1/openapi.json</code></a> —
    point a client generator or a self-hosted Swagger UI at it.
    <br>
    Connecting an AI agent instead? That is <code>/mcp</code>, which speaks JSON-RPC rather than
    REST and so is not described here — see <a href="/profile">your profile</a> for the endpoint
    and the tools it offers.
  </div>
  <div id="ops"></div>
</div>
<script>
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n }
const typeOf = (s) => {
  if (!s) return ''
  if (s.$ref) return s.$ref.split('/').pop()
  if (s.type === 'array') return typeOf(s.items) + '[]'
  if (Array.isArray(s.type)) return s.type.join(' | ')
  if (s.enum) return s.enum.map(v => JSON.stringify(v)).join(' | ')
  if (s.anyOf) return s.anyOf.map(typeOf).filter(Boolean).join(' | ')
  return s.type || 'object'
}
function rows(entries, required) {
  const table = el('table')
  for (const [name, schema] of entries) {
    const tr = el('tr')
    const n = el('td', 'n'); n.append(el('code', null, name))
    if (required.includes(name)) n.append(' ', el('span', 'req', '*'))
    tr.append(n, el('td', 't', typeOf(schema)), el('td', null, schema && schema.description || ''))
    table.append(tr)
  }
  return table
}
fetch('./openapi.json', { headers: { accept: 'application/json' } })
  .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
  .then((spec) => {
    document.getElementById('lede').textContent = spec.info.description
    const byTag = new Map()
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        const tag = (op.tags && op.tags[0]) || 'other'
        if (!byTag.has(tag)) byTag.set(tag, [])
        byTag.get(tag).push({ path, method, op })
      }
    }
    const container = document.getElementById('ops')
    for (const [tag, list] of [...byTag].sort((a, b) => a[0].localeCompare(b[0]))) {
      container.append(el('h2', null, tag))
      for (const { path, method, op } of list) {
        const details = el('details', 'op')
        const summary = el('summary', 'head')
        summary.append(el('span', 'm ' + method, method.toUpperCase()), el('span', 'p', path), el('span', 's', op.summary || ''))
        details.append(summary)

        const body = el('div', 'body')
        const params = op.parameters || []
        if (params.length) {
          body.append(el('h3', null, 'Parameters'))
          body.append(rows(params.map(p => [p.name + ' (' + p.in + ')', p.schema]), params.filter(p => p.required).map(p => p.name + ' (' + p.in + ')')))
        }
        const schema = op.requestBody && op.requestBody.content['application/json'].schema
        if (schema && schema.properties && Object.keys(schema.properties).length) {
          body.append(el('h3', null, 'Body'))
          body.append(rows(Object.entries(schema.properties), schema.required || []))
        }
        const ok = op.responses['200'] || op.responses['201'] || op.responses['204']
        body.append(el('h3', null, 'Response'))
        const okSchema = ok && ok.content && ok.content['application/json'] && ok.content['application/json'].schema
        body.append(el('pre', null, okSchema ? JSON.stringify(okSchema, null, 2) : (ok && ok.description) || 'No content.'))
        details.append(body)
        container.append(details)
      }
    }
  })
  .catch((error) => { document.getElementById('lede').textContent = 'Could not load the specification: ' + error.message })
</script>
</body>
</html>`
}
