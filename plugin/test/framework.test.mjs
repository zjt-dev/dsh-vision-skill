/**
 * dsh-vision-plugin framework integration test.
 *
 * Loads the plugin the way the Harness framework does — a real Cordis Context,
 * the real ToolRuntime tools registry (with a minimal systemPrompt stub for
 * its injection), and the plugin module mounted through `ctx.plugin()` with its
 * `inject: ['tools']` dependency resolution — then executes both tools through
 * the REAL tool pipeline (`ctx.tools.execute`), not a stub.
 *
 * Fiber activation is asynchronous (a plugin with `inject` stays PENDING until
 * its services activate), so the test polls for readiness instead of assuming
 * synchronous mounting.
 *
 * Run from the plugin directory:
 *
 *   node test/framework.test.mjs
 *
 * Requires `@deepseek-ai/*` packages to resolve (pnpm install in plugin/, or
 * the junction described in test/run.test.mjs) and a working powershell.exe.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import * as plugin from '../index.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const pluginDir = resolve(here, '..')

/** Minimal systemPrompt service satisfying ToolRuntime's `inject`. */
class StubSystemPrompt extends Service {
  constructor(ctx) {
    super(ctx, 'systemPrompt')
  }

  tools() {
    return []
  }
}

/** Poll until `fn()` is truthy, failing after `timeoutMs`. */
async function waitFor(fn, label, timeoutMs = 10_000) {
  const start = Date.now()
  for (;;) {
    if (fn()) return
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
  }
}

const app = new Context()
app.plugin(StubSystemPrompt)
app.plugin(ToolRuntime, { mode: 'native' })
app.plugin(plugin)

// Wait for the tools service and the plugin's registrations to activate.
await waitFor(() => app.tools !== undefined, 'tools service')
await waitFor(() => app.tools?.get('vision') !== undefined, 'vision registration')

const tools = app.tools
const vision = tools.get('vision')
assert.equal(vision.name, 'vision')
assert.ok(tools.get('vision_preflight'), 'vision_preflight tool registered in the real registry')

// Real pipeline execution: OCR against the repo sample image.
const image = resolve(pluginDir, '..', 'assets', 'star-history.png')
assert.ok(existsSync(image), `sample image exists: ${image}`)
const ocr = await tools.execute({
  callId: 'framework-test-1',
  name: 'vision',
  arguments: { path: image, intent: 'ocr', maxTokens: 200, timeoutSec: 60 },
  signal: AbortSignal.timeout(120_000),
})
assert.equal(ocr.isError, false, `vision OCR should succeed (got: ${JSON.stringify(ocr).slice(0, 300)})`)
assert.equal(ocr.value.task_type, 'ocr')
assert.ok(ocr.value.result.length > 0, 'OCR returned text')
console.log(`[framework] vision OCR ok: tool=${ocr.value.tool_used} resultBytes=${ocr.value.result.length}`)

// Real pipeline execution: preflight.
const report = await tools.execute({
  callId: 'framework-test-2',
  name: 'vision_preflight',
  arguments: {},
  signal: AbortSignal.timeout(120_000),
})
assert.equal(report.isError, false)
assert.ok(report.value.cloud_channels, 'preflight report has cloud_channels')
console.log(`[framework] preflight ok: channels=${Object.keys(report.value.cloud_channels).length}`)

// Error path through the pipeline: missing input becomes an isError result.
const missing = await tools.execute({
  callId: 'framework-test-3',
  name: 'vision',
  arguments: { path: resolve(pluginDir, 'nope.png'), intent: 'ocr' },
  signal: AbortSignal.timeout(30_000),
})
assert.equal(missing.isError, true, 'missing input is an error result')
assert.ok(missing.content[0].text.includes('input not found'), 'error message is actionable')

console.log('FRAMEWORK TEST OK')
