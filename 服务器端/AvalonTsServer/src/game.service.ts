import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { WebSocket } from "ws";
import { AvalonRoom, RoomConfig } from "./avalon.room";
import { ErrorCode, RoomError, Route, Stage } from "./avalon.types";
import { DatabaseService } from "./database.service";
import { encodePacket, Packet } from "./protocol";

export interface ClientConnection {
    socket: WebSocket;
    userId?: string;
    nickname?: string;
}

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

    public constructor(private readonly database: DatabaseService) {}

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
                case Route.Ready:
                    this.handleReady(userId, payload);
                    break;
                case Route.LeaveRoom:
                    this.handleLeave(client, userId);
                    break;
                case Route.ProposeTeam:
                    this.requireRoom(userId).propose(userId, payload.selectedSeats);
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
        const userId = normalizeUserId(payload.userId ?? payload.UID ?? payload.uid);
        const nickname = String(payload.nickname ?? "Guest").trim() || "Guest";
        if (userId.length > 128 || nickname.length > 64) throw new RoomError(ErrorCode.BadRequest, "用户 ID 或昵称过长");
        if (userId.startsWith("ai-")) throw new RoomError(ErrorCode.Conflict, "用户 ID 已由 AI 使用");
        try {
            await this.database.saveProfile(userId, nickname);
        } catch (error) {
            this.logger.error(`Profile write failed: ${String(error)}`);
            throw new RoomError(ErrorCode.Unavailable, "登录服务暂不可用");
        }
        // Switching identity on the same socket releases the old one as if it had disconnected.
        if (client.userId && client.userId !== userId) this.disconnect(client);
        const previous = this.clients.get(userId);
        if (previous && previous.socket !== client.socket) previous.socket.close();
        client.userId = userId;
        client.nickname = nickname;
        this.clients.set(userId, client);
        this.send(client, Route.Login, { code: 0, userId });
    }

    private handleJoinRoom(client: ClientConnection, userId: string, payload: Record<string, any>): void {
        const roomId = String(payload.roomId ?? DEFAULT_ROOM_ID).trim();
        if (!roomIdPattern.test(roomId)) throw new RoomError(ErrorCode.BadRequest, "房间号只能包含字母、数字、下划线和短横线");
        const nickname = (String(payload.nickname ?? client.nickname ?? "").trim() || `Player_${userId}`).slice(0, 64);

        const current = this.roomOf(userId);
        if (current && current.id !== roomId) {
            if (current.isInGame()) throw new RoomError(ErrorCode.Conflict, `你正在房间 ${current.id} 的对局中，请先返回或离开该房间`);
            this.leaveRoom(current, userId);
        }

        let room = this.rooms.get(roomId);
        if (!room) {
            if (this.rooms.size >= this.config.maxRooms) throw new RoomError(ErrorCode.Unavailable, "房间数量已达上限，请稍后再试");
            room = this.createRoom(roomId);
        }
        this.userRooms.set(userId, roomId);
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
            this.send(client, Route.IdentityPush, room.identity(userId));
            this.send(client, Route.StageChange, room.stagePayload());
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

    private createRoom(roomId: string): AvalonRoom {
        const room: AvalonRoom = new AvalonRoom(roomId, {
            config: this.config,
            send: (target, route, payload) => this.deliver(room, target, route, payload),
        });
        this.rooms.set(roomId, room);
        this.logger.log({ event: "room.created", roomId, rooms: this.rooms.size });
        return room;
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

function normalizeUserId(value: unknown): string {
    const text = String(value ?? "").trim();
    return text || `guest-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}
