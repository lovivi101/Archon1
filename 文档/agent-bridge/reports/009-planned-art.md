# 报告：009 素材：出图任务清单

- 状态：部分完成（13 张图全部出齐并通过尺寸/透明检查；Codex 在写报告前被用户叫停，本报告由 Claude 根据产物和执行日志补写）
- 执行：`node 文档/agent-bridge/run-task.mjs 文档/agent-bridge/tasks/009-planned-art.md --timeout 240 --sandbox danger-full-access`
  - 本机 Windows 防火墙服务（MpsSvc）处于停止状态，Codex 的 elevated 沙箱无法启动任何命令（`helper_firewall_policy_access_failed 0x800706D9`），经用户同意改用 `danger-full-access` 运行。
  - 中途 `gpt-6-sol` 返回 “Selected model is at capacity”，脚本自动续跑同一会话并切到 `gpt-6-astra`，续跑时核对了已有文件，没有重复生成。
- 修改的文件（均为新文件，未覆盖已有素材）：`客户端/Godot_Client/assets/ui/` 下 13 张
- 输出验收（Python PIL 实测）：

| 文件 | 尺寸 | 模式 | 四角 alpha |
| --- | --- | --- | --- |
| excalibur-icon.png | 1024×1024 | RGBA | 0,0,0,0 |
| lady-of-lake-icon.png | 1024×1024 | RGBA | 0,0,0,0 |
| vote-approve-emblem.png | 1024×1024 | RGBA | 0,0,0,0 |
| vote-reject-emblem.png | 1024×1024 | RGBA | 0,0,0,0 |
| tier-1-bronze.png … tier-6-king.png | 512×512 | RGBA | 0,0,0,0 |
| badge-ai.png、badge-offline.png | 256×256 | RGBA | 0,0,0,0 |
| share-card-bg.png | 750×1000 | RGB（不透明） | — |

  - `share-card-bg.png`：Codex 停止时还是生成原图 1086×1448（3:4），由 Claude 用 LANCZOS 等比缩放到 750×1000。
  - 对比图：`文档/agent-bridge/reports/009-planned-art-contact.png`（透明图放在棋盘格上，六个段位同一行）。
- 生成提示词：执行日志只记录了命令和复制步骤，没有记录生图工具的参数，提示词无法从日志还原。生成原图在 `~/.codex/generated_images/01a0ec70-dbd3-7d91-b7aa-c7acc562d7e1/`。
- 验证：
  - 尺寸、模式、四角 alpha → 通过（见上表）。
  - Godot `--import`、`smoke_client.gd` → 在合并后的分支上由 Claude 运行，结果见提交记录。
- 自评与待定：
  - 段位 1–5 构图一致（同一盾形、同一视角），材质和装饰逐级升级。
  - 段位 6（王者）外围加了火焰光环，盾牌本体明显比 1–5 小；清单要求的“圆桌”元素不明显。建议 UI 审查时在实际尺寸下确认，必要时重画。
  - 反对徽章的拳甲“拇指朝下”不够醒目，缩到小尺寸可能难以辨认，建议 UI 审查时确认。
