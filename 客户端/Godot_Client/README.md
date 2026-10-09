# 阿瓦隆：暗影对决 — Godot 客户端

Godot 4.7.2 项目。运行 `Run-Game.cmd` 从登录页开始；`Open-Editor.cmd` 打开编辑器。需要联机时先运行 `Run-Server.cmd`，再在客户端点击“连接 TS 服务器”。引擎路径为 `E:\Game_Work\Godot\Godot_v4.7.2-stable_win64.exe`。

## 当前功能

- 01–16 页均可加载。登录、主页、连服、房间、身份确认、组队、投票、任务、刺杀、结算、复盘、排行、好友已接入交互。
- 游客体验进入主页；主页可开始 5 人本地练习，4 名 AI 自动行动。支持从准备到结算的完整对局。`tools/smoke_client.gd` 用固定种子验证完整流程。
- “连接 TS 服务器”默认使用 `ws://127.0.0.1:8888`。客户端使用 Godot 原生 `WebSocketPeer`，协议为 little-endian `uint16 seq + uint16 route + UTF-8 JSON`，与 `服务器端/AvalonTsServer` 的 101–702 路由一致。服务端控制联机房间和对局状态，本地 AI 不会参与联机局。
- 联机登录：首次以游客身份登录，服务端返回的令牌按服务器地址保存在 `user://profile.json`，之后自动用令牌恢复同一账号（掉线重连后回到原座位）；令牌失效时自动改为游客登录。账号在别处登录时（关闭码 4001）不再自动重连。
- 联机对局：阶段、队长、轮次和倒计时以服务端推送为准；服务端拒绝操作时会在底部显示原因，并允许重新投票或出牌。“退出房间”会通知服务端释放座位；结算页“再来一局”会让服务端把房间重置为新一局。
- 排行页有四个标签：“全服排行”（服务端积分榜）、“好友排行”（只排你和好友）、“我的战绩”（最近对局，点开可看服务端保存的完整复盘）、“本机记录”（本地练习的记录）。联机对局结束后结算页显示本局积分变化和段位。未连接服务器时，打开排行页会先用保存的令牌连服拉取数据，连不上则只显示本机记录。
- 复盘：联机对局可看服务端完整复盘（身份、每次组队与投票、任务、湖中仙女、王者之剑）；本地练习是本局公开事件的规则摘要。
- 好友（需连接服务器）：好友页有“好友 / 申请 / 最近同局 / 找人”四个标签。“最近同局”列出最近联机对局里的其他玩家，可直接加好友；也可以按昵称或 ID 找人并申请，对方同意后成为好友；好友列表显示在线状态和所在房间，可私聊、删除（点两次确认）。在未开局的联机房间里（房间页左上“好友列表”）可以邀请在线好友，对方在好友页顶部看到邀请并一键加入。收到好友申请、私信、邀请时底部会提示。
- 分享：联机房间可“邀请好友”（复制邀请文字，微信小游戏里直接发卡片），大厅可“粘贴”邀请取出房间号；结算页和复盘页“分享战绩”会生成战绩图并预览。各平台行为、微信接口和 Android 分享插件接口见 `docs/分享与邀请.md`。

## 游戏流程

- **登录**：必须勾选《用户协议》《隐私政策》才能登录（同意一次后自动勾选）；协议、隐私、适龄提示可点开查看（当前为草案，上线前需替换为审核后的文本）。主界面左上角头像进入“个人设置”，可修改昵称、从 10 个头像中选择、开关声音。
- **联机大厅**（主界面“联机对战”）：选择 5～10 人后“快速匹配”（进入同人数的公开房间）或“创建房间”（得到 6 位房间号），也可以输入好友的房间号加入。房间页显示本局身份配置和特殊规则，准备后可取消。
- **一轮**：轮流发言（队长先说，每人限时，可发文字、可提前结束）→ 队长组队 → 全员投票（否决则换队长、重新发言）→ 任务 → 结果。7 人局第 2～4 轮任务后使用湖中仙女；10 人局队长组队时授予王者之剑，出牌后持有者可翻转一张牌。好人赢满 3 局后坏人亮明身份，坏人可私聊商议，刺客刺杀。
- 提名、投票、任务结果、湖中仙女、王者之剑等公开事件会以“系统”消息出现在发言记录里。停留在身份页或结果页时，如果轮到自己行动会有红字提醒。对局中右上角“退出”需点两次确认，座位交给 AI 托管。别人开始新一局不会把你从结算或复盘页拉走。
- **本地练习**：主界面选择 5～10 人，离线与 AI 对战，规则与联机完全相同（发言、湖中仙女、王者之剑、刺杀前亮明身份）。规则由 `scripts/services/local_game.gd`（服务端 `avalon.room.ts` 的 GDScript 版本）和 `scripts/services/local_ai.gd`（`avalon.ai.ts` 的 GDScript 版本）实现，修改规则或 AI 时两边要同步。本地练习没有倒计时，AI 会稍作停顿再行动。

## 画面和资源

设计画布为 **750×1334**，按 `canvas_items` 模式等比缩放，屏幕比例不同时留黑边而不拉伸；桌面窗口默认 600×1067，可调整大小。拆分 PNG 未改像素；`assets/ui/catalog.json` 记录有效区域，页面在 `scripts/views/page_view.gd` 中按指定宽度算高度，保持原始宽高比。动态文字和命中区域独立于图片。素材目录中的完整原始 UI 仅作为视觉参考，没有被直接用作界面背景。当前字体是系统字体，拆分素材与原稿部分元素不同，因此与参考图仍有美术差异。

## 结构

| 层 | 文件 | 职责 |
| --- | --- | --- |
| Model | `scripts/models/avalon_model.gd` | 客户端可见对局状态 |
| View | `scripts/views/page_view.gd`、`scenes/page_02.tscn` 等 | 15 页画面与按钮 |
| Controller | `scripts/controllers/avalon_controller.gd` | 页面流转和操作校验 |
| 网络 | `scripts/network/` | WebSocket 与二进制协议 |
| 本地规则 | `scripts/services/local_game.gd` | 离线对局与 AI 玩家（首任队长随机） |
| 资料 | `scripts/services/profile_store.gd` | 本机用户、对局记录 |
| 分享 | `scripts/services/share_service.gd` | 邀请、战绩图、各平台分享接口 |
| 声音 | `scripts/services/audio_service.gd` | 音效与音乐（素材清单见 `assets/audio/README.md`） |

## 验证

在项目根目录执行：

```powershell
& 'E:\Game_Work\Godot\Godot_v4.7.2-stable_win64_console.exe' --headless --path . --import
& 'E:\Game_Work\Godot\Godot_v4.7.2-stable_win64_console.exe' --path . --script res://tools/smoke_client.gd --audio-driver Dummy
& 'E:\Game_Work\Godot\Godot_v4.7.2-stable_win64_console.exe' --headless --path . --script res://tools/smoke_flow.gd
& 'E:\Game_Work\Godot\Godot_v4.7.2-stable_win64_console.exe' --headless --path . --script res://tools/smoke_effects.gd
```

Linux 下用 `Godot_v4.7.2-stable_linux.x86_64` 执行相同参数；没有显示器时第二条需要放在 `xvfb-run -a` 下运行。

第二条命令会渲染 15 页、保存 `verification/page_*.png`，并模拟一整局。第三条核对身份、组队、投票结果、任务页面的流转。联机验证：先在 `服务器端/AvalonTsServer` 运行 `npm run build`，再以 `PORT=8899`、`AVALON_NIGHT_SECONDS=1`、`AVALON_AI_TICK_MS=75` 启动 `node dist/server.js`，然后运行 `tools/smoke_network.gd`（完整联机对局）和 `tools/smoke_lifecycle.gd`（再来一局、退出房间、被同账号顶号后不再重连）。

`tools/smoke_friends.gd` 用一个真人客户端加一条原始连接在联机服务端上走完好友流程：搜索、申请、同意、双向私信、邀请进房、收到邀请、删除（加 `-- shots=目录` 保存好友页截图）。

`tools/smoke_excalibur.gd` 让玩家座位在 10 人局里持有王者之剑时通过界面翻牌，检查私密结果和得知的阵营（随机自对局里玩家很少拿到剑）。`tools/capture_review.gd` 按 5/7/10 人局截取全部页面，供 UI 审查。

`tools/smoke_share.gd -- room=654321` 验证邀请、粘贴、启动房间号和战绩图（需真实渲染，Linux 下用 `xvfb-run -a`）。

`tools/smoke_selfplay.gd` 让一个随机行动的“真人”通过客户端打完整联机对局（随机发言、组队、投票、出牌，拿到湖中仙女或王者之剑就随机使用，是刺客就刺杀），其余座位由服务端 AI 填满；服务端拒绝合法操作、页面没跟上阶段、私密结果缺失或卡住都会报错。加上 `url=local` 则在本地练习模式下对战（不需要服务端）。联机时打完后还会检查战绩、积分推送、排行榜和复盘页。`tools/ai_balance.gd -- games=100` 统计本地 AI 纯 AI 对局的好人胜率，用来和服务端的平衡对照。用法：

```powershell
& 'E:\Game_Work\Godot\Godot_v4.7.2-stable_win64_console.exe' --path . --script res://tools/smoke_selfplay.gd -- players=7 games=3 seed=1 url=ws://127.0.0.1:8899 shots=D:/tmp/shots
```

服务端建议以短时长启动，例如 `AVALON_SPEAK_SECONDS=4`、`AVALON_AI_SPEECH_MS=80`，其余阶段 8 秒。服务端默认端口 8888 供界面使用。

新增或更换 `assets/` 下的图片后，需要先用编辑器打开项目或执行上面的 `--import` 命令完成导入（`*.import` 文件不入库），否则运行时会报 “No loader found”。

`tools/build_pages.py`（需要 Python 与 Pillow，在仓库根目录运行）可重新复制 UI 素材并生成页面基础场景；不要把完整参考图写入场景。由于运行页用脚本绘制，页面布局修改在 `page_view.gd` 中进行。

## 导出 Android App

`export_presets.cfg` 已包含 “Android” 预设：包名 `com.archon1.avalon`，arm64-v8a，最低 Android 7.0，锁定竖屏，申请网络权限，使用 `assets/app/` 下的应用图标和自适应图标。`tools/`、`verification/` 和 `.cmd` 不会打进安装包。

一次性准备（Godot 编辑器 → 编辑器设置 → 导出 → Android）：

1. 安装 Godot 4.7.2 导出模板（编辑器菜单“编辑器 → 管理导出模板”）。
2. `Android SDK Path` 指向 Android SDK（Android Studio 自带，或命令行工具安装的 SDK），需要其中的 `build-tools` 和 `platform-tools`。
3. `Java SDK Path` 指向 JDK 17 或更高版本。调试证书由 Godot 自动生成。

导出调试包（可直接安装到手机测试）：

```powershell
& 'E:\Game_Work\Godot\Godot_v4.7.2-stable_win64_console.exe' --headless --path . --export-debug "Android" build/android/Avalon-debug.apk
```

也可以在编辑器“项目 → 导出 → Android → 导出项目”里操作。产物在 `build/`（不入库）。Linux/macOS 命令行导出时请使用 UTF-8 语言环境（如 `LC_ALL=C.UTF-8`），否则签名工具无法处理路径中的中文目录名。

发布包需要你自己的签名证书，证书一旦用于上架就要长期保管，**不要提交到仓库**：

```powershell
keytool -genkeypair -v -keystore avalon-release.keystore -alias avalon -keyalg RSA -keysize 2048 -validity 10000
$env:GODOT_ANDROID_KEYSTORE_RELEASE_PATH = 'D:\keys\avalon-release.keystore'
$env:GODOT_ANDROID_KEYSTORE_RELEASE_USER = 'avalon'
$env:GODOT_ANDROID_KEYSTORE_RELEASE_PASSWORD = '<证书密码>'
& 'E:\Game_Work\Godot\Godot_v4.7.2-stable_win64_console.exe' --headless --path . --export-release "Android" build/android/Avalon.apk
```

手机联机时，服务器地址不能用 `127.0.0.1`（那是手机自己），要在“连接服务器”页填写运行服务端那台电脑的局域网地址，例如 `ws://192.168.1.10:8888`，并在电脑防火墙放行该端口。正式上线应使用 `wss://` 地址。
