/**
 * dsh-vision-skill plugin integration test.
 *
 * Loads the real plugin entry with a stubbed `ctx.tools` registry (the only
 * service the plugin consumes), then exercises the registered tools for real:
 *
 *   - schema/config surface (name, inject, Config export)
 *   - tool registration and render functions
 *   - `vision` OCR execution against a real image (offline Windows OCR)
 *   - `vision` error path for a missing input file
 *   - `vision_preflight` execution
 *
 * Run from the plugin directory:
 *
 *   node test/run.test.mjs
 *
 * Module resolution: the plugin imports `@deepseek-ai/dsh-tools` and
 * `@deepseek-ai/schemastery`. In a checked-out repo without node_modules,
 * either `pnpm install` inside plugin/ or a junction to a dsh installation's
 * scope works:
 *
 *   New-Item -ItemType Junction -Path plugin\node_modules\@deepseek-ai `
 *     -Target C:\path\to\...\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai
 *
 * The test needs a working PowerShell (powershell.exe) and, for the OCR case,
 * Windows OCR support.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const pluginDir = resolve(here, '..')

/** Stub of the tools registry — the only service the plugin injects. */
const registered = []
const ctx = {
  tools: {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  },
}

const plugin = await import('../index.js')

// ── surface checks ─────────────────────────────────────────────────────────
assert.equal(plugin.name, 'dsh-vision-skill')
assert.deepEqual(plugin.inject, ['tools'])
assert.ok(plugin.Config, 'Config schema is exported')
assert.equal(typeof plugin.apply, 'function', 'apply is exported')

plugin.apply(ctx, {})
const names = registered.map((definition) => definition.name)
assert.ok(names.includes('vision'), `vision registered (got: ${names.join(', ')})`)
assert.ok(names.includes('vision_preflight'), 'vision_preflight registered')

const vision = registered.find((definition) => definition.name === 'vision')
const preflight = registered.find((definition) => definition.name === 'vision_preflight')

// ── render sanity ──────────────────────────────────────────────────────────
const sample = {
  task_type: 'ocr',
  tool_used: 'windows-ocr',
  confidence: 'medium',
  result: 'hello world',
  metadata: {},
}
const rendered = vision.output.render({ path: 'sample.png' }, sample)
assert.equal(rendered[0].type, 'text')
assert.ok(rendered[0].text.includes('hello world'), 'render includes the result')

// ── vision OCR against the repo sample image (offline Windows OCR) ─────────
const image = resolve(pluginDir, '..', 'assets', 'star-history.png')
assert.ok(existsSync(image), `sample image exists: ${image}`)
const envelope = await vision.execute(
  { path: image, intent: 'ocr', maxTokens: 200, timeoutSec: 60 },
  { signal: AbortSignal.timeout(120_000) },
)
assert.equal(envelope.task_type, 'ocr')
assert.equal(typeof envelope.result, 'string')
assert.ok(envelope.result.length > 0, 'OCR returned text')
assert.ok(typeof envelope.tool_used === 'string' && envelope.tool_used.length > 0)
assert.ok(['high', 'medium', 'low'].includes(envelope.confidence))
console.log(`[test] vision OCR ok: tool=${envelope.tool_used} resultBytes=${envelope.result.length}`)

// ── vision error path: missing input ───────────────────────────────────────
await assert.rejects(
  () => vision.execute(
    { path: resolve(pluginDir, 'definitely-missing.png'), intent: 'ocr' },
    { signal: AbortSignal.timeout(30_000) },
  ),
  /input not found/,
  'missing input rejects with a clear message',
)

// ── vision_preflight ───────────────────────────────────────────────────────
const report = await preflight.execute({}, { signal: AbortSignal.timeout(120_000) })
assert.ok(report.cloud_channels, 'preflight report has cloud_channels')
assert.ok(report.routing, 'preflight report has routing')
console.log(`[test] preflight ok: channels=${Object.keys(report.cloud_channels).length} routing=${Object.keys(report.routing).length}`)

console.log('PLUGIN TEST OK')
