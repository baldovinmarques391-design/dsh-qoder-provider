/**
 * 掐进程。
 *
 * **为什么不能只用 `child.kill()`**：Qoder 是 Electron。worker 跑在它里面，它会再拉子进程，
 * 这些子进程**继承了 stdout 管道**。父进程被 SIGTERM 杀掉之后，管道仍然被活着的子进程占着，
 * 于是 `for await (const line of rl)` **永远不结束** —— 表现就是"这一轮毫无理由地卡死"，
 * 同时留下几百 MB 的孤儿进程。
 *
 * `taskkill /PID <pid> /T /F` 才会把**整棵树**带走。
 * 实测证据：naive 与 tree 两种模式的对比。
 */
import { spawnSync } from 'node:child_process'

export function killTree(child, why = '') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return false
  const pid = child.pid
  let tree = false
  if (typeof pid === 'number' && process.platform === 'win32') {
    try {
      const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 5000,
      })
      tree = r.status === 0
    } catch {}
  }
  // 兜底（非 Windows / taskkill 失败）：至少把直接子进程杀了
  try {
    child.kill('SIGKILL')
  } catch {}
  if (process.env.DSH_QODER_DEBUG_KILL === '1') {
    console.error(`[qoder] killTree pid=${pid} tree=${tree} why=${why}`)
  }
  return tree
}

/** 把一条 stdout 管道彻底放掉，免得"等流结束"永远等下去。 */
export function releasePipe(rl, child) {
  try {
    rl?.close()
  } catch {}
  try {
    child?.stdout?.destroy()
  } catch {}
  try {
    child?.stdin?.end()
  } catch {}
}
