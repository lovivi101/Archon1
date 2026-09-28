# Avalon NestJS 服务端

服务端现已迁移到 NestJS 11：使用 `@nestjs/platform-express` 提供 HTTP 接口、`@nestjs/platform-ws` 提供 WebSocket 网关。Cocos 客户端当前协议保持不变：

```text
2 字节 little-endian seq
2 字节 little-endian route
JSON body
```

默认监听 `0.0.0.0:8888`，所以客户端可以继续使用 `ws://127.0.0.1:8888`。健康检查地址为 `http://127.0.0.1:8888/health`。
如果 `8888` 已被旧服务占用，可在 PowerShell 中先运行 `$env:PORT = '8889'`，再运行 `npm start`，并在 Cocos 的服务器地址框填写 `ws://127.0.0.1:8889`。

## 启动

```powershell
npm install
npm run build
npm start
```

开发模式：

```powershell
npm run dev
```

也可以双击 `start.bat`。

## 支持的链路

登录 -> 加入房间 -> 准备 -> 身份下发 -> 队长组队 -> 全员投票 -> 任务 -> 刺杀 -> 结算 -> 再次准备开新局。

- **多房间**：`JoinRoom` 的 `roomId`（字母、数字、`_`、`-`，最长 32 位，默认 `888`）不存在时自动创建。房间之间消息隔离；没有在线玩家的空房间会被关闭，对局中所有人掉线超过 `AVALON_ABANDON_SECONDS` 也会被回收。
- **AI 补位**：所有真人都准备后开局，不足 5 人时由 AI 补齐，因此一个房间最多可有 10 名真人。
- **离开与掉线**：开局前离开（`LeaveRoom` 104）或掉线会释放座位，剩余真人都已准备则直接开局。对局中掉线会保留座位，重新登录并加入同一房间即可恢复身份和阶段；对局中主动离开则由服务端托管该座位。对局进行中不能加入其他房间，需先回到原房间或主动离开。
- **超时托管**：各阶段超时由服务端执行，到时未操作的玩家由 AI 策略代为行动，挂机或掉线不会卡住对局。
- **再来一局**：结算后任一玩家发送 `Ready`，或有新玩家加入，房间都会回到准备阶段（移除 AI 和已离开的玩家，所有人需重新准备）。
- **AI 不读隐藏身份**：AI 只使用本座位按规则可见的信息和公开的组队、投票、任务记录做决策。刺杀阶段按规则坏人亮明身份，所以刺客此时知道所有坏人，但要靠对局表现推测谁是梅林。

## 协议补充

- 所有请求失败都会在**请求的同一路由**返回 `{ code, message, seq }`，`seq` 是请求包的序号。错误码：400 参数错误、401 未登录、403 无权限（例如不是队长、不在任务队伍中）、404 不在房间或路由不存在、409 状态冲突（阶段不对、重复投票、房间已满或已开局）、503 服务不可用。
- `StageChange`(302) 除 `stage`、`timeout`（剩余秒数）外，还带上 `deadline`（毫秒时间戳）、`captainIdx`、`round`、`failedVotes`、`selectedSeats`、`missionResults`。每次切换阶段前还会先推送一次 `RoomInfoInit`(201) 完整房间快照，客户端不需要自己推算队长和轮次。
- 房间快照里的玩家新增 `isOnline` 字段。
- `/health` 只返回连接数和房间数，不再返回房间内容和玩家 ID。

## 规则

- 夜晚视野：梅林看到除莫德雷德以外的所有坏人（包括奥伯伦）；派西维尔看到梅林和莫甘娜；除奥伯伦以外的坏人互相可见，但看不到奥伯伦；奥伯伦看不到任何人。
- 7 人及以上第 4 轮需要 2 张失败牌任务才失败；连续 5 次组队被否决坏人胜利；只有刺客可以刺杀，且只能选择好人阵营玩家。

## 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | 8888 | HTTP 与 WebSocket 端口 |
| `AVALON_NIGHT_SECONDS` | 2 | 夜晚阶段时长 |
| `AVALON_PROPOSE_SECONDS` | 60 | 组队超时 |
| `AVALON_VOTE_SECONDS` | 30 | 投票超时 |
| `AVALON_MISSION_SECONDS` | 30 | 任务超时 |
| `AVALON_ASSASSIN_SECONDS` | 60 | 刺杀超时 |
| `AVALON_AI_TICK_MS` | 250 | 房间推进的检查间隔 |
| `AVALON_AI_DELAY_MS` | 同 `AVALON_AI_TICK_MS` | 每个阶段开始后 AI 等待多久再行动 |
| `AVALON_MAX_ROOMS` | 1000 | 同时存在的房间上限 |
| `AVALON_ABANDON_SECONDS` | 60 | 对局中无人在线多久后回收房间 |

Go Due 服务端仍保留在 `服务器端/Due_Server`，作为后续 Redis、etcd、gRPC 集群化实现。这个 TypeScript 服务不复用 Due 的注册中心，因此本地联调不需要预先启动 Redis 和 etcd。

## 代码结构

- `src/server.ts`：Nest 应用启动、监听端口与 WebSocket 适配器。
- `src/app.module.ts`：控制器、网关、游戏服务的依赖注入注册。
- `src/health.controller.ts`：`GET /health` 诊断接口。
- `src/game.gateway.ts`：WebSocket 连接、断开和二进制消息入口。
- `src/protocol.ts`：二进制包的编码和解码。
- `src/game.service.ts`：登录、房间注册表、路由分发、错误回包、定时推进和空房间回收。
- `src/avalon.room.ts`：单个房间的规则状态机（纯逻辑，不直接操作 socket 或定时器，时钟和随机数可注入，便于测试）。
- `src/avalon.ai.ts`：AI 决策，只接收该座位可见的信息。
- `src/avalon.types.ts`：路由、身份、阶段、错误码和规则常量。

NestJS 提供成熟的应用结构和运行机制，但不会自动保证现有阿瓦隆规则正确。当前登录玩家资料可持久化到 PostgreSQL；房间、身份和对局仍保存在进程内存中，重启会丢失，也尚未接入正式鉴权，不应直接作为生产服务发布。

## Docker Compose 一键部署（Linux / macOS / Windows）

需要预先安装 Docker Engine + Compose 插件，或 Docker Desktop。Docker 会拉取 PostgreSQL 17 镜像和 Node 22 镜像，无需在宿主机单独安装数据库或 Node.js。

1. 将 `.env.example` 复制为 `.env`，务必把 `POSTGRES_PASSWORD` 改成唯一的长随机密码。`.env` 已加入 Git 和 Docker 构建忽略列表。
2. 在本目录运行 `docker compose up -d --build --wait`。Compose 会等待 PostgreSQL 健康、执行 `migrations/*.sql`，再启动服务器。数据库保存在 `pgdata` 命名卷中。
3. 访问 `http://127.0.0.1:8888/health`；返回 `ok: true`、`database: "ready"` 表示服务和数据库可用。`HOST_PORT` 可改宿主机端口，容器内仍是 8888。

```text
docker compose ps
docker compose logs --tail=200 server
docker compose logs --since=1h server
docker compose logs --tail=200 migrate
docker compose down
```

服务端在 Compose 中输出单行 JSON 日志到标准输出；HTTP 响应带 `X-Request-Id`（成功的健康检查不写访问日志），WebSocket 连接有 `connectionId`，路由日志包含 `seq`、`route` 和耗时。日志不记录包体、昵称或密码。Docker 的 `json-file` 日志每个服务最多保留 5 个 10 MB 文件，过期日志会轮转删除；长期留存需要接入集中日志系统。数据库没有对宿主机开放端口。

当前数据库持久化的是登录玩家资料，**不是正式账号验证**：客户端提交的 `userId` 仍可自行指定。房间、身份、对局进度依旧在进程内存中，重启会丢失，当前只能运行单个服务实例；要上线多人/多副本，还需实现正式鉴权、房间持久化或共享状态、备份、TLS/WSS、反向代理和完整对局测试。请不要用 `docker compose down -v`，那会删除数据库卷。

## 测试

```powershell
npm test          # 编译后运行 test/ 下的规则单元测试和 WebSocket 端到端测试
npm run test:smoke
```

`npm test` 不依赖数据库，会在随机端口启动独立服务，覆盖夜晚视野、各类非法操作的错误码、超时托管、结束后重开、离开与重连、多房间隔离等场景。

`test:smoke` 先运行 `npm test`，再直接加载 Cocos 项目中的 `AvalonNetwork`，在独立临时端口启动全新 NestJS 应用，依次验证登录、加入房间、准备、游戏开始、身份下发和阶段切换。成功时会输出 `PASS` 以及实际收到的路由序列；可反复运行，不会占用开发服务的 8888 房间。

在 Creator Preview 的连接框填写 `ws://127.0.0.1:8888`。手机或微信开发者工具连接到另一台电脑时，改用服务电脑的局域网地址；真机发布需要可访问的 `wss://` 地址及对应平台域名配置。
