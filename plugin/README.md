# dsh-vision-plugin

A **DeepSeek Harness plugin bundle** that gives text-first agents a vision layer:
image reasoning, OCR extraction, and document parsing, delivered as two
model-callable tools backed by the [ds-vision-skill](https://github.com/Sorwcyra/ds-vision-skill)
PowerShell scripts (shipped inside this bundle, self-contained).

It does not replace the main model. The tools detect the visual task, choose the
best route, race fast cloud vision channels when available, fall back through
custom and local options, and return one structured JSON envelope for the main
model to reason over.

| Tool | What it does | Backing script |
|---|---|---|
| `vision` | Analyze any image, screenshot, chart, scan, UI capture, or PDF | `scripts/vision-router.ps1 -Json` |
| `vision_preflight` | Availability matrix of channels, OCR, parsers, and local runtimes | `scripts/preflight.ps1 -Json` |

## Requirements

- Windows with PowerShell (the scripts use `powershell.exe`, which ships with
  Windows; OCR falls back to the built-in Windows OCR engine).
- DeepSeek Harness with the `dsh` CLI installed (`dsh --version`).
- Optional: cloud API keys for the vision race (GLM / Agnes), Baidu OCR, or
  MinerU — configure them once with the bundled `scripts\setup.cmd`.

## Install

The bundle ships a `dsh.bundle` manifest (`package.json`), so it installs as a
configuration layer into any profile:

```sh
# from the directory containing the bundle (e.g. the plugin/ folder)
dsh plugin --profile web add ./plugin

# verify the composed layer without booting
dsh --profile web --dump-config

# boot the profile
dsh --profile web
```

Alternatives for distributing the bundle:

```sh
# from a git host (shallow sources; the bundle is plain ESM so no build step)
dsh plugin --profile web add github:you/dsh-vision-plugin#<sha>

# from a packed tarball
pnpm pack            # inside plugin/
dsh plugin --profile web add ./dsh-vision-plugin-0.1.0.tgz
```

To remove: `dsh plugin --profile web remove dsh-vision-plugin`.

### Try it without touching a profile

Any profile accepts a one-off overlay (the plugin row's `name` resolves like an
installed package, so install the bundle first for a real boot):

```sh
dsh --profile web --patch ./plugin/cordis.patch.yml
```

## Configuration

All fields are optional; the plugin's Schemastery schema fills defaults. Edit
them in the profile's `cordis.patch.yml` (a later layer overrides the bundle
row by id — restate every key you want to keep):

```yaml
- id: vision-skill
  config:
    scriptsDir: 'C:\path\to\ds-vision-skill\scripts'  # default: the bundle's own scripts/
    pwsh: 'powershell.exe'                             # default by platform
    defaultIntent: 'auto'                              # auto | reason | ocr | document
    defaultMaxTokens: 1024                             # 1-8192
    defaultTimeoutSec: 90                              # 1-300
    preflightTimeoutSec: 60                            # 1-600
    enablePreflight: true                              # register vision_preflight
```

`scriptsDir` lets a deployment point the tools at a separate ds-vision-skill
checkout instead of the scripts shipped in the bundle.

## Using the tools

From the Web UI or any agent session, ask naturally:

> “Analyze `screenshots/ui.png` and describe the layout.”
> “OCR `scans/invoice.jpg` and extract the total.”
> “Parse `reports/paper.pdf` and summarize it.”

The `vision` tool parameters:

| Parameter | Type | Meaning |
|---|---|---|
| `path` | string, required | Image / screenshot / scan / chart / PDF path. Absolute paths pass through; relative paths resolve against the session working directory. |
| `prompt` | string | What to read, extract, or analyze. |
| `intent` | enum | `auto` (by file type), `reason`, `ocr`, `document`. |
| `complex` | boolean | Deeper visual reasoning for charts, math, complex UI, code screenshots. |
| `accurateOcr` | boolean | High-accuracy OCR for scans and low-quality text. |
| `maxTokens` | integer | 1-8192; default 1024 (2048 with `complex`). |
| `timeoutSec` | integer | 1-300; caps the whole routing race. |
| `noCache` | boolean | Skip cache reads and writes. |

### JSON contract

`vision` returns the standard ds-vision-skill envelope as its canonical value:

```json
{
  "task_type": "reason | ocr | document_parsing",
  "tool_used": "actual tool or model",
  "confidence": "high | medium | low",
  "result": "recognized, parsed, or understood content",
  "metadata": {}
}
```

Prefer `result` when reasoning over the content; use `tool_used`, `confidence`,
and `metadata` to explain routing or fallback behavior. When every route fails,
the envelope still comes back with `confidence: "low"` and
`metadata.error`/`metadata.attempts` — the model sees the failure as a result,
not a crash.

### Routing order

```text
image reasoning: race(agnes-2.5-flash, agnes-2.0-flash, glm, glm-thinking) -> custom-1 -> custom-2 -> custom-3 -> local
ocr:             baidu-ocr -> windows-ocr -> vision reasoning
document:        mineru flash -> mineru extract
```

## Configuring channels

Keys are read from the process, user, or machine environment (the scripts check
all three scopes). Use the bundled setup helper, which is safe in harnesses
that default to `cmd.exe`:

```cmd
scripts\setup.cmd -SetKey -Channel glm -Key "YOUR_GLM_API_KEY" -Verify
scripts\setup.cmd -SetKey -Channel agnes-2.5-flash -Key "YOUR_AGNES_API_KEY" -Verify
scripts\setup.cmd -SetKey -Channel baidu-ocr -Key "YOUR_BAIDU_API_KEY" -Secret "YOUR_BAIDU_SECRET_KEY" -Verify
scripts\setup.cmd -SetCustom -Slot 1 -BaseUrl "https://example.com/v1/chat/completions" -Key "YOUR_API_KEY" -Model "YOUR_MODEL" -Verify
scripts\setup.cmd -Status
```

Then check the result from the model side: “Run `vision_preflight`.” Or run the
script directly:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\preflight.ps1 -Json
```

## Privacy

Cloud channels send file content to the corresponding provider. For contracts,
IDs, medical material, financial files, or other sensitive content, prefer
Windows OCR or a local model (Ollama / LM Studio / llama.cpp), or confirm with
the user before sending files to cloud services.

## Layout

```
plugin/
├── package.json          # dsh.bundle manifest (patch layer, deps, metadata)
├── cordis.patch.yml      # the configuration layer applied on install
├── index.js              # plugin entry: registers vision + vision_preflight
├── scripts/              # self-contained copy of the ds-vision-skill scripts
│   ├── vision-router.ps1 # unified router (image reasoning / OCR / document)
│   ├── preflight.ps1     # channel availability matrix
│   ├── vlm-vision.ps1    # OpenAI-compatible vision caller (race + custom)
│   ├── baidu-ocr.ps1     # Baidu Cloud OCR
│   ├── windows-ocr.ps1   # offline Windows OCR
│   ├── mineru-extract.ps1# MinerU document parsing
│   ├── setup.ps1/.cmd    # channel configuration helper
│   └── local-select.ps1  # local runtime model picker
└── README.md
```

The bundle is plain ESM JavaScript with no build step, so local checkouts, git
installs, and tarballs all load identically (per the Harness publish
guidance: a git install runs no `build` script, so shipping built JS keeps the
bundle directly usable).

## Development

```sh
node --check index.js                    # syntax check
node test/run.test.mjs                   # integration test (stubbed ctx.tools)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\smoke-test.ps1   # from the repo root
```

See the [ds-vision-skill repository](https://github.com/Sorwcyra/ds-vision-skill)
for the full project (benchmarks, channel reference, update tooling) and the
[DeepSeek Harness plugin tutorial](https://deepseek-harness.github.io/deepseek-harness/develop/basic/)
for the plugin model this bundle follows.

## License

MIT — see [LICENSE](LICENSE).
