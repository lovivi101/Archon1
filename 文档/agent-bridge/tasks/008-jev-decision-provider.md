# 008 TypeSafe Jev 决策 Provider 与混合对战

- 类型：feature
- 前置：任务 003（`src/llm/`、`scripts/llm-arena.js`）已验收
- 范围：`服务器端/AvalonTsServer/src/llm/`、`服务器端/AvalonTsServer/scripts/llm-arena.js`、`scripts/llm-test.js`、`README.md`
- 不要改动：`src/rules.ts`、`src/ai.ts`、`src/game.service.ts`、`客户端/`、`Configure_environment/`
- **不要读取、打印或提交任何 API key**；测试一律用假服务，不访问外网

## 背景：Jev API（已由 Claude 实测确认）

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

- 已确认可用的题型：`choice`（`criteria` 为 `{选项键: 描述}`，每题最多 255 个选项）。`score` 存在但需要 `criteria`；`yes_no`、`probability`、`boolean` 返回 400，不要用。
- 一次请求可以带多道题；state + questions 合计 ≤64k tokens。
- 错误：400 `{"detail":{"error_type":"api_usage_error",...}}`，422 为字段校验错误。

## 要求

1. **Provider 抽象**：把 003 的 OpenAI 兼容客户端和新的 Jev 客户端统一成“决策后端”接口，Agent 不关心具体后端。Jev 配置：`AVALON_JEV_API_KEY` 或 `AVALON_JEV_KEY_FILE`（同样兼容 `key = xxx` 格式），`AVALON_JEV_MODEL`（默认 `jev-latest`），`AVALON_JEV_BASE_URL`（默认 `https://api.typesafe.ai`）。超时、重试、错误信息不含 key，与 003 一致。
2. **Jev 决策映射**（state 复用 003 的信息隔离提示构造，只含该座位合法可知信息）：
   - 投票：choice `approve/reject`。
   - 任务牌：好人直接出成功，不调用；坏人 choice `success/fail`。
   - 刺杀：choice，选项为合法目标座位（键如 `seat_3`，描述含座位号与昵称），排除自己与已知队友。
   - 组队：choice，选项为“包含队长本人、人数正确”的所有组合（键如 `team_0_2_4`）；组合数超过 255 时退回 `AvalonAi.chooseTeam`。
   - 发言：Jev 不支持，返回 `null`，竞技场里该座位跳过发言（记录 `speech: null, reason: "provider has no text output"`）。
   - 记录每次决策的 `probabilities` 与 `confidence`，写入 JSONL，便于分析 AI 的犹豫程度。
   - 响应缺字段、`choice` 不在选项中 → 回退 `AvalonAi` 并标记 `fallback`。
3. **竞技场混合对战**：新增参数 `--seat-providers`，例如 `--seat-providers 0:deepseek,1:jev,2:heuristic,3:jev,4:deepseek`；未指定的座位使用 `--llm-seats` 的旧逻辑以保持兼容。汇总按 provider 分组统计：胜率（按阵营）、刺杀命中率、调用次数、回退次数、token。
4. **测试**（加入 `scripts/llm-test.js`）：用假 `/v1/systemone` 服务覆盖四种决策映射、组合数超限回退、非法 choice 回退、400/422 处理、key 不出现在日志；用假服务跑一局 5 人混合对战（DeepSeek 假服务 + Jev 假服务 + 启发式）退出码 0。
5. **文档**：README 的“LLM 玩家与竞技场”一节补充 Jev 配置与混合对战示例。

## 验证（在 `服务器端/AvalonTsServer`）

- `npm run build`
- `node scripts/llm-test.js`
- `npm run test:smoke`

## 报告

写到 `文档/agent-bridge/reports/008-jev-decision-provider.md`。不要提交 git。
