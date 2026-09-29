# Claude ↔ Codex 协作

Claude（Claude Code）负责发现问题、拆解任务、审核与提交；Codex 负责执行具体修改和生成素材。双方通过本目录中的文件交接，不依赖任何一方的对话记录。

```
文档/agent-bridge/
├── tasks/        任务单（Claude 写，Codex 读）
├── reports/      执行报告（Codex 写，Claude 读）；*.log 是执行日志，不提交
├── templates/    bug / feature / asset 模板
└── run-task.mjs  用 codex exec 执行一个任务单
```

## 流程

1. **下单**：Claude 按模板在 `tasks/` 写任务单，文件名 `NNN-简短英文.md`，例如 `007-vote-button-state.md`。
2. **执行**，两种方式任选：
   - 命令行（Claude 可直接调用）：`node 文档/agent-bridge/run-task.mjs 文档/agent-bridge/tasks/007-vote-button-state.md`
   - Codex 桌面端：打开本仓库，对它说“处理 文档/agent-bridge/tasks/007-vote-button-state.md”。
3. **回报**：Codex 把报告写到 `reports/<同名>.md`。
4. **审核**：Claude 读报告、看 `git diff`、重跑验证；不通过就追加一份 `NNN-xxx-fix1.md` 任务单，引用上一份报告。
5. **提交**：验证通过后由 Claude 提交，任务单与报告一起入库。

## 执行脚本

```
node 文档/agent-bridge/run-task.mjs <任务单> [--sandbox read-only|workspace-write] [--timeout 分钟] [--model 名称]
```

- 默认 `workspace-write`：Codex 只能写仓库内文件；素材任务需要读取 `~/.codex/generated_images/`，读取不受限制。
- 执行日志写到 `reports/<同名>.log`，Codex 的最终回复写到 `reports/<同名>.last.txt`。退出码非 0 表示 Codex 执行失败或超时。
- 任务中断且重试用尽时，用 `--resume <session id>`（日志开头的 `session id:`）让同一会话继续，不会从头再做。
- 调用前必须已登录 Codex（`codex login status`）；本机 CLI 与桌面端共用 `~/.codex` 配置。

## 报告格式

```markdown
# 报告：<任务单标题>

- 状态：完成 / 部分完成 / 失败
- 修改的文件：
  - path — 做了什么
- 验证：
  - `命令` → 结果（通过 / 失败，附关键输出）
- 未完成或需要决定的事项：
```

素材任务额外列出：输出文件、尺寸、是否透明背景、生成提示词。
