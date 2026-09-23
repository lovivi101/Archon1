# Agent Handoff

## 当前状态

- 2026-09-23 新增 Docker Compose 部署：PostgreSQL 17 + 自动迁移 + NestJS；玩家资料写入数据库，生产环境缺少 `PGHOST` 会拒绝启动。Compose 日志按 10 MB × 5 轮转，服务端在 `LOG_JSON=1` 时输出结构化日志。当前工作机没有 `docker` 命令，因此尚未实启验证镜像/容器；已通过本机 TypeScript 编译和无数据库模式的 WebSocket 烟测。
- 登录现在是异步数据库写入；WebSocket 网关对同一连接按收到顺序处理消息，防止紧接登录的进房请求抢跑。二进制包上限 64 KiB。
- 数据库只存玩家资料，不提供可信登录鉴权；房间与对局仍是单实例内存状态，生产发布还需鉴权、WSS、备份及完整对局测试。
- 2026-09-23 已将 `服务器端/AvalonTsServer` 从 Express + ws 直连迁至 NestJS 11（platform-express + platform-ws）。默认 `:8888`，`/health`；可用 `npm run dev` 启动。独立端口烟测直接加载 Cocos `AvalonNetwork`，已通过登录、加房、开局、身份、阶段推送。
- 此前机器上的 `:8888` 被旧 Avalon Node 进程占用，`:8889` 也可能仍运行迁移前的旧进程。本次烟测在独立临时端口启动了新版 NestJS；没有终止或替换既有进程。Creator Preview 请先确认目标端口的 `/health` 返回 `framework: "NestJS"`，再连接对应 WebSocket 地址。
- `AvalonNetwork` 重连时解绑旧 WebSocket 回调，避免旧连接的 close/error 覆盖新连接状态。`AvalonDemoApp` 对登录、加房的非零 `code` 显示服务器错误。
- TypeScript 服务端在开局时会广播最新房间快照，断线后原用户可再次登录并重新进房，重新收到身份与阶段。
- 已新增 Demo 客户端第一版阿瓦隆主流程 UI，入口是 `assets/Scripts/App/AvalonDemoApp.ts`。
- 已修改 `assets/Main.scene`，在 `Canvas` 上挂载 `AvalonDemoApp`；脚本 uuid 为 `c9ba2916-ba9f-41d0-a197-7d73828a9037`。
- 当前 UI 运行时生成节点，不使用 prefab；如后续要可视化编辑，需要把运行时 UI 拆成 prefab/module，同时保留现有数据和网络层。
- Demo 客户端 WebSocket 包头已改为 due 默认格式：`2 字节 seq + 2 字节 route + JSON body`；根服务端 node 已显式使用 JSON codec，gate 已固定监听 `:8888`。

## 回归重点

- 在 `服务器端/AvalonTsServer` 运行 `npm run test:smoke`；它创建独立服务，可连续运行。连接本地开发服务时运行 `npm run dev`，Preview 地址为 `ws://127.0.0.1:8888`。
- 用 Cocos Creator 3.8.7 打开 `Demo/Test`，Preview `Main.scene`，确认 UI 出现且没有脚本解析错误。
- 未启动服务端时，点击“本地演示”应出现 5 人座位、身份、可见座位和组队选择，并可继续提交队伍、投票、任务、刺杀到结算。
- 联机回归顺序：连接 `ws://127.0.0.1:8888`、登录、加入房间、准备、进入组队、投票、任务、刺杀、结算。
- 当前命令行只能做 TypeScript 静态检查；真实 Button/EditBox/Graphics 渲染仍需要 Creator Preview。
- 已做命令行真实 WebSocket 烟测：连接 `ws://127.0.0.1:8888/` 后依次发送 `101 登录`、`102 加房`、`103 准备`，收到登录响应、加房响应和 `301/303/302` 推送。

## 本轮验证

- NestJS 迁移后 `npm run build` 与 `npm run test:smoke` 通过，后者实际收到 101、102、201、202、301、303、302。
- 已运行 Creator 3.8.7 自带 TypeScript：过滤 `assets/Scripts` 后无新增脚本报错。
- 完整 `tsc --noEmit` 仍会扫出 MKFramework 源码里的既有基线问题，如 `Editor` 类型、动态 import module 目标、extension source 默认导入等。
- 已用 PowerShell JSON 解析 `assets/Main.scene`，确认 `Canvas` 组件列表引用 `__id__ = 17`，且该组件类型为 `c9ba2kWup9B0KGXfXOCipA3`。
- 本地演示状态机已补齐，离线时不会再卡在队伍提交后无法推进。

## 注意事项

- `AvalonNetwork` 目前按 due 默认协议处理：2 字节 little-endian seq、2 字节 little-endian route、JSON payload。
- `AvalonGameState.updateRoomInfo` 已兼容 Go 导出的 `ID`、`Players`、`Stage`、`CaptainIdx`、`Round`、`FailedVotes`、`SelectedSeats`、`MissionResults`。
- 不要把根项目 `client/` 的脚本直接混入 Demo；Demo 是独立 Cocos 项目和独立 git repo。
