import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { WebSocket, RawData } from "ws";
import { DatabaseService } from "./database.service";

enum Route {
    Login = 101,
    JoinRoom = 102,
    Ready = 103,
    RoomInfoInit = 201,
    PlayerJoin = 202,
    PlayerReady = 203,
    GameStart = 301,
    StageChange = 302,
    IdentityPush = 303,
    ProposeTeam = 401,
    TeamProposed = 402,
    VoteTeam = 501,
    VoteResult = 502,
    MissionAction = 601,
    MissionResult = 602,
    Assassinate = 701,
    GameEnd = 702,
}

enum Role {
    Unknown = 0,
    Merlin = 1,
    Percival = 2,
    Servant = 3,
    Assassin = 4,
    Morgana = 5,
    Minion = 6,
    Oberon = 7,
    Mordred = 8,
}

enum Stage {
    Preparing = 0,
    Night = 1,
    Proposing = 2,
    Voting = 3,
    Mission = 4,
    Assassinating = 5,
    End = 6,
}

interface Player {
    userId: string;
    nickname: string;
    avatar: string;
    isReady: boolean;
    seatIndex: number;
    role: Role;
    isAi: boolean;
}

export interface ClientConnection {
    socket: WebSocket;
    userId?: string;
    nickname?: string;
}

export interface Packet {
    seq: number;
    route: number;
    payload: Record<string, any>;
}

const nightSeconds = Number(process.env.AVALON_NIGHT_SECONDS ?? 2);
const aiTickMs = Number(process.env.AVALON_AI_TICK_MS ?? 250);
let serverSequence = 0;
const clients = new Map<string, ClientConnection>();
let room: AvalonRoom;

@Injectable()
export class AvalonGameService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(AvalonGameService.name);
    private aiTimer?: NodeJS.Timeout;

    public constructor(private readonly database: DatabaseService) {}

    public onModuleInit(): void {
        this.aiTimer = setInterval(tickAI, aiTickMs);
        this.aiTimer.unref();
    }

    public onModuleDestroy(): void {
        if (this.aiTimer) clearInterval(this.aiTimer);
    }

    public connect(socket: WebSocket): ClientConnection {
        return { socket };
    }

    public disconnect(client: ClientConnection): void {
        if (client.userId && clients.get(client.userId)?.socket === client.socket) {
            clients.delete(client.userId);
        }
    }

    public async handle(client: ClientConnection, packet: Packet): Promise<void> {
        if (packet.route === Route.Login) {
            await this.handleLogin(client, packet.payload);
            return;
        }
        handlePacket(client, packet);
    }

    public async health(port: number): Promise<Record<string, unknown>> {
        const ready = await this.database.isReady();
        return { ok: ready, service: "avalon-ts-server", framework: "NestJS", websocket: `ws://127.0.0.1:${port}`, database: this.database.enabled ? (ready ? "ready" : "unavailable") : "disabled", clients: clients.size, room: room.snapshot() };
    }

    private async handleLogin(client: ClientConnection, payload: Record<string, any>): Promise<void> {
        const userId = normalizeUserId(payload.userId ?? payload.UID ?? payload.uid);
        const nickname = String(payload.nickname ?? "Guest").trim() || "Guest";
        if (userId.length > 128 || nickname.length > 64) {
            send(client, Route.Login, { code: 400, message: "用户 ID 或昵称过长" });
            return;
        }
        if (room.players.some((player) => player.isAi && player.userId === userId)) {
            send(client, Route.Login, { code: 409, message: "用户 ID 已由 AI 使用" });
            return;
        }
        try {
            await this.database.saveProfile(userId, nickname);
        } catch (error) {
            this.logger.error(`Profile write failed: ${String(error)}`);
            send(client, Route.Login, { code: 503, message: "登录服务暂不可用" });
            return;
        }
        const previous = clients.get(userId);
        if (previous && previous.socket !== client.socket) previous.socket.close();
        client.userId = userId;
        client.nickname = nickname;
        clients.set(userId, client);
        send(client, Route.Login, { code: 0, userId });
    }
}

export function decodePacket(raw: RawData): Packet | null {
    const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    if (buffer.length >= 4) {
        const seq = buffer.readUInt16LE(0);
        const route = buffer.readUInt16LE(2);
        const text = buffer.subarray(4).toString("utf8");
        const payload = text.length > 0 ? JSON.parse(text) : {};
        return { seq, route, payload: isObject(payload) ? payload : {} };
    }

    const text = buffer.toString("utf8");
    if (!text) {
        return null;
    }
    const data = JSON.parse(text);
    const route = Number(data.route ?? data.Route ?? data.cmd ?? data.Cmd);
    if (!Number.isFinite(route)) {
        return null;
    }
    const payload = data.data ?? data.Data ?? data.payload ?? data.Payload ?? data;
    return { seq: Number(data.seq ?? data.Seq ?? 0), route, payload: isObject(payload) ? payload : {} };
}

function encodePacket(route: number, payload: unknown): Buffer {
    const body = Buffer.from(JSON.stringify(payload ?? {}), "utf8");
    const packet = Buffer.allocUnsafe(4 + body.length);
    serverSequence = serverSequence >= 32767 ? 1 : serverSequence + 1;
    packet.writeUInt16LE(serverSequence, 0);
    packet.writeUInt16LE(route, 2);
    body.copy(packet, 4);
    return packet;
}

function send(client: ClientConnection, route: number, payload: unknown): void {
    if (client.socket.readyState === WebSocket.OPEN) {
        client.socket.send(encodePacket(route, payload));
    }
}

function broadcast(route: number, payload: unknown): void {
    for (const client of clients.values()) {
        send(client, route, payload);
    }
}

function handlePacket(client: ClientConnection, packet: Packet): void {
    switch (packet.route) {
        case Route.JoinRoom:
            handleJoinRoom(client, packet.payload);
            break;
        case Route.Ready:
            handleReady(client, packet.payload);
            break;
        case Route.ProposeTeam:
            handlePropose(client, packet.payload);
            break;
        case Route.VoteTeam:
            handleVote(client, packet.payload);
            break;
        case Route.MissionAction:
            handleMission(client, packet.payload);
            break;
        case Route.Assassinate:
            handleAssassinate(client, packet.payload);
            break;
        default:
            send(client, packet.route, { code: 404, message: `未实现路由 ${packet.route}` });
            break;
    }
}

function handleJoinRoom(client: ClientConnection, payload: Record<string, any>): void {
    if (!client.userId) {
        send(client, Route.JoinRoom, { code: 401, message: "请先登录" });
        return;
    }
    if (String(payload.roomId ?? room.id) !== room.id) {
        send(client, Route.JoinRoom, { code: 404, message: "房间不存在" });
        return;
    }
    const userId = client.userId;
    client.nickname = String(payload.nickname ?? client.nickname ?? `Player_${userId}`);

    if (!room.addHuman(userId, client.nickname)) {
        send(client, Route.JoinRoom, { code: 409, message: "房间已满或游戏已经开始" });
        return;
    }

    send(client, Route.JoinRoom, { code: 0, room: room.snapshot() });
    if (room.stage !== Stage.Preparing) {
        const player = room.players.find((item) => item.userId === userId);
        if (player) {
            send(client, Route.IdentityPush, { role: player.role, visibleSeats: room.visibleSeats(player) });
            send(client, Route.StageChange, { stage: room.stage, timeout: 0 });
        }
        return;
    }
    broadcast(Route.RoomInfoInit, { room: room.snapshot() });
    broadcast(Route.PlayerJoin, { room: room.snapshot() });
}

function handleReady(client: ClientConnection, payload: Record<string, any>): void {
    if (!client.userId) return;
    const userId = client.userId;
    if (!room.setReady(userId, true)) {
        broadcast(Route.PlayerReady, { room: room.snapshot() });
        return;
    }

    room.startGame();
    broadcast(Route.GameStart, { roomId: room.id });
    broadcast(Route.RoomInfoInit, { room: room.snapshot() });
    for (const player of room.players.filter((item) => !item.isAi)) {
        const target = clients.get(player.userId);
        if (target) {
            send(target, Route.IdentityPush, {
                role: player.role,
                visibleSeats: room.visibleSeats(player),
            });
        }
    }
    broadcastStage(Stage.Night, nightSeconds);
    setTimeout(() => {
        if (room.stage === Stage.Night) {
            room.stage = Stage.Proposing;
            broadcastStage(Stage.Proposing, 60);
        }
    }, nightSeconds * 1000).unref();
}

function handlePropose(client: ClientConnection, payload: Record<string, any>): void {
    if (!client.userId) return;
    const userId = client.userId;
    if (!room.isCaptain(userId)) {
        return;
    }
    const selectedSeats = toNumberArray(payload.selectedSeats);
    if (!room.propose(selectedSeats)) {
        return;
    }
    broadcast(Route.TeamProposed, { captainSeat: room.captainIdx, selectedSeats });
    broadcastStage(Stage.Voting, 30);
}

function handleVote(client: ClientConnection, payload: Record<string, any>): void {
    if (!client.userId) return;
    const userId = client.userId;
    const result = room.vote(userId, Boolean(payload.approve));
    if (!result.finished) {
        return;
    }
    broadcast(Route.VoteResult, { votes: result.votes, isPassed: result.passed });
    if (room.stage === Stage.End) {
        finishGame(false, "连续 5 次否决，坏人胜利");
    } else if (result.passed) {
        broadcastStage(Stage.Mission, 30);
    } else {
        broadcastStage(Stage.Proposing, 60);
    }
}

function handleMission(client: ClientConnection, payload: Record<string, any>): void {
    if (!client.userId) return;
    const userId = client.userId;
    const result = room.mission(userId, Boolean(payload.success));
    if (!result.finished) {
        return;
    }
    broadcast(Route.MissionResult, {
        isSuccess: result.success,
        failCount: result.failCount,
        round: result.round,
    });
    if (room.stage === Stage.End) {
        finishGame(false, "三轮任务失败，坏人胜利");
    } else if (room.stage === Stage.Assassinating) {
        broadcastStage(Stage.Assassinating, 60);
    } else {
        broadcastStage(Stage.Proposing, 60);
    }
}

function handleAssassinate(client: ClientConnection, payload: Record<string, any>): void {
    if (!client.userId) return;
    const userId = client.userId;
    if (!room.isBadPlayer(userId) || room.stage !== Stage.Assassinating) {
        return;
    }
    const targetSeat = Number(payload.targetSeat);
    const target = room.players[targetSeat];
    if (!target) {
        return;
    }
    const goodWin = target.role !== Role.Merlin;
    room.stage = Stage.End;
    finishGame(goodWin, `刺客选择了 ${target.nickname}`);
}

function broadcastStage(stage: Stage, timeout: number): void {
    room.stage = stage;
    broadcast(Route.StageChange, { stage, timeout });
}

function finishGame(isGoodWin: boolean, winReason: string): void {
    room.stage = Stage.End;
    broadcast(Route.GameEnd, {
        isGoodWin,
        winReason,
        allRoles: room.players,
    });
}

function tickAI(): void {
    if (room.stage === Stage.Proposing) {
        const captain = room.players[room.captainIdx];
        if (captain?.isAi) {
            const size = room.teamSize();
            const selected = room.players.slice(0, size).map((player) => player.seatIndex);
            room.propose(selected);
            broadcast(Route.TeamProposed, { captainSeat: room.captainIdx, selectedSeats: selected });
            broadcastStage(Stage.Voting, 30);
        }
        return;
    }

    if (room.stage === Stage.Voting) {
        for (const player of room.players.filter((item) => item.isAi)) {
            if (!room.votes.has(player.userId)) {
                const result = room.vote(player.userId, true);
                if (result.finished) {
                    broadcast(Route.VoteResult, { votes: result.votes, isPassed: result.passed });
                    if ((room.stage as Stage) === Stage.End) {
                        finishGame(false, "连续 5 次否决，坏人胜利");
                    } else if (result.passed) {
                        broadcastStage(Stage.Mission, 30);
                    } else {
                        broadcastStage(Stage.Proposing, 60);
                    }
                }
            }
        }
        return;
    }

    if (room.stage === Stage.Mission) {
        for (const seat of room.selectedSeats) {
            const player = room.players[seat];
            if (!player?.isAi || room.missionActions.has(player.userId)) {
                continue;
            }
            const success = !room.isBadRole(player.role);
            const result = room.mission(player.userId, success);
            if (result.finished) {
                broadcast(Route.MissionResult, {
                    isSuccess: result.success,
                    failCount: result.failCount,
                    round: result.round,
                });
                if ((room.stage as Stage) === Stage.End) {
                    finishGame(false, "三轮任务失败，坏人胜利");
                } else if ((room.stage as Stage) === Stage.Assassinating) {
                    broadcastStage(Stage.Assassinating, 60);
                } else {
                    broadcastStage(Stage.Proposing, 60);
                }
            }
        }
        return;
    }

    if (room.stage === Stage.Assassinating) {
        const assassin = room.players.find((player) => player.isAi && player.role === Role.Assassin);
        if (assassin) {
            const merlin = room.players.find((player) => player.role === Role.Merlin);
            if (merlin) {
                room.stage = Stage.End;
                finishGame(false, `刺客选择了 ${merlin.nickname}`);
            }
        }
    }
}

class AvalonRoom {
    public readonly id = "888";
    public players: Player[] = [];
    public stage = Stage.Preparing;
    public captainIdx = 0;
    public round = 1;
    public failedVotes = 0;
    public selectedSeats: number[] = [];
    public missionResults: boolean[] = [];
    public votes = new Map<string, boolean>();
    public missionActions = new Map<string, boolean>();

    public constructor() {
        for (let index = 0; index < 4; index += 1) {
            this.players.push({
                userId: `200${index + 1}`,
                nickname: `AI_Player_${index + 1}`,
                avatar: "",
                isReady: true,
                seatIndex: index,
                role: Role.Unknown,
                isAi: true,
            });
        }
    }

    public addHuman(userId: string, nickname: string): boolean {
        if (this.stage !== Stage.Preparing) {
            return this.players.some((player) => player.userId === userId);
        }
        const existing = this.players.find((player) => player.userId === userId);
        if (existing) {
            existing.nickname = nickname;
            return true;
        }
        if (this.players.length >= 10) {
            return false;
        }
        this.players.push({ userId, nickname, avatar: "", isReady: false, seatIndex: this.players.length, role: Role.Unknown, isAi: false });
        return true;
    }

    public setReady(userId: string, ready: boolean): boolean {
        const player = this.players.find((item) => item.userId === userId);
        if (!player || this.stage !== Stage.Preparing) {
            return false;
        }
        player.isReady = ready;
        return this.players.length >= 5 && this.players.every((item) => item.isReady);
    }

    public startGame(): void {
        if (this.stage !== Stage.Preparing) {
            return;
        }
        const roleSet = roleSetForCount(this.players.length);
        shuffle(roleSet);
        this.players.forEach((player, index) => {
            player.role = roleSet[index] ?? Role.Servant;
        });
        this.stage = Stage.Night;
        this.round = 1;
        this.failedVotes = 0;
        this.captainIdx = Math.floor(Math.random() * this.players.length);
    }

    public snapshot(): Record<string, any> {
        return {
            roomId: this.id,
            players: this.players.map((player) => ({ ...player, role: Role.Unknown })),
            stage: this.stage,
            captainIdx: this.captainIdx,
            round: this.round,
            failedVotes: this.failedVotes,
            selectedSeats: this.selectedSeats.slice(),
            missionResults: this.missionResults.slice(),
        };
    }

    public visibleSeats(player: Player): number[] {
        if (player.role === Role.Merlin) {
            return this.players.filter((item) => this.isBadRole(item.role) && item.role !== Role.Mordred).map((item) => item.seatIndex);
        }
        if (player.role === Role.Percival) {
            return this.players.filter((item) => item.role === Role.Merlin || item.role === Role.Morgana).map((item) => item.seatIndex);
        }
        if (this.isBadRole(player.role)) {
            return this.players.filter((item) => item.userId !== player.userId && [Role.Assassin, Role.Morgana, Role.Minion, Role.Mordred].includes(item.role)).map((item) => item.seatIndex);
        }
        return [];
    }

    public isCaptain(userId: string): boolean {
        return this.players[this.captainIdx]?.userId === userId;
    }

    public propose(selectedSeats: number[]): boolean {
        if (this.stage !== Stage.Proposing || selectedSeats.length !== this.teamSize()) {
            return false;
        }
        const unique = [...new Set(selectedSeats)].filter((seat) => this.players[seat]);
        if (unique.length !== selectedSeats.length) {
            return false;
        }
        this.selectedSeats = unique;
        this.votes.clear();
        this.stage = Stage.Voting;
        return true;
    }

    public vote(userId: string, approve: boolean): { finished: boolean; passed: boolean; votes: boolean[] } {
        if (this.stage !== Stage.Voting || !this.players.some((player) => player.userId === userId)) {
            return { finished: false, passed: false, votes: [] };
        }
        this.votes.set(userId, approve);
        if (this.votes.size < this.players.length) {
            return { finished: false, passed: false, votes: [] };
        }
        const votes = this.players.map((player) => this.votes.get(player.userId) ?? false);
        const passed = votes.filter(Boolean).length > this.players.length / 2;
        if (passed) {
            this.stage = Stage.Mission;
            this.missionActions.clear();
            this.failedVotes = 0;
        } else {
            this.failedVotes += 1;
            this.stage = this.failedVotes >= 5 ? Stage.End : Stage.Proposing;
            if (this.stage === Stage.Proposing) {
                this.captainIdx = (this.captainIdx + 1) % this.players.length;
            }
        }
        return { finished: true, passed, votes };
    }

    public mission(userId: string, success: boolean): { finished: boolean; success: boolean; failCount: number; round: number } {
        if (this.stage !== Stage.Mission || !this.selectedSeats.some((seat) => this.players[seat]?.userId === userId)) {
            return { finished: false, success: false, failCount: 0, round: this.round };
        }
        this.missionActions.set(userId, success);
        if (this.missionActions.size < this.selectedSeats.length) {
            return { finished: false, success: false, failCount: 0, round: this.round };
        }
        const failCount = [...this.missionActions.values()].filter((item) => !item).length;
        const successResult = this.players.length >= 7 && this.round === 4 ? failCount < 2 : failCount === 0;
        const resultRound = this.round;
        this.missionResults.push(successResult);
        const goodWins = this.missionResults.filter(Boolean).length;
        const badWins = this.missionResults.length - goodWins;
        if (badWins >= 3) {
            this.stage = Stage.End;
        } else if (goodWins >= 3) {
            this.stage = Stage.Assassinating;
        } else {
            this.round += 1;
            this.captainIdx = (this.captainIdx + 1) % this.players.length;
            this.stage = Stage.Proposing;
        }
        return { finished: true, success: successResult, failCount, round: resultRound };
    }

    public teamSize(): number {
        const matrix: Record<number, number[]> = {
            5: [2, 3, 2, 3, 3],
            6: [2, 3, 4, 3, 4],
            7: [2, 3, 3, 4, 4],
            8: [3, 4, 4, 5, 5],
            9: [3, 4, 4, 5, 5],
            10: [3, 4, 4, 5, 5],
        };
        return matrix[this.players.length]?.[this.round - 1] ?? 2;
    }

    public isBadRole(role: Role): boolean {
        return [Role.Assassin, Role.Morgana, Role.Minion, Role.Oberon, Role.Mordred].includes(role);
    }

    public isBadPlayer(userId: string): boolean {
        const player = this.players.find((item) => item.userId === userId);
        return Boolean(player && this.isBadRole(player.role));
    }
}

room = new AvalonRoom();

function roleSetForCount(count: number): Role[] {
    const base: Record<number, Role[]> = {
        5: [Role.Merlin, Role.Percival, Role.Servant, Role.Assassin, Role.Morgana],
        6: [Role.Merlin, Role.Percival, Role.Servant, Role.Servant, Role.Assassin, Role.Morgana],
        7: [Role.Merlin, Role.Percival, Role.Servant, Role.Servant, Role.Assassin, Role.Morgana, Role.Oberon],
        8: [Role.Merlin, Role.Percival, Role.Servant, Role.Servant, Role.Servant, Role.Assassin, Role.Morgana, Role.Oberon],
        9: [Role.Merlin, Role.Percival, Role.Servant, Role.Servant, Role.Servant, Role.Servant, Role.Assassin, Role.Morgana, Role.Minion],
        10: [Role.Merlin, Role.Percival, Role.Servant, Role.Servant, Role.Servant, Role.Servant, Role.Assassin, Role.Morgana, Role.Mordred, Role.Minion],
    };
    return (base[count] ?? [Role.Merlin, Role.Assassin, ...Array(Math.max(0, count - 2)).fill(Role.Servant)]).slice(0, count);
}

function normalizeUserId(value: unknown): string {
    const text = String(value ?? "").trim();
    return text || `guest-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

function toNumberArray(value: unknown): number[] {
    return Array.isArray(value) ? value.map((item) => Number(item)).filter((item) => Number.isInteger(item)) : [];
}

function isObject(value: unknown): value is Record<string, any> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shuffle<T>(items: T[]): void {
    for (let index = items.length - 1; index > 0; index -= 1) {
        const other = Math.floor(Math.random() * (index + 1));
        [items[index], items[other]] = [items[other], items[index]];
    }
}
