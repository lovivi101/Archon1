# NNN 标题（一句话说明要修什么）

- 类型：bug
- 范围：允许修改的目录/文件（例如 `客户端/Godot_Client/scripts/controllers/`）
- 不要改动：（例如 `客户端/Cocos_Client`、UI 布局）

## 现象

可复现的步骤、实际结果、期望结果。

## 已知原因（如有）

文件:行号，以及为什么会出错。

## 要求

- 具体要改成什么样
- 需要补的测试

## 验证

- `npm run test:smoke`（在 `服务器端/AvalonTsServer`）
- `<godot> --headless --path . --script res://tools/smoke_flow.gd`（在 `客户端/Godot_Client`）

## 报告

写到 `文档/agent-bridge/reports/NNN-xxx.md`，格式见 `文档/agent-bridge/README.md`。不要提交 git。
