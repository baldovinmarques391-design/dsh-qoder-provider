/**
 * Qoder 事件流 → DSH StreamChunk 的**唯一**翻译器。
 *
 * 两条铁律：
 *  1. 块类型只认结构化字段（event.type / delta.type），绝不做 `<think>` 之类子串嗅探。
 *     背景见 ../qoder-think-leak.md。
 *  2. **工具调用必须看得见**：一律发真正的 DSH tool-call 块，交给 GUI 用它原本的渲染去画。
 *
 * 两种模式（见 tool-bridge.js 顶部的说明）：
 *  - drive（默认）：Qwen 只决定工具调用，宿主在它决定完的那一刻掐掉进程，工具由 DSH 真执行。
 *    所以这里在 `message_delta{stop_reason:'tool_use'}` 上置 `turn.halt`，宿主据此收尾并掐进程。
 *  - display：Qwen 自己执行，结果按 callId 存起来给影子展示工具取（此时不能中断流）。
 *
 * 历史上踩过的坑（改动前先读一遍）：
 *  - 块索引必须**按出现顺序**发号。旧做法给工具块固定 2000+，于是正文永远排最上面、工具行全堆到
 *    最底部；第二步的思考复用 index 0 又会和正文撞车被丢弃（用户只看到第一段 COT）。
 *  - 工具块必须发 `block-start`：只发 delta + block-end 时服务端组装器能容忍，但**客户端渲染器不认**，
 *    界面上根本不出工具行。
 */
import { mapToolCall, recordResult, unmappedNotice, isKnownQoderTool, UNMAPPED_TOOL } from './tool-bridge.js'

export function createTurn(opts = {}) {
  // 兼容老写法 `{display:true}`（warm.js 与几个老测试这么调）：
  // 不认 mode 时就按 display 推，省得"以为在 display、其实跑成了 drive"这种静默错位。
  const mode = opts.mode === 'display' || (opts.mode === undefined && opts.display === true) ? 'display' : 'drive'
  return {
    mode,
    display: mode === 'display',
    sawStreamDeltas: false,
    sawText: false,
    maxIndex: -1,
    assistantText: '',
    resultText: '',
    stopReason: '',
    isError: false,
    errorDetail: '',
    usage: null,
    credits: null,
    usd: null,
    tools: new Map(), // Qoder 块 index -> { id, name, json }
    blocks: new Map(), // Qoder 块 index -> { dsl: 给 DSH 的索引, type }；texts 记累积内容
    texts: new Map(),
    nextIndex: 0,
    markers: 0,
    toolCalls: 0,
    unmappedCalls: 0,
    // 本轮（一条 Qwen 内部消息）里出现过几个映射成功的工具调用 / 未映射的
    iter: { mapped: 0, unmapped: 0 },
    // 宿主看到它就要：发 finish{tool-calls}、掐进程、收尾
    halt: null,
    finished: false,
    // drive 模式：会话声明过的工具名集合（原样透传的白名单，见 tool-bridge.mapToolCall）
    allowNames: opts.allowNames instanceof Set ? opts.allowNames : undefined,
  }
}

/** 过程信息（未映射工具、普通模式的标记）用完整 text 块呈现（只发 delta 客户端不认）。 */
function textBlockChunks(turn, text) {
  const index = turn.nextIndex++
  turn.sawText = true
  turn.markers += 1
  return [
    { type: 'block-start', index, blockType: 'text' },
    { type: 'text-delta', index, text },
    { type: 'block-end', index, block: { type: 'text', text } },
  ]
}

function toolChunks(turn, call, dslIndex) {
  // drive 模式才给白名单：display 模式下影子工具只覆盖那 8 个名字，透传别的名字会去调 DSH 的真工具，
  // 而那一侧 Qwen 已经自己执行过了 —— 那正是要避免的重复执行。
  const mapped = mapToolCall(call.name, call.json, turn.mode === 'drive' ? turn.allowNames : undefined)
  const index = dslIndex ?? turn.nextIndex++
  if (!mapped.mapped) {
    turn.unmappedCalls += 1
    turn.iter.unmapped += 1
    // display 模式有影子工具（Qwen 自己的名字一张通用卡 / 完全不认识的名字落到 qwen_tool），
    // 所以照旧出卡；drive 模式没有影子工具，只能出一行显性提示（绝不用它传来的名字去调 DSH 工具）。
    if (turn.mode === 'display') return shadowChunks(turn, call, index)
    return textBlockChunks(turn, unmappedNotice(call.name, call.json))
  }
  turn.toolCalls += 1
  turn.iter.mapped += 1
  return [
    { type: 'tool-call-delta', index, id: call.id, name: mapped.name, argumentsDelta: mapped.arguments },
    { type: 'block-end', index, block: { type: 'tool-call', id: call.id, name: mapped.name, arguments: mapped.arguments } },
  ]
}

/** display 模式专用：Qwen 独有 / 完全不认识的工具，落在影子工具上出一张卡。 */
function shadowChunks(turn, call, index) {
  const name = isKnownQoderTool(call.name) ? call.name : UNMAPPED_TOOL
  let args = String(call.json ?? '').trim()
  if (name === UNMAPPED_TOOL) {
    let parsed
    try {
      parsed = args === '' ? {} : JSON.parse(args)
    } catch {
      parsed = args
    }
    args = JSON.stringify({ tool: call.name, args: parsed })
  } else if (args === '') {
    args = '{}'
  }
  return [
    { type: 'tool-call-delta', index, id: call.id, name, argumentsDelta: args },
    { type: 'block-end', index, block: { type: 'tool-call', id: call.id, name, arguments: args } },
  ]
}

const oneLine = (text, cap) => {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > cap ? `${flat.slice(0, cap)}…` : flat
}

/** 把工具调用的参数写成一行可读文本（能解析成 JSON 就逐字段铺开，否则原样）。 */
function formatArgs(json) {
  const raw = String(json ?? '').trim()
  if (raw === '') return ''
  try {
    const value = JSON.parse(raw)
    if (value && typeof value === 'object') {
      return Object.entries(value)
        .map(([k, v]) => `${k}=${oneLine(typeof v === 'string' ? v : JSON.stringify(v), 200)}`)
        .join(' ')
    }
    return oneLine(value, 300)
  } catch {
    return oneLine(raw, 300)
  }
}

/** 从工具结果里尽量抠出可读文本。 */
function resultText(content) {
  if (content === undefined || content === null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (typeof block === 'string') parts.push(block)
    else if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (typeof block?.content === 'string') parts.push(block.content)
  }
  return parts.join('\n')
}

/** 收集一条 user 事件里的全部工具结果（按 tool_use_id 归档）。 */
function collectToolResults(message) {
  const content = message?.content
  if (!Array.isArray(content)) return []
  const found = []
  for (const block of content) {
    const id = block?.tool_use_id ?? block?.tool_call_id
    if (typeof id !== 'string' || id === '') continue
    found.push({
      id,
      output: resultText(block.content ?? block.text),
      isError: block.is_error === true || block.isError === true,
    })
  }
  return found
}

/** 喂一个事件，返回该事件应产出的块（可能为空）。 */
export function feed(turn, ev) {
  const out = []
  const kind = ev?.type

  if (kind === 'stream_event') {
    const e = ev.event ?? {}
    const srcIndex = typeof e.index === 'number' ? e.index : 0

    if (e.type === 'content_block_start') {
      const block = e.content_block ?? {}
      const blockType =
        block.type === 'thinking' ? 'reasoning' : block.type === 'tool_use' ? 'tool-call' : 'text'
      const dsl = turn.nextIndex++
      turn.texts.set(dsl, '')
      if (blockType === 'tool-call') {
        turn.tools.set(srcIndex, { id: block.id, name: block.name ?? 'tool', json: '' })
      }
      turn.blocks.set(srcIndex, { dsl, type: blockType })
      out.push({ type: 'block-start', index: dsl, blockType })
      return out
    }

    if (e.type === 'content_block_delta') {
      const d = e.delta ?? {}
      const mapped = turn.blocks.get(srcIndex)
      const dsl = mapped === undefined ? turn.maxIndex : mapped.dsl
      if (d.type === 'thinking_delta' && typeof d.thinking === 'string' && d.thinking !== '') {
        turn.sawStreamDeltas = true
        turn.maxIndex = Math.max(turn.maxIndex, dsl)
        turn.texts.set(dsl, (turn.texts.get(dsl) ?? '') + d.thinking)
        out.push({ type: 'reasoning-delta', index: dsl, text: d.thinking })
      } else if (d.type === 'text_delta' && typeof d.text === 'string' && d.text !== '') {
        turn.sawStreamDeltas = true
        turn.sawText = true
        turn.maxIndex = Math.max(turn.maxIndex, dsl)
        turn.texts.set(dsl, (turn.texts.get(dsl) ?? '') + d.text)
        out.push({ type: 'text-delta', index: dsl, text: d.text })
      } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
        const call = turn.tools.get(srcIndex)
        if (call) call.json += d.partial_json
      }
      return out
    }

    if (e.type === 'content_block_stop') {
      const mapped = turn.blocks.get(srcIndex)
      turn.blocks.delete(srcIndex)
      const call = turn.tools.get(srcIndex)

      if (call !== undefined) {
        turn.tools.delete(srcIndex)
        out.push(...toolChunks(turn, call, mapped?.dsl))
        return out
      }

      // 正文/思考块收尾：给一个完整的 block-end（界面靠它定稿；思考块也因此不会被丢）
      if (mapped !== undefined) {
        const text = turn.texts.get(mapped.dsl) ?? ''
        turn.texts.delete(mapped.dsl)
        if (mapped.type === 'text') out.push({ type: 'block-end', index: mapped.dsl, block: { type: 'text', text } })
        else out.push({ type: 'block-end', index: mapped.dsl, block: { type: 'reasoning', text } })
      }
      return out
    }

    if (e.type === 'message_delta') {
      if (e.usage) turn.usage = e.usage
      const reason = e.delta?.stop_reason
      if (typeof reason === 'string' && reason !== '') turn.stopReason = reason
      // 关键判据：这一条 Qwen 内部消息**以工具调用收尾**。此刻工具还一个都没执行
      // （实测 tool_result 永远出现在 message_stop 之后），所以 drive 模式在这里收手最干净。
      if (reason === 'tool_use') {
        const mappedNow = turn.iter.mapped
        turn.iter = { mapped: 0, unmapped: 0 }
        if (turn.mode === 'drive' && mappedNow > 0) turn.halt = 'tool-calls'
      } else if (reason !== undefined) {
        turn.iter = { mapped: 0, unmapped: 0 }
      }
      return out
    }

    return out
  }

  if (kind === 'assistant') {
    // 非流式模式下这是唯一来源；流式模式下它只是每个块的重复快照，只当兜底，避免重复投喂。
    const content = ev.message?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') turn.assistantText += block.text
      }
    }
    return out
  }

  // 工具结果：display 模式下 Qwen 用自己的工具执行、结果回灌给它自己；我们按 callId 存下来供展示工具取用。
  // drive 模式下**不该有真执行**：实测 `--permission-mode dont_ask` 会让 Qoder 直接拒绝，
  // 并把拒绝写成一条 is_error 的 tool_result（"needs approval … does not prompt"），
  // 然后我们照旧 halt 把工具交给 DSH 真执行。所以：
  //  - is_error 的结果 = Qoder 侧的拒绝，属于它内部噪声，**不投喂**（DSH 马上会给出真结果）；
  //  - 非 error 的结果 = 它真执行了（抢跑了，只读类工具在 dont_ask 下偶尔会被放行）
  //    ⇒ 必须显性报出来、绝不静默；但**只报一句话**：不贴输出（可能是几百行，实测一次 grep
  //    就把整屏糊满），也不加括号说明（用户明确要求）。
  if (kind === 'user') {
    for (const item of collectToolResults(ev.message)) {
      if (turn.mode === 'display') recordResult(item.id, item.output, item.isError)
      else if (!item.isError) {
        out.push(...textBlockChunks(turn, '\n⚠︎ Qwen 在自己的环境里执行了一次工具\n'))
      }
    }
    return out
  }

  if (kind === 'result') {
    if (typeof ev.result === 'string') turn.resultText = ev.result
    if (typeof ev.stop_reason === 'string') turn.stopReason = ev.stop_reason
    if (ev.is_error === true) turn.isError = true
    if (typeof ev.subtype === 'string' && ev.subtype !== 'success') turn.errorDetail = ev.subtype
    if (ev.usage) turn.usage = ev.usage
    if (ev.total_credits !== undefined) turn.credits = Number(ev.total_credits)
    if (ev.total_cost_usd !== undefined) turn.usd = Number(ev.total_cost_usd)
    return out
  }

  // system/init 之类只做诊断，不投喂
  return out
}

/** 一轮结束时补齐兜底正文、用量与终止原因（已经发过 finish 就不再发）。 */
export function closingChunks(turn) {
  const out = []
  if (!turn.sawText) {
    const fallback = turn.assistantText || turn.resultText
    if (fallback !== '') {
      const index = turn.nextIndex++
      turn.sawText = true
      turn.maxIndex = index
      out.push({ type: 'text-delta', index, text: fallback })
    }
  }
  const input = Number(turn.usage?.input_tokens ?? 0)
  const output = Number(turn.usage?.output_tokens ?? 0)
  if (input > 0 || output > 0) {
    out.push({ type: 'usage', usage: { inputTokens: input, outputTokens: output, totalTokens: input + output } })
  }
  if (!turn.finished) {
    turn.finished = true
    out.push({ type: 'finish', reason: { kind: turn.stopReason === 'max_tokens' ? 'max-tokens' : 'stop' } })
  }
  return out
}

/** 收尾：drive 模式在工具调用处收手时用。 */
export function haltChunks(turn) {
  turn.finished = true
  return [{ type: 'finish', reason: { kind: 'tool-calls' } }]
}
