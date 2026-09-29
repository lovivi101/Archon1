# 001 任务结果页标题的轮次取值错误

- 类型：bug
- 范围：`客户端/Godot_Client/scripts/views/page_view.gd`
- 不要改动：其他文件、页面布局与坐标

## 现象

第 11 页（投票/任务结果）标题为“第 N 轮任务结果”，N 取自 `maxi(1, model.round - 1)`。

- 服务端和离线引擎在任务结束后才推进轮次，并通过随后的房间快照更新 `model.round`。若结果页先于快照渲染，或该任务直接让一方拿到三胜（轮次不再推进），标题会少一轮或多一轮。
- 例：第 3 轮任务第三次失败 → 游戏结束，`model.round` 仍为 3，标题显示“第 2 轮任务结果”，应为第 3 轮。

## 要求

- 任务结果标题改用本次结果包里的轮次：`model.last_mission` 中的 `round` 字段（服务端 602 包 `{ isSuccess, failCount, round }`）。缺失时退回 `model.round`。
- 投票结果标题（`is_vote` 分支）保持不变。
- 只改这一处表达式及必要的局部变量。

## 验证

在 `客户端/Godot_Client`：

- `E:\Game_Work\Godot\Godot_v4.7.2-stable_win64_console.exe --headless --path . --script res://tools/smoke_flow.gd` 输出 `CLIENT_PHASE_FLOW_OK`
- `E:\Game_Work\Godot\Godot_v4.7.2-stable_win64_console.exe --path . --script res://tools/smoke_client.gd --audio-driver Dummy` 输出 `ALL_15_PAGES_RENDERED`，且没有 `SCRIPT ERROR`。

## 报告

写到 `文档/agent-bridge/reports/001-mission-result-round.md`。不要提交 git。
