# 003 LLM 玩家与自对弈竞技场（服务端）

- 类型：feature
- 范围：`服务器端/AvalonTsServer/src/llm/`（新建）、`服务器端/AvalonTsServer/scripts/`（新增脚本与测试）、`服务器端/AvalonTsServer/package.json`（仅 scripts 字段）、`服务器端/AvalonTsServer/.gitignore`、`服务器端/AvalonTsServer/README.md`
- 不要改动：`src/rules.ts`、`src/ai.ts`、`src/game.service.ts` 等现有源码（接入在线对局是后续任务 007）；`客户端/`；`Configure_environment/`
- **不要读取、打印或提交任何 API key**；测试一律用假的 HTTP 服务或注入的 fetch，不访问外网

## 目标

让大模型扮演阿瓦隆玩家，能离线自对弈多局，记录每步决策、理由和发言，便于评估 AI 水平。之后（任务 007）会把同一个 Agent 接入在线房间。

## 设计要求

### 1. Provider（`src/llm/provider.ts`）

- OpenAI 兼容的 Chat Completions 客户端：`POST {baseUrl}/chat/completions`，Bearer key，`response_format: { type: "json_object" }`（若 provider 不支持则靠提示词约束 JSON）。
- 配置对象 `{ baseUrl, apiKey, model, timeoutMs, maxRetries }`；内置预设 `deepseek`：`baseUrl=https://api.deepseek.com`，`model=deepseek-chat`。
- 从环境读取配置的函数：
  - `AVALON_LLM_PROVIDER`（默认 `deepseek`）、`AVALON_LLM_BASE_URL`、`AVALON_LLM_MODEL` 可覆盖预设；
  - key 来源依次为 `AVALON_LLM_API_KEY`，或 `AVALON_LLM_KEY_FILE` 指向的文件（格式为一行 `key = xxx`，也兼容文件里只有 key 本身）。
- 超时（默认 20 s）用 `AbortController`；429/5xx 退避重试（默认 2 次）；其余错误抛出。
- 错误信息、日志中绝不能出现 key。
- 统计每次调用的 token 用量（`usage` 字段），供竞技场汇总。
- `fetch` 可注入，便于测试。

### 2. Agent（`src/llm/agent.ts`）

- `class LlmAgent`，方法与 `src/ai.ts` 的 `AvalonAi` 对应：`chooseTeam`、`vote`、`missionCard`、`assassinTarget`，另加 `speak`（发言）。全部为 async，入参 `(room: AvalonRoom, self: Player, context)`。
- **信息隔离是硬要求**：给模型的提示只能包含该座位合法可知的信息——自己的身份、`room.visibleSeats(self)` 的夜晚视野、公开历史（各轮提案、队员、每人投票、任务失败票数）、此前的公开发言。不能把其他人的 `role` 放进提示。写一个导出的 `buildPrompt()`（或同等函数）以便测试断言。
- 每种决策要求模型返回 JSON，例如 `{"team":[0,2],"reason":"..."}`、`{"approve":true,"reason":"..."}`、`{"success":false,"reason":"..."}`、`{"target":3,"reason":"..."}`、`{"speech":"..."}`（发言不超过 80 字）。
- 严格校验模型输出：座位合法、人数正确、好人不能出失败、刺杀目标不能是自己或已知队友。**输出非法、超时或调用失败时回退到 `AvalonAi` 的同名决策**，并在决策记录里标记 `fallback: true` 及原因。
- 提示词用中文，包含简明规则（按人数的队伍大小、第 4 轮 7 人以上需两张失败、五次否决坏人胜、刺杀梅林），以及对本身份的策略提示（梅林隐藏身份、派西维尔分辨梅林/莫甘娜、坏人伪装与协调出失败票等）。

### 3. 竞技场脚本（`scripts/llm-arena.js`，运行 `dist/` 编译产物）

```
node scripts/llm-arena.js [--games 1] [--players 5] [--llm-seats all|0,2,4] [--seed 1] [--out logs/arena] [--discussion 1]
```

- 用 `AvalonRoom` 直接驱动整局（不起 WebSocket 服务）：开局 → 组队 → （可选）讨论 → 投票 → 任务 → 刺杀。
- `--llm-seats` 之外的座位用 `AvalonAi`，方便做 LLM 对启发式 AI 的对比。
- 讨论：每次提案后，队长先说明理由，其余玩家按座位顺序各发言一次（`--discussion 0` 关闭）；发言进入之后所有人的公开历史。
- 输出：
  - 每局一个 JSONL（`<out>/<时间戳>-g<序号>.jsonl`）：每步一行，含座位、身份、动作、结果、理由/发言、耗时、token、是否回退；
  - 最后打印汇总：好人/坏人胜局数、刺杀命中率、LLM 调用次数、回退次数、token 合计、平均每步耗时。
- 所有日志和控制台输出都不能包含 key。
- 把 `logs/` 加入 `服务器端/AvalonTsServer/.gitignore`。
- 在 `package.json` 的 scripts 里加 `"arena": "npm run build && node scripts/llm-arena.js"`。

### 4. 测试（`scripts/llm-test.js`，不访问外网）

用 `node:http` 起一个假的 Chat Completions 服务（或注入 fetch），覆盖：

1. 解析合法 JSON 决策；
2. 非法输出（人数不对、好人出失败、刺杀队友、坏 JSON）→ 回退到 `AvalonAi` 且标记 `fallback`；
3. 超时 → 回退；
4. 429 后重试成功；
5. `buildPrompt()` 对一名忠臣生成的提示中不包含其他玩家的身份名（例如 5 人局中不出现“刺客在 3 号”这类信息；可断言提示里不出现其他座位的 role 字段/身份词与座位号的组合）；
6. 用假服务跑完整一局 `llm-arena`（`--games 1 --players 5`），进程退出码 0，生成 JSONL；
7. 错误信息与日志中不含传入的假 key 字符串。

把 `node scripts/llm-test.js` 接入 `test:smoke`（放在 `rules-test.js` 之后）。

### 5. 文档

在 `服务器端/AvalonTsServer/README.md` 新增“LLM 玩家与竞技场”一节：环境变量、运行示例（用 `AVALON_LLM_KEY_FILE` 指向本地 key 文件）、日志位置、费用提示（每局调用次数量级）。

## 验证（在 `服务器端/AvalonTsServer`）

- `npm run build` 无错误
- `node scripts/llm-test.js` 全部通过
- `npm run test:smoke` 全部通过

## 报告

写到 `文档/agent-bridge/reports/003-llm-player-arena.md`：列出新增文件、提示词设计要点、测试结果、预计每局 LLM 调用次数。不要提交 git。
