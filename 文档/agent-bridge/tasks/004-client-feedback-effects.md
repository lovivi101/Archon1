# 004 客户端反馈与动效（震动、屏幕抖动、过渡、按钮反馈）

- 类型：feature
- 范围：新建 `客户端/Godot_Client/scripts/views/effects.gd`；修改 `客户端/Godot_Client/scripts/views/page_view.gd`、`客户端/Godot_Client/scripts/services/profile_store.gd`（仅新增设置字段）、`客户端/Godot_Client/scripts/controllers/avalon_controller.gd`（仅新增信号/字段，不改现有逻辑）；新增测试 `客户端/Godot_Client/tools/smoke_effects.gd`；更新 `客户端/Godot_Client/README.md`
- 不要改动：`scripts/models/`、`scripts/network/`、`scripts/services/local_game.gd`、场景 `.tscn`、素材文件；页面布局坐标只允许为新元素增加，不移动现有元素
- 画布固定 750×1334，所有效果必须在该画布内完成，不得导致页面布局偏移后不复位

## 背景

页面由 `page_view.gd` 每次状态变化整页重建（已做帧内合并，并保留输入框状态）。重建会销毁所有动态节点，所以**动效不能依赖跨重建存活的节点**：一次性效果（抖动、弹出）应在触发时作用于页面根节点或新建节点，并在重建后不残留错误状态（例如抖动中重建，根节点位置必须回到 (0,0)）。

## 要求

### effects.gd（静态工具或 Node 均可）

1. `shake(target: Control, strength := 12.0, duration := 0.35)`：对页面根节点做位移抖动，结束后精确复位到原位置；重复触发时不叠加漂移。
2. `vibrate(ms: int)`：调用 `Input.vibrate_handheld(ms)`，仅在移动平台生效；受设置开关 `vibration`（默认开）控制。桌面端无副作用。
3. `pop_in(node: CanvasItem, duration := 0.25)`：缩放 0.6→1.0 + 透明度 0→1 的弹出（以节点中心为 pivot）。
4. `fade_in(node: CanvasItem, duration := 0.2)`：页面进入时淡入。
5. `press_feedback(button: BaseButton)`：按下缩小到 0.94、松开回弹，并调用 `vibrate(15)`。
6. `pulse(node: CanvasItem)`：用于倒计时最后 10 秒的循环缩放脉冲；节点被释放时 tween 自动结束，不报错。

### 触发点（在 page_view.gd / controller 中接入）

| 事件 | 效果 |
| --- | --- |
| 进入任意页面 | 动态层 `fade_in` 一次（仅在换页时，不在同页重建时重复播放） |
| 所有 `button()` / `mini_button()` 创建的按钮 | `press_feedback` |
| 结果页（第 11 页）展示任务失败或队伍被否决 | 页面 `shake` + `vibrate(120)`；结果徽章 `pop_in` |
| 结果页展示任务成功或队伍通过 | 结果徽章 `pop_in` + `vibrate(40)` |
| 结算页（第 13 页）| 胜负标题 `pop_in`；自己阵营失败时 `shake` 一次 |
| 身份页（第 6 页）| 身份卡 `pop_in` |
| 倒计时 ≤10 秒 | 在倒计时文字左侧显示已有素材 `timer-icon`（显示宽约 34px），并对图标 `pulse`；>10 秒时显示图标但不脉冲 |
| 收到被拒绝的操作提示（controller 的 notice） | 轻微 `shake(strength=6)` |

“仅播放一次”的判定：效果由**事件**触发而不是由重建触发。建议在 controller 增加 `signal effect_requested(kind: String)`，在收到 502/602/702 包、进入新页面、操作被拒时发出；页面监听并播放。重建期间不能重复播放同一个事件的效果。

### 设置

- `profile_store.gd` 新增 `data.vibration := true`（旧存档缺省时视为 true）。
- 设置对话框（`page_view.gd` 的 `show_settings()`）增加一个“震动反馈”CheckBox，保存到 profile。

### 测试 `tools/smoke_effects.gd`（headless）

1. `shake` 结束后目标位置精确回到原值；连续触发 3 次后仍回到原值。
2. 抖动过程中触发页面重建，结束后根节点位置为 (0,0)。
3. `vibration=false` 时 `vibrate()` 不调用底层（可通过可替换的回调/计数器断言）。
4. 本地对局跑到结果页，确认 `effect_requested` 对同一事件只发出一次。
5. 输出 `EFFECTS_OK`。

## 验证（在 `客户端/Godot_Client`，引擎 `E:\Game_Work\Godot\Godot_v4.7.2-stable_win64_console.exe`）

- `--headless --path . --import`
- `--headless --path . --script res://tools/smoke_effects.gd` → `EFFECTS_OK`
- `--path . --script res://tools/smoke_client.gd --audio-driver Dummy` → `ALL_15_PAGES_RENDERED`，无 `SCRIPT ERROR`
- `--headless --path . --script res://tools/smoke_flow.gd` → `CLIENT_PHASE_FLOW_OK`
- `--headless --path . --script res://tools/smoke_social_ui.gd` → `SOCIAL_UI_TABS_AND_SEARCH_OK`

## 报告

写到 `文档/agent-bridge/reports/004-client-feedback-effects.md`。不要提交 git；`verification/` 截图的变动在报告中注明即可。
