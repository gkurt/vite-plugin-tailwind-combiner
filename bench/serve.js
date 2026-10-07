// Static server for the benchmark.
//   /             -> bench/runner.html
//   /baseline/*   -> bench/dist/baseline
//   /optimized/*  -> bench/dist/optimized
//   POST /results -> writes bench/results/<timestamp>.json
//
// HTML requested with ?enc=gzip or ?enc=br is sent compressed (gzip level 6 /
// Brotli quality 11, compressed once and cached) so the browser reports real
// transfer sizes and pays the real decompression cost.
//
// Sends COOP/COEP so the runner is cross-origin isolated: that gives
// high-resolution performance.now() and enables measureUserAgentSpecificMemory().

import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const benchDir = path.dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.PORT) || 4178
const encoders = {
  gzip: (buf) => gzipSync(buf, { level: 6 }),
  br: (buf) => brotliCompressSync(buf, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11 } }),
}
const compressed = new Map()
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' }

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (req.method === 'POST' && url.pathname === '/results') {
    let body = ''
    for await (const chunk of req) body += chunk
    const name = new Date().toISOString().replace(/[:.]/g, '-') + '.json'
    await mkdir(path.join(benchDir, 'results'), { recursive: true })
    await writeFile(path.join(benchDir, 'results', name), JSON.stringify(JSON.parse(body), null, 2))
    return res.writeHead(200, { 'Content-Type': 'text/plain' }).end(name)
  }
  const rel = url.pathname === '/' ? 'runner.html' : path.join('dist', decodeURIComponent(url.pathname))
  const file = path.join(benchDir, rel)
  if (!file.startsWith(benchDir)) return res.writeHead(403).end()
  try {
    let body = await readFile(file)
    const enc = url.searchParams.get('enc')
    const headers = {}
    if (encoders[enc] && file.endsWith('.html')) {
      const key = `${file}:${enc}`
      if (!compressed.has(key)) compressed.set(key, encoders[enc](body))
      body = compressed.get(key)
      headers['Content-Encoding'] = enc
    }
    res.writeHead(200, {
      ...headers,
      'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
}).listen(port, () => console.log(`Benchmark runner: http://localhost:${port}/`))
