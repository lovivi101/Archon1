# NNN 素材：名称

- 类型：asset
- 输出：`客户端/Godot_Client/assets/ui/<文件名>.png`（新文件名，不覆盖已有素材）
- 尺寸：例如 1254×1254（与现有图标一致）
- 背景：透明 / 不透明
- 数量：1 张（如需多个候选，输出 `<文件名>-a.png`、`<文件名>-b.png`）

## 用途

用在哪个页面、哪个位置、显示尺寸多大（例如第 9 页右上角，显示宽 40px）。

## 风格

参考现有素材（列出 1–3 个文件路径），例如 `客户端/Godot_Client/assets/ui/crown-icon.png`：暗色中世纪奇幻、金属描边、暖金色高光。

## 内容

画面主体、构图、不要出现的元素（文字、水印等）。

## 验收

- 文件存在且能被 Godot 导入：`<godot> --headless --path 客户端/Godot_Client --import` 无报错
- 透明背景的图四角像素 alpha 为 0
- 报告中写明生成提示词与最终尺寸

## 报告

写到 `文档/agent-bridge/reports/NNN-xxx.md`。不要提交 git。
