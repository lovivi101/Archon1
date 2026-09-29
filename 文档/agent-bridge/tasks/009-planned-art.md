# 009 素材：出图任务清单（王者之剑、湖中仙女、投票徽章、段位、角标、分享背景）

- 类型：asset
- 依据：`客户端/Godot_Client/docs/出图任务.md`（先完整阅读，尺寸、文件名、画面描述、顺序都以它为准）
- 图片模型：`gpt-image-2.5-flare`
- 输出目录：`客户端/Godot_Client/assets/ui/`，共 13 张：
  1. `excalibur-icon.png` 1024×1024
  2. `lady-of-lake-icon.png` 1024×1024
  3. `vote-approve-emblem.png` 1024×1024
  4. `vote-reject-emblem.png` 1024×1024
  5. `tier-1-bronze.png` … 10. `tier-6-king.png` 各 512×512
  11. `badge-ai.png` 256×256
  12. `badge-offline.png` 256×256
  13. `share-card-bg.png` 750×1000，**不透明**
- 背景：除 `share-card-bg.png` 外全部透明（四角 alpha 为 0）

## 做法

1. 开始前确认以上 13 个文件都不存在；若某个已存在，跳过它不要覆盖，并在报告里写明。
2. 先查看风格参考图：`assets/ui/mission-success-emblem.png`、`crown-icon.png`、`target-icon.png`（以及 `role-merlin.png`、`role-assassin.png` 的金属质感）。
3. 严格按清单顺序一次只出一张：生成 → 去背景/缩放到目标尺寸 → 检查（尺寸正确、四角 alpha 为 0、主体居中且未被裁切、四周约 6% 留白、无文字无水印）→ 合格再做下一张；不合格重画这一张。
4. 段位徽章 5–10 构图必须一致（同样大小的盾形、同一视角），只逐级升级材质和装饰。建议先定下青铜的构图，再以它为基准出后面五张。
5. 图标在界面上最小显示 30–34px（座位角标、座位上的剑/仙女），所以剪影要清晰、对比度高，细节不要太碎。
6. 全部完成后把 13 张拼成一张对比图（透明图放在棋盘格上）保存到 `文档/agent-bridge/reports/009-planned-art-contact.png`，六个段位放同一行便于比对一致性。

## 验收

- 用 Python PIL 检查每张的尺寸、模式（RGBA / RGB）和四角 alpha，把结果写进报告。
- 在 `客户端/Godot_Client` 运行 `E:\Game_Work\Godot\Godot_v4.7.2-stable_win64_console.exe --headless --path . --import`，无与这些文件相关的报错。
- 在 `客户端/Godot_Client` 运行 `E:\Game_Work\Godot\Godot_v4.7.2-stable_win64_console.exe --path . --script res://tools/smoke_client.gd --audio-driver Dummy`，通过（它会重写 `verification/*.png`，正常，报告里注明即可）。
- 不修改任何代码、场景或已有素材；代码已经接好，文件放进去即生效。

## 报告

写到 `文档/agent-bridge/reports/009-planned-art.md`：每张的路径、尺寸、透明检查结果、生成提示词；自评风格一致性（尤其六个段位），以及哪几张建议重做。不要提交 git。
