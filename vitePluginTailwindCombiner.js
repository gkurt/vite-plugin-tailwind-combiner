// vite-plugin-tailwind-combiner
//
// Post-build HTML optimizer for benchmarking. Finds elements that share the same
// long list of Tailwind utilities, collapses each list into one generated class
// (e.g. `t-opt-a1b2c3`), and injects the matching CSS into an inline <style>.
//
// The generated CSS is not hand-written: the plugin reads the stylesheet Tailwind
// already emitted, finds every rule that targets one of the combined utilities
// (including hover:, md:, dark:, etc. variants), and clones it with the selector
// rewritten to the new class. @media / @supports / @layer wrappers and rule order
// are preserved, so the cascade behaves exactly like the original utilities.

import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import path from 'node:path'
import postcss from 'postcss'

const PLUGIN_NAME = 'vite-plugin-tailwind-combiner'

/**
 * @param {object}  [options]
 * @param {number}  [options.minLength=4]       Minimum number of classes a list must contain to be considered.
 * @param {number}  [options.minOccurrences=5]  Minimum number of times the (sorted) list must appear in the document.
 * @param {string}  [options.prefix='t-opt-']   Prefix for generated class names.
 * @param {boolean} [options.log=true]          Print the per-file summary after each HTML file is processed.
 * @returns {import('vite').Plugin}
 */
export default function tailwindCombiner(options = {}) {
  const { minLength = 4, minOccurrences = 5, prefix = 't-opt-', log = true } = options

  let config

  return {
    name: PLUGIN_NAME,
    // Only meaningful on the built output: in dev, Vite injects CSS through JS
    // and there is no final stylesheet to read rules from.
    apply: 'build',

    configResolved(resolved) {
      config = resolved
    },

    transformIndexHtml: {
      // 'post' runs after Vite has injected the hashed <link rel="stylesheet"> tags
      // and gives us `ctx.bundle`, which holds the CSS Tailwind generated.
      order: 'post',
      handler(html, ctx) {
        const result = combine(html, ctx, { minLength, minOccurrences, prefix, base: config.base })
        if (log) printSummary(config, ctx, result)
        return result.html
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

function combine(html, ctx, { minLength, minOccurrences, prefix, base }) {
  const sizeBefore = sizes(html)

  // Pass 1: count every qualifying (deduped + sorted) class list.
  const counts = new Map()
  const inlineCss = []
  walkHtml(html, {
    onStyle: (css) => inlineCss.push(css),
    onClass: (raw) => {
      const tokens = tokenize(raw)
      if (tokens.length < minLength) return
      const key = tokens.join(' ')
      counts.set(key, (counts.get(key) || 0) + 1)
    },
  })

  const candidates = [...counts].filter(([, n]) => n >= minOccurrences)
  const empty = { html, stats: { ...emptyStats(), sizeBefore, sizeAfter: sizeBefore } }
  if (candidates.length === 0) return empty

  // Build an index of every CSS rule keyed by the class it styles.
  const cssSources = [...linkedCss(html, ctx.bundle, base), ...inlineCss]
  if (cssSources.length === 0) return empty
  const index = indexCss(cssSources)

  // Decide, per candidate list, which classes can be folded into the new class
  // and which must stay on the element (see `classify`).
  const plans = new Map() // key -> { className, passthrough, rules }
  const usedNames = new Map()
  let skipped = 0
  for (const [key] of candidates) {
    const tokens = key.split(' ')
    const absorbed = []
    const passthrough = []
    for (const t of tokens) (classify(t, index) === 'absorb' ? absorbed : passthrough).push(t)
    if (absorbed.length < 2) {
      skipped++
      continue
    }
    plans.set(key, {
      className: uniqueName(prefix, key, usedNames),
      absorbed: new Set(absorbed),
      passthrough,
    })
  }
  if (plans.size === 0) return { ...empty, stats: { ...empty.stats, skipped } }

  const css = buildCss(plans, index)

  // Pass 2: rewrite class attributes.
  let replaced = 0
  let out = walkHtml(html, {
    onClass: (raw) => {
      const plan = plans.get(tokenize(raw).join(' '))
      if (!plan) return undefined
      replaced++
      return [plan.className, ...plan.passthrough].map(escapeAttr).join(' ')
    },
  })

  out = injectStyle(out, css)

  return {
    html: out,
    stats: {
      replaced,
      created: plans.size,
      skipped,
      cssBytes: Buffer.byteLength(css),
      sizeBefore,
      sizeAfter: sizes(out),
    },
  }
}

function emptyStats() {
  return { replaced: 0, created: 0, skipped: 0, cssBytes: 0 }
}

function tokenize(raw) {
  const set = new Set(decodeEntities(raw).split(/\s+/).filter(Boolean))
  return [...set].sort()
}

function uniqueName(prefix, key, used) {
  const digest = createHash('sha1').update(key).digest('hex')
  for (let len = 6; len <= digest.length; len++) {
    const name = prefix + digest.slice(0, len)
    const owner = used.get(name)
    if (owner === undefined || owner === key) {
      used.set(name, key)
      return name
    }
  }
  throw new Error(`[${PLUGIN_NAME}] could not generate a unique class name for "${key}"`)
}

// ---------------------------------------------------------------------------
// HTML tokenizer
// ---------------------------------------------------------------------------

// Matches, in order of priority:
//   1. comments
//   2. raw-text elements (script/style/textarea/title) as a whole, so markup-looking
//      text inside them is never treated as elements
//   3. any other opening tag; quoted attribute values may contain '>'
const TAG = String.raw`(?:[^>"']|"[^"]*"|'[^']*')*`
const HTML_TOKEN_RE = new RegExp(
  String.raw`<!--[\s\S]*?-->` +
    String.raw`|(<(script|style|textarea|title)\b${TAG}>)([\s\S]*?)(<\/\2\s*>)` +
    String.raw`|<[a-zA-Z][^\s/>]*${TAG}>`,
  'gi',
)
const ATTR_RE = /([^\s"'<>/=]+)(?:(\s*=\s*)("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g

/**
 * Walks every opening tag. `onClass(rawValue)` may return a replacement value
 * (already attribute-escaped) for `class` / `className` attributes.
 * `onStyle(css)` receives the text of inline <style> blocks.
 */
function walkHtml(html, { onClass, onStyle }) {
  return html.replace(HTML_TOKEN_RE, (match, rawOpen, rawName, rawBody, rawClose) => {
    if (match.startsWith('<!--')) return match
    if (rawOpen) {
      if (onStyle && rawName.toLowerCase() === 'style') onStyle(rawBody)
      return rewriteTag(rawOpen, onClass) + rawBody + rawClose
    }
    return rewriteTag(match, onClass)
  })
}

function rewriteTag(tag, onClass) {
  const nameEnd = tag.search(/[\s/>]/)
  const name = tag.slice(0, nameEnd)
  const attrs = tag.slice(nameEnd).replace(ATTR_RE, (attr, attrName, eq, value) => {
    const lower = attrName.toLowerCase()
    if (!value || (lower !== 'class' && lower !== 'classname')) return attr
    const quoted = value[0] === '"' || value[0] === "'"
    const next = onClass(quoted ? value.slice(1, -1) : value)
    return next === undefined ? attr : `${attrName}="${next}"`
  })
  return name + attrs
}

function injectStyle(html, css) {
  const tag = `<style data-tailwind-combiner>${css}</style>`
  const headClose = html.search(/<\/head\s*>/i)
  if (headClose !== -1) return html.slice(0, headClose) + tag + html.slice(headClose)
  const bodyOpen = html.search(/<body\b/i)
  return bodyOpen === -1 ? tag + html : html.slice(0, bodyOpen) + tag + html.slice(bodyOpen)
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(str) {
  if (!str.includes('&')) return str
  return str.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m
  })
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// CSS indexing
// ---------------------------------------------------------------------------

/** Returns the source of every bundled stylesheet linked from this HTML, in link order. */
function linkedCss(html, bundle, base) {
  if (!bundle) return []
  const assets = Object.values(bundle).filter((f) => f.type === 'asset' && f.fileName.endsWith('.css'))
  const out = []
  for (const [, tag] of html.matchAll(/<link\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    if (!/\brel\s*=\s*["']?stylesheet/i.test(tag)) continue
    const href = tag.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
    if (!href) continue
    const url = (href[1] ?? href[2] ?? href[3]).split(/[?#]/)[0]
    const asset = assets.find((a) => url === base + a.fileName || url.endsWith('/' + a.fileName) || url === a.fileName)
    if (asset) out.push(String(asset.source))
  }
  return out
}

/**
 * Index shape:
 *   subject:    Map<className, Set<entry>>  rules where the class is in the rightmost compound selector
 *   nonSubject: Set<className>              classes used as ancestors / siblings / inside :is() etc.
 * entry = { order, rule, chain, items } where `items` is the parsed selector list.
 */
function indexCss(sources) {
  const subject = new Map()
  const nonSubject = new Set()
  let order = 0

  for (const source of sources) {
    let root
    try {
      root = postcss.parse(source)
    } catch {
      continue
    }
    root.walkRules((rule) => {
      // Only rules nested purely inside at-rules (@media, @supports, @layer, ...).
      const chain = []
      for (let p = rule.parent; p && p.type !== 'root'; p = p.parent) {
        if (p.type !== 'atrule' || /keyframes$/i.test(p.name)) return
        chain.unshift(p)
      }
      const items = parseSelectorList(rule.selector)
      const entry = { order: order++, rule, chain, items }
      for (const item of items) {
        for (const c of item.classes) {
          if (!c.subject) nonSubject.add(c.name)
          else {
            if (!subject.has(c.name)) subject.set(c.name, new Set())
            subject.get(c.name).add(entry)
          }
        }
      }
    })
  }
  return { subject, nonSubject }
}

/**
 * A class can be folded into the generated class only if every rule that uses it
 * targets the element itself. Classes that are referenced as an ancestor/sibling
 * (`group`, `peer`), inside a functional pseudo-class (`:where(.space-y-4 > *)`),
 * or that have no CSS at all (JS hooks, third-party classes) are kept on the element.
 */
function classify(name, index) {
  if (index.nonSubject.has(name)) return 'keep'
  if (!index.subject.has(name)) return 'keep'
  return 'absorb'
}

function buildCss(plans, index) {
  const out = postcss.root()
  // The currently open path of wrappers: [{ source: original at-rule, node: our copy }].
  // Consecutive rules that share an ancestry prefix (e.g. `@layer utilities`) reuse it.
  let open = []

  for (const { className, absorbed } of plans.values()) {
    // Every rule touching any absorbed class, in original stylesheet order.
    const entries = new Set()
    for (const name of absorbed) for (const e of index.subject.get(name)) entries.add(e)
    const sorted = [...entries].sort((a, b) => a.order - b.order)

    for (const { rule, chain, items } of sorted) {
      const selectors = new Set()
      for (const item of items) {
        const hits = item.classes.filter((c) => c.subject && absorbed.has(c.name))
        if (hits.length) selectors.add(rewriteSelector(item.text, item.offset, hits, className))
      }
      if (selectors.size === 0) continue

      let shared = 0
      while (shared < open.length && shared < chain.length && open[shared].source === chain[shared]) shared++
      open = open.slice(0, shared)
      for (let i = shared; i < chain.length; i++) {
        const node = postcss.atRule({
          name: chain[i].name,
          params: chain[i].params,
          raws: { before: '', afterName: ' ', between: '', after: '' },
        })
        ;(open.at(-1)?.node ?? out).append(node)
        open.push({ source: chain[i], node })
      }
      const parent = open.at(-1)?.node ?? out

      // Adjacent declaration-only rules with the same selector merge into one.
      const selector = [...selectors].join(',')
      const last = parent.last
      if (last?.type === 'rule' && last.selector === selector && onlyDecls(last) && onlyDecls(rule)) {
        for (const decl of rule.nodes) last.append(decl.clone())
      } else {
        parent.append(rule.clone({ selector }))
      }
    }
  }

  return out.toString()
}

function onlyDecls(rule) {
  return rule.nodes.every((n) => n.type === 'decl')
}

function rewriteSelector(text, offset, hits, className) {
  let result = text
  // Splice from the end so earlier offsets stay valid.
  for (const c of [...hits].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, c.start - offset) + '.' + className + result.slice(c.end - offset)
  }
  return result
}

// ---------------------------------------------------------------------------
// Selector scanner
// ---------------------------------------------------------------------------

/**
 * Splits a selector list and records every class selector with:
 *   name    - unescaped class name (matches what is written in HTML)
 *   start/end - offsets into the full selector string
 *   subject - true when the class sits at depth 0 in the rightmost compound
 */
function parseSelectorList(selector) {
  const items = []
  let itemStart = 0
  let classes = []
  let compound = 0
  let depth = 0
  let hasContent = false // seen anything other than combinators in this item
  let pendingBoundary = false // combinator seen; becomes a boundary once more content follows
  let i = 0

  const content = () => {
    if (pendingBoundary && hasContent) compound++
    pendingBoundary = false
    hasContent = true
  }

  const pushItem = (end) => {
    const raw = selector.slice(itemStart, end)
    const lead = raw.length - raw.trimStart().length
    for (const c of classes) c.subject = c.depth === 0 && c.compound === compound
    items.push({ text: raw.trim(), offset: itemStart + lead, classes })
    classes = []
    compound = 0
    hasContent = false
    pendingBoundary = false
  }

  while (i < selector.length) {
    const ch = selector[i]
    if (ch === ',' && depth === 0) {
      pushItem(i)
      itemStart = ++i
    } else if (depth === 0 && /[\s>+~]/.test(ch)) {
      pendingBoundary = true
      i++
    } else {
      content()
      if (ch === '\\') {
        i += escapeLength(selector, i)
      } else if (ch === '"' || ch === "'") {
        i = skipString(selector, i)
      } else if (ch === '[') {
        i = skipBracket(selector, i)
      } else if (ch === '(') {
        depth++
        i++
      } else if (ch === ')') {
        depth--
        i++
      } else if (ch === '.') {
        const [name, end] = readIdent(selector, i + 1)
        if (name) classes.push({ name, start: i, end, depth, compound })
        i = Math.max(end, i + 1)
      } else {
        i++
      }
    }
  }
  pushItem(selector.length)
  return items
}

function readIdent(s, i) {
  let name = ''
  while (i < s.length) {
    const ch = s[i]
    if (ch === '\\') {
      const len = escapeLength(s, i)
      name += unescape(s.slice(i, i + len))
      i += len
    } else if (/[a-zA-Z0-9_-]/.test(ch) || ch.charCodeAt(0) >= 0x80) {
      name += ch
      i++
    } else break
  }
  return [name, i]
}

function escapeLength(s, i) {
  const hex = /^[0-9a-fA-F]{1,6}/.exec(s.slice(i + 1, i + 7))
  if (hex) {
    let len = 1 + hex[0].length
    if (/\s/.test(s[i + len] ?? '')) len++
    return len
  }
  return Math.min(2, s.length - i)
}

function unescape(esc) {
  const hex = /^\\([0-9a-fA-F]{1,6})\s?$/.exec(esc)
  return hex ? String.fromCodePoint(parseInt(hex[1], 16)) : esc.slice(1)
}

function skipString(s, i) {
  const q = s[i++]
  while (i < s.length && s[i] !== q) i += s[i] === '\\' ? 2 : 1
  return i + 1
}

function skipBracket(s, i) {
  i++
  while (i < s.length && s[i] !== ']') {
    if (s[i] === '"' || s[i] === "'") i = skipString(s, i)
    else i += s[i] === '\\' ? 2 : 1
  }
  return i + 1
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function sizes(str) {
  return { raw: Buffer.byteLength(str), gzip: gzipSync(str).length }
}

function printSummary(config, ctx, { stats }) {
  const file = path.relative(config.root, ctx.filename).replace(/\\/g, '/') || ctx.path
  const { sizeBefore: b, sizeAfter: a } = stats
  // kB = 1000 bytes, matching Vite's own build report.
  const fmt = (n) => (n / 1000).toFixed(2).padStart(9) + ' kB'
  const delta = (x, y) => {
    const pct = x === 0 ? 0 : ((y - x) / x) * 100
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`.padStart(8)
  }

  const lines = [
    '',
    `[${PLUGIN_NAME}] ${file}`,
    `  elements optimized       ${stats.replaced}`,
    `  combined classes created ${stats.created}`,
  ]
  if (stats.skipped) lines.push(`  candidates skipped       ${stats.skipped} (fewer than 2 classes resolvable in CSS)`)
  if (stats.cssBytes) lines.push(`  injected <style>         ${(stats.cssBytes / 1000).toFixed(2)} kB`)
  lines.push(
    '',
    '              before         after      change',
    `  html  ${fmt(b.raw)}  ${fmt(a.raw)}  ${delta(b.raw, a.raw)}`,
    `  gzip  ${fmt(b.gzip)}  ${fmt(a.gzip)}  ${delta(b.gzip, a.gzip)}`,
    '',
  )
  config.logger.info(lines.join('\n'))
}
