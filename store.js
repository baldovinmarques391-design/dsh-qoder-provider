/**
 * 每次调用的原始事件落盘 + 花费账本。一次性进程与常驻进程共用。
 *
 * 为什么要单独一个模块：账本是"我到底花没花钱"的唯一依据，它绝不允许静默失败——
 * 写不进去必须报出来（onLogFailure），否则账本会"看起来正常但缺记录"。
 */
import { mkdirSync, writeFileSync, readdirSync, unlinkSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export function writeRunLog(opts, rawLines, meta) {
  try {
    mkdirSync(opts.logDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    writeFileSync(join(opts.logDir, `${stamp}.jsonl`), rawLines.join('\n') + '\n', 'utf8')
    // 旁挂一份元信息：这样"这轮是冷还是热、墙钟多久、花了多少"以后可复查，不用靠我口头汇报
    //（事件流里的 duration_ms 只是模型 API 时间，不含进程启动那 7 秒）。
    writeFileSync(
      join(opts.logDir, `${stamp}.meta.json`),
      JSON.stringify({ at: new Date().toISOString(), ...(meta ?? {}) }, null, 2),
      'utf8',
    )
    const files = readdirSync(opts.logDir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
    for (const old of files.slice(0, Math.max(0, files.length - 50))) {
      try {
        unlinkSync(join(opts.logDir, old))
      } catch {}
    }
    // 花钱报警：只要有一次调用报出 credits/usd > 0，就单独记一笔，别让它淹在事件流里
    if (Number(meta?.credits ?? 0) > 0 || Number(meta?.usd ?? 0) > 0) {
      appendFileSync(
        join(opts.logDir, 'COST-ALERTS.jsonl'),
        JSON.stringify({
          at: new Date().toISOString(),
          model: meta?.model ?? '',
          credits: meta?.credits ?? 0,
          usd: meta?.usd ?? 0,
        }) + '\n',
        'utf8',
      )
    }
  } catch (e) {
    const detail = `写日志失败（${opts.logDir}）：${e?.message ?? String(e)}`
    opts.onLogFailure?.(detail)
    try {
      writeFileSync(join(tmpdir(), 'dsh-qoder-provider-log-failure.txt'), detail + '\n', 'utf8')
    } catch {}
  }
}
