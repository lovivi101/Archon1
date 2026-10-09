# 报告：004 客户端反馈与动效

- 状态：完成。由 Claude 直接在 main 上实现，没有派给 Codex。任务单是按旧分支写的，下面写明和任务单不同的地方。
- 修改的文件：
  - `客户端/Godot_Client/scripts/views/effects.gd`（新）：`AvalonEffects.shake / vibrate / pop_in / fade_in / press_feedback / pulse`。
  - `客户端/Godot_Client/scripts/views/page_view.gd`：接入各触发点；设置页加“震动 开/关”。
  - `客户端/Godot_Client/scripts/controllers/avalon_controller.gd`：只加了 `result_serial`、`end_serial` 两个计数。
  - `客户端/Godot_Client/tools/smoke_effects.gd`（新）、`tools/capture_review.gd`（截图前多等 0.4 秒，避开入场动效）。
  - `AGENTS.md`、`客户端/Godot_Client/README.md`：验证命令加上 `smoke_effects.gd`。

## 触发点

| 事件 | 效果 |
| --- | --- |
| 换页（每页是独立场景，新实例即换页） | 整页 `fade_in` 0.2 秒 |
| `button()` 建的按钮 | 按下缩到 0.94、松开回弹，`vibrate(15)` |
| 投票结果 / 任务结果页 | 徽章 `pop_in`；否决或失败时整页 `shake` + `vibrate(120)`，通过或成功 `vibrate(40)` |
| 结算页 | 胜负标题 `pop_in`；自己输了 `shake` + `vibrate(120)` |
| 身份页 | 身份卡和徽记 `pop_in`（仅该页第一次绘制） |
| 倒计时 ≤ 10 秒 | 进度条右侧已有的 `timer-icon` 循环 `pulse` |
| 操作被拒（控制器的 `ui_error` 事件） | `shake(6)` + `vibrate(30)` |

## 和任务单的差异

- “只播一次”没有用 `effect_requested` 信号：换页会重建场景，信号可能在新页面连上之前就发出。改为控制器给每个结果 / 结局计数（`result_serial`、`end_serial`），页面用静态变量记住已播放的编号，重建和换页都不会重播。
- 震动开关在设置页（第 18 页），旧分支的 `show_settings()` 对话框在 main 上不存在。`profile.data.vibration` 缺省视为开，无需改 `profile_store.gd`。
- 计时图标沿用进度条上已有的 30px `timer-icon`，没有另加。
- `smoke_social_ui.gd` 在 main 上不存在，未运行。

## 验证

- `--headless --import`：通过。
- `smoke_effects.gd` → `EFFECTS_OK result=1 vibrations=2`：单次与连续 3 次抖动都精确回到原位；抖动中重建 3 次后页面根节点在 (0,0)；震动关时不调用；同一结果的效果只播一次。
- `smoke_client.gd` → `ALL_17_PAGES_RENDERED`（无 SCRIPT ERROR）；`smoke_flow.gd` → `CLIENT_PHASE_FLOW_OK`；`smoke_selfplay url=local` 5 人、10 人 → `GODOT_SELFPLAY_OK`。
- 注意：`effects.gd` 不能直接引用 `AvalonApp`，因为 `--script` 运行的测试脚本会在自动加载之前编译它，所以改为运行时从场景树查找。
