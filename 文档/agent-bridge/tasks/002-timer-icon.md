# 002 素材：倒计时沙漏图标

- 类型：asset
- 输出：`客户端/Godot_Client/assets/ui/timer-icon.png`（新文件，不要覆盖已有素材）
- 尺寸：1254×1254，RGBA
- 背景：透明
- 数量：1 张

## 用途

对局页（第 7–10、12 页）右上角的倒计时数字左侧，显示宽约 34px。需要在小尺寸下仍能看清轮廓。

## 风格

与现有图标保持一致，参考：

- `客户端/Godot_Client/assets/ui/crown-icon.png`
- `客户端/Godot_Client/assets/ui/check-icon.png`
- `客户端/Godot_Client/assets/ui/settings-icon.png`

先查看这几张图，匹配它们的描边粗细、金属质感、光照方向和留白比例。

## 内容

- 一个中世纪风格的沙漏：暗金/黄铜框架，上下玻璃泡，沙子为暖金色，上半部分剩余约三分之一。
- 主体居中，四周留白约 10%，轮廓清晰、剪影易识别。
- 不要文字、数字、水印、投影底座或背景。

## 验收

- 文件存在，尺寸 1254×1254，四个角像素 alpha 为 0（可用 Python PIL 检查）。
- 在 `客户端/Godot_Client` 运行 `E:\Game_Work\Godot\Godot_v4.7.2-stable_win64_console.exe --headless --path . --import` 无与该文件相关的报错。
- 不修改任何代码和其他素材（接入界面由 Claude 另行处理）。

## 报告

写到 `文档/agent-bridge/reports/002-timer-icon.md`，包含最终文件路径、尺寸、透明检查结果和生成提示词。不要提交 git。
