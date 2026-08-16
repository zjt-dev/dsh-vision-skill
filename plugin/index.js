// @ts-check
/**
 * dsh-vision-plugin — DeepSeek Harness plugin bundle.
 *
 * Registers two model-facing tools backed by the ds-vision-skill PowerShell
 * scripts (shipped in ./scripts, or pointed at by the `scriptsDir` config):
 *
 *   - `vision`          — unified visual-input router: image reasoning race,
 *                         OCR extraction, and document parsing. Runs
 *                         `scripts/vision-router.ps1 -Json` and returns the
 *                         standard JSON envelope.
 *   - `vision_preflight`— channel/tool/local-runtime availability matrix.
 *                         Runs `scripts/preflight.ps1 -Json`.
 *
 * Plugin form: function form with `inject: ['tools']` and a Schemastery
 * `Config` schema, per the DeepSeek Harness plugin tutorial (docs/user/develop/
 * basic/). Registered tools live in the global registry layer, so every agent
 * in the composition can call them unless a preset restricts them.
 *
 * Package layout (bundle manifest `dsh.bundle.patch` in package.json):
 *
 *   plugin/
 *   ├── package.json          # dsh.bundle manifest
 *   ├── cordis.patch.yml      # patch layer inserting the plugin row
 *   ├── index.js              # this file (ESM entry, no build step)
 *   ├── scripts/              # self-contained copy of the vision scripts
 *   └── README.md
 *
 * The bundle deliberately ships plain ESM JavaScript (like the official
 * `hello-plugin` tutorial) so a git install needs no `prepare` build and a
 * local checkout loads immediately.
 *
 * @module dsh-vision-plugin
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Plugin identity. */
export const name = 'dsh-vision-plugin'

/**
 * Required services. Cordis waits for the tool registry before `apply` runs.
 * `tools` is the only runtime service the plugin consumes; `shell` is
 * deliberately NOT used — the vision scripts are spawned directly so the
 * bundle stays independent of the mounted shell provider.
 */
export const inject = ['tools']

/**
 * Directory that ships with this bundle and contains the PowerShell scripts.
 * Resolved relative to this module so the default works from any install
 * location (local checkout, pnpm link, or npm package).
 */
const DEFAULT_SCRIPTS_DIR = fileURLToPath(new URL('./scripts/', import.meta.url))

/** Default PowerShell executable: Windows built-in `powershell.exe`. */
const DEFAULT_PWSH = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'

/** Hard per-stream capture cap (bytes). Prevents a runaway script from
 * ballooning the tool result; the tail of the output is preserved. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/** Grace added on top of the router's own `-TimeoutSec` before the child is
 * force-killed, so the script's internal race cap stays authoritative. */
const KILL_GRACE_MS = 30_000

/** Standard tool prompt reused when the model does not supply one. */
const DEFAULT_PROMPT = 'Analyze this visual input and return the useful content.'

/**
 * Runtime configuration. Every field is optional; the schema fills defaults.
 * Anything two deployments may want to set differently is a config field
 * (docs/user/develop/basic/config.md): script location, shell, and defaults
 * are all tunable from cordis.yml without a code edit.
 */
export const Config = z.object({
  /** Absolute path to the directory holding the vision PowerShell scripts.
   * Optional — defaults to the `scripts/` folder shipped inside this bundle. */
  scriptsDir: z.string(),
  /** PowerShell executable used to run the scripts. Defaults to
   * `powershell.exe` on Windows, `pwsh` elsewhere. */
  pwsh: z.string().default(DEFAULT_PWSH),
  /** Default `-Intent` for the `vision` tool when the model omits it. */
  defaultIntent: z.union(['auto', 'reason', 'ocr', 'document']).default('auto'),
  /** Default `-MaxTokens` (1-8192). */
  defaultMaxTokens: z.natural().min(1).max(8192).default(1024),
  /** Default `-TimeoutSec` (1-300) capping the whole routing race. */
  defaultTimeoutSec: z.natural().min(1).max(300).default(90),
  /** Timeout (seconds) for the `vision_preflight` tool (1-600). */
  preflightTimeoutSec: z.natural().min(1).max(600).default(60),
  /** Register the `vision_preflight` tool. Disable to keep the catalog lean. */
  enablePreflight: z.boolean().default(true),
})

/**
 * Output schema of the `vision` tool: the standard ds-vision-skill JSON
 * envelope. Closed object — the envelope is a fixed five-key contract
 * (task_type, tool_used, confidence, result, metadata); `metadata` itself is
 * open because routing details vary by channel.
 */
const VISION_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    task_type: {
      type: 'string',
      required: true,
      description: 'One of: reason | ocr | document_parsing',
    },
    tool_used: {
      type: 'string',
      required: true,
      description: 'The channel or script that produced the result',
    },
    confidence: {
      type: 'string',
      required: true,
      description: 'One of: high | medium | low',
    },
    result: {
      type: 'string',
      required: true,
      description: 'Recognized, parsed, or understood content',
    },
    metadata: {
      type: 'object',
      additionalProperties: true,
      required: true,
      description: 'Routing and fallback details (error, attempts, race winner)',
    },
  },
}

/** Output schema of the `vision_preflight` tool: the preflight JSON report.
 * Top-level keys are declared for the model; every object is open because the
 * report shape evolves with the script. */
const PREFLIGHT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    system: { type: 'object', additionalProperties: true },
    tools: { type: 'object', additionalProperties: true },
    local_runtimes: { type: 'object', additionalProperties: true },
    cloud_channels: { type: 'object', additionalProperties: true },
    notes: { type: 'object', additionalProperties: true },
    routing: { type: 'object', additionalProperties: true },
  },
}

/**
 * Apply the plugin: validate configuration, then register the tools.
 * Registrations made through `ctx` are cleaned up automatically when the
 * plugin unloads (Cordis Fiber lifecycle), so no manual disposer is needed.
 */
export function apply(ctx, config = {}) {
  // Cordis validates and fills defaults via the exported schema, but apply
  // still reads with `??` fallbacks mirroring those defaults so direct
  // programmatic use (and tests) behave identically.
  const scriptsDir = resolveScriptsDir(config.scriptsDir)
  const pwsh = config.pwsh ?? DEFAULT_PWSH
  const defaultIntent = config.defaultIntent ?? 'auto'
  const defaultMaxTokens = config.defaultMaxTokens ?? 1024
  const defaultTimeoutSec = config.defaultTimeoutSec ?? 90
  const preflightTimeoutSec = config.preflightTimeoutSec ?? 60
  const enablePreflight = config.enablePreflight ?? true

  ctx.tools.register(defineTool({
    name: 'vision',
    description:
      'Analyze a visual input (image, screenshot, chart, UI capture, photo, scan, or PDF) and return structured content as a JSON envelope. ' +
      'Routes automatically by file type: images go to a vision-reasoning race (GLM/Agnes) with custom and local fallbacks, OCR extraction goes to Baidu OCR then Windows OCR, ' +
      'and PDF/Office documents go to MinerU. Pass a file path plus an optional prompt describing what to read, extract, or analyze. ' +
      'The result envelope contains task_type, tool_used, confidence, result, and metadata; prefer `result` when reasoning over the content.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description:
          'Path to the image, screenshot, scan, chart, or PDF. Absolute paths are used as-is; relative paths resolve against the session working directory.',
      },
      prompt: {
        type: 'string',
        description: 'What to read, extract, or analyze. Default: "Analyze this visual input and return the useful content."',
      },
      intent: {
        type: 'string',
        enum: ['auto', 'reason', 'ocr', 'document'],
        description:
          'Routing intent: auto (default, by file type), reason (visual understanding race), ocr (plain text extraction), or document (PDF/Office parsing via MinerU).',
      },
      complex: {
        type: 'boolean',
        description: 'Enable deeper visual reasoning for charts, math, complex UI, or code screenshots.',
      },
      accurateOcr: {
        type: 'boolean',
        description: 'Use high-accuracy OCR for scans and low-quality text images.',
      },
      maxTokens: {
        type: 'integer',
        description: 'Max output tokens for the vision models, 1-8192. Default 1024 (2048 with complex).',
      },
      timeoutSec: {
        type: 'integer',
        description: 'Cap for the whole routing race in seconds, 1-300. Default 90.',
      },
      noCache: {
        type: 'boolean',
        description: 'Skip cache reads and do not write this result to cache.',
      },
    },
    output: {
      schema: VISION_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderEnvelope(value) }],
    },
    timeoutMs: (defaultTimeoutSec * 1000) + KILL_GRACE_MS,
    async execute(args, exec) {
      const inputPath = resolveInputPath(args.path, exec)
      if (!existsSync(inputPath)) {
        throw new Error(`vision: input not found: ${inputPath}`)
      }
      const router = join(scriptsDir, 'vision-router.ps1')
      if (!existsSync(router)) {
        throw new Error(`vision: vision-router.ps1 not found in scriptsDir: ${scriptsDir} (set the "scriptsDir" config to the ds-vision-skill scripts directory)`)
      }
      const timeoutSec = args.timeoutSec ?? defaultTimeoutSec
      const maxTokens = args.maxTokens ?? defaultMaxTokens
      const scriptArgs = [
        '-Path', inputPath,
        '-Intent', args.intent ?? defaultIntent,
        '-Prompt', args.prompt ?? DEFAULT_PROMPT,
        '-MaxTokens', String(maxTokens),
        '-TimeoutSec', String(timeoutSec),
        '-Json',
      ]
      if (args.complex) scriptArgs.push('-Complex')
      if (args.accurateOcr) scriptArgs.push('-AccurateOcr')
      if (args.noCache) scriptArgs.push('-NoCache')
      const result = await runPowerShell(pwsh, router, scriptArgs, {
        timeoutMs: (timeoutSec * 1000) + KILL_GRACE_MS,
        signal: exec?.signal,
      })
      assertNotKilled(result, (timeoutSec * 1000) + KILL_GRACE_MS, 'vision')
      return parseEnvelope(result, 'vision-router.ps1')
    },
    presentCall(args) {
      return { card: 'generic', title: 'Vision analyze', kind: 'vision', rawInput: args.path }
    },
    presentResult(args, value) {
      return { card: 'terminal', title: `Vision: ${args.path}`, output: renderEnvelope(value) }
    },
  }))

  if (enablePreflight) {
    ctx.tools.register(defineTool({
      name: 'vision_preflight',
      description:
        'Check which vision channels, OCR providers, document parsers, and local runtimes are configured and reachable. ' +
        'Returns the JSON availability matrix from preflight.ps1: cloud_channels (glm, glm-thinking, agnes, baidu-ocr, custom slots), tools, local_runtimes, and routing. ' +
        'Run this during initial setup or when the vision tool keeps failing — not before every normal analysis.',
      parameters: {},
      output: {
        schema: PREFLIGHT_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: renderPreflight(value) }],
      },
      timeoutMs: (preflightTimeoutSec * 1000) + KILL_GRACE_MS,
      async execute(_args, exec) {
        const script = join(scriptsDir, 'preflight.ps1')
        if (!existsSync(script)) {
          throw new Error(`vision_preflight: preflight.ps1 not found in scriptsDir: ${scriptsDir}`)
        }
        const result = await runPowerShell(pwsh, script, ['-Json'], {
          timeoutMs: (preflightTimeoutSec * 1000) + KILL_GRACE_MS,
          signal: exec?.signal,
        })
        assertNotKilled(result, (preflightTimeoutSec * 1000) + KILL_GRACE_MS, 'vision_preflight')
        const text = result.stdout.trim()
        if (!text) {
          throw new Error(`vision_preflight: preflight.ps1 produced no output (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 2000)}`)
        }
        try {
          return JSON.parse(text)
        } catch {
          throw new Error(`vision_preflight: preflight.ps1 did not return JSON: ${text.slice(0, 2000)}`)
        }
      },
      presentCall() {
        return { card: 'generic', title: 'Vision preflight', kind: 'vision' }
      },
      presentResult(_args, value) {
        return { card: 'terminal', title: 'Vision preflight', output: renderPreflight(value) }
      },
    }))
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve the scripts directory: explicit config wins, otherwise the
 * `scripts/` folder shipped inside this bundle.
 */
function resolveScriptsDir(configured) {
  if (configured) {
    if (typeof configured !== 'string' || configured.trim() === '') {
      throw new Error('dsh-vision-plugin: "scriptsDir" must be a non-empty absolute path')
    }
    return resolve(configured)
  }
  return DEFAULT_SCRIPTS_DIR
}

/**
 * Resolve a model-supplied path: absolute paths pass through; relative paths
 * resolve against the agent session working directory (like dsh-tool-pwsh),
 * falling back to the host process cwd.
 */
function resolveInputPath(raw, exec) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('vision: "path" must be a non-empty string')
  }
  if (isAbsolute(raw)) return raw
  const headerCwd = exec?.agent?.session?.header?.cwd
  return resolve(headerCwd || process.cwd(), raw)
}

/**
 * Run a PowerShell script with argument array (no shell interpolation), UTF-8
 * capture of stdout/stderr with a byte cap, a hard kill timer, and abort
 * propagation from the tool's AbortSignal. Settles only after the child has
 * actually exited, honoring the cooperative-cancellation contract.
 *
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string, stdoutTruncated: boolean, stderrTruncated: boolean, timedOut: boolean, aborted: boolean}>}
 */
function runPowerShell(pwsh, scriptPath, scriptArgs, { timeoutMs, signal }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const stdoutState = { bytes: 0, truncated: false, chunks: [] }
    const stderrState = { bytes: 0, truncated: false, chunks: [] }
    let timedOut = false
    let aborted = false
    let settled = false
    /** @type {ReturnType<typeof spawn> | undefined} */
    let child

    const killTimer = setTimeout(() => {
      timedOut = true
      child?.kill()
    }, timeoutMs)

    const onAbort = () => {
      aborted = true
      child?.kill()
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    const settle = (err, value) => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      signal?.removeEventListener('abort', onAbort)
      if (err) rejectPromise(err)
      else resolvePromise(value)
    }

    /** Collect a stream chunk under the byte cap, remembering truncation. */
    const collect = (state, chunk) => {
      if (state.bytes >= MAX_OUTPUT_BYTES) {
        state.truncated = true
        return
      }
      const remaining = MAX_OUTPUT_BYTES - state.bytes
      if (chunk.length > remaining) {
        state.chunks.push(chunk.subarray(0, remaining))
        state.truncated = true
      } else {
        state.chunks.push(chunk)
      }
      state.bytes += Math.min(chunk.length, remaining)
    }

    try {
      child = spawn(pwsh, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...scriptArgs], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      })
    } catch (err) {
      settle(err, null)
      return
    }

    child.stdout.on('data', (chunk) => collect(stdoutState, chunk))
    child.stderr.on('data', (chunk) => collect(stderrState, chunk))

    child.on('error', (err) => {
      settle(new Error(`vision: failed to launch ${pwsh}: ${err.message}`), null)
    })

    child.on('close', (code, _signal) => {
      if (settled) return
      settle(null, {
        exitCode: code,
        stdout: Buffer.concat(stdoutState.chunks).toString('utf8'),
        stderr: Buffer.concat(stderrState.chunks).toString('utf8'),
        stdoutTruncated: stdoutState.truncated,
        stderrTruncated: stderrState.truncated,
        timedOut,
        aborted,
      })
    })
  })
}

/**
 * Turn a killed run (abort or hard timeout) into a specific error instead of a
 * confusing "no JSON envelope" failure.
 */
function assertNotKilled(result, timeoutMs, toolName) {
  if (result.aborted) throw new Error(`${toolName}: aborted`)
  if (result.timedOut) throw new Error(`${toolName}: timed out after ${timeoutMs}ms`)
}

/**
 * Parse the router's stdout as the standard envelope. The router prints a JSON
 * envelope on BOTH success and fallback failure (the envelope then carries
 * `confidence: "low"` and `metadata.error`); only hard failures (missing
 * input, script errors) produce non-JSON output and a non-zero exit. So: a
 * parseable envelope is the canonical value regardless of exit code; anything
 * else becomes an error result the model can react to.
 */
function parseEnvelope(result, scriptName) {
  const stdout = result.stdout.trim()
  if (stdout) {
    try {
      const parsed = JSON.parse(stdout)
      if (parsed && typeof parsed === 'object' && typeof parsed.task_type === 'string') {
        return parsed
      }
    } catch {
      // Not JSON — fall through to the error path.
    }
  }
  const detail = (result.stderr.trim() || stdout || `exit code ${result.exitCode}`).slice(0, 2000)
  throw new Error(`vision: ${scriptName} did not return a JSON envelope: ${detail}`)
}

/**
 * Model-facing text for a vision envelope: a compact header line, the result
 * body, then any routing/fallback details worth surfacing.
 */
function renderEnvelope(value) {
  const parts = []
  parts.push(`[${value.task_type}] tool=${value.tool_used} confidence=${value.confidence}`)
  if (typeof value.result === 'string' && value.result) parts.push(value.result)
  const meta = value.metadata
  if (meta && typeof meta === 'object') {
    if (typeof meta.error === 'string' && meta.error) parts.push(`[error] ${meta.error}`)
    if (meta.race && typeof meta.race === 'object' && typeof meta.race.winner === 'string') {
      parts.push(`[race] winner=${meta.race.winner}`)
    }
  }
  return parts.join('\n')
}

/** Model-facing text for a preflight report: one line per channel group. */
function renderPreflight(value) {
  const lines = []
  const channels = value.cloud_channels
  if (channels && typeof channels === 'object') {
    for (const [channel, ok] of Object.entries(channels)) {
      lines.push(`${ok ? '[ok]' : '[missing]'} ${channel}`)
    }
  }
  const runtimes = value.local_runtimes
  if (runtimes && typeof runtimes === 'object') {
    for (const [runtime, state] of Object.entries(runtimes)) {
      lines.push(`[local] ${runtime}=${state}`)
    }
  }
  const notes = value.notes
  if (notes && typeof notes === 'object') {
    for (const [note, flag] of Object.entries(notes)) {
      if (flag) lines.push(`[note] ${note}`)
    }
  }
  if (lines.length === 0) return JSON.stringify(value)
  return lines.join('\n')
}
