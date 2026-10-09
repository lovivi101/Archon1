# 011-fix1 座位号改为从 1 开始，与游戏界面一致

- 类型：bug（任务 011 审核意见）
- 范围：`服务器端/AvalonTsServer/src/llm/prompt.ts`、`src/llm/agent.ts`、`scripts/llm-arena.js`、`test/llm.test.js`、`README.md`（LLM 一节里提到座位编号的地方）
- 不要改动：`avalon.room.ts`、`avalon.ai.ts`、`avalon.types.ts`、其他服务、客户端

## 审核发现（Claude）

011 按任务单把提示里的座位号定为“从 0 开始”。这是任务单的问题，不是实现的问题，但会带来实际错误：

- 游戏界面、内置 AI 发言（`aiSpeech`）、以及真人玩家在聊天里都用**从 1 开始**的座位号（“3号”就是 `seatIndex` 2）。
- 现在 `normalizeSpeech` 只把 `isAi` 座位的发言按 1 起算转换，非 AI 的发言当作已经是 0 起算。以后接入联机房间（真人发言）时，真人写的“3号”会被模型理解成另一个人。
- LLM 自己的发言（0 起算）进入房间聊天后，真人看到的号码也会错一位。

## 要求

1. **对模型的一切都用从 1 开始的座位号**：提示开头改为“座位号从 1 开始，与游戏界面一致；JSON 里的座位数字也从 1 开始”。`seatLabel` 输出 `3号(林中旅人)` 表示 `seatIndex` 2。历史、视野、候选、队伍、事实全部用这一套。
2. **JSON 输入输出在 Agent 边界换算**：模型返回的 `team`、`target` 是 1 起算，校验范围 1..人数，转换成 `seatIndex`（减 1）后再交给房间和回退逻辑；`Decision.value` 仍是内部的 `seatIndex`。JSONL 日志里同时记录内部座位和显示号码，或统一写明是哪一种（在 README 说明）。
3. **发言不再需要换算**：房间里的所有发言（内置 AI、真人、LLM）都已是 1 起算，`normalizeSpeech` 删除或改为只做“N号”→“N号(昵称)”的补全（不改数字）。回退发言直接用 `aiSpeech` 原文（截 80 字、去换行）。
4. 提示的格式示例同步改为 1 起算（例如 `{"team":[1,3],...}`、`{"target":4,...}`）。
5. 测试同步改：投票提示里当前队伍的号码、刺杀候选、发言补全等断言都按 1 起算；新增一条：真人（非 AI）发言里的“3号”在提示中仍是 `3号(对应昵称)`，指向 `seatIndex` 2；新增一条：模型返回 `{"target": 人数+1}` 或 `{"target": 0}` 判为非法并回退。

## 验证（在 `服务器端/AvalonTsServer`）

- `npm run build`
- `npm test` 全部通过（PostgreSQL 测试无数据库时跳过属正常）
- 用假服务跑一次 `node scripts/llm-arena.js --games 1 --players 5 --llm-seats 0,2,4`（或测试里已有的子进程用例），退出码 0

## 报告

写到 `文档/agent-bridge/reports/011-fix1-one-based-seats.md`，附一份修改后忠臣投票提示的完整样例（假数据）。不要提交 git。
