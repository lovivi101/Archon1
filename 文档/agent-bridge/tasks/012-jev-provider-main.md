# 012 Jev 决策后端与混合对战（按 main 重写 008）

- 类型：feature
- 前置：任务 011 与 011-fix1 已验收（`src/llm/provider.ts`、`prompt.ts`、`agent.ts`、`scripts/llm-arena.js`、`test/llm.test.js` 已在 main 上，座位号对模型统一从 1 开始）
- 取代：`tasks/008-jev-decision-provider.md`（按旧分支写的，不要照它的文件名做）
- 范围：`服务器端/AvalonTsServer/src/llm/`、`scripts/llm-arena.js`、`test/llm.test.js`、`README.md`（LLM 一节）
- 不要改动：`avalon.room.ts`、`avalon.ai.ts`、`avalon.types.ts`、`game.service.ts`、其他服务、`客户端/`
- **不要读取、打印或提交任何 API key**；测试一律用假服务，不访问外网

## 背景：Jev API（Claude 此前实测确认）

Jev 不生成文本，只回答带类型的问题。

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <key>
Content-Type: application/json

{
  "model": "jev-latest",
  "state": "<需要判断的材料，纯文本，≤32k tokens>",
  "questions": {
    "vote": {
      "type": "choice",
      "instructions": "你是否赞成这支队伍？",
      "criteria": { "approve": "赞成", "reject": "反对" }
    }
  }
}
```

实测响应：

```json
{"model":"jev-1.13.0","answers":{"vote":{"type":"choice","choice":"approve","confidence":0.56,"probabilities":{"approve":0.78,"reject":0.22}}},"usage":{"input_tokens":360,"output_tokens":31}}
```

- 可用题型只用 `choice`（`criteria` 为 `{选项键: 描述}`，每题最多 255 个选项）。`yes_no`、`probability`、`boolean` 返回 400，不要用。
- 一次请求可带多道题；state + questions 合计 ≤ 64k tokens。
- 错误：400 `{"detail":{"error_type":"api_usage_error",...}}`；422 为字段校验错误。两者都不重试，直接回退。

## 要求

1. **决策后端抽象**：在 `src/llm/` 里把现有 Chat Completions 客户端和新的 Jev 客户端统一成“决策后端”接口，Agent 不关心具体后端。保持 011 已有的公开行为与测试不变（可以重构内部）。
   - Jev 配置：`AVALON_JEV_API_KEY` 或 `AVALON_JEV_KEY_FILE`（同样兼容 `key = xxx`），`AVALON_JEV_MODEL`（默认 `jev-latest`），`AVALON_JEV_BASE_URL`（默认 `https://api.typesafe.ai`）。
   - 超时、429/5xx/网络错误重试、空 key 报错、错误与日志不含 key——与 011 的 Provider 一致。
   - usage 用 `input_tokens` / `output_tokens` 累计到同一个 `Tokens` 结构。
2. **Jev 决策映射**（`state` 复用 011 的 `buildPrompt` 的信息部分，只含该座位合法可知的信息；去掉“只返回 JSON”那段输出格式说明，改由 `questions` 表达）：
   - 投票：choice `approve` / `reject`。
   - 任务牌：好人直接出成功，不调用；坏人 choice `success` / `fail`。
   - 刺杀：choice，选项为合法候选（排除自己与已知同伴），键如 `seat_3`，描述为 `3号(昵称)`（1 起算，与 011-fix1 一致）。
   - 组队：choice，选项为“人数正确”的全部组合（键如 `team_1_3_5`，1 起算）；组合数超过 255 时不调用，直接用 `aiProposeTeam`，记录 `fallback: true`、原因“组合过多”。
   - 发言：Jev 不能生成文本，返回 `null`；竞技场里该座位直接 `endSpeech`，JSONL 记 `speech: null, reason: "provider has no text output"`。
   - 每次决策把 `probabilities` 与 `confidence` 写进 `Decision`（可选字段）和 JSONL，用于分析犹豫程度。
   - 响应缺字段、`choice` 不在选项中 → 回退到 `avalon.ai.ts` 同名函数并标记 `fallback`。
3. **混合对战**：竞技场新增 `--seat-providers`，例如 `--seat-providers 1:deepseek,2:jev,3:heuristic,4:jev,5:deepseek`（**座位号 1 起算**，与界面一致；在 README 写明）。未指定的座位沿用 `--llm-seats` 的旧逻辑以保持兼容；`heuristic` 表示内置 AI。若与 011 的座位重新编号方案冲突，按 011 的做法处理并在 JSONL / 汇总里写明实际座位。
   - 汇总按 provider 分组：对局数、按阵营的胜率、刺杀命中率（刺客属于该 provider 时）、调用次数、回退次数、token。
4. **测试**（加到 `test/llm.test.js`）：用假的 `/v1/systemone` 服务覆盖四种决策映射；组合数超限回退；非法 choice 回退；400 / 422 不重试并回退；key 不出现在日志与错误中；`probabilities` 写入 JSONL；用假服务跑一局 5 人混合对战（Chat Completions 假服务 + Jev 假服务 + 启发式）退出码 0。
5. **文档**：README 的“LLM 玩家与竞技场”一节补充 Jev 配置、`--seat-providers` 示例与费用说明（Jev 每局调用次数估算方法）。

## 验证（在 `服务器端/AvalonTsServer`）

- `npm run build`
- `npm test` 全部通过（PostgreSQL 测试无数据库时跳过属正常）

## 报告

写到 `文档/agent-bridge/reports/012-jev-provider-main.md`：新增 / 修改的文件、决策映射说明、测试结果摘要、混合对战汇总样例（假服务）。不要提交 git。
