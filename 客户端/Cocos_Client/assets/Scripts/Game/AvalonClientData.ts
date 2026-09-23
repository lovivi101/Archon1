import { AvalonGameState } from "./AvalonGameState";
import { GameStage, PlayerInfo, Route } from "./AvalonGameTypes";
import { AvalonNetwork, ConnectionState, DisposeHandler } from "../Network/AvalonNetwork";
import { DEFAULT_ROOM_ID, DEFAULT_SERVER_URL } from "../Network/AvalonProtocol";

export type ClientDataEventType = "state" | "connection" | "error";

export interface ClientDataEvent {
    type: ClientDataEventType;
    route?: number;
    message: string;
}

export interface ClientDataSnapshot {
    connection: ConnectionState;
    lastMessage: string;
    serverUrl: string;
    roomId: string;
    myId: string;
    nickname: string;
    players: PlayerInfo[];
    stage: GameStage;
    captainSeat: number;
    currentRound: number;
    failedVotes: number;
    myRole: AvalonGameState["myRole"];
    visibleSeats: number[];
    selectedSeats: number[];
    missionResults: boolean[];
    lastVotes: boolean[];
    lastVotePassed: boolean;
    timeoutSec: number;
    winReason: string;
    isGoodWin: boolean | null;
    isLocalDemo: boolean;
}

export type ClientDataListener = (event: ClientDataEvent, snapshot: ClientDataSnapshot) => void;

export class AvalonClientData {
    private static _instance: AvalonClientData | null = null;

    public static get instance(): AvalonClientData {
        if (!this._instance) this._instance = new AvalonClientData();
        return this._instance;
    }

    private readonly state = AvalonGameState.instance;
    private readonly network = AvalonNetwork.instance;
    private readonly listeners = new Set<ClientDataListener>();
    private disposers: DisposeHandler[] = [];
    private started = false;

    public start(): void {
        if (this.started) return;
        this.started = true;
        this.disposers.push(this.network.onStatus((connection, message) => {
            this.emit({ type: connection === "error" ? "error" : "connection", message });
        }));
        this.register(Route.Login, (data) => {
            if (this.isError(data, Route.Login, "登录失败")) return;
            this.state.updateLogin(data);
            this.emitState(Route.Login, "登录状态已更新");
        });
        this.register(Route.JoinRoom, (data) => {
            if (this.isError(data, Route.JoinRoom, "加入房间失败")) return;
            this.state.updateRoomInfo(data);
            this.emitState(Route.JoinRoom, "已加入房间");
        });
        for (const route of [Route.RoomInfoInit, Route.PlayerJoin, Route.PlayerReady]) {
            this.register(route, (data) => {
                this.state.updateRoomInfo(data);
                this.emitState(route, "房间数据已更新");
            });
        }
        this.register(Route.GameStart, () => this.emitState(Route.GameStart, "游戏已开始"));
        this.register(Route.StageChange, (data) => {
            this.state.applyStageChange(data);
            this.emitState(Route.StageChange, "阶段已更新");
        });
        this.register(Route.IdentityPush, (data) => {
            this.state.applyIdentity(data);
            this.emitState(Route.IdentityPush, "身份信息已更新");
        });
        this.register(Route.TeamProposed, (data) => {
            this.state.applyTeamProposed(data);
            this.emitState(Route.TeamProposed, "队伍提议已更新");
        });
        this.register(Route.VoteResult, (data) => {
            this.state.applyVoteResult(data);
            this.emitState(Route.VoteResult, "投票结果已更新");
        });
        this.register(Route.MissionResult, (data) => {
            this.state.applyMissionResult(data);
            this.emitState(Route.MissionResult, "任务结果已更新");
        });
        this.register(Route.GameEnd, (data) => {
            this.state.applyGameEnd(data);
            this.emitState(Route.GameEnd, "结算数据已更新");
        });
    }

    public stop(): void {
        this.disposers.forEach((dispose) => dispose());
        this.disposers.length = 0;
        this.started = false;
    }

    public subscribe(listener: ClientDataListener): DisposeHandler {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    public snapshot(): ClientDataSnapshot {
        return {
            connection: this.network.state,
            lastMessage: this.network.lastMessage,
            serverUrl: this.state.serverUrl,
            roomId: this.state.roomId,
            myId: this.state.myId,
            nickname: this.state.nickname,
            players: this.state.players.map((player) => ({ ...player })),
            stage: this.state.stage,
            captainSeat: this.state.captainSeat,
            currentRound: this.state.currentRound,
            failedVotes: this.state.failedVotes,
            myRole: this.state.myRole,
            visibleSeats: this.state.visibleSeats.slice(),
            selectedSeats: this.state.selectedSeats.slice(),
            missionResults: this.state.missionResults.slice(),
            lastVotes: this.state.lastVotes.slice(),
            lastVotePassed: this.state.lastVotePassed,
            timeoutSec: this.state.timeoutSec,
            winReason: this.state.winReason,
            isGoodWin: this.state.isGoodWin,
            isLocalDemo: this.state.isLocalDemo,
        };
    }

    public connect(url = this.state.serverUrl || DEFAULT_SERVER_URL): void {
        const normalized = url.trim() || DEFAULT_SERVER_URL;
        this.state.serverUrl = normalized;
        this.state.isLocalDemo = false;
        this.network.connect(normalized);
    }

    public disconnect(): void { this.network.close(); }

    public login(nickname = this.state.nickname): boolean {
        this.state.nickname = nickname.trim() || "Guest";
        this.state.ensureUserId();
        this.state.isLocalDemo = false;
        return this.send(Route.Login, { userId: this.state.myId, nickname: this.state.nickname });
    }

    public joinRoom(roomId = this.state.roomId): boolean {
        this.state.roomId = roomId.trim() || DEFAULT_ROOM_ID;
        this.state.ensureUserId();
        this.state.isLocalDemo = false;
        return this.send(Route.JoinRoom, { roomId: this.state.roomId, userId: this.state.myId, nickname: this.state.nickname });
    }

    public ready(): boolean { return this.send(Route.Ready, { userId: this.state.ensureUserId() }); }

    public proposeTeam(seats: number[]): boolean {
        const selectedSeats = this.normalizeSeats(seats);
        if (!this.state.isCaptain() || selectedSeats.length !== this.state.getExpectedTeamSize()) return false;
        return this.send(Route.ProposeTeam, { userId: this.state.myId, selectedSeats });
    }

    public vote(approve: boolean): boolean {
        if (this.state.stage !== GameStage.Voting) return false;
        return this.send(Route.VoteTeam, { userId: this.state.myId, approve });
    }

    public mission(success: boolean): boolean {
        if (this.state.stage !== GameStage.Mission || !this.state.isMissionMember()) return false;
        return this.send(Route.MissionAction, { userId: this.state.myId, success });
    }

    public assassinate(targetSeat: number): boolean {
        if (this.state.stage !== GameStage.Assassinating || !this.state.getPlayerAtSeat(targetSeat)) return false;
        return this.send(Route.Assassinate, { userId: this.state.myId, targetSeat });
    }

    private register(route: Route, handler: (data: any) => void): void {
        this.disposers.push(this.network.registerHandler(route, handler));
    }

    private send(route: Route, payload: unknown): boolean {
        const sent = this.network.send(route, payload);
        if (!sent) this.emit({ type: "error", route, message: this.network.lastMessage });
        return sent;
    }

    private isError(data: any, route: Route, fallback: string): boolean {
        if (data?.code === undefined || Number(data.code) === 0) return false;
        this.emit({ type: "error", route, message: String(data.message || fallback) });
        return true;
    }

    private normalizeSeats(seats: number[]): number[] {
        return [...new Set(seats.map((seat) => Number(seat)).filter((seat) => Number.isInteger(seat) && seat >= 0 && seat < 10 && Boolean(this.state.getPlayerAtSeat(seat))))];
    }

    private emitState(route: number, message: string): void { this.emit({ type: "state", route, message }); }

    private emit(event: ClientDataEvent): void {
        const snapshot = this.snapshot();
        this.listeners.forEach((listener) => {
            try { listener(event, snapshot); } catch (error) { console.error("Avalon data listener failed", error); }
        });
    }
}
