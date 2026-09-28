# Agent Worklog

## 2026-09-23

- 完善客户端数据层：新增 UI 无关的 `AvalonClientData` 门面与快照订阅，修正房间状态字段映射、局间重置、布尔/数组解析和网络包校验；目标 TypeScript 文件定向编译通过。未修改 `AvalonDemoApp.ts` 的 UI 构建代码。
- 增加跨平台 Compose 部署、PostgreSQL 玩家资料表与自动 SQL 迁移、数据库健康检查、生产环境数据库必填、JSON 访问与 WebSocket 日志、Docker 日志轮转。异步登录后为单连接消息加顺序队列，并限制包大小。宿主机未安装 Docker，未完成容器级验证；`npm run test:smoke` 保持通过。
- 应用户要求将 TypeScript 服务端迁至 NestJS 11；采用 platform-express + platform-ws，新增模块、健康控制器、WebSocket 网关，保留原 Cocos 二进制协议与现有游戏逻辑。`npm run build`、`npm run test:smoke` 通过；未替换机器上既有的 8888/8889 服务进程。
- 新增 `服务器端/AvalonTsServer`，以 Express + ws 接通现有 Cocos 二进制 WebSocket 协议；支持健康检查、登录、加房、准备、角色下发和后续游戏动作。
- 修复客户端重连回调竞态与错误响应提示；开局时服务端补发房间状态，断线重进时补发身份和阶段。
- `npm run test:smoke` 改为独立端口运行，直接加载客户端 `AvalonNetwork`。已验证 101、102、201、202、301、303、302；客户端脚本的 TypeScript 检查无报错。

## 2026-05-20

- 新增阿瓦隆 Demo 客户端代码层：`App/AvalonDemoApp.ts`、`Game/AvalonGameTypes.ts`、`Game/AvalonGameState.ts`、`Network/AvalonProtocol.ts`、`Network/AvalonNetwork.ts`。
- 修改 `assets/Main.scene`，将 `AvalonDemoApp` 挂载到 `Canvas`。
- 新增 `docs/CodeIndex.md`、`docs/AgentHandoff.md`，并更新 `docs/ProjectMemory.md` 记录 Demo 客户端入口和模块边界。
- 验证 `assets/Scripts` 无 TypeScript 报错；完整项目检查仍受 MKFramework 基线噪声影响。已解析 `assets/Main.scene` 确认脚本组件绑定存在。
- 补齐本地演示流程状态机：离线模式下可推进组队、投票、任务、刺杀与结算。
- 修正 Demo WebSocket 协议为 due 默认 `seq + route + JSON body`，并同步根服务端 JSON codec、WebSocket `:8888` 监听配置。
- 已启动临时 Redis/etcd/gate/node 做真实联机烟测：`101 登录`、`102 加房`、`103 准备` 成功，收到 `301 GameStart`、`303 IdentityPush`、`302 StageChange` 推送；测试后已关闭临时进程。
