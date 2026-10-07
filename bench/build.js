// Generates a large Tailwind page and builds it twice into bench/dist:
//   baseline/   - Tailwind only
//   optimized/  - Tailwind + vite-plugin-tailwind-combiner
//
// Usage: node bench/build.js [cards=1500]

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import tailwindCombiner from '../vitePluginTailwindCombiner.js'

const benchDir = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.join(benchDir, 'src')
const cards = Number(process.argv[2]) || 1500

const card = (n) => `<article class="group flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-5 shadow-sm transition hover:shadow-md md:p-6 dark:border-gray-800 dark:bg-gray-900">
        <header class="flex items-center justify-between gap-2">
          <h3 class="truncate text-base font-semibold text-gray-900 group-hover:text-blue-600 dark:text-white">Card ${n}</h3>
          <span class="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-emerald-600/20 ring-inset">Active</span>
        </header>
        <p class="line-clamp-2 text-sm leading-6 text-gray-600 dark:text-gray-400">Quarterly metrics for workspace ${n}: throughput is steady, error budget is healthy and no incidents were opened.</p>
        <footer class="mt-auto flex items-center justify-between border-t border-gray-100 pt-3">
          <span class="text-xs font-medium text-gray-500 tabular-nums">#${String(n).padStart(5, '0')}</span>
          <button class="js-open inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-blue-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600">Open</button>
        </footer>
      </article>`

writeFileSync(
  path.join(srcDir, 'index.html'),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Combiner benchmark page</title>
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body class="bg-gray-50 p-6 font-sans antialiased">
    <main class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      ${Array.from({ length: cards }, (_, i) => card(i + 1)).join('\n      ')}
    </main>
  </body>
</html>
`,
)
writeFileSync(path.join(srcDir, 'style.css'), `@import "tailwindcss";\n@source "./index.html";\n`)

for (const variant of ['baseline', 'optimized']) {
  console.log(`\n=== ${variant} ===`)
  await build({
    configFile: false,
    root: srcDir,
    base: './',
    logLevel: 'info',
    plugins: [tailwindcss(), variant === 'optimized' && tailwindCombiner()].filter(Boolean),
    build: { outDir: path.join(benchDir, 'dist', variant), emptyOutDir: true },
  })
}
console.log(`\nBuilt ${cards} cards (${cards * 8} styled elements) into bench/dist.`)

// Compressed size report: gzip at the usual on-the-fly level (6) and max (9), Brotli max (11).
const sizeOf = (buf) => ({
  raw: buf.length,
  gzip6: gzipSync(buf, { level: 6 }).length,
  gzip9: gzipSync(buf, { level: 9 }).length,
  brotli11: brotliCompressSync(buf, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11 } }).length,
})
const sizes = { cards }
for (const variant of ['baseline', 'optimized']) {
  const dir = path.join(benchDir, 'dist', variant)
  const html = sizeOf(readFileSync(path.join(dir, 'index.html')))
  const cssFile = readdirSync(path.join(dir, 'assets')).find((f) => f.endsWith('.css'))
  const css = sizeOf(readFileSync(path.join(dir, 'assets', cssFile)))
  const total = Object.fromEntries(Object.keys(html).map((k) => [k, html[k] + css[k]]))
  sizes[variant] = { html, css, total }
}
writeFileSync(path.join(benchDir, 'dist', 'sizes.json'), JSON.stringify(sizes, null, 2))

const kb = (n) => (n / 1000).toFixed(2).padStart(10)
const pct = (a, b) => (((b - a) / a) * 100).toFixed(1).padStart(7) + '%'
console.log('\nBuild output sizes (kB)      baseline   optimized    change')
for (const part of ['html', 'css', 'total']) {
  for (const enc of ['raw', 'gzip6', 'gzip9', 'brotli11']) {
    const a = sizes.baseline[part][enc]
    const b = sizes.optimized[part][enc]
    console.log(`  ${(part + ' ' + enc).padEnd(24)} ${kb(a)}  ${kb(b)}  ${pct(a, b)}`)
  }
}
