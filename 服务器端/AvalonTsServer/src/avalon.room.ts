import { aiAssassinTarget, aiMissionCard, aiProposeTeam, aiVote, AiView, Random } from "./avalon.ai";
import {
    ErrorCode, failsNeeded, isBadRole, MissionRecord, Player, ProposalRecord, Role, roleSetFor, RoomError, Route, Stage, teamSizeFor,
} from "./avalon.types";

export interface RoomConfig {
    minPlayers: number;
    maxPlayers: number;
    nightMs: number;
    proposeMs: number;
    voteMs: number;
    missionMs: number;
    assassinMs: number;
    /** How long AI (and autopilot) players wait after a stage starts before acting. */
    aiDelayMs: number;
}

/** Delivers a message to one human (userId) or to every human in the room (null). */
export type RoomSend = (userId: string | null, route: Route, payload: unknown) => void;

export interface RoomOptions {
    config: RoomConfig;
    send: RoomSend;
    clock?: () => number;
    random?: Random;
}

export interface GameOutcome {
    isGoodWin: boolean;
    winReason: string;
    allRoles: Record<string, unknown>[];
}

const aiNames = ["灰袍贤者", "北境女王", "林中旅人", "山岭铁卫", "暗影祭司", "夜鸦", "堕落骑士", "湖畔游侠", "银月守卫"];
const inGameStages = new Set([Stage.Night, Stage.Proposing, Stage.Voting, Stage.Mission, Stage.Assassinating]);

/**
 * One Avalon table. Pure game state: it never touches sockets or timers. The owner calls
 * `tick()` periodically to advance timed stages, AI moves and timeouts.
 */
export class AvalonRoom {
    public players: Player[] = [];
    public stage = Stage.Preparing;
    public captainIdx = 0;
    public round = 1;
    public failedVotes = 0;
    public selectedSeats: number[] = [];
    public missionResults: boolean[] = [];
    public proposals: ProposalRecord[] = [];
    public missions: MissionRecord[] = [];
    public deadline = 0;
    public outcome: GameOutcome | null = null;
    /** Keyed by seat. */
    public readonly votes = new Map<number, boolean>();
    /** Keyed by seat. */
    public readonly missionCards = new Map<number, boolean>();

    private stageStartedAt = 0;
    private readonly visibility = new Map<number, number[]>();
    private readonly clock: () => number;
    private readonly random: Random;

    public constructor(public readonly id: string, private readonly options: RoomOptions) {
        this.clock = options.clock ?? Date.now;
        this.random = options.random ?? Math.random;
    }

    private get config(): RoomConfig {
        return this.options.config;
    }

    // ---- membership ----

    public join(userId: string, nickname: string): void {
        const existing = this.find(userId);
        if (existing && !existing.isAi) {
            existing.nickname = nickname;
            existing.isOnline = true;
            existing.autopilot = false;
            return;
        }
        if (this.stage === Stage.End) this.reset();
        if (this.stage !== Stage.Preparing) throw new RoomError(ErrorCode.Conflict, "游戏已经开始");
        if (this.players.length >= this.config.maxPlayers) throw new RoomError(ErrorCode.Conflict, "房间已满");
        this.players.push({
            userId, nickname, avatar: "", isReady: false, seatIndex: this.players.length,
            role: Role.Unknown, isAi: false, isOnline: true, autopilot: false,
        });
    }

    /** Explicit leave: frees the seat before the game, hands it to autopilot during the game. */
    public leave(userId: string): void {
        const player = this.find(userId);
        if (!player || player.isAi) return;
        if (this.stage === Stage.Preparing) {
            this.remove(player);
            return;
        }
        player.isOnline = false;
        player.autopilot = true;
        if (this.isInGame()) this.broadcastRoom(Route.RoomInfoInit);
    }

    /** Connection lost: frees the seat before the game; during the game the seat waits for a reconnect and timeouts. */
    public setOffline(userId: string): void {
        const player = this.find(userId);
        if (!player || player.isAi) return;
        if (this.stage === Stage.Preparing) {
            this.remove(player);
            return;
        }
        player.isOnline = false;
        if (this.isInGame()) this.broadcastRoom(Route.RoomInfoInit);
    }

    public ready(userId: string, ready: boolean): void {
        if (this.stage === Stage.End) {
            this.requireMember(userId);
            this.reset();
        }
        const player = this.requireMember(userId);
        if (this.stage !== Stage.Preparing) throw new RoomError(ErrorCode.Conflict, "游戏已经开始");
        player.isReady = ready;
        if (!this.startIfAllReady()) this.broadcastRoom(Route.PlayerReady);
    }

    // ---- game actions ----

    public propose(userId: string, selectedSeats: unknown): void {
        const player = this.requireMember(userId, true);
        if (this.stage !== Stage.Proposing) throw new RoomError(ErrorCode.Conflict, "当前不是组队阶段");
        if (player.seatIndex !== this.captainIdx) throw new RoomError(ErrorCode.Forbidden, "只有队长可以组队");
        const size = this.teamSize();
        const seats = Array.isArray(selectedSeats) ? selectedSeats : [];
        const valid = seats.length === size
            && seats.every((seat) => Number.isInteger(seat) && seat >= 0 && seat < this.players.length)
            && new Set(seats).size === seats.length;
        if (!valid) throw new RoomError(ErrorCode.BadRequest, `需要选择 ${size} 名不重复的队员`);
        this.selectedSeats = seats.slice() as number[];
        this.votes.clear();
        this.broadcast(Route.TeamProposed, { captainSeat: this.captainIdx, selectedSeats: this.selectedSeats.slice() });
        this.enterStage(Stage.Voting);
    }

    public vote(userId: string, approve: unknown): void {
        const player = this.requireMember(userId, true);
        if (this.stage !== Stage.Voting) throw new RoomError(ErrorCode.Conflict, "当前不是投票阶段");
        if (typeof approve !== "boolean") throw new RoomError(ErrorCode.BadRequest, "approve 必须是布尔值");
        if (this.votes.has(player.seatIndex)) throw new RoomError(ErrorCode.Conflict, "你已经投过票");
        this.votes.set(player.seatIndex, approve);
        if (this.votes.size < this.players.length) return;

        const votes = this.players.map((item) => this.votes.get(item.seatIndex) === true);
        const passed = votes.filter(Boolean).length > this.players.length / 2;
        this.proposals.push({ round: this.round, captainSeat: this.captainIdx, team: this.selectedSeats.slice(), votes, passed });
        this.broadcast(Route.VoteResult, { votes, isPassed: passed });
        if (passed) {
            this.failedVotes = 0;
            this.missionCards.clear();
            this.enterStage(Stage.Mission);
            return;
        }
        this.failedVotes += 1;
        if (this.failedVotes >= 5) {
            this.finish(false, "连续 5 次组队被否决，坏人胜利");
            return;
        }
        this.passCaptain();
        this.enterStage(Stage.Proposing);
    }

    public mission(userId: string, success: unknown): void {
        const player = this.requireMember(userId, true);
        if (this.stage !== Stage.Mission) throw new RoomError(ErrorCode.Conflict, "当前不是任务阶段");
        if (typeof success !== "boolean") throw new RoomError(ErrorCode.BadRequest, "success 必须是布尔值");
        if (!this.selectedSeats.includes(player.seatIndex)) throw new RoomError(ErrorCode.Forbidden, "你不在任务队伍中");
        if (this.missionCards.has(player.seatIndex)) throw new RoomError(ErrorCode.Conflict, "你已经提交过任务牌");
        if (!success && !isBadRole(player.role)) throw new RoomError(ErrorCode.Forbidden, "好人只能提交任务成功");
        this.missionCards.set(player.seatIndex, success);
        if (this.missionCards.size < this.selectedSeats.length) return;

        const failCount = [...this.missionCards.values()].filter((card) => !card).length;
        const isSuccess = failCount < failsNeeded(this.players.length, this.round);
        this.missionResults.push(isSuccess);
        this.missions.push({ round: this.round, team: this.selectedSeats.slice(), failCount, success: isSuccess });
        this.broadcast(Route.MissionResult, { isSuccess, failCount, round: this.round });
        const goodWins = this.missionResults.filter(Boolean).length;
        const badWins = this.missionResults.length - goodWins;
        if (badWins >= 3) {
            this.finish(false, "三次任务失败，坏人胜利");
        } else if (goodWins >= 3) {
            this.enterStage(Stage.Assassinating);
        } else {
            this.round += 1;
            this.passCaptain();
            this.enterStage(Stage.Proposing);
        }
    }

    public assassinate(userId: string, targetSeat: unknown): void {
        const player = this.requireMember(userId, true);
        if (this.stage !== Stage.Assassinating) throw new RoomError(ErrorCode.Conflict, "当前不是刺杀阶段");
        if (player.role !== Role.Assassin) throw new RoomError(ErrorCode.Forbidden, "只有刺客可以刺杀");
        const seat = Number(targetSeat);
        const target = Number.isInteger(seat) ? this.players[seat] : undefined;
        if (!target || isBadRole(target.role)) throw new RoomError(ErrorCode.BadRequest, "只能刺杀好人阵营玩家");
        const merlinKilled = target.role === Role.Merlin;
        this.finish(!merlinKilled, `刺客选择了 ${target.nickname}，${merlinKilled ? "梅林被刺杀，坏人胜利" : "梅林存活，好人胜利"}`);
    }

    /** Advances timed stages, lets AI/autopilot seats act, and plays for humans whose time ran out. */
    public tick(): void {
        const now = this.clock();
        if (this.stage === Stage.Night) {
            if (now >= this.deadline) this.enterStage(Stage.Proposing);
            return;
        }
        if (!this.isInGame()) return;
        const stage = this.stage;
        const expired = now >= this.deadline;
        const aiReady = now - this.stageStartedAt >= this.config.aiDelayMs;
        for (const player of this.pendingActors()) {
            if (!expired && !(aiReady && (player.isAi || player.autopilot))) continue;
            this.autoAct(player);
            if (this.stage !== stage) return;
        }
    }

    // ---- views ----

    public snapshot(): Record<string, unknown> {
        return {
            roomId: this.id,
            players: this.players.map((player) => this.publicPlayer(player, false)),
            stage: this.stage,
            captainIdx: this.captainIdx,
            round: this.round,
            failedVotes: this.failedVotes,
            selectedSeats: this.selectedSeats.slice(),
            missionResults: this.missionResults.slice(),
            deadline: this.deadline,
        };
    }

    /** StageChange payload: carries the full public progress so clients never have to infer it. */
    public stagePayload(): Record<string, unknown> {
        const remaining = this.deadline > 0 ? Math.max(0, Math.ceil((this.deadline - this.clock()) / 1000)) : 0;
        return {
            stage: this.stage,
            timeout: remaining,
            deadline: this.deadline,
            captainIdx: this.captainIdx,
            round: this.round,
            failedVotes: this.failedVotes,
            selectedSeats: this.selectedSeats.slice(),
            missionResults: this.missionResults.slice(),
        };
    }

    public identity(userId: string): { role: Role; visibleSeats: number[] } {
        const player = this.find(userId);
        return { role: player?.role ?? Role.Unknown, visibleSeats: player ? (this.visibility.get(player.seatIndex) ?? []) : [] };
    }

    /** Seats revealed to this player at night. */
    public visibleSeats(player: Player): number[] {
        const others = this.players.filter((item) => item.seatIndex !== player.seatIndex);
        let seen: Player[] = [];
        if (player.role === Role.Merlin) {
            seen = others.filter((item) => isBadRole(item.role) && item.role !== Role.Mordred);
        } else if (player.role === Role.Percival) {
            seen = others.filter((item) => item.role === Role.Merlin || item.role === Role.Morgana);
        } else if (isBadRole(player.role) && player.role !== Role.Oberon) {
            seen = others.filter((item) => isBadRole(item.role) && item.role !== Role.Oberon);
        }
        return seen.map((item) => item.seatIndex);
    }

    public teamSize(): number {
        return teamSizeFor(this.players.length, this.round);
    }

    public isInGame(): boolean {
        return inGameStages.has(this.stage);
    }

    public hasMember(userId: string): boolean {
        return this.find(userId) !== undefined;
    }

    public onlineHumanCount(): number {
        return this.players.filter((player) => !player.isAi && player.isOnline).length;
    }

    public broadcastRoom(route: Route): void {
        this.broadcast(route, { room: this.snapshot() });
    }

    // ---- internals ----

    private startGame(): void {
        for (let index = 0; this.players.length < this.config.minPlayers; index += 1) {
            this.players.push({
                userId: `ai-${this.id}-${index + 1}`, nickname: `AI_${aiNames[index % aiNames.length]}`, avatar: "",
                isReady: true, seatIndex: this.players.length, role: Role.Unknown, isAi: true, isOnline: true, autopilot: false,
            });
        }
        const roles = roleSetFor(this.players.length);
        for (let index = roles.length - 1; index > 0; index -= 1) {
            const other = Math.floor(this.random() * (index + 1));
            [roles[index], roles[other]] = [roles[other], roles[index]];
        }
        this.players.forEach((player, index) => {
            player.role = roles[index];
            player.isReady = true;
        });
        this.round = 1;
        this.failedVotes = 0;
        this.captainIdx = Math.floor(this.random() * this.players.length);
        this.selectedSeats = [];
        this.missionResults = [];
        this.proposals = [];
        this.missions = [];
        this.votes.clear();
        this.missionCards.clear();
        this.outcome = null;
        this.visibility.clear();
        for (const player of this.players) this.visibility.set(player.seatIndex, this.visibleSeats(player));

        this.broadcast(Route.GameStart, { roomId: this.id });
        for (const player of this.players.filter((item) => !item.isAi)) {
            this.options.send(player.userId, Route.IdentityPush, this.identity(player.userId));
        }
        this.enterStage(Stage.Night);
    }

    /** Back to a fresh lobby after a finished game: AI and departed humans are dropped, everyone must ready again. */
    private reset(): void {
        this.players = this.players.filter((player) => !player.isAi && player.isOnline && !player.autopilot);
        this.players.forEach((player, index) => {
            player.seatIndex = index;
            player.role = Role.Unknown;
            player.isReady = false;
        });
        this.stage = Stage.Preparing;
        this.round = 1;
        this.failedVotes = 0;
        this.captainIdx = 0;
        this.selectedSeats = [];
        this.missionResults = [];
        this.proposals = [];
        this.missions = [];
        this.votes.clear();
        this.missionCards.clear();
        this.deadline = 0;
        this.outcome = null;
        this.visibility.clear();
        this.broadcastRoom(Route.RoomInfoInit);
        this.broadcast(Route.StageChange, this.stagePayload());
    }

    private enterStage(stage: Stage): void {
        const durations: Partial<Record<Stage, number>> = {
            [Stage.Night]: this.config.nightMs,
            [Stage.Proposing]: this.config.proposeMs,
            [Stage.Voting]: this.config.voteMs,
            [Stage.Mission]: this.config.missionMs,
            [Stage.Assassinating]: this.config.assassinMs,
        };
        const now = this.clock();
        this.stage = stage;
        this.stageStartedAt = now;
        this.deadline = now + (durations[stage] ?? 0);
        if (stage === Stage.Proposing) this.selectedSeats = [];
        this.broadcastRoom(Route.RoomInfoInit);
        this.broadcast(Route.StageChange, this.stagePayload());
    }

    private finish(isGoodWin: boolean, winReason: string): void {
        this.stage = Stage.End;
        this.deadline = 0;
        this.outcome = { isGoodWin, winReason, allRoles: this.players.map((player) => this.publicPlayer(player, true)) };
        this.broadcast(Route.GameEnd, this.outcome);
    }

    private passCaptain(): void {
        this.captainIdx = (this.captainIdx + 1) % this.players.length;
    }

    private pendingActors(): Player[] {
        switch (this.stage) {
            case Stage.Proposing:
                return [this.players[this.captainIdx]];
            case Stage.Voting:
                return this.players.filter((player) => !this.votes.has(player.seatIndex));
            case Stage.Mission:
                return this.selectedSeats.map((seat) => this.players[seat]).filter((player) => !this.missionCards.has(player.seatIndex));
            case Stage.Assassinating:
                return this.players.filter((player) => player.role === Role.Assassin);
            default:
                return [];
        }
    }

    /** Plays for an AI, autopilot or timed-out seat. An invalid AI move falls back to a safe default so a room can never stall. */
    private autoAct(player: Player): void {
        try {
            this.aiAct(player);
        } catch (error) {
            if (!(error instanceof RoomError)) throw error;
            this.fallbackAct(player);
        }
    }

    private aiAct(player: Player): void {
        // Evil players reveal themselves before the assassination, so the assassin then knows every evil seat (Oberon included).
        const visibleSeats = this.stage === Stage.Assassinating
            ? this.players.filter((item) => isBadRole(item.role) && item !== player).map((item) => item.seatIndex)
            : (this.visibility.get(player.seatIndex) ?? []);
        const view: AiView = {
            seat: player.seatIndex,
            role: player.role,
            visibleSeats,
            playerCount: this.players.length,
            round: this.round,
            failedVotes: this.failedVotes,
            proposals: this.proposals,
            missions: this.missions,
        };
        switch (this.stage) {
            case Stage.Proposing:
                this.propose(player.userId, aiProposeTeam(view, this.teamSize(), this.random));
                break;
            case Stage.Voting:
                this.vote(player.userId, aiVote(view, this.selectedSeats, this.random));
                break;
            case Stage.Mission:
                this.mission(player.userId, aiMissionCard(view, this.selectedSeats, this.random));
                break;
            case Stage.Assassinating:
                this.assassinate(player.userId, aiAssassinTarget(view, this.random));
                break;
            default:
                break;
        }
    }

    private fallbackAct(player: Player): void {
        switch (this.stage) {
            case Stage.Proposing:
                this.propose(player.userId, this.players.slice(0, this.teamSize()).map((item) => item.seatIndex));
                break;
            case Stage.Voting:
                this.vote(player.userId, true);
                break;
            case Stage.Mission:
                this.mission(player.userId, true);
                break;
            case Stage.Assassinating: {
                const target = this.players.find((item) => !isBadRole(item.role));
                if (target) this.assassinate(player.userId, target.seatIndex);
                break;
            }
            default:
                break;
        }
    }

    private remove(player: Player): void {
        this.players = this.players.filter((item) => item !== player);
        this.players.forEach((item, index) => {
            item.seatIndex = index;
        });
        if (!this.startIfAllReady()) this.broadcastRoom(Route.RoomInfoInit);
    }

    private startIfAllReady(): boolean {
        const humans = this.players.filter((player) => !player.isAi);
        if (humans.length === 0 || !humans.every((player) => player.isReady)) return false;
        this.startGame();
        return true;
    }

    /** `allowAi` lets the server's own auto-actions pass through the same validation as human input. */
    private requireMember(userId: string, allowAi = false): Player {
        const player = this.find(userId);
        if (!player || (player.isAi && !allowAi)) throw new RoomError(ErrorCode.NotFound, "你不在该房间中");
        return player;
    }

    private find(userId: string): Player | undefined {
        return this.players.find((player) => player.userId === userId);
    }

    private publicPlayer(player: Player, revealRole: boolean): Record<string, unknown> {
        return {
            userId: player.userId,
            nickname: player.nickname,
            avatar: player.avatar,
            isReady: player.isReady,
            seatIndex: player.seatIndex,
            role: revealRole ? player.role : Role.Unknown,
            isAi: player.isAi,
            isOnline: player.isAi || player.isOnline,
        };
    }

    private broadcast(route: Route, payload: unknown): void {
        this.options.send(null, route, payload);
    }
}
