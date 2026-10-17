/**
 * Qwen 模式的展示工具（preset 作用域）。
 *
 * 这些工具**不执行任何东西**：它们与 DSH 原生工具同名（pwsh / read / write / edit / glob / grep /
 * web_fetch / web_search），所以 GUI 会用原本的渲染去画（终端行、diff 行、搜索行）；
 * handler 只按 exec.callId 把 Qwen 的真实输出取回来返回。
 *
 * 作用域：本插件由 agent preset 挂载，因此注册是**会话级**的，只会遮蔽该会话里的同名全局工具，
 * 其它会话不受影响。
 */
import { DISPLAY_TOOL_NAMES, DISPLAY_MARKER, DISPLAY_SENTINEL, takeResult } from './tool-bridge.js'

export const name = 'qwen-display'
export const inject = ['tools']

const textBlock = (text) => [{ type: 'text', text }]

const HINTS = {
  pwsh: 'command / description —— Qwen 在它自己的环境里执行过的命令',
  read: 'file_path / offset / limit —— Qwen 读过的文件',
  write: 'file_path / content —— Qwen 写过的文件',
  edit: 'file_path / old_string / new_string —— Qwen 改过的文件',
  glob: 'pattern / path —— Qwen 做过的文件名搜索',
  grep: 'pattern / path / include —— Qwen 做过的内容搜索',
  web_fetch: 'url —— Qwen 抓取过的网页',
  web_search: 'queries —— Qwen 搜过的关键词',
}

export function apply(ctx) {
  // 标记走 systemPrompt.**section**（section 一定会进系统提示字符串；context 不一定——
  // 上次就是靠 context 识别，结果 markerInSystem=false，静默退回了文字标记，白折腾好几轮）。
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(() =>
      promptCtx.systemPrompt.section({
        name: 'qwen-display',
        order: 95,
        text: `${DISPLAY_MARKER} 本会话的工具卡片展示的是 Qwen 自己执行的结果，DSH 不再重复执行。`,
      }),
    )
  })

  ctx.inject(['tools'], (toolsCtx) => {
    // 哨兵工具：宿主的适配器靠"它在不在"判断这个会话有没有挂上展示插件，
    // 于是"挂了插件却没拿到原生同名展示工具"可以被检测出来并直接报错。
    toolsCtx.effect(() =>
      toolsCtx.tools.register({
        name: DISPLAY_SENTINEL,
        description: `${DISPLAY_MARKER} 哨兵：本会话使用 Qwen 展示模式（工具卡只展示 Qwen 自己的执行结果）。不要调用它。`,
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: () => textBlock('哨兵工具，仅供宿主识别会话模式，不执行任何操作。'),
        },
        isConcurrencySafe: () => true,
        async execute() {
          return { output: '哨兵工具，不执行任何操作。', display_only: true }
        },
      }),
    )

    for (const toolName of DISPLAY_TOOL_NAMES) {
      toolsCtx.effect(() =>
        toolsCtx.tools.register({
          name: toolName,
          description: `${DISPLAY_MARKER} Qwen 展示工具（不执行任何操作）：把 Qwen 自己那一步的真实输出显示出来。参数：${HINTS[toolName] ?? ''}`,
          parameters: { type: 'object', properties: {}, additionalProperties: true },
          output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => textBlock(value?.output ?? ''),
          },
          isConcurrencySafe: () => true,
          async execute(_args, exec) {
            const recorded = takeResult(exec?.callId)
            if (recorded === undefined) {
              return { output: '（这次调用没有留下输出）', display_only: true }
            }
            return { output: recorded.output, error: recorded.isError, display_only: true }
          },
        }),
      )
    }
  })
}
