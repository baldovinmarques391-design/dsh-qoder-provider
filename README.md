# Qoder 免费模型（qoder-provider）

把 **Qoder CN 的免费模型**接成 DSH 的一等 LLM 提供方：provider = `qoder`。
装上之后，DSH 的模型选择器里会直接出现 `qoder / Qwen3.8-Flash` 这一组，选它就是白嫖（实测 `total_credits = 0`）。

## 它做了什么

宿主插件向 `ctx.llm.registerAdapter(['qoder'], adapter)` 注册一个 `LlmAdapter`：

| 成员 | 行为 |
| --- | --- |
| `providerInfo('qoder')` | 显示名「Qoder CN（免费模型）」 |
| `listModels('qoder')` | 已验证免费的模型表（默认只有 Qwen3.8-Flash） |
| `resolveModel` | 返回 id / 名称 / 说明 |
| `stream(options)` | 起 Qoder worker 子进程，把 NDJSON 事件流翻译成 DSH 的 `StreamChunk` |

另有自检工具 `qoder_selftest`：在会话里直接跑一次「DSH → qoder → 回答」，用来确认这条路通。

## 走线（实测事实，不是推测）

```
Qoder CN.exe  resources\app.asar.unpacked\...\dist\_worker\qoder-worker-runtime.obf.mjs
环境            ELECTRON_RUN_AS_NODE=1
参数            -p <提示词> --output-format stream-json --include-partial-messages
                --model <id> --tools "" --permission-mode dont_ask --no-session-persistence
```

事件是 Anthropic 式信封：

- `{type:'system',subtype:'init',session_id,model,permissionMode,tools,cwd,...}`
- `{type:'stream_event',event:{type:'message_start'|'content_block_start'|'content_block_delta'|'content_block_stop'|'message_delta'|'message_stop',...}}`
- 增量：`delta:{type:'thinking_delta',thinking}` 与 `delta:{type:'text_delta',text}`
- `{type:'assistant',message:{content:[...]}}` —— 每个块一份**重复快照**（流式模式下必须忽略，否则内容翻倍）
- `{type:'result',subtype:'success',result,stop_reason,total_credits,usage,modelUsage,...}`

## 三个必须记住的坑（都有实测依据）

1. **块类型只认结构化字段**（`delta.type` / `content_block.type`），绝不按 `<think>` 之类子串嗅探。
   Qoder 自己的渲染器就是靠子串匹配把输出搞坏的（`../qoder-think-leak.md`，WorkBuddy 调查报告复现过）。
   我们绕开它的渲染器直接读 NDJSON，所以**不对文本做任何改写**——改写文本正是那类 bug 的成因。
2. **`assistant` 快照会重复投喂**：`--include-partial-messages` 下增量和快照同时来，快照只当兜底
   （一个增量都没有时才用），否则回答会变成两份。
3. **用量是假的 0**：Qoder 免费路线把 `input_tokens` / `output_tokens` / `modelUsage.*` 一律报 0，
   所以合计为 0 时**不发 usage 块**，免得 DSH 把「上下文用量 0」当真。

## 两种模式（`mode`）—— **2026-10-16 晚的重要改动**

| 值 | 谁执行工具 | 长相 / 权限 | 代价 |
| --- | --- | --- | --- |
| `drive`（**默认**） | **DSH 真执行**，Qwen 只决定"调哪个工具、传什么参数" | 会话/权限/沙箱/diff/工具输出全部是 DSH 原生的，和标准模式一模一样；某一步失败**不会**把之前做完的事从界面上抹掉 | 每一步重新拉起一次 Qoder 进程（约 +7–10 秒） |
| `display`（旧做法） | Qwen 在自己进程里执行，DSH 只把它的工具卡照搬显示 | 需要 `qwen-display` 那 33 个同名影子工具 | 一个请求里 Qwen 自跑一整轮循环 ⇒ DSH 只能当"一条消息"，思考/正文/工具行交替堆叠；最后一步失败会把**整条消息（含已发生的真实改动）**丢掉 |

drive 是这么做到的（都有实测依据）：

1. Qoder 在 `message_delta{stop_reason:'tool_use'}` 那一刻**还没有执行任何工具**
   （实测 tool_result 永远出现在这之后），我们在这里收手。
2. 收手后立刻掐掉 Qoder 进程的**整棵进程树**（`taskkill /T /F`，见 `proc.js`），
   否则占了 stdout 的子进程会让这一轮永远等下去。
3. 同时用 `--permission-mode dont_ask` + 对任何 `can_use_tool` 一律回 `cancel` 兜底：
   万一它抢跑，也只会拿到一句拒绝，绝不会真改磁盘。
4. 交给 DSH 的 tool-call 块用**Dsh 真工具名**（`pwsh`/`read`/`write`/`edit`/…），参数补齐真工具必需的字段
   （例如 DSH 的 `pwsh` 强制 `description` 非空，缺了会直接抛 `invalid description`）。
5. Qwen 独有的工具名（`Agent`/`TaskCreate`/…）drive 模式**不生成任何真调用**，
   只在正文里出一行显性提示（"DSH 侧没有对应工具，这一调用没有执行"）。

## 落盘取证

每次调用把原始 NDJSON 写到 `runs\<时间戳>.jsonl`（只保留最近 50 个），
旁挂一份 `<时间戳>.meta.json`：`mode` / `halted` / `toolCalls` / `unmappedCalls` / `controlRequests` /
`credits` / `usd` / `diag`。出问题时先看这两个文件——事件流是权威事实，界面渲染不是。
端到端验收另有 `..\_verify-e2e.mjs`（读会话记录 + run 记录，逐条判定）。

## 配置（`cordis.patch.yml`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `drive` | `drive` = DSH 真执行工具（见上表）；`display` = 旧做法 |
| `permissionMode` | `bypass_permissions` | **只在 display 模式生效**；drive 模式固定 `dont_ask`（一个都不许真跑） |
| `toolNote` | 一段中文说明 | drive 模式附在系统提示后面的一句"本机哪些工具名有效"，省得它去调本机没有的工具 |
| `timeoutMs` | `300000` | **空闲**超时（一直在吐事件就续命）⇒ 掐整棵进程树并报错 |
| `allowUnlisted` | `false` | 是否放行不在免费表里的模型。**默认一路拦死**：未实测的模型可能直接花钱 |
| `selftest` | `true` | 是否注册 `qoder_selftest` / `qoder_cost_report` 工具 |
| `warm` | `false` | 常驻进程池，**只服务 display 模式**（drive 每轮都要掐进程，常驻没有意义） |
| `localTitles` | `true` | 会话标题本地生成，不为几个字起一个 Qoder 进程 |
| `warmIdleMs` | `60000` | 常驻进程空闲多久后回收 |
| `exe` / `worker` | Qoder CN 安装路径 | Qoder 升级后若挪了目录，改这里 |
| `logDir` | `...\qoder-provider\runs` | 原始事件落盘目录 |

### 权限询问必须应答（旧代码在这里卡死 300 秒）

Qoder 在自己的权限层要审批时，会往 stdout 发 `control_request{subtype:'can_use_tool', request_id, …}`，
然后**等 stdin 上的应答**。旧代码根本不应答 ⇒ 进程干等到空闲超时，用户看到的是
「本轮运行失败 qoder：常驻进程 300000ms 一直没输出（卡在工具审批之类的地方）」。

应答形状是从 Qoder worker 自己的校验代码里挖出来的（不是猜的）：

```json
{"type":"control_response","response":{"subtype":"success","request_id":"<id>","response":{"outcome":"cancel"}}}
```

`outcome` ∈ `proceed_once | proceed_always | proceed_always_and_save | modify_with_editor | cancel`。
drive 模式一律 `cancel`；display 模式一律 `proceed_once`（那边就是要它自己干活）。
实测：收到询问 → 回 cancel → worker 不报 malformed → 整轮 10.6 秒收场。

### 常驻进程池（只对 display 模式有意义）

冷热实测（同一进程连答三轮）：

| | 一轮耗时 |
| --- | --- |
| 每轮起一个新进程（旧行为） | 约 9–15 秒，其中 **约 7 秒是 Qoder 自己启动**（安全 hook + 初始化） |
| 一个进程连答第 2、3 轮 | **1.7 秒 / 1.8 秒**（纯模型时间） |

机制是 `-p --input-format stream-json`：进程从 stdin 连续接收 NDJSON 用户消息。五条设计规则：

1. **按会话隔离**：一个 DSH 会话一个进程（key = `sessionId`）；没有 sessionId 退回一次性进程。
2. **只发增量 + 逐条比对记忆**：DSH 每轮发完整历史，而常驻进程自己也有记忆，所以只发最新那一轮；
   发之前必须确认"进程记忆 == 这次历史的前缀"，对不上就重开并重发完整记录。
   （踩过的坑：用"前缀指纹"比对是错的——助手自己的回复会进入下一轮前缀，那样每轮都会误判成不一致。）
3. **`purpose` 调用不进池**：压缩这类调用会污染会话记忆，走一次性进程；标题见下一节。
4. **串行**：同一进程同一时刻只允许一轮（带排队），否则输出会交错。
5. **空闲回收**：`warmIdleMs` 到了就杀，不留孤儿进程。

### 标题不再冷启动

实测发现一次「你好」会打出**两次** Qoder 调用：正文一次、**会话标题生成**一次（日志里能看到
`result` 为「简单问候开场」的那一次），等于每轮付两次约 7 秒冷启动。

现在 `purpose === 'session-title'` 的请求**直接本地生成标题**（取第一条用户消息、去首尾标点、限 16 字），
不启进程、不花钱、瞬时返回；正文完全不受影响。要换回模型生成，把 `localTitles` 设为 `false`。

## 测试

本包不带测试脚本；验收方式是装好后在会话里选 `qoder / Qwen3.8-Flash` 跑一轮，
看界面是否出现正常的流式正文与工具卡。

### 免费名单只认实测（2026-10-16 的教训）

Qoder **不告诉你**哪个模型免费：`--list-models` 只列名字（连 `Auto` / `Fast` 都在里面）。
我一开始按「Flash / Preview 档看着像免费」推测，一次塞进 4 个未实测的模型，被用户当场指出——
**只有 Qwen3.8-Flash 是免费的**。这类猜测会直接花掉真钱。

所以现在的规则是：

1. 默认名单里**只有实测确认免费的** `Qwen3.8-Flash`。
2. 其它任何模型一律拒绝，除非显式打开 `allowUnlisted`（明确表示我知道它可能花钱）。
3. 想给某个模型"转正"，先跑 `..\_verify-models.mjs --yes <模型>` 实测一次，读 `result` 事件里的
   `total_credits` / `total_cost_usd`；确认是 0，才写进 `VERIFIED_FREE_MODELS`。实测记录落在
   `..\_model-verification.jsonl` 账本里，可复查。
