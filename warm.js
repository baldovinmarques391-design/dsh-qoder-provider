/**
 * 常驻 Qoder 进程池。
 *
 * 为什么需要：Qoder CLI 每次冷启动约 7 秒（安全 hook + 初始化），而模型本身只要 1.7-2 秒。
 * 实测（同一进程连答三轮）：冷启动那一轮 8.7s → 热进程 1.7s / 1.7s / 1.8s，credits 全 0。
 *
 * 机制：`-p --input-format stream-json` 让进程从 stdin 连续接收 NDJSON 用户消息。
 *
 * 关键设计（每条都是真会踩的坑）：
 *  1. **按会话隔离**：一个 DSH 会话一个进程（key = sessionId）。没有 sessionId 就退回一次性进程，
 *     绝不共用，否则两个会话的上下文串味。
 *  2. **只发增量 + 逐条比对记忆**：DSH 每轮都发完整历史，而常驻进程自己也有记忆。所以只发最新一轮，
 *     但发之前必须确认"进程记忆 == 这次历史的前缀"，否则重开并重发完整记录。注意不能拿"前缀指纹"比对——
 *     助手自己的回复会进入下一轮前缀，那样每轮都会误判成不一致（本文件第一版就是这么错的）。
 *  3. **purpose 调用不进池**：会话标题 / 压缩会污染会话记忆，一律走一次性进程。
 *  4. **串行**：同一进程同一时刻只允许一轮（带排队），否则输出交错。
 *  5. **空闲回收**：闲置超时即杀，避免留下孤儿进程。
 */
import { spawn } from 'node:child_process'
import { createTurn, feed, closingChunks } from './translate.js'
import { writeRunLog } from './store.js'
import { killTree, releasePipe } from './proc.js'

const sameMessages = (a, b) =>
  a.length === b.length && a.every((m, i) => m.role === b[i].role && m.text === b[i].text)

export class WarmPool {
  constructor(opts) {
    this.opts = opts
    this.procs = new Map()
  }

  dispose() {
    for (const rec of [...this.procs.values()]) this.kill(rec)
    this.procs.clear()
  }

  fail(rec, error) {
    const state = rec.pending
    if (!state) return
    state.failure = error
    const wake = state.wake
    state.wake = null
    if (wake) wake()
  }

  kill(rec) {
    clearTimeout(rec.idleTimer)
    rec.dead = true
    this.procs.delete(rec.key)
    this.fail(rec, new Error('qoder：常驻进程被回收（空闲超时或插件卸载）'))
    // 必须连整棵进程树一起掐：只 kill 父进程时，占了 stdout 的子进程会让这一轮永远等下去
    try {
      killTree(rec.child, 'warm-kill')
      releasePipe(rec.rl, rec.child)
    } catch {}
  }

  spawnFor(key, model, memory, args, link) {
    // 进程上限：这台机器被"多起几个 Qoder"卡到过鼠标都不能动，所以常驻进程数必须硬封顶。
    const max = Math.max(1, Number(this.opts.warmMax ?? 1))
    while (this.procs.size >= max) {
      const oldest = [...this.procs.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0]
      if (!oldest) break
      this.kill(oldest)
    }
    const child = spawn(this.opts.exe, args, {
      cwd: link?.cwd ?? this.opts.cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const rec = {
      key,
      model,
      link,
      child,
      lastUsed: Date.now(),
      buf: '',
      stderr: [],
      pending: null,
      dead: false,
      memory: [], // 这个进程"脑子里"有的消息（assistant 条目是我们自己产出的正文）
      idleTimer: null,
      chain: Promise.resolve(),
      raw: [],
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d) => {
      rec.buf += d
      let i
      while ((i = rec.buf.indexOf('\n')) >= 0) {
        const line = rec.buf.slice(0, i).trim()
        rec.buf = rec.buf.slice(i + 1)
        if (line === '') continue
        rec.raw.push(line)
        let ev
        try {
          ev = JSON.parse(line)
        } catch {
          continue
        }
        const state = rec.pending
        if (!state) continue
        state.lines.push(ev)
        state.bump?.() // 有事件就是"还活着"，空闲计时器续命
        const wake = state.wake
        state.wake = null
        if (wake) wake()
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d) => {
      if (rec.stderr.length < 200) rec.stderr.push(String(d))
    })
    child.on('exit', (code) => {
      rec.dead = true
      this.fail(rec, new Error(`qoder 常驻进程退出（码 ${code}）：${rec.stderr.join('').slice(-400)}`))
    })
    this.procs.set(key, rec)
    this.send(rec, memory)
    return rec
  }

  send(rec, text) {
    rec.child.stdin.write(
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n',
    )
  }

  touch(rec) {
    clearTimeout(rec.idleTimer)
    rec.idleTimer = setTimeout(() => {
      if (rec.pending === null) this.kill(rec)
    }, this.opts.warmIdleMs)
    rec.idleTimer.unref?.()
  }

  /**
   * @param options DSH 的 GenerateOptions（要用到 sessionId / signal）
   * @param fullPrompt 完整记录（与一次性路径同格式）
   * @param turns 规范化后的消息 [{role, text}]
   * @param model 模型 id
   * @param args Qoder CLI 参数（由 index.js 的 cliArgs 生成，两条路径共用一份，避免漂移）
   * @param link 该会话的工作目录与权限档（变了必须重开进程）
   */
  async *stream(options, fullPrompt, turns, model, args, link) {
    const key = String(options.sessionId)
    let rec = this.procs.get(key)
    // 模型 / 工作目录 / 权限档变了，进程参数就过期了——必须重开，不能沿用旧的权限
    const linkChanged =
      rec !== undefined &&
      (rec.link?.cwd !== link?.cwd || rec.link?.permissionMode !== link?.permissionMode)
    if (rec && (rec.dead || rec.model !== model || linkChanged)) {
      this.kill(rec)
      rec = undefined
    }

    let warm = false
    if (!rec) {
      rec = this.spawnFor(key, model, fullPrompt, args, link)
      rec.memory = turns.slice()
    } else if (
      turns.length === rec.memory.length + 1 &&
      sameMessages(turns.slice(0, rec.memory.length), rec.memory)
    ) {
      // 续聊：只发最新那一轮
      this.send(rec, turns[turns.length - 1].text)
      rec.memory = turns.slice()
      warm = true
    } else {
      // 记忆对不上（压缩 / 编辑 / 重来 / 系统提示变了）：宁可重开，也不串味
      this.kill(rec)
      rec = this.spawnFor(key, model, fullPrompt, args, link)
      rec.memory = turns.slice()
    }
    rec.lastUsed = Date.now()

    // 串行闸门：同一进程同时只允许一轮
    const previous = rec.chain
    let release
    rec.chain = new Promise((resolve) => {
      release = resolve
    })
    await previous

    const turn = createTurn({ mode: 'display' })
    const state = { lines: [], wake: null, failure: null, bump: null }
    rec.pending = state
    rec.raw = []
    const startedAt = Date.now()

    const abort = () => this.fail(rec, new Error('qoder：调用已取消。'))
    options.signal?.addEventListener('abort', abort, { once: true })

    // **空闲**超时，不是总超时：只要进程还在吐事件就一直续命。
    // 教训：22 次工具调用的正常长任务被"总超时 5 分钟"误杀过；反过来卡在审批上时进程一声不吭，
    // 空闲计时器正好能抓到它。
    let idleTimer = null
    const bump = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(
        () => this.fail(rec, new Error(`qoder：常驻进程 ${this.opts.timeoutMs}ms 一直没输出（卡在工具审批之类的地方）`)),
        this.opts.timeoutMs,
      )
    }
    state.bump = bump
    bump()

    let answer = ''
    try {
      for (;;) {
        while (state.lines.length === 0) {
          if (state.failure) throw state.failure
          if (rec.dead) throw new Error('qoder：常驻进程已退出')
          await new Promise((resolve) => {
            state.wake = resolve
          })
        }
        const ev = state.lines.shift()
        for (const chunk of feed(turn, ev)) {
          if (chunk.type === 'text-delta') answer += chunk.text
          yield chunk
        }
        if (ev.type === 'result') break
      }
      if (turn.isError) {
        throw new Error(
          `qoder：模型返回错误（${turn.errorDetail || 'unknown'}）${turn.resultText ? `：${turn.resultText}` : ''}`,
        )
      }
      if (answer === '') answer = turn.assistantText || turn.resultText || ''
      for (const chunk of closingChunks(turn)) yield chunk
    } finally {
      clearTimeout(idleTimer)
      options.signal?.removeEventListener('abort', abort)
      // 进程记忆里补上它自己的回复，供下一轮比对
      if (!rec.dead && answer !== '') rec.memory = [...rec.memory, { role: 'assistant', text: answer }]
      rec.pending = null
      release()
      if (rec.dead) this.procs.delete(key)
      else this.touch(rec)
      writeRunLog(this.opts, rec.raw.slice(), {
        model,
        credits: turn.credits,
        usd: turn.usd,
        ms: Date.now() - startedAt,
        warm,
        display: link?.display === true,
        diag: link?.diag,
      })
    }
  }
}
