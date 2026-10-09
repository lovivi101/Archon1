# 报告：012 Jev 决策后端与混合对战（按 main 重写 008）

- 状态：完成
- 修改的文件：
  - `服务器端/AvalonTsServer/src/llm/backend.ts`（新增）— 定义统一 `DecisionBackend` 与结果接口，提供 Chat Completions 适配器，保留原 JSON 校验和座位转换。
  - `服务器端/AvalonTsServer/src/llm/jev.ts`（新增）— Jev 配置、choice 决策映射、候选枚举、响应校验及置信度/概率记录。
  - `服务器端/AvalonTsServer/src/llm/provider.ts` — 提取共用 JSON 请求层与 key 配置解析；保留 `ChatCompletionProvider.complete()` 和 `providerFromEnv()`；复用超时、重试、脱敏与 token 累计。
  - `服务器端/AvalonTsServer/src/llm/prompt.ts` — 提取共享 `buildState()` 信息部分；Chat 原输出格式保留，Jev 不带 JSON 输出说明。
  - `服务器端/AvalonTsServer/src/llm/agent.ts` — 通过统一后端获取决策，统一回退到原 AI；新增可选 `confidence`、`probabilities`、逻辑调用数，允许空发言。
  - `服务器端/AvalonTsServer/scripts/llm-arena.js` — 增加 `--seat-providers`、实际座位映射、Jev 空发言、按 provider 的对局/阵营胜率/刺杀/调用/回退/token 汇总；全启发式不加载凭据，全 Jev 不加载 Chat 凭据。
  - `服务器端/AvalonTsServer/test/llm.test.js` — 保留原有 15 项测试，新增 7 项 Jev/混合对战测试；子进程显式使用假凭据和本地假服务地址。
  - `服务器端/AvalonTsServer/README.md` — 仅补充“LLM 玩家与竞技场”一节：Jev 配置、参数示例、座位与统计口径、调用次数及费用估算。
  - `文档/agent-bridge/reports/012-jev-provider-main.md`（新增）— 本报告。
- 验证：
  - `npm run build` → 通过，退出码 0，`tsc -p tsconfig.json` 无错误。
  - `node --test test/llm.test.js` → 通过，22 项通过、0 失败；最后一次全量验证也包含这 22 项。
  - `AVALON_PG_TEST=0 npm test` → 通过，退出码 0；67 项测试，66 通过、0 失败、1 跳过，最终运行耗时约 17.4 秒。显式关闭真实 PostgreSQL 测试以遵守本任务离线验证要求；跳过提示为 `set PGHOST and AVALON_PG_TEST=1`。
  - `git diff --check` → 通过，退出码 0；只有 Git 的 LF/CRLF 转换提示，没有空白错误。
  - 本地假服务 5 人 `deepseek + jev + heuristic` 子进程 → 退出码 0；JSONL 以 outcome 结束，存在 `probabilities`、`confidence` 和空发言记录，分组调用/token 与动作记录一致。
  - 额外覆盖部分座位覆盖、全启发式无 key、全 Jev 无 Chat key、Jev 在 `--speech 0` 下仍记录空发言，以及非法/重复/越界座位参数。
- 未完成或需要决定的事项：无任务范围内遗留项。未访问真实 Jev/Chat 服务、未读取真实 key 文件；测试只使用合成凭据、注入 fetch 或 `127.0.0.1` 假服务。因此没有真实模型效果或实际费用结论。未改动房间规则、内置 AI、其他服务、客户端或归档，未执行 git commit/push。

## 决策映射与回退

| 动作 | Jev 问题/结果 | 不调用与回退规则 |
| --- | --- | --- |
| 投票 | `choice`：`approve` / `reject` → 布尔值 | 非法响应回退 `aiVote` |
| 任务牌 | 坏人 `choice`：`success` / `fail` → 布尔值 | 好人直接成功，0 调用；非法响应回退 `aiMissionCard` |
| 刺杀 | `choice`：`seat_3`，描述 `3号(昵称)` | 只包含排除自己和已知同伴后的候选；非法响应回退 `aiAssassinTarget` |
| 组队 | `choice`：`team_1_3_5`，完整枚举人数正确的队伍 | 超过 255 组合时 0 调用，回退 `aiProposeTeam`，记录 `fallbackReason: "组合过多"` |
| 发言 | 返回 `null` | 不调用服务，直接 `endSpeech`；JSONL 记录 `speech: null, reason: "provider has no text output"`，关闭发言时也保留此记录 |

题目键、候选描述、提示中的号码从 1 开始；后端返回给 Agent 的座位值已经转换为从 0 开始的内部索引。王者之剑与湖中仙女继续使用原启发式逻辑。

Jev 使用 `AVALON_JEV_API_KEY` 或 `AVALON_JEV_KEY_FILE`（支持 `key = xxx`），默认模型 `jev-latest`、默认地址 `https://api.typesafe.ai`。请求超时 20 秒；429、5xx 和网络 TypeError 最多重试 2 次；超时、400、422 等直接回退。共用请求层只输出固定错误信息，不回显响应正文或底层异常。合法响应仅复制候选白名单中的数值概率；缺失/非法 `choice`、`type`、`confidence`、`probabilities` 都回退。`input_tokens/output_tokens` 计入统一 `Tokens.prompt/completion`，有 usage 的非法决策也保留其消耗。

测试验证了本地 `/v1/systemone` 的四种决策请求、合法座位与全部组合、超时中止、重试/不重试、空 key、假 key 文件与配置覆盖、合法信息边界、错误和 JSONL 脱敏、概率持久化及混合局统计。

当前规则最多 `C(10,5)=252` 种组合，因此超过 255 的分支使用测试夹具只给 Jev 枚举注入 11 人视图，Agent 回退仍使用合法 10 人视图。开发中的首次边界测试把 11 人传给了原 AI，曾出现 `Unsupported player count 11`；已修正夹具，并在定向测试与最终全量测试中通过，没有为测试修改游戏规则。

## 混合对战汇总样例（实际运行的假服务）

参数：`--games 1 --players 5 --seat-providers 1:deepseek,2:jev,3:heuristic,4:jev,5:deepseek --seed 1`，发言开启。测试进程将 Chat 与 Jev 地址都指向本机临时 HTTP 假服务，不使用生产地址；以下 token 是假服务返回的合成 usage。

沿用 011 的加入与重编号方式，模型座位先加入，启发式补齐。每局 JSONL 首行和汇总中的 `providerSeatMapping` 都采用 1 起算：

| 请求显示座位 | 实际显示座位 | provider |
| --- | --- | --- |
| 1 | 1 | deepseek |
| 2 | 2 | jev |
| 4 | 3 | jev |
| 5 | 4 | deepseek |
| 3 | 5 | heuristic |

本局坏人获胜，刺客命中；56 个记录动作，31 次逻辑请求，0 回退；合计输入 361、输出 177 tokens。HTTP 重试不重复计入逻辑调用数，Jev 空发言和好人成功牌不计调用。

| provider | 对局数 | 好人胜局/参与局（胜率） | 坏人胜局/参与局（胜率） | 刺杀命中/次数 | 调用 | 回退 | 输入/输出 tokens |
| --- | --- | --- | --- | --- | --- | --- | --- |
| deepseek | 1 | 0/1（0%） | 1/1（100%） | 0/0 | 21 | 0 | 231/147 |
| jev | 1 | 0/1（0%） | 0/0（字段值为 0） | 0/0 | 10 | 0 | 130/30 |
| heuristic | 1 | 0/0（字段值为 0） | 1/1（100%） | 1/1 | 0 | 0 | 0/0 |

分组 `games` 为 provider 参与局数；按阵营的分母是该 provider 在该局至少有一个该阵营座位的局数，同阵营多个座位不重复计数，跨阵营可分别计数。刺杀只归属实际刺客的 provider。零分母比率记录 0。该样例仅验证流程与统计，不代表模型胜率。

报告通过文件编辑工具 apply_patch 写入，随后读回确认内容非空。
