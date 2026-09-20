#!/usr/bin/env node
"use strict";

// 原地翻译方案由 hjkl950217 在 PR #238 提供。只改变字符串占位内的内容，
// 保留 Bun 数据布局；备份、签名和启动验证完成后才替换用户的可执行文件。
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const io = require("../bun-binary-io.js");

// spinner 完成态/进度词：传统 Layer 4 在 patch-cli.js 用结构锚定替换它们，
// bytecode 容器按常量池整串匹配即可。这些词在常量池里只作显示值（无逻辑
// 比较/对象键），整串替换安全；Baked 桶短译成双字才放得下。
// 词表与 patch-cli.js 的 statusVerbs / 动词数组同源（后者是 Layer 4 的锚点），
// 改动其中一处时两处都要跟。
const BUILTIN_SPINNER_TRANSLATIONS = [
  { en: "Baked", zh: "烤了" },
  { en: "Brewed", zh: "沏了" },
  { en: "Churned", zh: "翻搅了" },
  { en: "Cogitated", zh: "琢磨了" },
  { en: "Cooked", zh: "烹饪了" },
  { en: "Crunched", zh: "嚼了" },
  { en: "Sautéed", zh: "翻炒了" },
  { en: "Saut\\xE9ed", zh: "翻炒了" },
  { en: "Worked", zh: "忙活了" },
  { en: "Thought", zh: "思考了" },
  { en: "almost done thinking", zh: "即将完成思考" },
  { en: "thinking some more", zh: "继续思考中" },
  { en: "thinking more", zh: "深入思考" },
  { en: "still thinking", zh: "仍在思考" },
  { en: "Needs input", zh: "需要输入" },
  { en: "Ready for review", zh: "待审核" },
];

// 粘贴/截断附件的协议占位符碎片。Bun 把 `[Pasted text #${id} +${n} lines]` 这类
// 运行时解析的模板拆成常量池静态段，翻译任一静态段都会让识别附件的正则失配，
// 模型只收到占位符字面量而不是真实粘贴内容。patch-cli.js 的
// isProtectedProtocolLiteral 只覆盖明文路径，这里补齐 bytecode 池。
// 注意 ` more lines]` 是折叠行数提示的 UI 文案，可翻译，不在保护之列。
const PROTOCOL_FRAGMENTS = new Set([
  "[Pasted text #",
  " lines]",
  "[...Truncated text",
  "[Image #",
]);

// `Shell cwd was reset to <dir>` 由明文正则（Egt）消费，用于把执行目录复位；
// 翻译会让解析失配、后续命令跑到错误目录。池里暂无完整条目，守卫纯属防御。
// `Agent "`（minify 名 `Wet`）与 `" finished`（`Xir`）是逻辑前缀/后缀对：agent
// 任务列表靠 `startsWith(Wet) && endsWith(Xir)` 识别完成通知，同一常量还用于生成
// 模型可见的 `<task-notification>` 摘要。池里确有 7B `Agent "` 条目，翻译会让任务
// 识别失配、协议混入中文，必须拒绝。
const LOGIC_CONSUMED_FRAGMENTS = new Set([
  "Shell cwd was reset to ",
  'Agent "',
]);

// 池内专用译文。两类用途：
// 1) 修正主表里放不进窄槽的条目（如 ctrl+o，主表长译 24B 装不进 19B 窄槽）；
// 2) 只在 Bun 常量池里作展示片段的串——写进 cli-translations.json 会让明文路径
//    （patch-cli.js）在协议模板或提示词里误替换，故只在此维护、不走主表。
// 槽宽来自 2.1.260 实测，译文超宽会被静默跳过，改动后用测试核对。
const POOL_TRANSLATIONS = new Map([
  [" (ctrl+o to expand)", " ctrl+o展开"],
  ["Added ", "新增 "],
  [" lines", " 行"],
  [" completed", " 已完成"],
  ["timeout ", "超时 "],
  [" · timeout ", " ·超时 "],
  [" for ", "耗时"], // 5B 窄槽最多 2 个单元；`思考了 for 7s` -> `思考了耗时7s`
  ["searched for", "搜索了"],
  ["patterns", "个模式"], // 单数 `pattern` 与 Grep 工具参数共享，不动
  // 2.1.260 用户反馈缺口：Waiting for task 前缀、chord 附加指示、后台 agent
  // 启动/完成、Goal 状态词、Task Output 工具名。均只在池里作展示片段，进主表
  // 会被明文路径在协议模板/提示词里误替换。槽宽来自本机 2.1.260 实测。
  ["\xA0\xA0\xA0\xA0\xA0Waiting for task", "\xA0\xA0等待任务"],
  ["give additional instructions", "给出额外指示"],
  [" background agents launched", " 个后台 Agent 启动"],
  ['Background agent "', '后台 Agent"'],
  [" finished", " 已完成"],
  ["Goal achieved", "目标已达成"],
  ["Goal could not be achieved", "目标未能达成"],
  ["Goal not yet met… continuing", "目标尚未达成…继续"],
  ["Task Output", "任务输出"],
  // 上下文压缩后 banner `✻ Conversation compacted (ctrl+o for history)` 又显示英文：
  // 主表键 `✻ Conversation compacted (` 不匹配池条目（✻ 由组件单独渲染，@111563738
  // children:[mB,"Conversation compacted (",Aw," for history)"]），池里是 24B 的
  // `Conversation compacted (`。尾段 ` for history)` 还被 summarized hint @112441011
  // 的模板共用，头段一并翻避免中英混。`ctrl+o` 是键位变量（保留），` for history`
  // （12B）是 Compacted 状态行 detail（@111406312 `${f} for history`）。槽宽实测。
  ["Conversation compacted (", "对话已压缩（"],
  ["Conversation summarized (", "对话已摘要（"],
  [" for history)", " 查看历史）"],
  [" for history", " 查看历史"],
]);

// 2.1.278 CLI 帮助文本（claude --help / --cloud / --plugin / auto-mode 等）在 Bun 常量池里
// 的整段条目。只在池里作展示，不进主表：写进 cli-translations.json 会让明文路径在别处误替换。
// 窄槽上限即该条 English 的字符数，中文按 UTF-16 计，译文长度必须 <= floor(en.length / 2)，
// 超出会被 patchStringPool 静默跳过（tooLong）。槽宽与命中均为本机 2.1.278 实测。
const POOL_HELP_TRANSLATIONS = new Map([
  ["JSON object defining custom agents (e.g. '{\"reviewer\": {\"description\": \"Reviews code\", \"prompt\": \"You are a code reviewer\"}}')", "定义自定义 Agent 的 JSON 对象（如 '{\"reviewer\": {...}}'）"],
  ["Comma or space-separated list of tool names to allow (e.g. \"Bash(git *) Edit\")", "允许的工具名，逗号或空格分隔（如 \"Bash(git *) Edit\"）"],
  ["Start the session in the background and return immediately. Prints the id that `claude attach`, `logs`, `stop` and `rm` take; `claude agents` lists them. With --resume <session-id>, continues that session in the background under the same ID, or starts a copy and says so when the session is already running", "在后台启动会话并立即返回。输出的 id 可交给 `claude attach`、`logs`、`stop`、`rm`；`claude agents` 列出全部。配合 --resume <session-id> 时，以同一 ID 在后台继续该会话；若会话已在运行，则启动副本并提示"],
  ["Beta headers to include in API requests (API key users only)", "API 请求携带的 Beta 头（仅 API key 用户）"],
  ["Create a cloud session with the given description, or attach to an existing one by session ID or claude.ai/code URL", "按给定描述创建云会话，或按会话 ID 或 claude.ai/code URL 接入已有会话"],
  ["Comma or space-separated list of tool names to deny (e.g. \"Bash(git *) Edit\")", "拒绝的工具名，逗号或空格分隔（如 \"Bash(git *) Edit\"）"],
  ["Create a new cloud session that runs on the given self-hosted environment (ccpool_...).", "创建运行在指定自托管环境（ccpool_...）上的新云会话。"],
  ["Move per-machine sections (cwd, env info, memory paths, git status) from the system prompt into the first user message. Improves cross-user prompt-cache reuse. Only applies with the default system prompt (ignored with --system-prompt).", "把随机器变化的部分（cwd、环境信息、memory 路径、git 状态）从系统提示词移入首条用户消息，提升跨用户 prompt 缓存复用。仅对默认系统提示词生效（用 --system-prompt 时忽略）。"],
  ["Enable automatic fallback to specified model(s) when the default model is overloaded or not available. Accepts a comma-separated list to try each in order. Re-tries the primary at the start of each user turn.", "默认模型过载或不可用时自动回退到指定模型。可用逗号分隔多个模型按序尝试，并在每轮用户输入开始时重试主模型。"],
  ["When resuming, create a new session ID instead of reusing the original (use with --resume or --continue)", "恢复时新建会话 ID，而非复用原 ID（配合 --resume 或 --continue 使用）"],
  ["Forward subagent text and thinking blocks as assistant/user messages with parent_tool_use_id set (only works with --print and --output-format=stream-json)", "按 parent_tool_use_id 转发 subagent 文本与 thinking 块（仅配 --print、stream-json 输出）"],
  ["Error: --prompt-suggestions requires --print and --output-format=stream-json (prompt_suggestion messages are only surfaced in stream-json output).", "错误：--prompt-suggestions 需要 --print 与 --output-format=stream-json"],
  ["Include all hook lifecycle events in the output stream (only works with --output-format=stream-json)", "输出流含所有 hook 生命周期事件（仅配 --output-format=stream-json）"],
  ["Include partial message chunks as they arrive (only works with --print and --output-format=stream-json)", "消息分片到达即输出（仅配 --print 与 --output-format=stream-json）"],
  ["JSON Schema for structured output validation. Example: {\"type\":\"object\",\"properties\":{\"name\":{\"type\":\"string\"}},\"required\":[\"name\"]}", "结构化输出校验用的 JSON Schema（示例见文档）"],
  ["Model for the current session. Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name (e.g. 'claude-fable-5').", "当前会话的模型。可给最新模型的别名（如 'fable'、'opus'、'sonnet'）或完整模型名（如 'claude-fable-5'）。"],
  ["Output format (only works with --print): \"text\" (default), \"json\" (single result), or \"stream-json\" (realtime streaming)", "输出格式（仅配合 --print）：\"text\"（默认）、\"json\"（单结果）或 \"stream-json\"（实时流）"],
  ["Who answers permission prompts with --print: \"host\" (the SDK host or --permission-prompt-tool) or \"none\" (nobody: anything that would prompt is denied automatically; the permission mode still decides everything else)", "--print 下由谁应答权限提示：\"host\"（SDK 宿主或 --permission-prompt-tool）或 \"none\"（无人应答：任何需要提示的操作都自动拒绝；权限模式仍决定其余行为）"],
  ["no approval surface in this session; permission request denied automatically", "本会话无批准入口；权限请求自动拒绝"],
  ["Load a plugin from a directory or .zip for this session only; a folder of plugins loads each child (repeatable: --plugin-dir A --plugin-dir B.zip)", "仅本会话从目录或 .zip 加载插件；文件夹会加载其中每个插件（可重复：--plugin-dir A --plugin-dir B.zip）"],
  ["Fetch a plugin .zip from a URL for this session only (repeatable: --plugin-url A --plugin-url B)", "仅本会话从 URL 取插件 .zip（可重复 --plugin-url A/B）"],
  ["Print response and exit (useful for pipes). Note: The workspace trust dialog is skipped when Claude is run in non-interactive mode (via -p, or when stdout is not a TTY, e.g. piped or redirected output). Only use this in directories you trust. Settings files that fail validation are silently ignored in this mode (no error dialog is shown).", "打印回复后退出（适合管道）。注意：非交互模式（-p，或 stdout 非 TTY，如管道或重定向输出）会跳过工作区信任对话框，请只在信任的目录中使用；此模式下校验失败的设置文件会被静默忽略（不弹错误框）。"],
  ["Re-emit user messages from stdin back on stdout for acknowledgment (only works with --input-format=stream-json and --output-format=stream-json)", "回显 stdin 消息以便确认（仅限 stream-json 输入输出）"],
  ["Read the initialize control request from stdin during startup so its launch-scoped fields (plugins) apply exactly like their command-line flags. Pass it only from the process that writes that request as the first stdin line at spawn (only works with --input-format=stream-json)", "启动时从 stdin 读取 initialize 控制请求，使其启动范围字段（plugins）像命令行参数一样生效。仅应由在启动时把该请求作为首行 stdin 写入的进程传入（仅配合 --input-format=stream-json）"],
  ["Restricted mode: removes the built-in tools that run commands or code (Bash, PowerShell, REPL and the other code-running tools) and WebFetch unless --tools names them, and ignores user, project and local settings files (managed settings and --settings still apply; add --strict-mcp-config to skip MCP servers too). Also confines the file tools to the working directories (--add-dir included), refuses bypassPermissions, and lets only a person or the configured permission handler approve writes to settings, git and tool-configuration files.", "受限模式：移除运行命令或代码的内置工具（Bash、PowerShell、REPL 等）以及 WebFetch，除非 --tools 点名；忽略 user、project、local 设置文件（managed 设置与 --settings 仍生效；加 --strict-mcp-config 可一并跳过 MCP 服务器）。同时把文件工具限制在工作目录内（含 --add-dir），拒绝 bypassPermissions，且只有人或所配的权限处理器能批准对设置、git 与工具配置文件的写入。"],
  ["Safe mode: all customizations are disabled (CLAUDE.md, skills, plugins, hooks, MCP, agents, and more)", "安全模式：禁用全部自定义（CLAUDE.md、skills、插件、hooks、MCP、agents）"],
  ["Comma-separated list of setting sources to load (user, project, local).", "要加载的设置来源，逗号分隔（user、project、local）。"],
  ["Only use MCP servers from --mcp-config, ignoring all other MCP configurations", "只用 --mcp-config 的 MCP 服务器，忽略其他 MCP 配置"],
  ["Create a tmux session for the worktree (requires --worktree). Uses iTerm2 native panes when available; use --tmux=classic for traditional tmux.", "为 worktree 建 tmux 会话（需 --worktree）。优先 iTerm2 分屏；--tmux=classic 走传统 tmux"],
  ["Open a background session in this terminal. <id> is the short id that `claude --bg` prints and `claude agents` lists", "在本终端打开后台会话。<id> 是 `claude --bg` 打印、`claude agents` 列出的短 id"],
  [" didn't resume its automatic replies here: they were last turned on from a background agent of this conversation, which keeps them while it runs (see `claude agents`). If that agent has ended, publish the Artifact again here to turn them back on.", " 未在此处恢复自动回复：它们上次由本对话的后台 agent 开启，该 agent 运行期间会一直持有（见 `claude agents`）。若该 agent 已结束，在这里重新发布 Artifact 即可重新开启。"],
  ["Install Claude Code native build. Use [target] to specify version (stable, latest, or specific version)", "安装 Claude Code 原生版，[target] 指定版本（stable/latest/具体）"],
  ["Print the background session's recent terminal output.", "打印后台会话最近的终端输出。"],
  ["Restart a background session, or all of them with --all, so it runs the current Claude Code version", "重启一个后台会话（加 --all 则重启全部），使其运行当前 Claude Code 版本"],
  ["Delete a background session, and its worktree when that is safe. Works on sessions that have already exited", "删除后台会话，安全时连同其 worktree 一并删除。对已退出的会话同样有效"],
  ["Stop a background session. Its conversation is kept; resume it later with `claude attach <id>`.", "停止后台会话。对话会保留；之后用 `claude attach <id>` 恢复。"],
  ["Stop a background session. Its conversation is kept: `claude attach <id>` opens it again, `claude --resume` works once it is stopped", "停止后台会话。对话会保留：`claude attach <id>` 可重开，停止后 `claude --resume` 也能恢复"],
  ["With --json: also include completed background sessions", "配合 --json 时：同时包含已结束的后台会话"],
  ["The background daemon manages `& <prompt>` jobs and `claude agents`. If the issue involves background sessions, look here.", "后台守护进程管理 `& <prompt>` 任务和 `claude agents`。问题涉及后台会话时看这里。"],
  ["Print active sessions (interactive and background) as a JSON array and exit (for scripting; does not require a TTY)", "以 JSON 数组打印活动会话（交互式与后台）后退出（供脚本使用；不需要 TTY）"],
  ["Load plugins from specified directory for the agent view and dispatched sessions; a folder of plugins loads each child (repeatable)", "为 agent 视图与派发的会话从指定目录加载插件；文件夹会加载其中每个插件（可重复）"],
  ["Additional directory to allow tool access to in dispatched sessions (repeatable)", "派发的会话中额外允许工具访问的目录（可重复）"],
  ["Inspect or reset auto mode classifier configuration", "查看或重置 auto mode 分类器配置"],
  ["Print the effective auto mode config as JSON: your settings where set, defaults otherwise", "以 JSON 打印生效的 auto mode 配置：设置过的用你的值，其余用默认值"],
  ["Print the default auto mode environment, allow, soft_deny, and hard_deny rules as JSON", "以 JSON 打印 auto mode 默认规则"],
  ["Reset auto mode configuration to the shipped defaults by removing the autoMode section from your user settings file", "从用户设置文件中移除 autoMode 段，把 auto mode 配置重置为出厂默认"],
  ["Import MCP servers from Claude Desktop (Mac and WSL only)", "从 Claude Desktop 导入 MCP"],
  ["Add an MCP server (stdio, SSE, HTTP, or WebSocket) with a JSON string", "用 JSON 串加 MCP（stdio/SSE/HTTP/WS）"],
  ["Manage Claude Code plugins", "管理插件"],
  ["Run eval cases (<eval dir>/**/case.yaml or prompt.md + graders/*.md; the eval dir is evals/ unless --eval-dir or the manifest says otherwise) against a plugin and report scored results. ", "对插件运行评测用例（<eval dir>/**/case.yaml 或 prompt.md + graders/*.md）并报告评分。"],
  ["Claude in Chrome setup completed: the extension is installed and connected, and the mcp__claude-in-chrome__* browser tools are now available in this session. Continue the user's task using them.", "Claude in Chrome 设置完成：扩展已安装并连接，本会话已可用 mcp__claude-in-chrome__* 浏览器工具。请继续用户的任务。"],
  [" is not a trusted plugin directory, and this run cannot stop to ask you about it (no interactive terminal, or --json / CI). `claude plugin eval` loads the plugin and runs its eval suite on this machine as you - only evaluate plugins you trust. Run it once in a terminal to trust this directory, or pass ", " 不是受信任的插件目录，本次运行也无法停下来询问（无交互终端，或 --json / CI）。`claude plugin eval` 会以你的身份在本机加载插件并运行其评测套件——只评测你信任的插件。请在终端里运行一次以信任该目录，或传入 "],
  ["`claude plugin eval` loads this plugin (its skills, hooks and MCP servers) and runs its eval suite - prompts and graders; scaffold scripts only with --scaffold - on this machine, as you. The run is sandboxed where the platform supports it, which limits what a malicious plugin can reach but is not a guarantee against one. A plugin's own suite passing says nothing about whether the plugin is safe.", "`claude plugin eval` 会以你的身份在本机加载该插件（其 skills、hooks 与 MCP 服务器）并运行其评测套件——提示词与评分器，仅加 --scaffold 才生成脚手架脚本。平台支持时运行在沙箱中，可限制恶意插件能触及的范围，但不构成保证。插件自身套件通过不代表它安全。"],
  ["Scaffold a new plugin at ~/.claude/skills/<name>/ (auto-loads next session as <name>@skills-dir)", "在 ~/.claude/skills/<name>/ 生成插件脚手架（下次会话自动加载）"],
  ["Validate a plugin or marketplace manifest, or the skills, agents, and commands in a directory", "校验插件或市场 manifest，或目录下的 skills、agents、commands"],
  ["Do not post the findings to the PR (the default; accepted for parity with the /ultrareview and /code-review ultra flags)", "不要把发现发布到 PR（默认；与 /ultrareview 和 /code-review 的 ultra 参数对齐）"],
  ["Post the finished review's findings to the PR as you (PR targets only; one plain comment, not a review)", "以你的身份把完成的评审发现发布到 PR（仅限 PR 目标；一条普通评论，不是 review）"],
]);

function patchStringPool(buffer, translations) {
  if (!Array.isArray(translations)) throw new Error("翻译表必须是数组");
  const table = new Map();
  const protectedText = new Set(translations.filter(t => t?.skipPatch).map(t => t.en));
  for (const item of translations) {
    if (!item || typeof item.en !== "string" || typeof item.zh !== "string" || !item.en || !item.zh) {
      throw new Error("翻译条目必须包含非空 en / zh 字符串");
    }
    if (protectedText.has(item.en) || PROTOCOL_FRAGMENTS.has(item.en) || LOGIC_CONSUMED_FRAGMENTS.has(item.en)) continue;
    if (table.has(item.en) && table.get(item.en) !== item.zh) throw new Error(`翻译冲突：${item.en}`);
    table.set(item.en, item.zh);
  }
  // 内置补充词只在主表缺省时生效，避免与 cli-translations.json 冲突；
  // 主表标记 skipPatch 的条目仍受保护，内置词不得绕过。
  for (const item of BUILTIN_SPINNER_TRANSLATIONS) {
    if (!table.has(item.en) && !protectedText.has(item.en)) table.set(item.en, item.zh);
  }
  // CLI 帮助文本同样只走池路径，不进主表。
  for (const [en, zh] of POOL_HELP_TRANSLATIONS) {
    if (!protectedText.has(en) && !PROTOCOL_FRAGMENTS.has(en) && !LOGIC_CONSUMED_FRAGMENTS.has(en)) table.set(en, zh);
  }
  // 池内专用译文直接写入池表（可覆盖主表同名值）；协议/逻辑守卫优先级最高。
  for (const [en, zh] of POOL_TRANSLATIONS) {
    if (!protectedText.has(en) && !PROTOCOL_FRAGMENTS.has(en) && !LOGIC_CONSUMED_FRAGMENTS.has(en)) table.set(en, zh);
  }
  const lengths = new Set([...table.keys()].map(en => en.length));
  const found = new Set();
  let patched = 0, tooLong = 0;
  // ponytail: 单遍扫描 Bun 数据中的精确字符串和条目头；格式变化时扩展版本化解析器。
  for (let offset = 0; offset + 8 <= buffer.length; offset++) {
    // CachedUniquedStringImplBase (2.1.242): relative pointer, bool flags, length.
    // Later shared-pool records: length | is8Bit << 31, hash, characters.
    const cached = offset + 16 <= buffer.length && buffer.readUInt32LE(offset) === 16 &&
      buffer.readUInt32LE(offset + 4) === 0 && (buffer[offset + 8] & 0x36) === 0;
    const flags = cached ? buffer[offset + 8] : buffer[offset + 3];
    if (!cached && flags !== 0x80 && flags !== 0) continue;
    const length = buffer.readUInt32LE(offset + (cached ? 12 : 0)) & 0x7fffffff;
    if (!lengths.has(length)) continue;
    const narrow = cached ? (flags & 1) !== 0 : flags === 0x80;
    const bytes = length * (narrow ? 1 : 2);
    const start = offset + (cached ? 16 : 8);
    if (start + bytes > buffer.length) continue;
    const en = buffer.toString(narrow ? "latin1" : "utf16le", start, start + bytes);
    const zh = table.get(en);
    if (!zh) continue;
    found.add(en);
    const replacement = Buffer.from(zh, "utf16le");
    if (replacement.length > bytes) {
      tooLong++;
    } else {
      buffer.writeUInt32LE(zh.length, offset + (cached ? 12 : 0)); // UTF-16 code units.
      if (cached) buffer[offset + 8] &= ~1;
      buffer.fill(0, start, start + bytes);
      replacement.copy(buffer, start);
      patched++;
    }
    offset = start + bytes - 1;
  }
  return { patched, notFound: table.size - found.size, tooLong };
}

function readContainer(binaryPath) {
  const lief = io.loadNodeLief();
  if (!lief) throw new Error("native patch 需要 node-lief");
  const parsed = io.extractNativeBun(lief, binaryPath);
  const entry = io.findClaudeModule(parsed.bunData, parsed.bunOffsets, parsed.moduleStructSize);
  if (!entry || !io.claudeBytecodeGuardReason(entry)) throw new Error("当前程序不是已识别的 Bun bytecode 容器");
  return { ...parsed, bunData: Buffer.from(parsed.bunData) };
}

function patchBinary(binaryPath, translations, { dryRun = false } = {}) {
  binaryPath = fs.realpathSync(binaryPath);
  const version = io.readExecutableVersion(binaryPath);
  if (!version) throw new Error("原始 Claude Code 启动自检失败，未改动文件");
  const backupPath = binaryPath + ".zh-cn-backup";
  const sameVersionBackup = fs.existsSync(backupPath) && io.readExecutableVersion(backupPath) === version;
  const sourcePath = sameVersionBackup ? backupPath : binaryPath;
  const { bunData, format } = readContainer(sourcePath);
  const original = fs.readFileSync(sourcePath);
  const payloadOffset = original.indexOf(bunData);
  if (payloadOffset < 0 || original.indexOf(bunData, payloadOffset + 1) !== -1) {
    throw new Error("无法唯一定位 Bun 数据，未改动文件");
  }
  const summary = patchStringPool(bunData, translations);
  if (dryRun) return { ...summary, version, mode: "dry-run" };
  if (!summary.patched) throw new Error("没有命中可翻译的字节码条目，未改动文件");
  bunData.copy(original, payloadOffset);
  const current = fs.readFileSync(binaryPath);
  const currentPayload = current.subarray(payloadOffset, payloadOffset + bunData.length);
  if (sameVersionBackup && currentPayload.equals(bunData)) return { ...summary, version, backup: backupPath, changed: false };

  const tempDir = fs.mkdtempSync(path.join(path.dirname(binaryPath), ".zh-cn-bytecode-"));
  const candidate = path.join(tempDir, format === "PE" ? "claude.exe" : "claude");
  try {
    fs.writeFileSync(candidate, original, { mode: fs.statSync(binaryPath).mode });
    if (format === "MachO") io.signAndVerifyMachO(candidate);
    if (io.readExecutableVersion(candidate) !== version) throw new Error("汉化副本启动自检失败，未改动原文件");
    const help = execFileSync(candidate, ["--help"], { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
    if (!/[\u3400-\u9fff]/u.test(help)) throw new Error("汉化副本帮助界面未出现中文，未改动原文件");
    if (!sameVersionBackup) io.withWindowsFileRetry(() => fs.copyFileSync(binaryPath, backupPath));
    io.withWindowsFileRetry(() => fs.renameSync(candidate, binaryPath));
    return { ...summary, version, backup: backupPath, changed: true };
  } finally {
    io.withWindowsFileRetry(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  }
}

function restoreBinary(binaryPath) {
  binaryPath = fs.realpathSync(binaryPath);
  const backup = binaryPath + ".zh-cn-backup";
  const receiptPath = binaryPath + ".zh-cn-repair.json";
  if (fs.existsSync(receiptPath)) {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    const { hash } = require("./native-repair.js");
    if (hash(backup) !== receipt.sourceHash) throw new Error("备份指纹不符，未还原文件；备份已保留");
    if (hash(binaryPath) !== receipt.patchedHash) {
      // CC 已被上游重新安装或升级，不能用同版本旧备份覆盖它。
      fs.unlinkSync(backup);
      fs.unlinkSync(receiptPath);
      fs.rmSync(receiptPath + ".pending", { force: true });
      return { restored: false, reason: "current-file-changed", preservedCurrent: true };
    }
  }
  const version = io.readExecutableVersion(binaryPath);
  if (!version || io.readExecutableVersion(backup) !== version) {
    throw new Error("备份与当前程序版本不一致或无法启动，未还原文件；备份已保留");
  }
  const tempDir = fs.mkdtempSync(path.join(path.dirname(binaryPath), ".zh-cn-restore-"));
  try {
    const candidate = path.join(tempDir, path.basename(binaryPath));
    fs.copyFileSync(backup, candidate);
    io.withWindowsFileRetry(() => fs.renameSync(candidate, binaryPath));
    io.withWindowsFileRetry(() => fs.unlinkSync(backup));
    fs.rmSync(binaryPath + ".zh-cn-repair.json", { force: true });
    fs.rmSync(binaryPath + ".zh-cn-repair.json.pending", { force: true });
    return { restored: true, version };
  } finally {
    io.withWindowsFileRetry(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  }
}

function main() {
  const [command, binaryPath, translationsPath, ...flags] = process.argv.slice(2);
  if (command === "restore" && binaryPath && !translationsPath) {
    process.stdout.write(JSON.stringify(restoreBinary(binaryPath)) + "\n");
    return;
  }
  if (!["patch", "scan"].includes(command) || !binaryPath || !translationsPath || flags.some(f => !["--json", "--dry-run"].includes(f))) {
    throw new Error("Usage: patch-bytecode.js <patch|scan> <binary> <translations.json> [--dry-run] [--json]");
  }
  const translations = JSON.parse(fs.readFileSync(translationsPath, "utf8"));
  const result = patchBinary(binaryPath, translations, { dryRun: command === "scan" || flags.includes("--dry-run") });
  process.stdout.write(flags.includes("--json") ? JSON.stringify(result) + "\n" : String(result.patched) + "\n");
}

module.exports = { patchStringPool, patchBinary, restoreBinary, POOL_HELP_TRANSLATIONS };
if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`bytecode patch: ${error.message}\n`);
    process.exitCode = 1;
  }
}
