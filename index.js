/**
 * qoder-provider —— 把 Qoder CN 的免费模型接成 DSH 的一等 LLM 提供方（provider = qoder）。
 *
 * 设计要点（依据每次调用落盘的原始事件，不是猜测）：
 *  1) 走 Qoder CLI 的 worker（ELECTRON_RUN_AS_NODE=1）+ `-p --output-format stream-json
 *     --include-partial-messages`，读 NDJSON。事件是 Anthropic 式信封：
 *     {type:'stream_event', event:{type:'content_block_delta', index, delta:{type:'thinking_delta'|'text_delta', ...}}}
 *  2) 只用结构化字段判断块类型（delta.type / content_block.type），**绝不做 `<think>` 子串嗅探**。
 *     Qoder 自己的渲染器就是靠子串匹配把输出搞坏的（见 qoder-think-leak.md），我们绕开它的渲染器，
 *     因此对文本**不做任何改写**。
 *  3) 提示词走 stdin（`--input-format stream-json`），不放命令行：会话一长 argv 就超 Windows 32k 上限，
 *     spawn 直接失败（实测 `spawn ENAMETOOLONG`，那一轮就此报废）。
 *  4) 用量：Qoder 免费路线把 input/output tokens 一律报 0（实测 usage 与 modelUsage 全 0），
 *     所以 sums 为 0 时不发 usage 块，免得 DSH 把上下文计量当成真的 0。
 *  5) 它是「一个模型」而不是「一个工具」：DSH 侧的模型选择器里会出现 qoder / Qwen3.8-Flash。
 *
 * **两种模式**（配置 `mode`）：
 *  - `drive`（默认）：Qwen 当大脑，工具由 DSH 真执行。这一轮里 Qwen 每次决定完工具调用就收手
 *    （`turn.halt`），我们把它的 Qoder 进程掐掉，再把映射后的 tool-call 块交给 DSH。
 *    ⇒ 界面/权限/沙箱/diff 全是 DSH 原生的；某一步失败也不会把之前做完的事从界面上抹掉。
 *    实测：掐在 `message_delta{stop_reason:'tool_use'}` 时，全程没有出现过任何
 *    tool_result，即"赶在它动手之前"是成立的。
 *  - `display`：Qwen 自己执行工具，DSH 只照搬显示（见 tool-bridge.js 顶部说明）。
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { createTurn, feed, closingChunks, haltChunks } from './translate.js'
import {
  canUseToolResponse,
  displayDiagnosis,
  DISPLAY_SENTINEL,
  DISPLAY_TOOL_NAMES,
  QODER_NAME_OF,
} from './tool-bridge.js'
import { writeRunLog } from './store.js'
import { WarmPool } from './warm.js'
import { killTree, releasePipe } from './proc.js'

export const name = 'qoder-provider'
export const inject = ['llm']

const PROVIDER = 'qoder'
/** Where the Qoder CN desktop app installs on Windows; the first one present wins. */
const QODER_ROOTS = [
  'C:\\Program Files (x86)\\Qoder CN',
  'C:\\Program Files\\Qoder CN',
  'D:\\Program Files (x86)\\Qoder CN',
  'D:\\Program Files\\Qoder CN',
]
const QODER_ROOT = QODER_ROOTS.find((dir) => existsSync(join(dir, 'Qoder CN.exe'))) ?? QODER_ROOTS[0]
const DEFAULT_EXE = join(QODER_ROOT, 'Qoder CN.exe')
const DEFAULT_WORKER = join(
  QODER_ROOT, 'resources', 'app.asar.unpacked', 'node_modules', '@qoder-ai',
  'qoder-cn-agent-sdk', 'dist', '_worker', 'qoder-worker-runtime.obf.mjs',
)
const DEFAULT_LOG_DIR = join(homedir(), '.dsh-qoder-provider', 'runs')

/**
 * 免费模型表：**只放经过实测确认为免费的模型**。
 *
 * 2026-10-16 教训：我早先把「Flash / Preview 档看着像免费」当成免费，一次塞进 4 个未实测的
 * 模型（Qwen3.7-Flash / DeepSeek-Flash / GLM-5.3-Flash / Kimi-K2.8-Preview），用户指出只有
 * Qwen3.8-Flash 免费。`--list-models` 也证实 Qoder 根本不给计费标注，所以「免费」只能靠实测
 * result 事件里的 total_credits / total_cost_usd 得到。
 *
 * 规则：没实测过的一律按「要花钱」处理。要把新模型加进这张表，先用 _verify-models.mjs 实测，
 * 确认 total_credits=0 之后再写进来（并把实测时间记在 description 里）。
 */
const VERIFIED_FREE_MODELS = [
  { id: 'Qwen3.8-Flash', name: 'Qwen3.8-Flash', description: '已验证免费（实测 credits=0）' },
]

/** Config 值可能是惰性 {get()} 单元（.volatile() 字段），取用时必须解包。 */
function value(v, fallback) {
  if (v && typeof v === 'object' && typeof v.get === 'function') {
    try {
      const got = v.get()
      return got === undefined || got === null ? fallback : got
    } catch {
      return fallback
    }
  }
  return v === undefined || v === null ? fallback : v
}

const textBlock = (text) => [{ type: 'text', text }]

/**
 * 往 Qwen 那边回灌历史时，工具名要换成**它自己的名字**（Read/Write/Edit/Bash/…）。
 * 否则它会读到"我调过 pwsh"这种它没干过的事——实测症状是整段回答退化成 "a\n\nCurlh"。
 */
const qoderName = (dshName) => QODER_NAME_OF[dshName] ?? dshName

/** 把 DSH 的消息块拍平成纯文本（宽容处理 string / 块数组 / 未知块）。 */
/**
 * 工具参数压成一行 `key=value`（**不带花括号/引号**）。
 *
 * 为什么要这样：历史里一旦出现 `[工具调用 Edit：{"file_path":…}]` 这种"可执行的 JSON 形状"，
 * Qwen 会照着抄进正文（实测它真写了一行 `[工具调用 Edit: {...}]` 给用户看），很难看。
 * 改成过去式 `[已执行 Edit] file_path=…` 之后没有可抄的形状，同时它还知道自己动过哪个文件。
 */
function briefArgs(raw, cap = 160) {
  const text = String(raw ?? '').trim()
  if (text === '') return ''
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return ' ' + text.replace(/\s+/g, ' ').slice(0, cap)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return ' ' + String(value).slice(0, cap)
  const parts = []
  for (const [k, v] of Object.entries(value)) {
    const one = typeof v === 'string' ? v : JSON.stringify(v)
    parts.push(`${k}=${String(one).replace(/\s+/g, ' ').slice(0, 80)}`)
    if (parts.join(' ').length > cap) break
  }
  return ' ' + parts.join(' ').slice(0, cap)
}

function blocksToText(content) {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    if (typeof content === 'object' && typeof content.text === 'string') return content.text
    return JSON.stringify(content)
  }
  const parts = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (!block || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        parts.push(block.text ?? '')
        break
      case 'reasoning':
        break // 不回灌思维链
      case 'tool-call':
        parts.push(`[已执行 ${qoderName(block.name ?? '')}]${briefArgs(block.arguments)}`)
        break
      case 'tool-result':
      case 'tool-result-error':
        parts.push(`[结果 ${qoderName(block.toolName ?? block.name ?? '')}] ${blocksToText(block.content)}`)
        break
      case 'image':
        parts.push('[图片]')
        break
      default:
        if (typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * display 模式下要**丢弃的回声**：我在 UI 里发出的工具块（名字是映射后的 DSH 原生名，如 pwsh）
 * 以及影子展示工具返回的结果。这些是给"看"的，不是 Qwen 的记忆——
 * Qwen 自己记得那次调用叫 Bash，若把"它调过 pwsh"这种不存在的记录喂回去，它会当场懵掉。
 *
 * drive 模式下**绝不能丢**：那些工具是 DSH 真执行的，Qwen 必须知道结果，否则会重复干同一件事。
 */
const SHADOW_NAMES = new Set([...DISPLAY_TOOL_NAMES, DISPLAY_SENTINEL])

function isDisplayEcho(message) {
  const content = message?.content
  if (!Array.isArray(content)) return false
  let sawMine = false
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && String(block.text ?? '').trim() !== '') return false
    if (block.type === 'tool-call' && (SHADOW_NAMES.has(block.name) || MY_DISPLAY_NAMES.has(block.name))) {
      sawMine = true
      continue
    }
    if (
      (block.type === 'tool-result' || block.type === 'tool-result-error') &&
      (SHADOW_NAMES.has(block.toolName ?? block.name) || MY_DISPLAY_NAMES.has(block.toolName ?? block.name))
    ) {
      sawMine = true
    }
  }
  return sawMine
}

/**
 * 把 DSH 的消息规范化成 [{role, text}]；DSH 的 system 作为首条并入，
 * 原样以 `<system>` 块喂给 Qoder —— 不替换、不追加、不跟它的设计较劲。
 *
 * drive 模式额外加一句**宿主工具说明**（note）：Qwen 手里的工具名是它自己那套
 * （Read/Write/Edit/Bash/…），而本机真正执行的是 DSH 的工具。不说清楚它会去调 Agent / TaskCreate
 * 这类本机没有的工具，白烧一轮。这句只说明"哪些名字有效"，不改它的系统提示。
 */
export function normalizeTurns(options, display, note) {
  const messages = Array.isArray(options.messages) ? options.messages : []
  const usable = display === true ? messages.filter((m) => !isDisplayEcho(m)) : messages
  const turns = usable
    .map((m) => ({ role: m?.role ?? 'user', text: blocksToText(m?.content) }))
    .filter((t) => t.text !== '')
  let system = typeof options.system === 'string' ? options.system.trim() : ''
  if (note && note !== '') system = system === '' ? note : `${system}\n\n${note}`
  return system === '' ? turns : [{ role: 'system', text: system }, ...turns]
}

/**
 * Qoder CLI 的参数。一次性与常驻两条路径共用这一份，避免参数漂移。
 *
 * 原则（用户定的）：**不在没有碾压性优势的地方乱动 DSH 的设计**。
 * 所以：DSH 的系统提示原样当内容喂进去（上面那个 `<system>` 块），
 * Qoder 自己的 agent 系统提示与它自带的工具**保持原样**——它才知道怎么真干活。
 * 不用 `--system-prompt` / `--append-system-prompt`，也不清空 `--tools`。
 *
 * `--permission-mode`：
 *  - drive：固定 `dont_ask`。它永远不会真执行（我们掐在它动手之前），但万一抢跑了，
 *    dont_ask 会让它直接拒绝而不是弹审批干等（旧的 300 秒卡死就是这么来的）。
 *  - display：按会话的权限预设映射（danger-full-access+never → bypass_permissions，
 *    workspace-write → accept_edits，其余 → default），并对应答 can_use_tool。
 *
 * @param stdin 常驻模式：提示词从 stdin 喂，不放在命令行里。
 */
export function cliArgs(opts, { model, prompt, stdin, permissionMode }) {
  const args = [opts.worker, '-p']
  if (!stdin) args.push(prompt)
  if (stdin) args.push('--input-format', 'stream-json')
  args.push('--output-format', 'stream-json', '--include-partial-messages', '--model', model)
  args.push('--permission-mode', permissionMode ?? opts.permissionMode)
  args.push('--no-session-persistence')
  return args
}

/**
 * 把 DSH 会话的**权限预设**与**工作目录**映射到 Qoder CLI —— 这就是"权限/目录联动"。
 * 值全部来自 DSH 自己的服务，不猜：
 *   ctx.sessions.get(sessionId)              → 会话（含 header.cwd）
 *   ctx.permissionPresets.current(session)   → 预设名，再 resolve 出 { sandbox, approval }
 *   ctx.sandboxPolicy.workspaceRoot          → 兜底的工作区根
 */
export function makeLinker(ctx, opts) {
  return (sessionId) => {
    try {
      const sessions = ctx.get('sessions')
      const presets = ctx.get('permissionPresets')
      const sandboxPolicy = ctx.get('sandboxPolicy')
      const session = sessionId === undefined ? undefined : sessions?.get?.(sessionId)
      const cwd = session?.header?.cwd ?? session?.cwd ?? sandboxPolicy?.workspaceRoot ?? opts.cwd
      let permissionMode = opts.permissionMode
      if (session !== undefined && typeof presets?.current === 'function') {
        const spec = presets.resolve?.(presets.current(session)) ?? {}
        const approval = spec.approval ?? 'ask'
        const sandbox = spec.sandbox ?? 'read-only'
        if (approval === 'never' && sandbox === 'danger-full-access') permissionMode = 'bypass_permissions'
        else if (sandbox === 'workspace-write') permissionMode = 'accept_edits'
        else permissionMode = 'default'
      }
      return { cwd, permissionMode }
    } catch {
      return { cwd: opts.cwd, permissionMode: opts.permissionMode }
    }
  }
}

/** 组装交给 Qoder 的提示词。单轮用户消息就原样发，避免任何模板污染。 */
function buildPrompt(turns) {
  if (turns.length === 1 && turns[0].role === 'user') return turns[0].text
  return turns.map((t) => `<${t.role}>\n${t.text}\n</${t.role}>`).join('\n\n')
}

/**
 * 会话标题不值得花一次进程冷启动（实测一次约 7 秒），直接从第一条用户消息里取一个短标题。
 * 只有 purpose === 'session-title' 会走这里，正文一个字都不受影响。
 *
 * 注意：标题请求的正文**不是**用户原话，而是会话标题插件拼的指令
 * （`Generate the session title from this JSON array of human messages:\n["你好"]`，
 * 见 @deepseek-ai/dsh-session-title-llm）。所以必须先剥掉指令、解出里面的 JSON，
 * 否则标题会变成「Generate the ses」（实测踩过）。
 */
const TITLE_INSTRUCTION = 'Generate the session title from this JSON array of human messages:'

function titleSourceText(turns) {
  const raw = turns.find((t) => t.role === 'user')?.text ?? ''
  const at = raw.indexOf(TITLE_INSTRUCTION)
  if (at < 0) return raw
  const json = raw.slice(at + TITLE_INSTRUCTION.length).trim()
  try {
    const parsed = JSON.parse(json)
    const first = Array.isArray(parsed) ? parsed[0] : parsed
    if (typeof first === 'string') return first
    if (first && typeof first === 'object') {
      if (typeof first.text === 'string') return first.text
      if (typeof first.content === 'string') return first.content
      if (Array.isArray(first.content)) return blocksToText(first.content)
    }
  } catch {}
  return json
}

function* localTitle(turns) {
  const cleaned = titleSourceText(turns)
    .replace(/[\r\n]+/g, ' ')
    .replace(/^[\s"'`「『【（(]+/, '')
    .replace(/[\s"'`」』】）)]+$/, '')
    .trim()
  yield { type: 'text-delta', index: 0, text: cleaned.slice(0, 16) || '新会话' }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/** 写一行 NDJSON 给 Qoder；写不进去不该让整轮崩掉，所以吞掉异常（stdin 可能已经关了）。 */
function writeLine(child, obj) {
  try {
    child.stdin.write(JSON.stringify(obj) + '\n')
    return true
  } catch {
    return false
  }
}

export class QoderAdapter extends LlmAdapter {
  constructor(opts) {
    super()
    this.opts = opts
  }

  providerInfo(provider) {
    return { id: provider, name: 'Qoder CN（免费模型）' }
  }

  async listModels(provider) {
    return this.opts.models.map((m) => ({
      provider,
      id: m.id,
      name: m.name,
      description: m.description,
    }))
  }

  async resolveModel(provider, model) {
    const known = this.opts.models.find((m) => m.id === model)
    return {
      provider,
      id: model,
      name: known?.name ?? model,
      ...(known?.description ? { description: known.description } : {}),
    }
  }

  async *stream(options) {
    const model = String(options.model ?? '')
    if (!this.opts.allowUnlisted && !this.opts.models.some((m) => m.id === model)) {
      throw new Error(
        `qoder 拒绝这个模型：${model} —— 它不在已验证免费的名单里（可能直接花钱）。` +
          `已验证免费：${this.opts.models.map((m) => m.id).join(' / ') || '(空)'}。` +
          `确实要用，就把插件配置 allowUnlisted 设为 true 后重启；想把它变成"已验证免费"，先用 _verify-models.mjs 实测 credits。`,
      )
    }

    const mode = this.opts.mode
    const display = mode === 'display'

    // 展示模式的判据以这个会话实际拿到的工具表为准（含诊断，写进 runs 的 meta）。
    // 必须先算它：拍平历史时要按它过滤掉"我给 UI 看的回声"。
    const diag = displayDiagnosis(options)
    const turns = normalizeTurns(options, display, display || !this.opts.toolNote ? '' : this.opts.toolNote)
    const prompt = buildPrompt(turns)
    if (prompt.trim() === '') throw new Error('qoder：这次请求没有任何可发送的文本内容')

    // 会话标题：为几个字起一个 Qoder 进程太亏，本地直接给（正文完全不受影响）
    if (options.purpose === 'session-title' && this.opts.localTitles) {
      yield* localTitle(turns)
      return
    }

    // **不许静默回退**（只在 display 模式有意义）：这个会话挂了展示插件（哨兵在）却没拿到
    // 原生同名展示工具，那工具调用就会被 DSH 的真工具接手（把 Qwen 干过的活再干一遍）⇒ 直接报错。
    if (display && diag.hasSentinel && !diag.display) {
      throw new Error(
        `qwen：这个会话是 Qwen 展示模式（哨兵工具在），但原生同名展示工具没挂上，` +
          `继续下去会让 DSH 真的执行一遍 Qwen 已经执行过的操作，所以停手报错。` +
          `诊断：工具表 ${diag.toolCount} 个、我的展示工具 ${diag.displayToolCount} 个、` +
          `原生同名工具=[${diag.nativeNamesPresent}]。` +
          `请检查 preset-qwen 里的 qwen-display 条目（@local/dsh-qoder-provider/display）。`,
      )
    }

    // 反向的不同步：预设里还挂着展示模式的影子工具，provider 却是 drive 模式。
    // 影子工具的 handler 只回放"记录下来的输出"，而 drive 模式根本没有记录 ⇒ 每一次工具调用都会
    // 空转（界面上像成功了，实际什么都没干）。这种"看起来能用"的失败最坏，所以直接报错。
    // 背景：`patchReload: live` 只热重载补丁、不重载插件代码，改代码后不重启就会出现这个错配。
    if (!display && diag.display) {
      throw new Error(
        `qwen：provider 是 drive 模式（工具该由 DSH 真执行），但这个会话里挂着展示模式的影子工具：` +
          `[${diag.displayToolNames}]。影子工具只回放记录、不执行，会让每一次工具调用都空转。` +
          `请把 preset-qwen 里的 qwen-display 条目去掉（drive 模式不需要它），` +
          `或者把 provider 的 mode 改成 display 再重启。`,
      )
    }

    const linked = this.opts.link?.(options.sessionId) ?? {
      cwd: this.opts.cwd,
      permissionMode: this.opts.permissionMode,
    }
    // drive 模式固定 dont_ask：工具由 DSH 执行，Qoder 侧一个都不许真跑
    const link = { ...linked, permissionMode: display ? linked.permissionMode : 'dont_ask' }

    // 常驻进程：只接普通对话回合，且只服务 display 模式——
    // drive 模式每一轮都要在工具调用处掐进程，常驻没有意义（进程都掐了还谈什么复用）。
    if (display && this.opts.pool && options.sessionId !== undefined && options.purpose === undefined) {
      if (options.signal?.aborted) throw new Error('qoder：请求在开始前已被取消')
      const args = cliArgs(this.opts, { model, prompt, stdin: true, permissionMode: link.permissionMode })
      yield* this.opts.pool.stream(options, prompt, turns, model, args, { ...link, display: true, diag })
      return
    }

    const args = cliArgs(this.opts, { model, prompt, stdin: true, permissionMode: link.permissionMode })

    const signal = options.signal
    if (signal?.aborted) throw new Error('qoder：请求在开始前已被取消')

    const startedAt = Date.now()
    const child = spawn(this.opts.exe, args, {
      cwd: link.cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    writeLine(child, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } })

    // **空闲**超时，不是总超时：只要还在吐事件就续命。
    // 超时后必须**主动把管道放掉**：只 kill 的话，只要还有子进程占着 stdout，
    // `for await (const line of rl)` 就永远不结束，这一轮会毫无理由地卡死（见 proc.js）。
    let timedOut = false
    let timer = null
    const closer = () => releasePipe(rl, child)
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        timedOut = true
        killTree(child, 'idle-timeout')
        closer()
      }, this.opts.timeoutMs)
    }
    arm()
    const onAbort = () => {
      killTree(child, 'abort')
      closer()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const stderrChunks = []
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d) => {
      if (stderrChunks.length < 400) stderrChunks.push(String(d))
    })
    const stderrTail = () => stderrChunks.join('').slice(-2000)

    child.stdout.setEncoding('utf8')
    const raw = []
    const rl = createInterface({ input: child.stdout })

    // 解析状态：与常驻池共用同一份翻译器（translate.js），避免两个解析器各自漂移
    const turn = createTurn({ mode, allowNames: new Set(diag.names ?? []) })
    let halted = false
    let done = false
    const asked = []

    try {
      for await (const line of rl) {
        arm() // 每来一行就续命（空闲超时）
        const trimmed = line.trim()
        if (trimmed === '') continue
        raw.push(trimmed)
        let ev
        try {
          ev = JSON.parse(trimmed)
        } catch {
          continue
        }

        // Qoder 自己的权限询问：**必须回**，否则它干等到空闲超时（旧代码就是这样卡死 300 秒的）。
        // drive 模式一律拒绝——工具是 DSH 的事，Qoder 侧一个都不许真跑。
        if (ev?.type === 'control_request') {
          const allow = display
          writeLine(child, canUseToolResponse(ev.request_id, allow))
          asked.push({ id: ev.request_id, tool: ev.request?.tool_name, allow })
          continue
        }

        for (const chunk of feed(turn, ev)) yield chunk

        // Qwen 刚决定完工具调用（此刻它还没执行任何东西）：交给 DSH 执行，我们收手
        if (turn.halt !== null) {
          halted = true
          for (const chunk of haltChunks(turn)) yield chunk
          killTree(child, 'halt')
          break
        }

        // **`result` 就是这一轮的终点，必须收手。**
        // 实测坑：`--input-format stream-json` 下 Qoder 回答完**不会退出**（它在等下一条 stdin），
        // 所以"等 stdout 关掉"会一直等下去 —— 表现就是"最后一步没有工具调用的回合永远卡着"，
        // 一直挂到空闲超时才报错（旧的一次性路径就有这个病）。
        if (ev.type === 'result') {
          done = true
          killTree(child, 'result')
          break
        }
      }
    } catch (e) {
      // 主动放掉管道会以"流提前关闭"的形式抛出来，那是我们自己干的，不算错
      if (!timedOut && !halted && !signal?.aborted) throw e
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      releasePipe(rl, child)
      killTree(child, 'finally')
    }

    // 原始事件落盘 + 花费账本（写失败会报出来，绝不静默）
    writeRunLog(this.opts, raw.slice(), {
      model,
      mode,
      halted,
      done,
      ms: Date.now() - startedAt,
      credits: turn.credits,
      usd: turn.usd,
      toolCalls: turn.toolCalls,
      unmappedCalls: turn.unmappedCalls,
      controlRequests: asked,
      diag,
    })

    // 等进程收场：用 'exit'（进程真的结束了），并加一个兜底时限——
    // 绝不允许"等子进程把管道关掉"这种事把这一轮永远挂住。
    const exited = await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(child.exitCode)
        return
      }
      const fallback = setTimeout(() => resolve(child.exitCode), 3000)
      child.once('exit', (code) => {
        clearTimeout(fallback)
        resolve(code)
      })
    })

    if (timedOut) {
      throw new Error(
        `qoder：${this.opts.timeoutMs}ms 之内一直没有新事件，已终止。` +
          `（模式 ${mode}；见过的权限询问 ${asked.length} 次；最后停在第 ${turn.toolCalls} 个工具调用。` +
          `这条错误以前写作"卡在工具审批"，但审批现在一定会被应答——真再出现，请查 runs 里的原始事件流。）`,
      )
    }
    if (signal?.aborted) throw new Error('qoder：调用已取消。')
    if (turn.isError) {
      throw new Error(
        `qoder：模型返回错误（${turn.errorDetail || 'unknown'}）${turn.resultText ? `：${turn.resultText}` : ''}`,
      )
    }
    if (!halted && !done && !turn.sawText && !turn.assistantText && !turn.resultText && exited !== 0) {
      throw new Error(`qoder：进程退出码 ${exited}，且没有产出任何内容。stderr：${stderrTail()}`)
    }

    for (const chunk of closingChunks(turn)) yield chunk
  }
}

export function apply(ctx, config = {}) {
  // 落盘失败（写日志/写账本）记在这里，由 qoder_cost_report 报出来，绝不静默
  let logFailure = null
  const opts = {
    exe: value(config.exe, DEFAULT_EXE),
    worker: value(config.worker, DEFAULT_WORKER),
    models: value(config.models, VERIFIED_FREE_MODELS),
    // drive = Qwen 只当大脑、工具由 DSH 真执行（默认）；display = 旧做法（Qwen 自己执行，DSH 只显示）
    mode: value(config.mode, 'drive') === 'display' ? 'display' : 'drive',
    // 只有 display 模式用得上：Qwen 自己执行工具时的权限档
    permissionMode: value(config.permissionMode, 'bypass_permissions'),
    timeoutMs: value(config.timeoutMs, 5 * 60 * 1000),
    cwd: value(config.cwd, process.cwd()),
    logDir: value(config.logDir, DEFAULT_LOG_DIR),
    allowUnlisted: value(config.allowUnlisted, false),
    selftest: value(config.selftest, true),
    // 诊断开关：把"设置页会看到的插件显示名"写进 <logDir>/META-PROBE.json（见文件末尾的说明）
    metaProbe: value(config.metaProbe, false),
    // drive 模式下给 Qwen 的宿主说明。措辞必须**准确**，每条都是实测踩出来的：
    //  ① 工具名：写窄了（"其它工具名不可用"）会让它一边读到宿主工具表、一边被告知不可用，白烧一轮；
    //  ② 命令是 **PowerShell 不是 bash**：它拿自己那套 POSIX 习惯写 `| head -40`、`&&`、单引号，
    //     在 pwsh 里直接报错退出码 1（实测：`ls -lt "D:/下载" | head -40` —— ls 有别名能过，head 不存在）；
    //  ③ 超过 1 秒的命令会被宿主转成后台任务并返回 job 号（这台机器 pwsh-sandbox 的 timeoutMs=1000），
    //     输出不会自动进上下文，要用 job_output 去取。
    toolNote: value(
      config.toolNote,
      '[宿主说明] 你这台机器上：' +
        '（1）命令工具是 PowerShell，不是 bash —— 没有 head/tail/grep/sed，别用 && 和单引号；' +
        '取前 N 行用 `| Select-Object -First N`，多条命令用 `;` 分隔。' +
        '（2）命令超过 1 秒会被转成后台任务、返回一个 job 号，输出不会自动回来，要用 job_output 取。' +
        '（3）你原来的工具名（Read / Write / Edit / Bash / Glob / Grep / WebFetch / WebSearch）由宿主执行；' +
        '宿主系统提示里列出的其它工具（例如 todo_write、job_output、present）也能直接用那些名字调用。' +
        '这两类之外的名字本机没有，不要调用。',
    ),
    // 默认关：常驻进程会占着几百 MB，这台机器被多起 Qoder 卡到过鼠标都动不了。
    // 而且 drive 模式每轮都要掐进程，常驻本来也没用——它只为 display 模式保留。
    warm: value(config.warm, false),
    warmMax: value(config.warmMax, 1),
    localTitles: value(config.localTitles, true),
    warmIdleMs: value(config.warmIdleMs, 60 * 1000),
    pool: null,
    link: null,
    onLogFailure: (detail) => {
      logFailure = detail
    },
  }

  // 权限/目录联动的查表函数（用 DSH 的 sessions / permissionPresets / sandboxPolicy 服务）
  opts.link = makeLinker(ctx, opts)

  // 常驻进程池：只服务 display 模式
  if (opts.warm && opts.mode === 'display') {
    const pool = new WarmPool(opts)
    opts.pool = pool
    ctx.effect(() => () => pool.dispose())
  }

  const adapter = new QoderAdapter(opts)
  ctx.llm.registerAdapter([PROVIDER], adapter)

  // 自检工具的迷你会话记忆：同一个 session 的第二次调用要真的构成"续聊"，
  // 否则每次历史都只有一条消息，常驻池会判定记忆对不上而重开，看不出热进程的收益。
  const selftestHistory = new Map()
  if (opts.selftest) {
    ctx.inject(['tools'], (toolsCtx) => {
      toolsCtx.effect(() =>
        toolsCtx.tools.register({
          name: 'qoder_selftest',
          description:
            '自检 Qoder 通道：让 qoder 提供方的免费模型回答一句话，返回原文与耗时。用来确认「DSH 直连 Qoder 免费模型」这条路是通的。',
          parameters: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: '要问的话，留空则问「只回答两个字：收到」' },
              model: { type: 'string', description: '模型 id，默认 Qwen3.8-Flash' },
              session: {
                type: 'string',
                description:
                  '可选。填一个会话标识（随便一个字符串，两次填一样即可）就会走常驻进程池：第二次调用会明显更快（约 2 秒 vs 约 10 秒）。不填则每次都是新进程。',
              },
            },
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_a, v) => textBlock(JSON.stringify(v, null, 2)),
          },
          timeoutMs: 5 * 60 * 1000,
          isConcurrencySafe: () => true,
          async execute(args) {
            const a = args ?? {}
            const model = a.model || opts.models[0]?.id || 'Qwen3.8-Flash'
            const question = a.prompt || '只回答两个字：收到'
            const started = Date.now()
            let text = ''
            const kinds = []
            const history = a.session ? [...(selftestHistory.get(a.session) ?? [])] : []
            history.push({ role: 'user', content: question })
            for await (const chunk of ctx.llm.stream({
              provider: PROVIDER,
              model,
              ...(a.session ? { sessionId: a.session } : {}),
              messages: history,
            })) {
              kinds.push(chunk.type)
              if (chunk.type === 'text-delta') text += chunk.text
              if (chunk.type === 'finish' && chunk.reason?.kind !== 'stop') {
                return { ok: false, model, question, answer: text, finish: chunk.reason, ms: Date.now() - started }
              }
            }
            if (a.session) {
              // 必须带 source：运行时假定每条 assistant 消息都有 source，缺了会在请求组装阶段
              // 直接抛 "Cannot read properties of undefined (reading 'replayState')"（实测踩过）
              selftestHistory.set(a.session, [
                ...history,
                { role: 'assistant', content: text, source: { kind: 'model', provider: PROVIDER, model } },
              ])
            }
            return { ok: text.trim() !== '', model, question, answer: text, ms: Date.now() - started, chunks: kinds.length }
          },
        }),
      )

      // 账单工具：白嫖纪律的账本。它不额外记日志，直接解析每次调用落盘的原始事件（连历史 run 都能回溯）。
      toolsCtx.effect(() =>
        toolsCtx.tools.register({
          name: 'qoder_cost_report',
          description:
            '查 Qoder 通道的账单：扫描每次调用落盘的事件流，汇总 credits / usd，并列出花过钱的调用。用来确认「我到底有没有被扣费」。',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_a, v) => textBlock(JSON.stringify(v, null, 2)),
          },
          isConcurrencySafe: () => true,
          async execute() {
            let files = []
            try {
              files = readdirSync(opts.logDir)
                .filter((f) => f.endsWith('.jsonl') && f !== 'COST-ALERTS.jsonl')
                .sort()
            } catch {
              return { logDir: opts.logDir, runs: 0, note: '还没有任何调用记录' }
            }
            const rows = []
            let credits = 0
            let usd = 0
            for (const f of files) {
              let text = ''
              try {
                text = readFileSync(join(opts.logDir, f), 'utf8')
              } catch {
                continue
              }
              let model = ''
              let c = 0
              let u = 0
              let ms = null
              for (const line of text.split(/\r?\n/)) {
                const t = line.trim()
                if (t === '') continue
                let ev
                try {
                  ev = JSON.parse(t)
                } catch {
                  continue
                }
                if (ev.type === 'system' && ev.subtype === 'init') model = ev.model ?? ''
                if (ev.type === 'result') {
                  c = Number(ev.total_credits ?? 0)
                  u = Number(ev.total_cost_usd ?? 0)
                  ms = ev.duration_ms ?? null
                }
              }
              credits += c
              usd += u
              rows.push({ file: f, model, credits: c, usd: u, ms })
            }
            const paying = rows.filter((r) => r.credits > 0 || r.usd > 0)
            return {
              logDir: opts.logDir,
              runs: rows.length,
              total_credits: credits,
              total_usd: usd,
              paying_runs: paying.length,
              paying,
              recent: rows.slice(-8),
              log_failure: logFailure,
              verdict: credits === 0 && usd === 0 ? '✅ 至今所有调用都是 0 花费' : '💸 有花费，见 paying',
            }
          },
        }),
      )
    })
  }

  /**
   * 诊断：让**活进程自己**把"设置页会看到的插件显示名"写出来。
   *
   * 为什么需要它：`@local/dsh-qoder-provider` 在设置页一直显示成包名，而 qwen-mode 正常。
   * 我在命令行里用 DSH 自己的 `readPluginMeta` 复现，任何 parentURL 都成功 —— 说明复现和活进程
   * 有差别，再推断下去就是猜。这个开关直接调活进程里的 `pluginPackages.metaOf()`（设置页走的就是它），
   * 把结果落到 `<logDir>/META-PROBE.json`。
   */
  if (opts.metaProbe) {
    ctx.inject(['pluginPackages'], (probeCtx) => {
      probeCtx.effect(() => {
        const packages = probeCtx.pluginPackages
        const out = {
          at: new Date().toISOString(),
          ctxBaseUrl: String(ctx.baseUrl ?? probeCtx.baseUrl ?? '(none)'),
          cwd: process.cwd(),
          probes: {},
        }
        const bases = [
          String(ctx.baseUrl ?? probeCtx.baseUrl ?? ''),
          'file:///D:/dsh-3081/home/profiles/web/package.json',
          'file:///D:/dsh-3081/home/profiles/web/node_modules/@local/dsh-qoder-provider/package.json',
          'file:///D:/%E6%A1%8C%E9%9D%A2/DSH%E4%B8%8E%E8%87%AA%E5%8A%A8%E5%8C%96/agent-bridge/qoder-provider/package.json',
        ].filter((b) => b !== '')
        for (const spec of ['@local/dsh-qoder-provider', '@local/dsh-qwen-mode']) {
          for (const base of bases) {
            const key = spec + '  @  ' + base
            try {
              out.probes[key] = packages?.metaOf?.(spec, base) ?? '(metaOf 不存在)'
            } catch (e) {
              out.probes[key] = '❌ ' + (e?.code ?? '') + ' ' + String(e?.message ?? e).slice(0, 200)
            }
          }
        }
        try {
          mkdirSync(opts.logDir, { recursive: true })
          writeFileSync(join(opts.logDir, 'META-PROBE.json'), JSON.stringify(out, null, 2), 'utf8')
        } catch (e) {
          console.error('[qoder] META-PROBE 写盘失败：' + String(e?.message ?? e))
        }
      })
    })

    // 再往下钉一层：设置页"已安装"那段用的就是 pluginManager.listBundles()。
    // metaOf 对不代表 listBundles 对（两处可能用不同的 specifier / parentURL）。
    ctx.inject(['pluginManager'], (pmCtx) => {
      pmCtx.effect(() => {
        const done = (async () => {
          const result = { at: new Date().toISOString() }
          try {
            const rows = await pmCtx.pluginManager.listBundles()
            result.count = Array.isArray(rows) ? rows.length : null
            result.mine = (Array.isArray(rows) ? rows : [])
              .filter((r) => String(r?.name ?? '').includes('qoder-provider') || String(r?.name ?? '').includes('qwen-mode'))
              .map((r) => ({
                name: r.name,
                description: r.description,
                meta: r.meta,
                entryRows: Array.isArray(r.rows) ? r.rows.slice(0, 3).map((x) => ({ moduleName: x.moduleName, meta: x.meta })) : undefined,
              }))
          } catch (e) {
            result.error = String(e?.message ?? e)
          }
          try {
            mkdirSync(opts.logDir, { recursive: true })
            writeFileSync(join(opts.logDir, 'META-PROBE-BUNDLES.json'), JSON.stringify(result, null, 2), 'utf8')
          } catch (e) {
            console.error('[qoder] META-PROBE-BUNDLES 写盘失败：' + String(e?.message ?? e))
          }
        })()
        return () => void done
      })
    })
  }
}
