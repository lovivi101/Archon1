import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { WebSocket } from "ws";
import { AvalonRoom, RoomConfig } from "./avalon.room";
import { ErrorCode, RoomError, Route, Stage } from "./avalon.types";
import { AuthService } from "./auth.service";
import { DatabaseService } from "./database.service";
import { encodePacket, Packet } from "./protocol";

export interface ClientConnection {
    socket: WebSocket;
    userId?: string;
    nickname?: string;
    /** Timestamps of recent login attempts on this connection, for rate limiting. */
    loginAttempts?: number[];
}

const loginWindowMs = 60_000;
const maxLoginAttempts = 10;

export const DEFAULT_ROOM_ID = "888";
const roomIdPattern = /^[A-Za-z0-9_-]{1,32}$/;

function envNumber(name: string, fallback: number, min = 0): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= min ? value : fallback;
}

export function loadRoomConfig(): RoomConfig & { tickMs: number; maxRooms: number; abandonMs: number } {
    const tickMs = envNumber("AVALON_AI_TICK_MS", 250, 10);
    return {
        minPlayers: 5,
        maxPlayers: 10,
        nightMs: envNumber("AVALON_NIGHT_SECONDS", 2) * 1000,
        speakMs: envNumber("AVALON_SPEAK_SECONDS", 30, 0.1) * 1000,
        ladyMs: envNumber("AVALON_LADY_SECONDS", 30, 0.1) * 1000,
        excaliburMs: envNumber("AVALON_EXCALIBUR_SECONDS", 20, 0.1) * 1000,
        aiSpeechMs: envNumber("AVALON_AI_SPEECH_MS", 1500),
        proposeMs: envNumber("AVALON_PROPOSE_SECONDS", 60, 0.1) * 1000,
        voteMs: envNumber("AVALON_VOTE_SECONDS", 30, 0.1) * 1000,
        missionMs: envNumber("AVALON_MISSION_SECONDS", 30, 0.1) * 1000,
        assassinMs: envNumber("AVALON_ASSASSIN_SECONDS", 60, 0.1) * 1000,
        aiDelayMs: envNumber("AVALON_AI_DELAY_MS", tickMs),
        tickMs,
        maxRooms: envNumber("AVALON_MAX_ROOMS", 1000, 1),
        abandonMs: envNumber("AVALON_ABANDON_SECONDS", 60) * 1000,
    };
}

@Injectable()
export class AvalonGameService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(AvalonGameService.name);
    private readonly config = loadRoomConfig();
    private readonly clients = new Map<string, ClientConnection>();
    private readonly rooms = new Map<string, AvalonRoom>();
    /** userId -> roomId the user currently belongs to. */
    private readonly userRooms = new Map<string, string>();
    /** roomId -> time the last online human disappeared from a game in progress. */
    private readonly abandonedSince = new Map<string, number>();
    private sequence = 0;
    private timer?: NodeJS.Timeout;

    public constructor(private readonly database: DatabaseService, private readonly auth: AuthService) {}

    public onModuleInit(): void {
        this.timer = setInterval(() => this.tick(), this.config.tickMs);
        this.timer.unref();
    }

    public onModuleDestroy(): void {
        if (this.timer) clearInterval(this.timer);
    }

    public connect(socket: WebSocket): ClientConnection {
        return { socket };
    }

    public disconnect(client: ClientConnection): void {
        const userId = client.userId;
        if (!userId || this.clients.get(userId)?.socket !== client.socket) return;
        this.clients.delete(userId);
        const room = this.roomOf(userId);
        if (!room) return;
        room.setOffline(userId);
        if (!room.hasMember(userId)) this.userRooms.delete(userId);
        this.collect(room);
    }

    public async handle(client: ClientConnection, packet: Packet): Promise<void> {
        try {
            if (packet.route === Route.Login) {
                await this.handleLogin(client, packet.payload);
                return;
            }
            const userId = client.userId;
            if (!userId) throw new RoomError(ErrorCode.Unauthorized, "请先登录");
            const payload = packet.payload;
            switch (packet.route) {
                case Route.JoinRoom:
                    this.handleJoinRoom(client, userId, payload);
                    break;
                case Route.CreateRoom:
                    this.handleCreateRoom(client, userId, payload);
                    break;
                case Route.QuickMatch:
                    this.handleQuickMatch(client, userId, payload);
                    break;
                case Route.Chat:
                    this.requireRoom(userId).chat(userId, payload.text);
                    break;
                case Route.EndSpeech:
                    this.requireRoom(userId).endSpeech(userId);
                    break;
                case Route.LadyCheck:
                    this.requireRoom(userId).ladyCheck(userId, payload.targetSeat);
                    break;
                case Route.ExcaliburUse:
                    this.requireRoom(userId).useExcalibur(userId, payload.targetSeat);
                    break;
                case Route.Ready:
                    this.handleReady(userId, payload);
                    break;
                case Route.LeaveRoom:
                    this.handleLeave(client, userId);
                    break;
                case Route.ProposeTeam:
                    this.requireRoom(userId).propose(userId, payload.selectedSeats, payload.excaliburSeat);
                    break;
                case Route.VoteTeam:
                    this.requireRoom(userId).vote(userId, payload.approve);
                    break;
                case Route.MissionAction:
                    this.requireRoom(userId).mission(userId, payload.success);
                    break;
                case Route.Assassinate:
                    this.requireRoom(userId).assassinate(userId, payload.targetSeat);
                    break;
                default:
                    throw new RoomError(ErrorCode.NotFound, `未实现路由 ${packet.route}`);
            }
        } catch (error) {
            if (!(error instanceof RoomError)) throw error;
            this.send(client, packet.route, { code: error.code, message: error.message, seq: packet.seq });
        }
    }

    public async health(port: number): Promise<Record<string, unknown>> {
        const ready = await this.database.isReady();
        return {
            ok: ready,
            service: "avalon-ts-server",
            framework: "NestJS",
            websocket: `ws://127.0.0.1:${port}`,
            database: this.database.enabled ? (ready ? "ready" : "unavailable") : "disabled",
            clients: this.clients.size,
            rooms: this.rooms.size,
        };
    }

    /** Advances every room; drops rooms nobody is playing in any more. */
    public tick(): void {
        const now = Date.now();
        for (const room of [...this.rooms.values()]) {
            try {
                room.tick();
            } catch (error) {
                this.logger.error({ event: "room.tick_error", roomId: room.id, error: String(error) }, error instanceof Error ? error.stack : undefined);
            }
            if (room.onlineHumanCount() > 0) {
                this.abandonedSince.delete(room.id);
                continue;
            }
            if (!room.isInGame()) {
                this.deleteRoom(room, "room.closed");
                continue;
            }
            const since = this.abandonedSince.get(room.id) ?? now;
            this.abandonedSince.set(room.id, since);
            if (now - since >= this.config.abandonMs) this.deleteRoom(room, "room.abandoned");
        }
    }

    private async handleLogin(client: ClientConnection, payload: Record<string, any>): Promise<void> {
        const now = Date.now();
        client.loginAttempts = (client.loginAttempts ?? []).filter((time) => now - time < loginWindowMs);
        if (client.loginAttempts.length >= maxLoginAttempts) throw new RoomError(ErrorCode.TooManyRequests, "登录过于频繁，请稍后再试");
        client.loginAttempts.push(now);

        const nickname = String(payload.nickname ?? "").trim() || "Guest";
        if (nickname.length > 64) throw new RoomError(ErrorCode.BadRequest, "昵称过长");
        const { userId, provider } = await this.auth.authenticate(payload);
        try {
            await this.database.saveProfile(userId, nickname);
        } catch (error) {
            this.logger.error(`Profile write failed: ${String(error)}`);
            throw new RoomError(ErrorCode.Unavailable, "登录服务暂不可用");
        }
        // Switching identity on the same socket releases the old one as if it had disconnected.
        if (client.userId && client.userId !== userId) this.disconnect(client);
        const previous = this.clients.get(userId);
        if (previous && previous.socket !== client.socket) previous.socket.close(4001, "Logged in elsewhere");
        client.userId = userId;
        client.nickname = nickname;
        this.clients.set(userId, client);
        const { token, expiresAt } = this.auth.issueToken(userId);
        this.logger.log({ event: "auth.login", provider });
        this.send(client, Route.Login, { code: 0, userId, nickname, provider, token, expiresAt });
    }

    /** Joins a room by id. A missing room is created (legacy clients) unless `mustExist` is set, as when typing a room code. */
    private handleJoinRoom(client: ClientConnection, userId: string, payload: Record<string, any>): void {
        const roomId = String(payload.roomId ?? DEFAULT_ROOM_ID).trim();
        if (!roomIdPattern.test(roomId)) throw new RoomError(ErrorCode.BadRequest, "房间号只能包含字母、数字、下划线和短横线");
        this.leaveOtherRoom(userId, roomId);
        let room = this.rooms.get(roomId);
        if (!room) {
            if (payload.mustExist === true) throw new RoomError(ErrorCode.NotFound, "房间不存在，请检查房间号");
            room = this.createRoom(roomId, payload.playerCount === undefined ? 5 : playerCount(payload), false);
        }
        this.enterRoom(client, userId, room, payload);
    }

    /** A private room with a fresh 6-digit code; friends join it with JoinRoom + mustExist. */
    private handleCreateRoom(client: ClientConnection, userId: string, payload: Record<string, any>): void {
        const count = playerCount(payload);
        this.leaveOtherRoom(userId, null);
        this.enterRoom(client, userId, this.createRoom(this.newRoomCode(), count, false), payload);
    }

    /** Seats the player in an open public room for that player count, or opens a new one. */
    private handleQuickMatch(client: ClientConnection, userId: string, payload: Record<string, any>): void {
        const count = playerCount(payload);
        this.leaveOtherRoom(userId, null);
        const open = [...this.rooms.values()].find((room) => room.isPublic && room.targetPlayers === count && room.hasFreeSeat());
        this.enterRoom(client, userId, open ?? this.createRoom(this.newRoomCode(), count, true), payload);
    }

    private leaveOtherRoom(userId: string, keepRoomId: string | null): void {
        const current = this.roomOf(userId);
        if (!current || current.id === keepRoomId) return;
        if (current.isInGame()) throw new RoomError(ErrorCode.Conflict, `你正在房间 ${current.id} 的对局中，请先返回或离开该房间`);
        this.leaveRoom(current, userId);
    }

    private enterRoom(client: ClientConnection, userId: string, room: AvalonRoom, payload: Record<string, any>): void {
        const nickname = (String(payload.nickname ?? client.nickname ?? "").trim() || `Player_${userId}`).slice(0, 64);
        this.userRooms.set(userId, room.id);
        try {
            room.join(userId, nickname);
        } catch (error) {
            if (!room.hasMember(userId)) this.userRooms.delete(userId);
            this.collect(room);
            throw error;
        }
        client.nickname = nickname;

        this.send(client, Route.JoinRoom, { code: 0, room: room.snapshot() });
        if (room.stage === Stage.End) {
            this.send(client, Route.GameEnd, room.outcome);
            return;
        }
        if (room.isInGame()) {
            // Rejoining mid-game: identity (with private Lady/Excalibur knowledge), the stage and the table talk so far.
            this.send(client, Route.IdentityPush, room.identity(userId));
            this.send(client, Route.StageChange, room.stagePayload());
            for (const entry of room.chatFor(userId)) this.send(client, Route.ChatMessage, { ...entry, history: true });
        }
        room.broadcastRoom(Route.PlayerJoin);
    }

    private handleReady(userId: string, payload: Record<string, any>): void {
        const ready = payload.ready ?? true;
        if (typeof ready !== "boolean") throw new RoomError(ErrorCode.BadRequest, "ready 必须是布尔值");
        this.requireRoom(userId).ready(userId, ready);
    }

    private handleLeave(client: ClientConnection, userId: string): void {
        const room = this.roomOf(userId);
        if (room) this.leaveRoom(room, userId);
        this.send(client, Route.LeaveRoom, { code: 0 });
    }

    private leaveRoom(room: AvalonRoom, userId: string): void {
        room.leave(userId);
        this.userRooms.delete(userId);
        this.collect(room);
    }

    private createRoom(roomId: string, targetPlayers: number, isPublic: boolean): AvalonRoom {
        if (this.rooms.size >= this.config.maxRooms) throw new RoomError(ErrorCode.Unavailable, "房间数量已达上限，请稍后再试");
        const room: AvalonRoom = new AvalonRoom(roomId, {
            config: this.config,
            targetPlayers,
            isPublic,
            send: (target, route, payload) => this.deliver(room, target, route, payload),
        });
        this.rooms.set(roomId, room);
        this.logger.log({ event: "room.created", roomId, targetPlayers, isPublic, rooms: this.rooms.size });
        return room;
    }

    private newRoomCode(): string {
        for (;;) {
            const code = String(100000 + Math.floor(Math.random() * 900000));
            if (!this.rooms.has(code)) return code;
        }
    }

    /** Rooms outside a game with nobody online are closed right away; games in progress wait for `tick` to time them out. */
    private collect(room: AvalonRoom): void {
        if (room.onlineHumanCount() === 0 && !room.isInGame()) this.deleteRoom(room, "room.closed");
    }

    private deleteRoom(room: AvalonRoom, event: string): void {
        if (this.rooms.get(room.id) !== room) return;
        this.rooms.delete(room.id);
        this.abandonedSince.delete(room.id);
        for (const player of room.players) {
            if (this.userRooms.get(player.userId) === room.id) this.userRooms.delete(player.userId);
        }
        this.logger.log({ event, roomId: room.id, rooms: this.rooms.size });
    }

    private roomOf(userId: string): AvalonRoom | undefined {
        const roomId = this.userRooms.get(userId);
        return roomId === undefined ? undefined : this.rooms.get(roomId);
    }

    private requireRoom(userId: string): AvalonRoom {
        const room = this.roomOf(userId);
        if (!room) throw new RoomError(ErrorCode.NotFound, "你不在任何房间中");
        return room;
    }

    private deliver(room: AvalonRoom, target: string | null, route: Route, payload: unknown): void {
        const recipients = target === null ? room.players.filter((player) => !player.isAi).map((player) => player.userId) : [target];
        for (const userId of recipients) {
            const client = this.clients.get(userId);
            if (client && this.userRooms.get(userId) === room.id) this.send(client, route, payload);
        }
    }

    private send(client: ClientConnection, route: number, payload: unknown): void {
        if (client.socket.readyState !== WebSocket.OPEN) return;
        this.sequence = this.sequence >= 65535 ? 1 : this.sequence + 1;
        client.socket.send(encodePacket(this.sequence, route, payload));
    }
}

function playerCount(payload: Record<string, any>): number {
    const count = Number(payload.playerCount ?? 5);
    if (!Number.isInteger(count) || count < 5 || count > 10) throw new RoomError(ErrorCode.BadRequest, "人数必须是 5 到 10 人");
    return count;
}
