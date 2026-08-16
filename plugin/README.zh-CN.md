# dsh-vision-plugin

**DeepSeek Harness 插件包**，为纯文本智能体提供视觉能力：图像推理、OCR 文字提取与文档解析，以两个模型可调用的工具形式提供，底层由 [ds-vision-skill](https://github.com/Sorwcyra/ds-vision-skill) PowerShell 脚本驱动（已随包内置，开箱即用）。

它不替代主模型。工具会识别视觉任务类型、选择最佳路由：可用时并发竞速多个云端视觉通道，依次回退到自定义与本地通道，最终返回一个结构化 JSON 信封，供主模型基于其内容进行推理。

| 工具 | 功能 | 底层脚本 |
|---|---|---|
| `vision` | 分析任意图片、截图、图表、扫描件、界面截图或 PDF | `scripts/vision-router.ps1 -Json` |
| `vision_preflight` | 通道、OCR、解析器与本地运行时的可用性矩阵 | `scripts/preflight.ps1 -Json` |

## 环境要求

- Windows 系统并带有 PowerShell（脚本使用系统自带的 `powershell.exe`；OCR 回退到内置的 Windows OCR 引擎）。
- 已安装 DeepSeek Harness 及 `dsh` CLI（`dsh --version`）。
- 可选：用于视觉竞速的云端 API 密钥（GLM / Agnes）、百度 OCR 或 MinerU——使用随包提供的 `scripts\setup.cmd` 配置一次即可。

## 安装

本包自带 `dsh.bundle` 清单（`package.json`），可作为配置层安装到任意 profile：

```sh
# 在包含本包的目录下执行（例如 plugin/ 目录）
dsh plugin --profile web add ./plugin

# 不启动即可验证组合后的配置层
dsh --profile web --dump-config

# 启动 profile
dsh --profile web
```

其他分发方式：

```sh
# 从 git 仓库安装（浅拷贝；本包为纯 ESM，无需构建步骤）
dsh plugin --profile web add github:you/dsh-vision-plugin#<sha>

# 从打包的 tarball 安装
pnpm pack            # 在 plugin/ 内执行
dsh plugin --profile web add ./dsh-vision-plugin-0.1.0.tgz
```

卸载：`dsh plugin --profile web remove dsh-vision-plugin`。

### 不修改 profile 试运行

任意 profile 都接受一次性叠加层（插件行的 `name` 按已安装包解析，因此真实启动前需先安装本包）：

```sh
dsh --profile web --patch ./plugin/cordis.patch.yml
```

## 配置

所有字段均可选，插件会通过 Schemastery schema 填充默认值。在 profile 的 `cordis.patch.yml` 中修改（后续层按 id 覆盖本包的行——需要保留的键都要重新写上）：

```yaml
- id: vision-skill
  config:
    scriptsDir: 'C:\path\to\ds-vision-skill\scripts'  # 默认：本包自带的 scripts/
    pwsh: 'powershell.exe'                             # 默认按平台选择
    defaultIntent: 'auto'                              # auto | reason | ocr | document
    defaultMaxTokens: 1024                             # 1-8192
    defaultTimeoutSec: 90                              # 1-300
    preflightTimeoutSec: 60                            # 1-600
    enablePreflight: true                              # 是否注册 vision_preflight
```

`scriptsDir` 可让部署指向独立的 ds-vision-skill 检出目录，而不是使用包内自带的脚本。

## 使用工具

在 Web UI 或任意智能体会话中直接自然语言提问：

> “分析 `screenshots/ui.png` 并描述其布局。”
> “对 `scans/invoice.jpg` 做 OCR，提取总金额。”
> “解析 `reports/paper.pdf` 并总结内容。”

`vision` 工具参数：

| 参数 | 类型 | 含义 |
|---|---|---|
| `path` | string，必填 | 图片 / 截图 / 扫描件 / 图表 / PDF 路径。绝对路径原样使用；相对路径基于会话工作目录解析。 |
| `prompt` | string | 要读取、提取或分析的内容说明。 |
| `intent` | enum | `auto`（按文件类型自动判断）、`reason`、`ocr`、`document`。 |
| `complex` | boolean | 对图表、数学题、复杂界面、代码截图启用更深度的视觉推理。 |
| `accurateOcr` | boolean | 对扫描件和低质量文字使用高精度 OCR。 |
| `maxTokens` | integer | 1-8192；默认 1024（开启 `complex` 时为 2048）。 |
| `timeoutSec` | integer | 1-300；限制整个路由竞速的时长上限。 |
| `noCache` | boolean | 跳过缓存读取与写入。 |

### JSON 契约

`vision` 返回标准的 ds-vision-skill 信封作为规范结果：

```json
{
  "task_type": "reason | ocr | document_parsing",
  "tool_used": "actual tool or model",
  "confidence": "high | medium | low",
  "result": "recognized, parsed, or understood content",
  "metadata": {}
}
```

基于内容推理时优先使用 `result`；用 `tool_used`、`confidence` 和 `metadata` 解释路由或回退行为。所有路由都失败时，信封仍会返回，此时 `confidence: "low"`，并在 `metadata.error` / `metadata.attempts` 中给出失败详情——模型看到的是“结果”而不是崩溃。

### 路由顺序

```text
image reasoning: race(agnes-2.5-flash, agnes-2.0-flash, glm, glm-thinking) -> custom-1 -> custom-2 -> custom-3 -> local
ocr:             baidu-ocr -> windows-ocr -> vision reasoning
document:        mineru flash -> mineru extract
```

## 配置通道

密钥从进程、用户或机器环境变量中读取（脚本会检查全部三个作用域）。使用随包提供的配置助手（在默认 `cmd.exe` 的 harness 环境中也安全）：

```cmd
scripts\setup.cmd -SetKey -Channel glm -Key "YOUR_GLM_API_KEY" -Verify
scripts\setup.cmd -SetKey -Channel agnes-2.5-flash -Key "YOUR_AGNES_API_KEY" -Verify
scripts\setup.cmd -SetKey -Channel baidu-ocr -Key "YOUR_BAIDU_API_KEY" -Secret "YOUR_BAIDU_SECRET_KEY" -Verify
scripts\setup.cmd -SetCustom -Slot 1 -BaseUrl "https://example.com/v1/chat/completions" -Key "YOUR_API_KEY" -Model "YOUR_MODEL" -Verify
scripts\setup.cmd -Status
```

然后从模型侧验证结果：让它“运行 `vision_preflight`”，或直接执行脚本：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\preflight.ps1 -Json
```

## 隐私

云端通道会把文件内容发送给对应的服务商。合同、证件、医疗资料、财务文件或其他敏感内容，建议优先使用 Windows OCR 或本地模型（Ollama / LM Studio / llama.cpp），或在发送文件到云端服务前与用户确认。

## 目录结构

```
plugin/
├── package.json          # dsh.bundle 清单（补丁层、依赖、元数据）
├── cordis.patch.yml      # 安装时应用的配置层
├── index.js              # 插件入口：注册 vision + vision_preflight
├── scripts/              # 自带的 ds-vision-skill 脚本副本
│   ├── vision-router.ps1 # 统一路由（图像推理 / OCR / 文档解析）
│   ├── preflight.ps1     # 通道可用性矩阵
│   ├── vlm-vision.ps1    # OpenAI 兼容视觉调用器（竞速 + 自定义）
│   ├── baidu-ocr.ps1     # 百度云 OCR
│   ├── windows-ocr.ps1   # 离线 Windows OCR
│   ├── mineru-extract.ps1# MinerU 文档解析
│   ├── setup.ps1/.cmd    # 通道配置助手
│   └── local-select.ps1  # 本地运行时模型选择器
├── README.md             # 英文文档
└── README.zh-CN.md       # 中文文档（本文件）
```

本包为纯 ESM JavaScript、无构建步骤，本地检出、git 安装与 tarball 安装加载行为完全一致（遵循 Harness 发布规范：git 安装不执行 `build` 脚本，因此直接随包携带源码即可使用）。

## 开发

```sh
node --check index.js                    # 语法检查
node test/run.test.mjs                   # 集成测试（stubbed ctx.tools）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\smoke-test.ps1   # 在仓库根目录执行
```

完整的项目（基准测试、通道参考、更新工具）参见 [ds-vision-skill 仓库](https://github.com/Sorwcyra/ds-vision-skill)，本包遵循的插件模型参见 [DeepSeek Harness 插件教程](https://deepseek-harness.github.io/deepseek-harness/develop/basic/)。

## 许可证

MIT——见 [LICENSE](LICENSE)。
