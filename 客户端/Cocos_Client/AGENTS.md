# Repository Guidelines

## 项目记忆与 Agent 启动

- 本项目启用本地仓库上下文 skill：`.codex/skills/repo-context-workflow/SKILL.md`。新 agent 开始任务时，先读取该 skill 建立通用工作流，再继续读取本文件和下列项目记忆文档。
- 仓库内长期项目记忆统一维护在 `docs/ProjectMemory.md`，记录稳定架构、核心玩法链路、关键模块入口、性能约束与常见坑点。
- 低 token 代码地图统一维护在 `docs/CodeIndex.md`，用于按任务快速定位脚本入口，避免每次全局分析代码。
- 当前交接热区统一维护在 `docs/AgentHandoff.md`，记录最近仍影响开发判断的改动、风险、未决事项与回归点。
- 历史工作流水归档在 `docs/AgentWorklog.md`；新 agent 默认不要全文读取，只在 `AgentHandoff` 指向历史问题或用户任务需要追溯时，用 `rg` 按标题、日期或关键词定位。
- 新进入本项目的 agent，在开始搜索或修改代码前，默认按顺序阅读 `AGENTS.md`、`docs/ProjectMemory.md`、`docs/CodeIndex.md`、`docs/AgentHandoff.md`，再按需深入相关脚本。
- 对本仓库中的常规开发需求，默认按“仓库记忆工作流”执行：先基于上述热区文档建立上下文，完成后更新 `docs/AgentHandoff.md`；非微小改动同时追加 `docs/AgentWorklog.md`，除非用户明确要求不要这样做。
- 若开启新的 agent，也沿用同样的仓库记忆工作流，不需要用户重复说明。
- 如果改动改变了稳定约定、架构理解、入口索引或回归重点，需要同步更新 `docs/ProjectMemory.md` 或 `docs/CodeIndex.md`。
- 需要沉淀项目规则、模块关系、隐藏约束时，优先写入上述文档，不要只留在对话里。

## 构建、测试与开发命令

- 推荐用 Cocos Creator 3.8.7 打开仓库根目录，使用 Preview 进行本地运行与调试。
- 命令行构建（需安装 Creator CLI）：`CocosCreator.exe --path . --build "platform=web-mobile;debug=true"` 生成调试版；去掉 `debug` 生成发布包。
- 运行/调试时 TypeScript 会由 Creator 自动编译；如需清理缓存，删除 `temp/` 后重新打开工程。

## Shell 与 PowerShell

- 全局默认使用 PowerShell 7（`pwsh`）执行命令，不使用 Windows PowerShell 5.x；命令示例、脚本片段与终端操作都按 `pwsh` 语法理解。
- 如需显式启动 shell，统一使用 `pwsh -NoLogo -NoProfile -Command "<command>"` 或 `pwsh -NoLogo -NoProfile -File <script.ps1>`，不要写 `powershell.exe`。
- PowerShell 全局 profile 文件固定为 `D:\Backup\Documents\PowerShell\Microsoft.PowerShell_profile.ps1`。
- 涉及 shell 初始化、别名、环境变量、启动脚本或 profile 修改时，统一以上述 PowerShell 7 profile 为准。

## 编码风格与命名约定

- TypeScript 使用 4 空格缩进、分号结尾、尽量显式类型；组件类使用 `@ccclass`，序列化字段用 `@property` 并补充 `displayName`。
- 文件名与类名保持 PascalCase（如 `UIPowerBar.ts`、`MapCtr.ts`），常量/枚举沿用 `CommonEvent`、`ObjectType` 的命名方式；事件字符串集中维护，避免魔法值。
- 组件获取节点/资源时优先序列化赋值，生命周期遵循 Cocos 规范（`onLoad` 订阅，`onDestroy` 清理）。

## 测试指南

- 当前无自动化测试；新增改动后需在 `Game.scene` 通过 Preview 手动回归：开局加载、角色移动攻击、掉落/拾取、结算 UI 与下载按钮交互。
- 建议记录测试步骤、设备/浏览器信息及截图；复杂逻辑可用断言或临时日志辅助验证，提交前移除。

## 提交与 Pull Request

- 现有提交为简短动词式（如 `init`、`update`）；建议保持动词开头并指明模块，例如 `update UI power bar`、`fix manager drop spawn`。
- PR 需包含：变更摘要、涉及场景/脚本路径、风险点与回归范围、手动验证结果；UI 变更附截图/GIF；关联需求或缺陷编号。
- 提交前确认 `.meta` 与资源一起纳入版本控制，避免遗漏引用，勿提交 `library/`、`temp/`、`build/`、`profiles/`。

## 编码规则
- 编辑文件时优先保持原有编码，避免无意转码。
- 需要新增中文注释、`displayName` 或 `tooltip` 时，先确认文件编码安全，再正常使用中文，不要直接改成英文规避。
- 修改包含中文的文件后，完成前检查是否出现乱码或 mojibake。
