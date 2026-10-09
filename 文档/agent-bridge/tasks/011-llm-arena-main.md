# 011 LLM 玩家与自对弈竞技场（按 main 的服务端结构重写 003 + 003-fix1）

- 类型：feature
- 取代：`tasks/003-llm-player-arena.md`、`tasks/003-fix1-prompt-context.md`（它们是按旧分支的 `rules.ts` / `ai.ts` 写的，**不要照着旧文件名做**；旧分支上那份未提交的 `src/llm/` 代码也不要找、不要移植）
- 范围（只改这些）：
  - 新建 `服务器端/AvalonTsServer/src/llm/`（`provider.ts`、`prompt.ts`、`agent.ts`，可按需拆分）
  - 新建 `服务器端/AvalonTsServer/scripts/llm-arena.js`
  - 新建 `服务器端/AvalonTsServer/test/llm.test.js`
  - `服务器端/AvalonTsServer/src/avalon.room.ts`：**只允许新增两个公开只读方法**（见下文“房间接口”），不改任何现有逻辑
  - `服务器端/AvalonTsServer/package.json`（只加 scripts 里的 `arena`）、`.gitignore`（加 `logs/`）、`README.md`（新增一节）
- 不要改动：`avalon.ai.ts`、`avalon.types.ts`、`game.service.ts`、`game.gateway.ts`、其他服务、`客户端/`、`归档/`
- **不要读取、打印或提交任何 API key**。测试一律用 `node:http` 起的假服务或注入的 `fetch`，不访问外网。

## 背景：main 的服务端

- `src/avalon.room.ts` 的 `AvalonRoom` 是纯状态机：不碰 socket 和定时器，由调用方定期 `tick()`。可注入 `clock` 和 `random`（见 `RoomOptions`）。
- 一轮的流程：Speaking（队长先说，然后按座位顺序，每人 `chat()` 后 `endSpeech()`）→ Proposing（`propose`）→ Voting（`vote`）→ Mission（`mission`）[→ Excalibur] → 结果 [→ LadyOfLake] → 下一轮。被否决则换队长回到 Speaking。好人三胜后进入 Assassinating（`assassinate`）。
- `isAi` 的座位由 `tick()` 调 `src/avalon.ai.ts`（`aiProposeTeam`、`aiVote`、`aiMissionCard`、`aiAssassinTarget`、`aiSpeech`、`aiExcaliburHolder`、`aiExcaliburTarget`、`aiLadyTarget`）代为行动；这些函数只看 `AiView`（该座位合法可知的信息）。
- 规则辅助：`avalon.types.ts` 的 `teamSizeFor`、`failsNeeded`、`isBadRole`、`roleSetFor`、`rulesFor`、`Role`、`Stage`。
- 现有测试：`test/*.test.js`，`npm test` = `npm run build && node --test "test/*.test.js"`。参考 `test/room.test.js` 怎样不起服务直接驱动房间。

## 房间接口（`avalon.room.ts` 只新增这两个方法）

```ts
/** Seats that must act now (the current speaker, the captain, voters still to vote, ...). */
public pendingSeats(): number[]            // 等价于现有 private pendingActors() 映射成座位号
/** What this seat may legally know, the same view the built-in AI gets. */
public viewOf(seat: number): AiView        // 等价于现有 private viewFor(player)
```

在 `test/llm.test.js` 里加断言：两者对任意座位的结果与内置 AI 用到的一致（例如 `viewOf` 对忠臣不含他人身份）。

## 设计要求

### 1. Provider（`src/llm/provider.ts`）

- OpenAI 兼容 Chat Completions：`POST {baseUrl}/chat/completions`，`Authorization: Bearer <key>`，带 `response_format: { type: "json_object" }`。
- 配置 `{ baseUrl, apiKey, model, timeoutMs, maxRetries }`；预设 `deepseek`：`baseUrl=https://api.deepseek.com`、`model=deepseek-chat`。
- `providerFromEnv()`：`AVALON_LLM_PROVIDER`（默认 deepseek）、`AVALON_LLM_BASE_URL`、`AVALON_LLM_MODEL` 覆盖预设；key 依次取 `AVALON_LLM_API_KEY`，或 `AVALON_LLM_KEY_FILE` 指向的文件（一行 `key = xxx`，或文件只含 key）。
- **key 为空时在构造或首次调用时直接抛出“未配置 LLM key”**，不要带空 Bearer 发请求。
- 超时（默认 20 秒）用 `AbortController`；429、5xx、以及 `fetch` 抛出的网络错误（`TypeError`，如连接被重置）按指数退避重试（默认 2 次）；其他错误直接抛出。
- 错误信息和日志里绝不出现 key（包括 `Bearer xxx`）。
- 累计每次调用的 `usage`（prompt / completion tokens），供竞技场汇总。
- `fetch` 可注入。

### 2. 提示（`src/llm/prompt.ts`）

导出 `buildPrompt(room, seat, action)`，`action` 为 `speak | propose | vote | mission | assassinate`。输入只用 `room.viewOf(seat)` 和房间的**公开**信息（昵称、队长、当前提案队伍 `selectedSeats`、`missionResults`、`failedVotes`、`proposals`、`missions`、`chatFor(该座位的 userId)` 里的公开发言）。**不能把其他玩家的 `role` 放进提示**——这是硬要求。

提示用中文，包含：

1. **座位编号**：统一写明“座位号从 0 开始”，所有地方（历史、视野、候选、队伍）都写成 `2号(林中旅人)` 这种“号 + 昵称”的形式。
2. **规则**：本局人数；五轮各自的队伍人数（直接写出数字，从 `teamSizeFor` 取）；本局第 4 轮是否需要两张失败牌（`failsNeeded`）；连续五次否决坏人获胜；好人三胜后刺客可刺杀梅林。
3. **当前局面**：第几轮、当前队长、本轮队伍人数、已连续否决几次、任务比分（如“好人 1 胜，坏人 1 胜”）。
   - 投票时：**当前提案的队伍全部座位**（`selectedSeats`）。
   - 出任务时：队伍成员，以及本轮需要几张失败牌任务才失败。
   - 刺杀时：候选座位列表（排除自己和已知队友）。
4. **夜晚视野按身份解释**（不能统一写成“夜晚确认的座位”）：

| 身份 | 视野含义 |
| --- | --- |
| 梅林 | 这些座位是坏人（莫德雷德除外，你看不到他） |
| 派西维尔 | 这两个座位一个是梅林、一个是莫甘娜，你不知道哪个是哪个 |
| 刺客 / 莫甘娜 / 爪牙 / 莫德雷德 | 这些座位是你的坏人同伴（奥伯伦除外，你们互不相识） |
| 奥伯伦 | 你看不到任何人，其他坏人也不知道你 |
| 忠臣 | 你没有夜晚信息 |

   （刺杀阶段 `viewOf` 返回的是已亮明的全部坏人，说明里照实写。）`view.facts`（湖中仙女查验、王者之剑看到的牌）也要写进去。
5. **公开历史**：每次提案（队长、队伍、每人赞成/反对、是否通过），每次任务（队伍、失败牌数、结果），之前的公开发言（最多最近 30 条）。
6. **身份策略提示**：梅林隐藏身份、派西维尔分辨梅林与莫甘娜、坏人伪装并协调出失败牌、刺客根据发言和投票找梅林等，每个身份两三句即可。
7. **输出格式**：要求只返回 JSON：`{"speech":"..."}`（不超过 80 字）、`{"team":[0,2],"reason":"..."}`、`{"approve":true,"reason":"..."}`、`{"success":false,"reason":"..."}`、`{"target":3,"reason":"..."}`。

### 3. Agent（`src/llm/agent.ts`）

- `class LlmAgent`，构造参数 `(provider, options)`；方法 `speak / propose / vote / mission / assassinate`，全部 async，入参 `(room, seat)`，返回 `{ value, reason, fallback, fallbackReason?, tokens, ms }`。
- 严格校验输出：座位合法（0 ≤ seat < 人数）；队伍人数等于 `room.teamSize()`、无重复、包含队长本人可以不强制；**好人不能出失败**；刺杀目标不能是自己或已知队友；发言截到 80 字、去掉换行。
- 输出非法、JSON 解析失败、超时或调用失败 → 回退到 `avalon.ai.ts` 同名函数（用 `room.viewOf(seat)` 和一个确定的 `random`），并标记 `fallback: true` 与原因。发言回退用 `aiSpeech`。
- 王者之剑、湖中仙女不调用模型，直接用 `aiExcaliburHolder` / `aiExcaliburTarget` / `aiLadyTarget`（在记录里标明 `provider: "heuristic"`）。

### 4. 竞技场（`scripts/llm-arena.js`，运行 `dist/` 编译产物）

```
node scripts/llm-arena.js [--games 1] [--players 5] [--llm-seats all|0,2,4] [--seed 1] [--out logs/arena] [--speech 1]
```

驱动方式（不起 WebSocket 服务）：

- `new AvalonRoom(id, { config, send: () => {}, clock, random, targetPlayers })`；`config` 把各阶段时限设得极大（例如 1e9 ms），`nightMs`、`aiDelayMs`、`aiSpeechMs` 设为 1；`clock` 是脚本自己推进的假时钟。
- LLM 座位以**普通玩家**身份 `join("llm-<seat>", 昵称)` 并 `ready`；其余座位开局时由房间补成 AI（`isAi`）。这样房间会等 LLM 座位行动，而 AI 座位在 `tick()` 时自动行动。
- 主循环：若 `pendingSeats()` 里有 LLM 座位 → 依次 `await` 该座位的 Agent 决策，再调 `room.chat`+`endSpeech` / `propose` / `vote` / `mission` / `assassinate`（王者之剑、湖中仙女见上）；否则把假时钟加 2 再 `tick()`。直到 `room.outcome` 不为空。加一个总步数上限防止死循环。
- `--speech 0`：LLM 座位轮到发言时不调模型，直接 `endSpeech`。
- `--llm-seats` 之外的座位就是内置 AI，用于 LLM 对启发式 AI 的对比。
- 输出：每局一个 JSONL `<out>/<时间戳>-g<序号>.jsonl`，每步一行：座位、身份、动作、取值、理由 / 发言、耗时、token、是否回退；最后打印汇总：好人 / 坏人胜局数、刺杀命中率、LLM 调用次数、回退次数、token 合计、平均每步耗时。
- 日志与控制台输出都不能出现 key。
- `.gitignore` 加 `logs/`；`package.json` scripts 加 `"arena": "npm run build && node scripts/llm-arena.js"`。

### 5. 测试（`test/llm.test.js`，`node --test`，不访问外网）

用 `node:http` 起假的 Chat Completions 服务（或注入 `fetch`），覆盖：

1. 合法 JSON 决策被采用；
2. 非法输出（人数不对、好人出失败、刺杀队友、坏 JSON）→ 回退且标记 `fallback`；
3. 超时 → 回退；429 后重试成功；`fetch` 抛 `TypeError` 后重试成功；
4. 空 key → 抛出“未配置 LLM key”，信息里不含 `Bearer`；
5. 提示内容：投票提示包含当前提案队伍的全部座位号；出任务提示包含本轮需要的失败牌数；梅林 / 派西维尔 / 坏人 / 奥伯伦 / 忠臣五种身份的视野说明各不相同且与上表一致；**忠臣的提示里不出现任何其他座位的身份名**；
6. `pendingSeats()` / `viewOf()` 的断言（见“房间接口”）；
7. 用假服务跑完整一局 `scripts/llm-arena.js --games 1 --players 5`（子进程，环境变量指向假服务和假 key），退出码 0，生成 JSONL，且 JSONL 与输出中不含假 key 字符串。

### 6. 文档

`服务器端/AvalonTsServer/README.md` 新增“LLM 玩家与竞技场”一节：环境变量、运行示例（用 `AVALON_LLM_KEY_FILE` 指向本地 key 文件）、日志位置、费用量级（估算每局调用次数，写出估算方法）。

## 验证（在 `服务器端/AvalonTsServer`）

- `npm run build` 无错误
- `npm test` 全部通过（含新的 `test/llm.test.js`；PostgreSQL 测试没有数据库时会跳过，属正常）

## 报告

写到 `文档/agent-bridge/reports/011-llm-arena-main.md`：新增 / 修改的文件、提示词设计要点（附一份忠臣投票时的完整提示样例，用假数据）、测试结果原文摘要、预计每局 LLM 调用次数。不要提交 git。

## 补充

- `join()` 按顺序分配座位。`--llm-seats 0,2,4` 这种指定座位时，需要让 LLM 玩家正好坐在这些座位上（例如先按座位顺序依次加入，非 LLM 座位留给开局补 AI；若房间接口做不到，就把 LLM 座位按加入顺序重新编号，并在 JSONL 与汇总里写明实际座位）。选一种做法，在报告里说明。
