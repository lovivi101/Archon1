import {
    aiAssassinTarget, aiExcaliburHolder, aiExcaliburTarget, aiLadyTarget, aiMissionCard, aiProposeTeam, aiSpeech, aiVote, AiView, Fact, Random,
} from "./avalon.ai";
import {
    ErrorCode, failsNeeded, GameRules, isBadRole, LadyRecord, ladyRounds, MissionRecord, Player, ProposalRecord, Role, roleSetFor, RoomError, Route,
    rulesFor, Stage, teamSizeFor,
} from "./avalon.types";

export interface RoomConfig {
    minPlayers: number;
    maxPlayers: number;
    nightMs: number;
    /** Per speaker in the Speaking stage. */
    speakMs: number;
    proposeMs: number;
    voteMs: number;
    missionMs: number;
    ladyMs: number;
    excaliburMs: number;
    assassinMs: number;
    /** How long AI (and autopilot) players wait after a stage starts before acting. */
    aiDelayMs: number;
    /** How long an AI speaker holds the floor, so humans can read along. */
    aiSpeechMs: number;
}

/** Delivers a message to one human (userId) or to every human in the room (null). */
export type RoomSend = (userId: string | null, route: Route, payload: unknown) => void;

export interface RoomOptions {
    config: RoomConfig;
    send: RoomSend;
    clock?: () => number;
    random?: Random;
    /** Seats at the table; empty seats are filled with AI when the game starts. Defaults to `minPlayers`. */
    targetPlayers?: number;
    /** Public rooms are found by quick match; private rooms only by code. */
    isPublic?: boolean;
}

export interface GameOutcome {
    isGoodWin: boolean;
    winReason: string;
    allRoles: Record<string, unknown>[];
}

export interface ChatEntry {
    seat: number;
    nickname: string;
    text: string;
    /** "all" during speeches; "evil" is the evil team's private channel during the assassination. */
    channel: "all" | "evil";
    round: number;
    time: number;
}

const aiNames = ["灰袍贤者", "北境女王", "林中旅人", "山岭铁卫", "暗影祭司", "夜鸦", "堕落骑士", "湖畔游侠", "银月守卫"];
const inGameStages = new Set([
    Stage.Night, Stage.Speaking, Stage.Proposing, Stage.Voting, Stage.Mission, Stage.Excalibur, Stage.LadyOfLake, Stage.Assassinating,
]);
const maxChatLength = 80;
const maxMessagesPerTurn = 5;
const chatHistoryLimit = 60;

/**
 * One Avalon table. Pure game state: it never touches sockets or timers. The owner calls
 * `tick()` periodically to advance timed stages, AI moves and timeouts.
 *
 * Round flow: Speaking (captain first, then clockwise) -> Proposing -> Voting -> Mission
 * [-> Excalibur] -> result [-> Lady of the Lake after rounds 2-4] -> next round's Speaking.
 * A rejected team passes the captain and goes back to Speaking.
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
    public readonly targetPlayers: number;
    public readonly isPublic: boolean;
    public rules: GameRules;
    /** Keyed by seat. */
    public readonly votes = new Map<number, boolean>();
    /** Keyed by seat. */
    public readonly missionCards = new Map<number, boolean>();

    public speechOrder: number[] = [];
    public speakerIndex = 0;
    public ladyHolder = -1;
    public ladyHistory: LadyRecord[] = [];
    public excaliburSeat = -1;
    public revealedEvil: number[] = [];

    private stageStartedAt = 0;
    private speakerMessages = 0;
    private readonly visibility = new Map<number, number[]>();
    /** Private knowledge per seat from the Lady of the Lake and Excalibur. */
    private readonly facts = new Map<number, Fact[]>();
    /** The team each AI captain announced in its speech, so its proposal matches what it said. */
    private readonly aiPlans = new Map<number, number[]>();
    private readonly chatLog: ChatEntry[] = [];
    private readonly clock: () => number;
    private readonly random: Random;

    public constructor(public readonly id: string, private readonly options: RoomOptions) {
        this.clock = options.clock ?? Date.now;
        this.random = options.random ?? Math.random;
        const target = options.targetPlayers ?? options.config.minPlayers;
        this.targetPlayers = Math.min(options.config.maxPlayers, Math.max(options.config.minPlayers, Math.floor(target)));
        this.isPublic = options.isPublic ?? false;
        this.rules = rulesFor(this.targetPlayers);
    }

    private get config(): RoomConfig {
        return this.options.config;
    }

    // ---- membership ----

    public join(userId: string, nickname: string, avatar = ""): void {
        const existing = this.find(userId);
        if (existing && !existing.isAi) {
            existing.nickname = nickname;
            existing.avatar = avatar;
            existing.isOnline = true;
            existing.autopilot = false;
            return;
        }
        if (this.stage === Stage.End) this.reset();
        if (this.stage !== Stage.Preparing) throw new RoomError(ErrorCode.Conflict, "游戏已经开始");
        if (this.players.length >= this.targetPlayers) throw new RoomError(ErrorCode.Conflict, "房间已满");
        this.players.push({
            userId, nickname, avatar, isReady: false, seatIndex: this.players.length,
            role: Role.Unknown, isAi: false, isOnline: true, autopilot: false,
        });
    }

    public hasFreeSeat(): boolean {
        return this.stage === Stage.Preparing && this.players.length < this.targetPlayers;
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

    // ---- speaking ----

    public chat(userId: string, text: unknown): void {
        const player = this.requireMember(userId, true);
        const message = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
        if (!message) throw new RoomError(ErrorCode.BadRequest, "发言内容不能为空");
        if (message.length > maxChatLength) throw new RoomError(ErrorCode.BadRequest, `每条发言最多 ${maxChatLength} 个字`);
        if (this.stage === Stage.Speaking) {
            if (player.seatIndex !== this.currentSpeaker()) throw new RoomError(ErrorCode.Forbidden, "还没轮到你发言");
            if (this.speakerMessages >= maxMessagesPerTurn) throw new RoomError(ErrorCode.Conflict, `每轮最多发送 ${maxMessagesPerTurn} 条`);
            this.speakerMessages += 1;
            this.postChat(player, message, "all");
            return;
        }
        if (this.stage === Stage.Assassinating) {
            if (!isBadRole(player.role)) throw new RoomError(ErrorCode.Forbidden, "刺杀阶段只有坏人可以商议");
            this.postChat(player, message, "evil");
            return;
        }
        throw new RoomError(ErrorCode.Conflict, "现在不是发言时间");
    }

    public endSpeech(userId: string): void {
        const player = this.requireMember(userId, true);
        if (this.stage !== Stage.Speaking) throw new RoomError(ErrorCode.Conflict, "当前不是发言阶段");
        if (player.seatIndex !== this.currentSpeaker()) throw new RoomError(ErrorCode.Forbidden, "还没轮到你发言");
        this.nextSpeaker();
    }

    /** Messages this player may see, oldest first (for reconnects). */
    public chatFor(userId: string): ChatEntry[] {
        const player = this.find(userId);
        const evil = Boolean(player && isBadRole(player.role));
        return this.chatLog.filter((entry) => entry.channel === "all" || evil);
    }

    public currentSpeaker(): number {
        return this.stage === Stage.Speaking ? (this.speechOrder[this.speakerIndex] ?? -1) : -1;
    }

    // ---- game actions ----

    public propose(userId: string, selectedSeats: unknown, excaliburSeat?: unknown): void {
        const player = this.requireMember(userId, true);
        if (this.stage !== Stage.Proposing) throw new RoomError(ErrorCode.Conflict, "当前不是组队阶段");
        if (player.seatIndex !== this.captainIdx) throw new RoomError(ErrorCode.Forbidden, "只有队长可以组队");
        const size = this.teamSize();
        const seats = Array.isArray(selectedSeats) ? selectedSeats : [];
        const valid = seats.length === size
            && seats.every((seat) => Number.isInteger(seat) && seat >= 0 && seat < this.players.length)
            && new Set(seats).size === seats.length;
        if (!valid) throw new RoomError(ErrorCode.BadRequest, `需要选择 ${size} 名不重复的队员`);
        let holder = -1;
        if (this.rules.excalibur) {
            holder = Number(excaliburSeat);
            if (!Number.isInteger(holder) || !seats.includes(holder) || holder === this.captainIdx) {
                throw new RoomError(ErrorCode.BadRequest, "请把王者之剑交给队伍中除队长以外的一名队员");
            }
        }
        this.selectedSeats = seats.slice() as number[];
        this.excaliburSeat = holder;
        this.votes.clear();
        this.broadcast(Route.TeamProposed, { captainSeat: this.captainIdx, selectedSeats: this.selectedSeats.slice(), excaliburSeat: holder });
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
        this.excaliburSeat = -1;
        this.beginSpeaking();
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
        if (this.rules.excalibur && this.excaliburSeat >= 0) {
            this.enterStage(Stage.Excalibur);
            return;
        }
        this.resolveMission();
    }

    /** targetSeat -1 keeps every card as played. */
    public useExcalibur(userId: string, targetSeat: unknown): void {
        const player = this.requireMember(userId, true);
        if (this.stage !== Stage.Excalibur) throw new RoomError(ErrorCode.Conflict, "当前不是王者之剑阶段");
        if (player.seatIndex !== this.excaliburSeat) throw new RoomError(ErrorCode.Forbidden, "只有王者之剑持有者可以使用");
        const target = Number(targetSeat);
        if (target !== -1 && (!Number.isInteger(target) || !this.selectedSeats.includes(target) || target === player.seatIndex)) {
            throw new RoomError(ErrorCode.BadRequest, "只能对其他任务队员使用王者之剑");
        }
        if (target >= 0) {
            const original = this.missionCards.get(target) === true;
            this.missionCards.set(target, !original);
            this.options.send(player.userId, Route.ExcaliburResult, { targetSeat: target, originalSuccess: original });
            if (!original) this.learn(player.seatIndex, { seat: target, isGood: false });
        }
        this.broadcast(Route.ExcaliburUsed, { holderSeat: player.seatIndex, targetSeat: target });
        this.resolveMission({ holderSeat: player.seatIndex, targetSeat: target });
    }

    public ladyCheck(userId: string, targetSeat: unknown): void {
        const player = this.requireMember(userId, true);
        if (this.stage !== Stage.LadyOfLake) throw new RoomError(ErrorCode.Conflict, "当前不是湖中仙女阶段");
        if (player.seatIndex !== this.ladyHolder) throw new RoomError(ErrorCode.Forbidden, "只有湖中仙女持有者可以查验");
        const target = Number(targetSeat);
        if (!this.ladyEligible().includes(target)) throw new RoomError(ErrorCode.BadRequest, "不能查验自己或曾经持有湖中仙女的玩家");
        const isGood = !isBadRole(this.players[target].role);
        this.options.send(player.userId, Route.LadyResult, { targetSeat: target, isGood });
        this.learn(player.seatIndex, { seat: target, isGood });
        this.ladyHistory.push({ round: this.round, holderSeat: player.seatIndex, targetSeat: target });
        this.ladyHolder = target;
        this.broadcast(Route.LadyUsed, { holderSeat: player.seatIndex, targetSeat: target, round: this.round });
        this.nextRound();
    }

    /** Seats the Lady holder may check: anyone except itself and earlier holders. */
    public ladyEligible(): number[] {
        const earlier = new Set([this.initialLadyHolder(), ...this.ladyHistory.map((record) => record.targetSeat)]);
        return this.players.map((player) => player.seatIndex).filter((seat) => seat !== this.ladyHolder && !earlier.has(seat));
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
            if (now >= this.deadline) this.beginSpeaking();
            return;
        }
        if (!this.isInGame()) return;
        const stage = this.stage;
        const expired = now >= this.deadline;
        const elapsed = now - this.stageStartedAt;
        for (const player of this.pendingActors()) {
            const automated = player.isAi || player.autopilot;
            const aiReady = elapsed >= (stage === Stage.Speaking && player.isAi ? this.config.aiSpeechMs : this.config.aiDelayMs);
            if (!expired && !(automated && aiReady)) continue;
            this.autoAct(player);
            // A speech turn or stage change moves on to a new actor; handle it on the next tick.
            if (this.stage !== stage || stage === Stage.Speaking) return;
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
            targetPlayers: this.targetPlayers,
            isPublic: this.isPublic,
            rules: { ...this.rules },
            roleSet: roleSetFor(this.stage === Stage.Preparing ? this.targetPlayers : this.players.length),
            ...this.progress(),
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
            ...this.progress(),
        };
    }

    /** Role, night visibility and private facts learned so far (Lady checks, cards seen with Excalibur). */
    public identity(userId: string): { role: Role; visibleSeats: number[]; facts: Fact[] } {
        const player = this.find(userId);
        if (!player) return { role: Role.Unknown, visibleSeats: [], facts: [] };
        return { role: player.role, visibleSeats: this.visibility.get(player.seatIndex) ?? [], facts: (this.facts.get(player.seatIndex) ?? []).slice() };
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

    private progress(): Record<string, unknown> {
        return {
            speakerSeat: this.currentSpeaker(),
            speechOrder: this.stage === Stage.Speaking ? this.speechOrder.slice() : [],
            ladyHolder: this.ladyHolder,
            ladyHistory: this.ladyHistory.map((record) => ({ ...record })),
            ladyEligible: this.stage === Stage.LadyOfLake ? this.ladyEligible() : [],
            excaliburSeat: this.excaliburSeat,
            revealedEvil: this.revealedEvil.slice(),
        };
    }

    private startGame(): void {
        for (let index = 0; this.players.length < this.targetPlayers; index += 1) {
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
        this.rules = rulesFor(this.players.length);
        this.clearGameState();
        this.captainIdx = Math.floor(this.random() * this.players.length);
        // The Lady of the Lake starts with the player to the first captain's right.
        this.ladyHolder = this.rules.lady ? (this.captainIdx - 1 + this.players.length) % this.players.length : -1;
        for (const player of this.players) this.visibility.set(player.seatIndex, this.visibleSeats(player));

        this.broadcast(Route.GameStart, { roomId: this.id });
        for (const player of this.players.filter((item) => !item.isAi)) {
            this.options.send(player.userId, Route.IdentityPush, this.identity(player.userId));
        }
        this.enterStage(Stage.Night);
    }

    private clearGameState(): void {
        this.round = 1;
        this.failedVotes = 0;
        this.captainIdx = 0;
        this.selectedSeats = [];
        this.missionResults = [];
        this.proposals = [];
        this.missions = [];
        this.votes.clear();
        this.missionCards.clear();
        this.outcome = null;
        this.visibility.clear();
        this.facts.clear();
        this.aiPlans.clear();
        this.chatLog.length = 0;
        this.speechOrder = [];
        this.speakerIndex = 0;
        this.ladyHolder = -1;
        this.ladyHistory = [];
        this.excaliburSeat = -1;
        this.revealedEvil = [];
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
        this.clearGameState();
        this.rules = rulesFor(this.targetPlayers);
        this.deadline = 0;
        this.broadcastRoom(Route.RoomInfoInit);
        this.broadcast(Route.StageChange, this.stagePayload());
    }

    private enterStage(stage: Stage): void {
        const durations: Partial<Record<Stage, number>> = {
            [Stage.Night]: this.config.nightMs,
            [Stage.Speaking]: this.config.speakMs,
            [Stage.Proposing]: this.config.proposeMs,
            [Stage.Voting]: this.config.voteMs,
            [Stage.Mission]: this.config.missionMs,
            [Stage.Excalibur]: this.config.excaliburMs,
            [Stage.LadyOfLake]: this.config.ladyMs,
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

    /** Captain speaks first, then everyone else clockwise. */
    private beginSpeaking(): void {
        const count = this.players.length;
        this.speechOrder = Array.from({ length: count }, (_, offset) => (this.captainIdx + offset) % count);
        this.speakerIndex = 0;
        this.speakerMessages = 0;
        this.aiPlans.clear();
        this.enterStage(Stage.Speaking);
        this.announceSpeaker();
    }

    private nextSpeaker(): void {
        this.speakerIndex += 1;
        this.speakerMessages = 0;
        if (this.speakerIndex >= this.speechOrder.length) {
            this.enterStage(Stage.Proposing);
            return;
        }
        const now = this.clock();
        this.stageStartedAt = now;
        this.deadline = now + this.config.speakMs;
        this.announceSpeaker();
    }

    private announceSpeaker(): void {
        const remaining = Math.max(0, Math.ceil((this.deadline - this.clock()) / 1000));
        this.broadcast(Route.SpeakerChange, {
            speakerSeat: this.currentSpeaker(), speakerIndex: this.speakerIndex, speechOrder: this.speechOrder.slice(),
            timeout: remaining, deadline: this.deadline,
        });
    }

    private postChat(player: Player, text: string, channel: "all" | "evil"): void {
        const entry: ChatEntry = { seat: player.seatIndex, nickname: player.nickname, text, channel, round: this.round, time: this.clock() };
        this.chatLog.push(entry);
        if (this.chatLog.length > chatHistoryLimit) this.chatLog.shift();
        if (channel === "all") {
            this.broadcast(Route.ChatMessage, entry);
            return;
        }
        for (const member of this.players.filter((item) => !item.isAi && isBadRole(item.role))) {
            this.options.send(member.userId, Route.ChatMessage, entry);
        }
    }

    private resolveMission(excalibur?: { holderSeat: number; targetSeat: number }): void {
        const failCount = [...this.missionCards.values()].filter((card) => !card).length;
        const isSuccess = failCount < failsNeeded(this.players.length, this.round);
        this.missionResults.push(isSuccess);
        this.missions.push({ round: this.round, team: this.selectedSeats.slice(), failCount, success: isSuccess, excalibur });
        this.broadcast(Route.MissionResult, { isSuccess, failCount, round: this.round });
        const goodWins = this.missionResults.filter(Boolean).length;
        const badWins = this.missionResults.length - goodWins;
        if (badWins >= 3) {
            this.finish(false, "三次任务失败，坏人胜利");
        } else if (goodWins >= 3) {
            // Evil players reveal themselves to everyone before the assassin chooses.
            this.revealedEvil = this.players.filter((player) => isBadRole(player.role)).map((player) => player.seatIndex);
            this.broadcast(Route.EvilRevealed, { evilSeats: this.revealedEvil.slice() });
            this.enterStage(Stage.Assassinating);
        } else if (this.rules.lady && ladyRounds.has(this.round) && this.ladyEligible().length > 0) {
            this.enterStage(Stage.LadyOfLake);
        } else {
            this.nextRound();
        }
    }

    private nextRound(): void {
        this.round += 1;
        this.passCaptain();
        this.excaliburSeat = -1;
        this.beginSpeaking();
    }

    private initialLadyHolder(): number {
        return this.ladyHistory.length > 0 ? this.ladyHistory[0].holderSeat : this.ladyHolder;
    }

    private learn(seat: number, fact: Fact): void {
        const known = this.facts.get(seat) ?? [];
        if (!known.some((item) => item.seat === fact.seat)) known.push(fact);
        this.facts.set(seat, known);
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
            case Stage.Speaking:
                return this.currentSpeaker() >= 0 ? [this.players[this.currentSpeaker()]] : [];
            case Stage.Proposing:
                return [this.players[this.captainIdx]];
            case Stage.Voting:
                return this.players.filter((player) => !this.votes.has(player.seatIndex));
            case Stage.Mission:
                return this.selectedSeats.map((seat) => this.players[seat]).filter((player) => !this.missionCards.has(player.seatIndex));
            case Stage.Excalibur:
                return this.excaliburSeat >= 0 ? [this.players[this.excaliburSeat]] : [];
            case Stage.LadyOfLake:
                return this.ladyHolder >= 0 ? [this.players[this.ladyHolder]] : [];
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

    private viewFor(player: Player): AiView {
        // Evil players reveal themselves before the assassination, so the assassin then knows every evil seat (Oberon included).
        const visibleSeats = this.stage === Stage.Assassinating
            ? this.revealedEvil.filter((seat) => seat !== player.seatIndex)
            : (this.visibility.get(player.seatIndex) ?? []);
        return {
            seat: player.seatIndex,
            role: player.role,
            visibleSeats,
            playerCount: this.players.length,
            round: this.round,
            failedVotes: this.failedVotes,
            proposals: this.proposals,
            missions: this.missions,
            facts: this.facts.get(player.seatIndex) ?? [],
        };
    }

    private aiAct(player: Player): void {
        const view = this.viewFor(player);
        switch (this.stage) {
            case Stage.Speaking: {
                // Humans who run out of time simply lose their turn; the AI never talks on their behalf.
                if (player.isAi) {
                    const isCaptain = player.seatIndex === this.captainIdx;
                    const plan = isCaptain ? aiProposeTeam(view, this.teamSize(), this.random) : undefined;
                    if (plan) this.aiPlans.set(player.seatIndex, plan);
                    const lastCheck = this.ladyHistory.at(-1);
                    const ladyCheck = lastCheck && lastCheck.holderSeat === player.seatIndex && lastCheck.round === this.round - 1
                        ? view.facts.find((fact) => fact.seat === lastCheck.targetSeat) : undefined;
                    this.chat(player.userId, aiSpeech(view, { isCaptain, plan, ladyCheck }, this.random));
                }
                this.nextSpeaker();
                break;
            }
            case Stage.Proposing: {
                const team = this.aiPlans.get(player.seatIndex) ?? aiProposeTeam(view, this.teamSize(), this.random);
                const holder = this.rules.excalibur ? aiExcaliburHolder(view, team, this.random) : -1;
                this.propose(player.userId, team, holder);
                break;
            }
            case Stage.Voting:
                this.vote(player.userId, aiVote(view, this.selectedSeats, this.random));
                break;
            case Stage.Mission:
                this.mission(player.userId, aiMissionCard(view, this.selectedSeats, this.random));
                break;
            case Stage.Excalibur:
                this.useExcalibur(player.userId, aiExcaliburTarget(view, this.selectedSeats, this.missionCards.get(player.seatIndex) === true, this.random));
                break;
            case Stage.LadyOfLake:
                this.ladyCheck(player.userId, aiLadyTarget(view, this.ladyEligible(), this.random));
                break;
            case Stage.Assassinating: {
                const target = aiAssassinTarget(view, this.random);
                if (player.isAi) this.chat(player.userId, `我觉得${target + 1}号最像梅林，准备刺杀他。`);
                this.assassinate(player.userId, target);
                break;
            }
            default:
                break;
        }
    }

    private fallbackAct(player: Player): void {
        switch (this.stage) {
            case Stage.Speaking:
                this.nextSpeaker();
                break;
            case Stage.Proposing: {
                const team = this.players.slice(0, this.teamSize()).map((item) => item.seatIndex);
                this.propose(player.userId, team, team.find((seat) => seat !== this.captainIdx));
                break;
            }
            case Stage.Voting:
                this.vote(player.userId, true);
                break;
            case Stage.Mission:
                this.mission(player.userId, true);
                break;
            case Stage.Excalibur:
                this.useExcalibur(player.userId, -1);
                break;
            case Stage.LadyOfLake:
                this.ladyCheck(player.userId, this.ladyEligible()[0]);
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
