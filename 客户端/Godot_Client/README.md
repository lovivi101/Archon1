# 阿瓦隆：暗影对决 — Godot 客户端

Godot 4.7.2 项目。运行 `Run-Game.cmd` 从登录页开始；`Open-Editor.cmd` 打开编辑器。需要联机时先运行 `Run-Server.cmd`，再在客户端点击“连接 TS 服务器”。引擎路径为 `E:\Game_Work\Godot\Godot_v4.7.2-stable_win64.exe`。

## 当前功能

- 01–16 页均可加载。登录、主页、连服、房间、身份确认、组队、投票、任务、刺杀、结算、复盘、排行、好友已接入交互。
- 游客体验进入主页；主页可开始 5 人本地练习，4 名 AI 自动行动。支持从准备到结算的完整对局。`tools/smoke_client.gd` 用固定种子验证完整流程。
- “连接 TS 服务器”默认使用 `ws://127.0.0.1:8888`。客户端使用 Godot 原生 `WebSocketPeer`，协议为 little-endian `uint16 seq + uint16 route + UTF-8 JSON`，与 `服务器端/AvalonTsServer` 的 101–702 路由一致。服务端控制联机房间和对局状态，本地 AI 不会参与联机局。
- 排行和好友是本机资料；复盘是本局公开事件的规则摘要，分享按钮保存当前复盘页面 PNG 至 `user://avalon-share.png`。这些功能没有云端服务或外部大模型调用。

## 画面和资源

固定画布及窗口 **750×1334**，窗口不可调整大小。无分辨率适配。拆分 PNG 未改像素；`assets/ui/catalog.json` 记录有效区域，页面在 `scripts/views/page_view.gd` 中按指定宽度算高度，保持原始宽高比。动态文字和命中区域独立于图片。素材目录中的完整原始 UI 仅作为视觉参考，没有被直接用作界面背景。当前字体是系统字体，拆分素材与原稿部分元素不同，因此与参考图仍有美术差异。

## 结构

| 层 | 文件 | 职责 |
| --- | --- | --- |
| Model | `scripts/models/avalon_model.gd` | 客户端可见对局状态 |
| View | `scripts/views/page_view.gd`、`scenes/page_02.tscn` 等 | 15 页画面与按钮 |
| Controller | `scripts/controllers/avalon_controller.gd` | 页面流转和操作校验 |
| 网络 | `scripts/network/` | WebSocket 与二进制协议 |
| 本地规则 | `scripts/services/local_game.gd` | 离线对局与 AI 玩家 |
| 资料 | `scripts/services/profile_store.gd` | 本机用户、对局记录和好友 |

## 验证

在项目根目录执行：

```powershell
& 'E:\Game_Work\Godot\Godot_v4.7.2-stable_win64_console.exe' --headless --path . --import
& 'E:\Game_Work\Godot\Godot_v4.7.2-stable_win64_console.exe' --path . --script res://tools/smoke_client.gd --audio-driver Dummy
& 'E:\Game_Work\Godot\Godot_v4.7.2-stable_win64_console.exe' --headless --path . --script res://tools/smoke_flow.gd
```

第二条命令会渲染 15 页、保存 `verification/page_*.png`，并模拟一整局。第三条核对身份、组队、投票结果、任务页面的流转。联机验证：先在 `服务器端/AvalonTsServer` 运行 `npm run build`，再以 `PORT=8899`、`AVALON_NIGHT_SECONDS=1`、`AVALON_AI_TICK_MS=75` 启动 `node dist/server.js`，然后运行 `tools/smoke_network.gd`。服务端默认端口 8888 供界面使用。

`tools/build_pages.py` 可重新复制 UI 素材并生成页面基础场景；不要把完整参考图写入场景。由于运行页用脚本绘制，页面布局修改在 `page_view.gd` 中进行。
