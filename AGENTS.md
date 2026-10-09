# 阿瓦隆项目 · Agent 说明

本文件供 Codex 等编码 Agent 读取。回复与报告使用中文。

## 目录

| 路径 | 说明 |
| --- | --- |
| `服务器端/AvalonTsServer` | NestJS 11 + ws 服务端。`src/avalon.room.ts` 房间状态机与规则，`src/avalon.ai.ts` AI，`src/avalon.types.ts` 规则表，`src/game.service.ts` 连接/房间/广播，`src/records.service.ts` 战绩与积分，`src/auth.service.ts` 登录 |
| `客户端/Godot_Client` | Godot 4.7.2 客户端（MVC）。`scripts/models`、`scripts/controllers`、`scripts/views/page_view.gd`、`scripts/services/local_game.gd`（`avalon.room.ts` 的 GDScript 版）、`scripts/services/local_ai.gd`（`avalon.ai.ts` 的 GDScript 版） |
| `客户端/Godot_Client/assets/ui` | UI 素材：PNG + `catalog.json`（`名字: [x, y, w, h]` 有效区域，可省略） |
| `归档/` | 已归档的 Cocos 客户端与 Due 服务端，**不要修改** |
| `文档/agent-bridge` | Claude ↔ Codex 协作任务单与报告 |

协议：`uint16 seq + uint16 route + UTF-8 JSON`（little-endian）。路由、角色、阶段在 `服务器端/AvalonTsServer/src/protocol.ts` / `avalon.types.ts` 与 `客户端/Godot_Client/scripts/mvc/avalon_types.gd` 中必须保持一致，规则表（队伍人数、身份配置、夜晚视野、湖中仙女、王者之剑）同样两边一致。

## 验证命令

服务端（在 `服务器端/AvalonTsServer`）：

```
npm test
```

Godot（在 `客户端/Godot_Client`，引擎 `E:\Game_Work\Godot\Godot_v4.7.2-stable_win64_console.exe`）：

```
<godot> --headless --path . --import
<godot> --path . --script res://tools/smoke_client.gd --audio-driver Dummy
<godot> --headless --path . --script res://tools/smoke_flow.gd
<godot> --headless --path . --script res://tools/smoke_effects.gd
<godot> --headless --path . --script res://tools/smoke_selfplay.gd -- players=7 games=2 seed=1 url=local
```

联机测试（`smoke_network.gd`、`smoke_lifecycle.gd`、`smoke_selfplay.gd url=ws://...`）需先 `npm run build`，再在 8899 端口启动服务端：`PORT=8899 AVALON_NIGHT_SECONDS=1 AVALON_AI_TICK_MS=75 node dist/server.js`，测试结束后关掉它。

`smoke_client.gd` 会重写 `verification/*.png`。在沙箱中无法写 `.git/`（`git checkout`/`git add` 会失败），不要尝试还原截图，在报告里注明即可，由审核方处理。

## 约定

- 沿用周边代码风格：GDScript 用 Tab 缩进和类型标注，TypeScript 4 空格、`strict`。
- 改规则或 AI 时同时改服务端和 Godot 两侧，并补测试（`test/*.test.js`、`tools/` 下对应 smoke）。
- **不要 `git commit`/`push`**，由发起任务的一方审核后提交。不要改动任务范围之外的文件。
- 不要删除或覆盖已有素材；新素材使用新文件名，除非任务明确要求替换。`*.import` 不入库。

## 协作任务（文档/agent-bridge）

被要求处理 `文档/agent-bridge/tasks/<任务>.md` 时：

1. 完整阅读任务单，只做任务单要求的事。
2. 完成后运行任务单列出的验证命令。
3. 用文件编辑工具（apply_patch）而不是 shell 命令把报告写到 `文档/agent-bridge/reports/<同名>.md`，写完读回确认非空，格式见 `文档/agent-bridge/README.md` 的“报告格式”。结论必须和实际运行结果一致：测试失败就写失败并附输出，没做到的写明原因。

素材任务：用图像生成功能出图，然后把最终文件复制到任务单指定的路径（生成的原图在 `~/.codex/generated_images/` 下），按任务单要求处理尺寸与透明背景。报告里写明文件路径、尺寸，以及生成时使用的提示词。
