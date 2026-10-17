/**
 * Qwen 模式的桥：Qwen 的工具调用 ↔ DSH 的工具调用。
 *
 * **两种模式**（由 qoder-provider 的 `mode` 决定）：
 *
 *  - `drive`（默认，2026-10-16 改）：Qwen 只当大脑——它决定"调哪个工具、传什么参数"，
 *    工具由 **DSH 真的执行**。Qwen 那次工具调用在它自己进程里**永远不会被执行**：
 *    宿主在它刚决定完（`message_delta{stop_reason:'tool_use'}`）就把进程掐掉，
 *    并且用 `--permission-mode dont_ask` + 对任何 `can_use_tool` 一律回 `cancel` 兜底。
 *    ⇒ 界面、权限、沙箱、diff、工具输出全部是 DSH 原生的；失败也不会把已经做完的事从界面上抹掉。
 *
 *  - `display`（旧做法，保留可切回）：Qwen 在自己进程里执行工具，DSH 只把它的工具卡**照搬显示**
 *    （同名展示工具 + 按 callId 取回它的真实输出）。缺点（用户实测）：
 *    DSH 会把 Qwen 一轮里的多步思考/工具行压成"一条消息"交替堆叠；且最后一步一失败，
 *    整条消息连同已经发生的真实改动都会从界面上消失。
 *
 * 名字映射是同一份（两种模式共用），只是参数要为**真工具**负责：
 * 比如 DSH 的 `pwsh` 强制要求 `description` 非空，缺了就直接抛错——所以这里负责补齐。
 */

/** Qoder 工具 → DSH 工具。名字必须落在 GUI 的渲染表里，才有原生长相（终端行 / diff 行 / 搜索行）。 */
export const TOOL_MAP = {
  Bash: {
    name: 'pwsh',
    args: (a) => ({
      command: a.command,
      // DSH 的 pwsh 对 description 有非空校验（空就抛 "invalid description"），必须补齐
      description: describe(a.description, a.command),
    }),
  },
  Read: {
    name: 'read',
    args: (a) => ({ file_path: a.file_path ?? a.path, offset: a.offset, limit: a.limit }),
  },
  Write: {
    name: 'write',
    args: (a) => ({ file_path: a.file_path ?? a.path, content: a.content }),
  },
  Edit: {
    name: 'edit',
    args: (a) => ({
      file_path: a.file_path ?? a.path,
      old_string: a.old_string,
      new_string: a.new_string,
      replace_all: a.replace_all === true,
    }),
  },
  Glob: {
    name: 'glob',
    args: (a) => ({ pattern: a.pattern, path: a.path }),
  },
  Grep: {
    name: 'grep',
    args: (a) => ({ pattern: a.pattern, path: a.path, include: a.glob ?? a.include }),
  },
  WebFetch: {
    name: 'web_fetch',
    args: (a) => ({ url: a.url }),
  },
  WebSearch: {
    name: 'web_search',
    args: (a) => ({
      queries: Array.isArray(a.queries) ? a.queries : [a.query, a.search_query].filter((x) => typeof x === 'string'),
    }),
  },
}

/** 反向表：往 Qwen 那边回灌历史时，要用**它自己的工具名**，否则它会不认识自己干过的事。 */
export const QODER_NAME_OF = Object.fromEntries(Object.entries(TOOL_MAP).map(([q, m]) => [m.name, q]))

/** Qwen 侧全部 33 个工具名（实测清单，来自 runs 的 init 事件）。 */
export const QODER_TOOLS = [
  'Agent', 'Bash', 'CreateGoal', 'CronCreate', 'CronDelete', 'CronList', 'Edit', 'EnterPlanMode',
  'EnterWorktree', 'ExitPlanMode', 'ExitWorktree', 'GetGoal', 'Glob', 'Grep', 'ImageGen',
  'ImageSearch', 'Monitor', 'NotebookEdit', 'Read', 'ScheduleWakeup', 'Skill', 'TaskCreate',
  'TaskGet', 'TaskList', 'TaskStop', 'TaskUpdate', 'UpdateGoal', 'VideoGen', 'VideoGenRetrieve',
  'WebFetch', 'WebSearch', 'Workflow', 'Write',
]

const QODER_TOOL_SET = new Set(QODER_TOOLS)

/** DSH 侧真实存在、能承接 Qwen 调用的工具名（= TOOL_MAP 的值）。 */
export const DRIVE_TOOL_NAMES = [...new Set(Object.values(TOOL_MAP).map((m) => m.name))]

function describe(given, command) {
  const text = typeof given === 'string' ? given.trim() : ''
  if (text !== '') return text
  const flat = String(command ?? '').replace(/\s+/g, ' ').trim()
  return flat === '' ? 'Run a command' : `Run: ${flat.slice(0, 80)}`
}

const dropUndefined = (obj) => {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v
  }
  return out
}

/**
 * 把一次 Qwen 工具调用翻译成 DSH 的工具名与参数。
 *
 * @param allowNames drive 模式下传**这个会话真的声明过的工具名集合**（`options.tools`）。
 *   为什么需要它：Drive 模式下 Qwen 也会读到宿主（DSH）的系统提示，那里列着 DSH 自己的工具
 *   （`todo_write` / `job_output` / `present` / `read_image` …）。实测它会纠结"到底能用哪些名字"，
 *   甚至想去调 `job_output`。这些名字本来就该能调（DSH 是执行者，权限也归 DSH），所以：
 *   **只放行会话声明过的名字，原样透传**；没声明过的名字仍然拦下来 —— 既让 DSH 的全部工具可用，
 *   又不会被幻觉出来的名字牵去调一个不存在的工具。
 * @returns {{ name: string, arguments: string, mapped: boolean, passthrough?: boolean }}
 */
export function mapToolCall(qoderName, argsJson, allowNames) {
  const text = String(argsJson ?? '').trim()
  const rule = TOOL_MAP[qoderName]
  if (rule === undefined) {
    if (allowNames !== undefined && allowNames.has(qoderName)) {
      return { name: qoderName, arguments: text === '' ? '{}' : text, mapped: true, passthrough: true }
    }
    return { name: '', arguments: text === '' ? '{}' : text, mapped: false }
  }
  if (text === '') {
    return { name: rule.name, arguments: JSON.stringify(dropUndefined(rule.args({}))), mapped: true }
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    // 参数流还没拼完整 / 不是 JSON：仍然发出去（让卡片先出现），但标记成不能当真执行
    return { name: rule.name, arguments: text, mapped: true, partial: true }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) raw = {}
  return { name: rule.name, arguments: JSON.stringify(dropUndefined(rule.args(raw))), mapped: true }
}

/** 这个 Qwen 工具名有没有 DSH 对应物。 */
export function isMapped(qoderName) {
  return TOOL_MAP[qoderName] !== undefined
}

export function isKnownQoderTool(name) {
  return QODER_TOOL_SET.has(name)
}

/** 「Qwen 想用一个 DSH 没有的工具」时给界面看的一行字（显性，不静默）。 */
export function unmappedNotice(qoderName, argsJson) {
  const flat = String(argsJson ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
  const known = QODER_TOOL_SET.has(qoderName) ? '' : '（连 Qwen 自己的工具清单里也没有这个名字）'
  return `\n⚠︎ Qwen 要求调用 \`${qoderName}\`${known}，DSH 侧没有对应工具，这一调用没有执行。参数：${flat || '(无)'}\n`
}

/**
 * 应答 Qoder 的 `can_use_tool`（权限询问）。
 *
 * 实测事实（从 Qoder worker 的协议实现里挖出来的，不是猜的）：应答必须是
 * `{type:'control_response', response:{subtype:'success', request_id, response:{outcome}}}`
 * 其中 outcome ∈ proceed_once | proceed_always | proceed_always_and_save | modify_with_editor | cancel。
 * **旧代码根本不回**，于是 Qoder 干等到空闲超时（实测 300 秒后报"一直没输出"）。
 */
export function canUseToolResponse(requestId, allow) {
  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: String(requestId ?? ''),
      response: { outcome: allow ? 'proceed_once' : 'cancel' },
    },
  }
}

/* ------------------------------------------------------------------ *
 * display 模式专用：callId → 真实输出（展示工具按 callId 取回来返回）  *
 * ------------------------------------------------------------------ */

const results = new Map()
const MAX_PENDING = 200

export function recordResult(callId, output, isError) {
  if (typeof callId !== 'string' || callId === '') return
  results.set(callId, { output: String(output ?? ''), isError: isError === true })
  while (results.size > MAX_PENDING) {
    const oldest = results.keys().next().value
    if (oldest === undefined) break
    results.delete(oldest)
  }
}

export function takeResult(callId) {
  const key = String(callId ?? '')
  const found = results.get(key)
  if (found !== undefined) results.delete(key)
  return found
}

/* ------------------------------------------------------------------ *
 * display 模式专用：展示工具的注册名单 + 模式判据                       *
 * ------------------------------------------------------------------ */

/** 工具描述里带这个标记 = 展示模式的影子工具。 */
export const DISPLAY_MARKER = '[qwen-display-mode]'

/** 未映射工具的落点名（display 模式用；drive 模式不用它）。 */
export const UNMAPPED_TOOL = 'qwen_tool'

/**
 * display 模式需要注册的影子工具名：
 *  - 有原生渲染的目标名（pwsh / read / …）→ GUI 用原生行画
 *  - 其余 Qwen 工具用**它自己的名字**（PascalCase，不会与 DSH 的小写工具撞车）→ GUI 画通用卡
 * 安全前提：只注册上面这份已知名单，绝不按事件流里出现的任意名字注册。
 */
export const DISPLAY_TOOL_NAMES = [
  ...new Set([
    ...DRIVE_TOOL_NAMES,
    ...QODER_TOOLS.filter((n) => TOOL_MAP[n] === undefined),
    UNMAPPED_TOOL,
  ]),
]

/** 哨兵工具名：display 插件一定会注册它，用来判断"这个会话挂了展示插件"。 */
export const DISPLAY_SENTINEL = 'qwen_display_mode'

/** 这个请求是不是来自 Qwen 展示模式？以**这个会话实际拿到的工具表**（options.tools）为准。 */
export function displayDiagnosis(options) {
  const tools = Array.isArray(options?.tools) ? options.tools : []
  const mine = tools.filter(
    (t) => t?.name !== DISPLAY_SENTINEL && typeof t?.description === 'string' && t.description.includes(DISPLAY_MARKER),
  )
  const names = tools.map((t) => t?.name).filter((n) => typeof n === 'string')
  return {
    display: mine.length > 0,
    hasSentinel: names.includes(DISPLAY_SENTINEL),
    toolCount: tools.length,
    displayToolCount: mine.length,
    displayToolNames: mine.map((t) => t?.name).join(','),
    nativeNamesPresent: names.filter((n) => DRIVE_TOOL_NAMES.includes(n)).join(','),
    // 会话真的声明了哪些工具名（drive 模式用它做"原样透传"的白名单）
    names,
  }
}
