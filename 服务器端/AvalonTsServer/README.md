# Avalon NestJS 服务端

服务端现已迁移到 NestJS 11：使用 `@nestjs/platform-express` 提供 HTTP 接口、`@nestjs/platform-ws` 提供 WebSocket 网关。客户端（`客户端/Godot_Client`）使用的协议：

```text
2 字节 little-endian seq
2 字节 little-endian route
JSON body
```

默认监听 `0.0.0.0:8888`，所以客户端可以继续使用 `ws://127.0.0.1:8888`。健康检查地址为 `http://127.0.0.1:8888/health`。
如果 `8888` 已被旧服务占用，可在 PowerShell 中先运行 `$env:PORT = '8889'`，再运行 `npm start`，并在 Godot 客户端的服务器地址框填写 `ws://127.0.0.1:8889`。

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

登录 -> 建房/匹配/按房间号加入 -> 准备 -> 身份下发 -> 轮流发言 -> 队长组队 -> 全员投票 -> 任务 [-> 王者之剑] [-> 湖中仙女] -> 下一轮发言 … -> 坏人亮明身份 -> 刺杀 -> 结算 -> 再次准备开新局。

- **轮流发言**：每轮组队前（包括组队被否决后）进入发言阶段，队长先说，然后按座位顺时针轮流，每人限时 `AVALON_SPEAK_SECONDS`。只有当前发言人能发送文字（每条最多 80 字、每轮最多 5 条），可提前结束发言；超时的真人直接轮到下一位，服务端不会替真人说话。AI 按自己掌握的信息发一句模板化发言，AI 队长会说出打算带谁，并按所说的组队。
- **刺杀前坏人亮明身份**：好人完成 3 次任务后，服务端向所有人公布全部坏人座位（含奥伯伦），坏人之间可在私密频道商议，只有坏人能收到。
- **湖中仙女（7 人局）**：第一任队长右手边的玩家持有。第 2、3、4 轮任务结束后（对局未结束时），持有者查验一名玩家的阵营，结果只发给持有者，查验关系公开，令牌交给被查验者；不能查验自己和曾经持有过的人。
- **王者之剑（10 人局）**：队长提名时把王者之剑交给队伍中除自己外的一名队员。任务牌交齐后，持有者可以翻转另一名队员的牌（成功变失败或失败变成功），并私下得知那张牌原来是什么；也可以不使用。使用对象公开。

- **建房与匹配**：`CreateRoom`(105) 按人数（5～10）创建带 6 位房间号的私人房间；`QuickMatch`(106) 按人数进入有空位的公开房间，没有就新开一个；`JoinRoom`(102) 带 `mustExist: true` 时按房间号加入，房间不存在返回 404。三者成功都在 `JoinRoom` 路由回复。房间人数固定，开局时空位由 AI 补齐；快照里有 `targetPlayers`、`rules`（是否启用湖中仙女/王者之剑）和 `roleSet`（本局身份配置）。
- **多房间**：`JoinRoom` 的 `roomId`（字母、数字、`_`、`-`，最长 32 位，默认 `888`）不存在时自动创建。房间之间消息隔离；没有在线玩家的空房间会被关闭，对局中所有人掉线超过 `AVALON_ABANDON_SECONDS` 也会被回收。
- **AI 补位**：所有真人都准备后开局，房间人数不足的座位由 AI 补齐。
- **离开与掉线**：开局前离开（`LeaveRoom` 104）或掉线会释放座位，剩余真人都已准备则直接开局。对局中掉线会保留座位，重新登录并加入同一房间即可恢复身份和阶段；对局中主动离开则由服务端托管该座位。对局进行中不能加入其他房间，需先回到原房间或主动离开。
- **超时托管**：各阶段超时由服务端执行，到时未操作的玩家由 AI 策略代为行动，挂机或掉线不会卡住对局。
- **再来一局**：结算后任一玩家发送 `Ready`，或有新玩家加入，房间都会回到准备阶段（移除 AI 和已离开的玩家，所有人需重新准备）。
- **AI 不读隐藏身份**：AI 只使用本座位按规则可见的信息和公开的组队、投票、任务记录做决策。刺杀阶段按规则坏人亮明身份，所以刺客此时知道所有坏人，但要靠对局表现推测谁是梅林。

## 登录与鉴权

`Login`(101) 按以下优先级识别登录方式，成功后返回 `{ code: 0, userId, nickname, provider, token, expiresAt }`。客户端应保存 `token`，下次登录时优先发送它：

| 请求字段 | provider | 说明 |
|---|---|---|
| `token` | `token` | 恢复之前的账号。令牌由服务端用 HMAC-SHA256 签名，有效期 `AVALON_TOKEN_TTL_DAYS` 天；被篡改、过期或由其他密钥签发的令牌返回 401 |
| `wxCode`（或 `code`） | `wechat` | 微信小游戏 `wx.login()` 拿到的 code，服务端调用 `jscode2session` 换取 openid。userId 为 `wx_` 加 openid 的哈希，其他玩家从房间快照里看不到 openid；`session_key` 不保存。未配置 `WECHAT_APPID`/`WECHAT_SECRET` 时返回 503 |
| 什么都不带，或 `guest: true` | `guest` | 新建一个随机游客账号（`g_` 开头，不可猜测） |
| `userId` | `legacy` | 旧版“客户端自报 ID”，当前 Godot 客户端尚未接入令牌时使用这种方式。**生产环境默认关闭**（返回 401），开发环境默认开启，可用 `AVALON_ALLOW_LEGACY_LOGIN` 覆盖；不能使用 `wx_`、`g_`、`ai-` 前缀 |

- 同一账号在新连接登录时，旧连接会以关闭码 4001 断开。
- 每个连接 60 秒内最多尝试登录 10 次，超出返回 429。
- `NODE_ENV=production` 时必须设置至少 32 个字符的 `AVALON_TOKEN_SECRET`，否则服务拒绝启动。开发环境未设置时使用随机密钥，重启后旧令牌失效，客户端需要重新以游客或微信方式登录。
- 令牌是无状态的，目前不支持提前吊销；更换 `AVALON_TOKEN_SECRET` 会让所有令牌失效。

## 协议补充

- 所有请求失败都会在**请求的同一路由**返回 `{ code, message, seq }`，`seq` 是请求包的序号。错误码：400 参数错误、401 未登录、403 无权限（例如不是队长、不在任务队伍中）、404 不在房间或路由不存在、409 状态冲突（阶段不对、重复投票、房间已满或已开局）、503 服务不可用。
- 新阶段：发言 7、湖中仙女 8、王者之剑 9。新路由：`Chat` 801（发言，`{ text }`）、`ChatMessage` 802（`{ seat, nickname, text, channel, round }`，重连时补发历史并带 `history: true`）、`EndSpeech` 803、`SpeakerChange` 804（`{ speakerSeat, speechOrder, timeout, deadline }`）、`LadyCheck` 901（`{ targetSeat }`）、`LadyResult` 902（仅持有者）、`LadyUsed` 903、`ExcaliburUse` 904（`{ targetSeat }`，-1 表示不使用）、`ExcaliburResult` 905（仅持有者）、`ExcaliburUsed` 906、`EvilRevealed` 703（`{ evilSeats }`）。`ProposeTeam` 在 10 人局需带 `excaliburSeat`。`IdentityPush` 新增 `facts`：本人通过湖中仙女或王者之剑得知的阵营（重连后仍保留）。
- `StageChange`(302) 除 `stage`、`timeout`（剩余秒数）外，还带上 `deadline`（毫秒时间戳）、`captainIdx`、`round`、`failedVotes`、`selectedSeats`、`missionResults`。每次切换阶段前还会先推送一次 `RoomInfoInit`(201) 完整房间快照，客户端不需要自己推算队长和轮次。
- 房间快照里的玩家新增 `isOnline` 字段。
- 战绩与排行（需已登录）：`MatchHistory` 1001（`{ limit? }` → `{ matches: [{ matchId, endedAt, playerCount, role, won, reason, ratingDelta }] }`，最新在前）、`MatchDetail` 1002（`{ matchId }` → 完整复盘：玩家与身份、每次组队与投票、任务结果、王者之剑、湖中仙女、公开发言；只有参加过该局的玩家能查看，否则 404）、`Leaderboard` 1003（`{ limit?, scope? }` → `{ scope, top: [{ rank, userId, nickname, avatar, rating, tier, games, wins }], me }`；`scope: "friends"` 只排我和好友）、`MyStats` 1004（→ `{ rating, tier, games, wins, rank }`，未打过对局时 rank 为 0）。每局结束时服务端保存对局并向每位真人推送 `RatingUpdate` 1005（`{ matchId, rating, delta, tier, games, wins }`）。数据库出错时这些路由返回 503。
- 好友（需已登录）：`FriendList` 1101（→ `{ friends, incoming, outgoing, recent }`，每项 `{ userId, nickname, avatar, online, roomId }`；`recent` 是最近联机对局里的其他真人，最新在前，另带 `isFriend`、`pending`）、`FriendSearch` 1102（`{ query }` 按昵称包含或 ID 精确匹配 → `{ players }`，另带 `isFriend`、`pending`）、`FriendRequest` 1103（`{ targetId }` → `{ targetId, accepted }`；对方已向我申请时直接成为好友）、`FriendReply` 1104（`{ requesterId, accept }`）、`FriendRemove` 1105（`{ targetId }`）。好友关系变化和好友上下线推送 `FriendUpdate` 1106（`{ kind: request|accepted|removed|online|offline, userId, nickname }`）。私信：`DirectChat` 1107（`{ targetId, text }`，只能发给好友，1–200 字）→ 对方收到 `DirectMessage` 1108；`DirectHistory` 1109（`{ targetId }` → 最近 50 条）。`RoomInvite` 1110（`{ targetId }`，自己在未开局且有空位的房间里、对方是在线好友）→ 对方收到 `RoomInvitePush` 1111（`{ fromId, nickname, roomId, playerCount }`）。好友上限 100。
- `/health` 只返回连接数和房间数，不再返回房间内容和玩家 ID。

## 规则

- 夜晚视野：梅林看到除莫德雷德以外的所有坏人（包括奥伯伦）；派西维尔看到梅林和莫甘娜；除奥伯伦以外的坏人互相可见，但看不到奥伯伦；奥伯伦看不到任何人。
- 7 人及以上第 4 轮需要 2 张失败牌任务才失败；连续 5 次组队被否决坏人胜利；只有刺客可以刺杀，且只能选择好人阵营玩家。
- 积分：团队 Elo，初始 1000 分。以两队平均分计算期望胜率，AI 座位按 1000 分计入但不计分；前 10 局 K=40，之后 K=24。段位：青铜·见习骑士（<1100）、白银·侍从骑士（1100）、黄金·誓约骑士（1200）、铂金·王国骑士（1300）、钻石·圣殿骑士（1450）、王者·圆桌圣骑士（1600）。

## 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | 8888 | HTTP 与 WebSocket 端口 |
| `AVALON_NIGHT_SECONDS` | 2 | 夜晚阶段时长 |
| `AVALON_SPEAK_SECONDS` | 30 | 每人发言时长 |
| `AVALON_AI_SPEECH_MS` | 1500 | AI 发言停留时长（方便真人阅读） |
| `AVALON_PROPOSE_SECONDS` | 60 | 组队超时 |
| `AVALON_VOTE_SECONDS` | 30 | 投票超时 |
| `AVALON_MISSION_SECONDS` | 30 | 任务超时 |
| `AVALON_LADY_SECONDS` | 30 | 湖中仙女查验超时 |
| `AVALON_EXCALIBUR_SECONDS` | 20 | 王者之剑决定超时 |
| `AVALON_ASSASSIN_SECONDS` | 60 | 刺杀超时 |
| `AVALON_AI_TICK_MS` | 250 | 房间推进的检查间隔 |
| `AVALON_AI_DELAY_MS` | 同 `AVALON_AI_TICK_MS` | 每个阶段开始后 AI 等待多久再行动 |
| `AVALON_MAX_ROOMS` | 1000 | 同时存在的房间上限 |
| `AVALON_ABANDON_SECONDS` | 60 | 对局中无人在线多久后回收房间 |
| `AVALON_HEARTBEAT_MS` | 30000 | 心跳间隔；连续一个间隔没有回应 ping 的连接会被断开（座位交给 AI 托管）。单个数据包最大 64 KB，超过会以 1009 关闭连接 |
| `AVALON_TOKEN_SECRET` | 开发环境随机 | 登录令牌签名密钥，生产环境必填且不少于 32 个字符 |
| `AVALON_TOKEN_TTL_DAYS` | 30 | 令牌有效天数 |
| `AVALON_ALLOW_LEGACY_LOGIN` | 生产环境 0，其他 1 | 是否允许客户端自报 `userId` 登录 |
| `WECHAT_APPID` / `WECHAT_SECRET` | 空 | 小游戏的 AppID 和 AppSecret，都填写后才启用微信登录 |
| `WECHAT_API_BASE` | `https://api.weixin.qq.com` | 微信接口地址，测试时可指向模拟服务 |

原 Cocos 客户端和 Go Due 服务端已停止维护，移到仓库根目录的 `归档/` 中保留参考。

## 代码结构

- `src/server.ts`：Nest 应用启动、监听端口与 WebSocket 适配器。
- `src/app.module.ts`：控制器、网关、游戏服务的依赖注入注册。
- `src/health.controller.ts`：`GET /health` 诊断接口。
- `src/game.gateway.ts`：WebSocket 连接、断开和二进制消息入口。
- `src/protocol.ts`：二进制包的编码和解码。
- `src/auth.service.ts`：游客、令牌、微信登录和旧版 userId 登录，令牌签发与校验。
- `src/game.service.ts`：登录、房间注册表、路由分发、错误回包、定时推进和空房间回收。
- `src/avalon.room.ts`：单个房间的规则状态机（纯逻辑，不直接操作 socket 或定时器，时钟和随机数可注入，便于测试）。
- `src/avalon.ai.ts`：AI 决策，只接收该座位可见的信息。
- `src/avalon.types.ts`：路由、身份、阶段、错误码和规则常量。
- `src/social.service.ts`：好友、好友申请和私信。配置 PostgreSQL 时存在 `friend_requests`、`friendships`、`direct_messages`（`migrations/003_social.sql`），否则存在进程内存，行为一致；在线状态和所在房间由 `game.service.ts` 补上。
- `src/records.service.ts`：对局记录、积分计算、战绩、复盘、排行榜。配置了 PostgreSQL 时写入 `matches`、`match_players` 和 `player_profiles`（`migrations/002_match_records.sql`，积分更新在事务内加行锁）；未配置 `PGHOST` 时保存在进程内存（最多 5000 局，重启丢失），行为一致，方便开发和测试。

NestJS 提供成熟的应用结构和运行机制，但不会自动保证现有阿瓦隆规则正确。当前登录玩家资料、对局记录和积分可持久化到 PostgreSQL，登录支持游客、令牌和微信；房间、身份和对局仍保存在进程内存中，重启会丢失，只能单实例运行。

## Docker Compose 一键部署（Linux / macOS / Windows）

需要预先安装 Docker Engine + Compose 插件，或 Docker Desktop。Docker 会拉取 PostgreSQL 17 镜像和 Node 22 镜像，无需在宿主机单独安装数据库或 Node.js。

1. 将 `.env.example` 复制为 `.env`，务必把 `POSTGRES_PASSWORD` 改成唯一的长随机密码。`.env` 已加入 Git 和 Docker 构建忽略列表。
2. 同样在 `.env` 中设置 `AVALON_TOKEN_SECRET`（至少 32 个字符的随机串），需要微信登录时再填 `WECHAT_APPID` 和 `WECHAT_SECRET`。
3. 在本目录运行 `docker compose up -d --build --wait`。Compose 会等待 PostgreSQL 健康、执行 `migrations/*.sql`，再启动服务器。数据库保存在 `pgdata` 命名卷中。
4. 访问 `http://127.0.0.1:8888/health`；返回 `ok: true`、`database: "ready"` 表示服务和数据库可用。`HOST_PORT` 可改宿主机端口，容器内仍是 8888。

```text
docker compose ps
docker compose logs --tail=200 server
docker compose logs --since=1h server
docker compose logs --tail=200 migrate
docker compose down
```

服务端在 Compose 中输出单行 JSON 日志到标准输出；HTTP 响应带 `X-Request-Id`（成功的健康检查不写访问日志），WebSocket 连接有 `connectionId`，路由日志包含 `seq`、`route` 和耗时。日志不记录包体、昵称或密码。Docker 的 `json-file` 日志每个服务最多保留 5 个 10 MB 文件，过期日志会轮转删除；长期留存需要接入集中日志系统。数据库没有对宿主机开放端口。

Compose 以 `NODE_ENV=production` 运行，因此 `.env` 必须设置 `AVALON_TOKEN_SECRET`，并且默认关闭旧版 `userId` 登录。Godot 客户端接入令牌登录之前如需在自己的服务器上联调，可临时设置 `AVALON_ALLOW_LEGACY_LOGIN=1`，**不要在公网服务器上开启**。房间、身份、对局进度依旧在进程内存中，重启会丢失，当前只能运行单个服务实例；要上线多人/多副本，还需实现房间持久化或共享状态、备份、TLS/WSS、反向代理。请不要用 `docker compose down -v`，那会删除数据库卷。

## LLM 玩家与竞技场

竞技场直接驱动房间状态机，不启动 WebSocket 服务。LLM 座位作为普通玩家加入，其余座位由房间补成内置 AI；规则、线上服务和客户端不变。需要支持内置 `fetch` 的 Node.js（项目使用 Node 22）。

| 环境变量 | 默认值 / 行为 |
|---|---|
| `AVALON_LLM_PROVIDER` | `deepseek`，预设地址 `https://api.deepseek.com`、模型 `deepseek-chat` |
| `AVALON_LLM_BASE_URL` | 覆盖预设地址；调用时追加 `/chat/completions` |
| `AVALON_LLM_MODEL` | 覆盖模型；其他 provider 必须同时配置地址和模型 |
| `AVALON_LLM_API_KEY` | 优先使用非空值；不在日志中输出 |
| `AVALON_LLM_KEY_FILE` | API_KEY 为空时读取；支持文件只含 key 或一行 `key = xxx`；文件请保存在仓库之外 |
| `AVALON_JEV_API_KEY` | Jev 凭据，优先使用非空值；只在需要 Jev 座位时加载，不写日志 |
| `AVALON_JEV_KEY_FILE` | Jev API_KEY 为空时读取；同样支持纯 key 或 `key = xxx`；请放在仓库之外 |
| `AVALON_JEV_MODEL` | `jev-latest` |
| `AVALON_JEV_BASE_URL` | `https://api.typesafe.ai`，调用时追加 `/v1/systemone` |

Git Bash 示例（自行将凭据放入本地文件，不要将 key 写进命令或提交到仓库）：

```bash
export AVALON_LLM_KEY_FILE='C:/Users/Administrator/.config/avalon/llm-key.txt'
npm run arena -- --games 1 --players 5 --llm-seats all --seed 1 --out logs/arena --speech 1
# 混合对局，关闭 LLM 发言以减少调用：
npm run arena -- --games 2 --players 7 --llm-seats 0,2,4 --seed 1 --speech 0
# Chat Completions、Jev 与内置 AI 混合；新参数的座位号从 1 开始：
export AVALON_JEV_KEY_FILE='C:/Users/Administrator/.config/avalon/jev-key.txt'
npm run arena -- --games 1 --players 5 --seat-providers 1:deepseek,2:jev,3:heuristic,4:jev,5:deepseek --seed 1
```

`--llm-seats` 使用从 0 开始的内部座位索引。`join()` 顺序分配座位，因此指定的 LLM 座位按列表顺序重编号为 `0..k-1`：例如 `0,2,4` 实际是 `0,1,2`（界面显示为 1、2、3 号），其他座位都是 AI。每局 JSONL 首行及最终汇总的 `seatMapping` 都记录请求索引与实际索引。对模型的提示、视野、历史、候选、事实和 JSON 的 `team` / `target` 全部使用从 1 开始的显示号码，与游戏界面一致。Agent 校验号码在 `1..人数` 范围内后减 1，`Decision.value` 中的座位仍为内部 `seatIndex`，回退 AI 的座位结果不换算。真人、内置 AI 和 LLM 的发言均使用显示号码；提示只补全昵称，不改数字，回退发言使用内置 AI 原文（去换行、最多 80 字）。

`--seat-providers` 支持 `deepseek`、`jev`、`heuristic`，**输入为从 1 开始的请求座位号**。它先覆盖对应请求座位的后端，未指定的座位仍按 `--llm-seats` 旧逻辑分配（默认 `all`，使用 `AVALON_LLM_PROVIDER`）。随后沿用旧版加入方式：外部模型座位先加入，启发式座位由房间补齐；外部座位按旧列表顺序加入，新增外部座位接在后面，启发式按请求座位升序映射。上述示例的实际显示座位为：1 号 deepseek、2/3 号 Jev、4 号 deepseek、5 号 heuristic。首行和汇总新增 `providerSeatMapping: [{requested, actual, provider}]`，这两个号码都从 **1** 开始，另有 `providerSeatBase: 1`；原 `seatMapping` 仍是从 0 开始的模型座位映射。动作新增 `seatNumber`（实际显示号）和 `seatProvider`（该座位配置的后端）。全 heuristic 不需要任何 key；全 Jev 不需要 Chat Completions key。

JSONL 首行的 `seatNumbering` 明确约定：`seatIndexBase: 0`、`speechSeatBase: 1`、`modelSeatBase: 1`。`seatMapping.requested/actual`、`actualLlmSeats`、`heuristicSeats`、动作的 `seat`，以及 `propose`、`assassinate`、`excaliburHolder`、`excaliburTarget`、`ladyTarget` 的 `value` 均为从 0 开始的内部索引（王者之剑 `-1` 仍表示不使用）。发言、理由和结果描述里的号码为从 1 开始的显示号码，日志不转换发言数字。

默认每次请求超时 20 秒；429、5xx、网络 TypeError 最多重试 2 次，退避 100/200 毫秒。超时、调用失败或非法 JSON 决策回退到内置 AI；好人失败牌、重复/越界队伍和刺杀同伴均会拒绝。王者之剑和湖中仙女始终用启发式策略，记录 `provider: "heuristic"`。`--speech 0` 只跳过 LLM 发言，AI 仍照常发言。

Jev 使用共享提示的信息部分作为 `state`，只含当前座位合法可知的信息，不带 JSON 输出格式指令。问题统一为 `choice`：投票 `approve/reject`，坏人任务牌 `success/fail`，刺杀 `seat_1` 等合法候选，组队 `team_1_3` 等人数正确的全部组合，键和描述均为显示座位号。好人直接出成功牌，Jev 发言返回 `null` 并直接结束发言，JSONL 记录 `speech: null, reason: "provider has no text output"`（`--speech 0` 下同样保留此记录），两者都不调用服务。组队组合超过 255 时直接用 `aiProposeTeam` 并记录 `fallback: true, fallbackReason: "组合过多"`（当前 5～10 人规则最多 252 种）。缺少有效答案字段、非法 choice 或无效 confidence/probabilities 都回退到对应内置 AI；400/422 不重试。合法答案的 `confidence` 和各选项 `probabilities` 保存在 Decision 与 JSONL 中，不作为额外回退阈值。

每局日志为 `<out>/<时间戳>-g<序号>.jsonl`（时间戳附进程号避免冲突，默认 `logs/arena/`，`logs/` 已忽略）。首行为配置及座位映射，中间为决策，末行为结果。决策含身份（供离线复盘，不进入其他玩家提示）、动作、值、理由/发言、耗时、token 和回退原因。最后控制台输出 JSON 汇总：`goodWins/evilWins`、`assassinationHits/assassinations/assassinationHitRate`、`llmCalls`、`fallbacks`、`tokens`、`averageStepMs`。`llmCalls` 是逻辑决策调用次数，不含 HTTP 重试；token 累计服务实际返回的 usage（缺失 usage 或请求未返回时无法估计消耗）。平均耗时按全部记录动作计算，内置 AI 自动动作记 0 ms，LLM 决策包含重试与回退耗时。

汇总 `byProvider` 按座位配置的 provider 分组，包含 `games`、`goodGames/goodWins/goodWinRate`、`evilGames/evilWins/evilWinRate`、`assassinations/assassinationHits/assassinationHitRate`、`calls`、`fallbacks`、`tokens`。`games` 为该 provider 参与的对局数；阵营分母为该 provider 至少有一个座位属于该阵营的对局数，同一局同一阵营多个座位只计一次，跨阵营可同时计入两个分母。刺杀只计该 provider 担任刺客并实际刺杀的局，分母为零时比率记 0。王者之剑等启发式动作仍归属其配置的座位 provider，但不增加调用数。`llmCalls`/分组 `calls` 排除 Jev 空发言、好人成功牌与组合超限等未发请求的动作；失败请求计一次，HTTP 重试不重复计。Jev `input_tokens/output_tokens` 映射为同一 `tokens.prompt/completion` 结构。

费用估算方法：全 LLM 的 N 人局，P 次提案、M 次实际任务，开启发言时调用数为 `P × (2N + 1) + 各任务队伍人数之和 + A`，A 在进入刺杀时为 1，否则为 0。关闭发言改为 `P × (N + 1) + 队伍人数之和 + A`。例如 5 人局、没有否决、打满 5 轮：开启发言 68～69 次，关闭为 43～44 次；每次否决额外增加 11 或 6 次。混合局按实际 LLM 发言、队长、投票、任务成员、刺客分别计数。假设每次输入 2000、输出 100 tokens，则约 69 次对应 13.8 万输入、6900 输出 tokens；这只是预算假设，历史增长会增加输入量。金额用 `输入 tokens/百万 × 输入单价 + 输出 tokens/百万 × 输出单价` 计算，单价取所用服务账单价格，重试可能增加费用。

上述包含发言的公式用于 Chat Completions。Jev 每局逻辑调用数估算为 `Jev 队长提案次数（组合≤255）+ Jev 座位投票次数 + Jev 坏人实际出任务次数 + Jev 刺客刺杀次数`，不计发言、好人任务牌、王者之剑和湖中仙女。全 Jev 时为 `P × (N + 1) + B + A`，B 为各次任务中坏人上队人数之和。混合局分别估算两类后端；以 `byProvider.jev.calls` 和返回的 token 为实测依据。每次请求都包含当前历史及选项描述，尤其组队选项多时输入会增加；Jev 的金额同样用输入/输出 token 与实际账单单价计算，本地假服务测试不产生供应商费用，也不能代表真实模型效果。

## 测试

```powershell
npm test          # 编译后运行 test/ 下的规则单元测试和 WebSocket 端到端测试
```

`npm test` 不依赖数据库，会在随机端口启动独立服务，覆盖登录与令牌（含模拟微信接口）、夜晚视野、各类非法操作的错误码、超时托管、结束后重开、离开与重连、多房间隔离等场景。

`test/postgres.test.js` 针对真实 PostgreSQL 验证迁移、对局保存、积分和复盘权限，默认跳过。需要时先准备一个空数据库，再设置连接变量运行：

```bash
AVALON_PG_TEST=1 PGHOST=127.0.0.1 PGPORT=5432 PGUSER=avalon PGPASSWORD=... PGDATABASE=avalon_test npm test
```

客户端协议的联调验证见 `客户端/Godot_Client/tools/smoke_network.gd`。

在 Godot 客户端的服务器地址框填写 `ws://127.0.0.1:8888`。手机或微信开发者工具连接到另一台电脑时，改用服务电脑的局域网地址；真机发布需要可访问的 `wss://` 地址及对应平台域名配置。
