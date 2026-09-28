import { GameEndInfo, GameStage, MissionResultInfo, missionTeamSize, PlayerInfo, Role, VoteResultInfo } from "./AvalonGameTypes";

function asString(value: unknown, fallback = ""): string {
    if (value === undefined || value === null) {
        return fallback;
    }

    return String(value);
}

function asNumber(value: unknown, fallback: number): number {
    if (value === undefined || value === null || value === "") {
        return fallback;
    }
    const result = Number(value);
    return Number.isFinite(result) ? result : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
    if (value === undefined || value === null) {
        return fallback;
    }

    if (typeof value === "boolean") return value;
    if (value === 1 || value === "1" || value === "true") return true;
    if (value === 0 || value === "0" || value === "false") return false;
    return fallback;
}

function asNumberArray(value: unknown, fallback: number[] = []): number[] {
    if (!Array.isArray(value)) {
        return fallback.slice();
    }

    return [...new Set(value.map((item) => asNumber(item, -1)).filter((item) => Number.isInteger(item) && item >= 0 && item < 10))];
}

function asBooleanArray(value: unknown, fallback: boolean[] = []): boolean[] {
    if (!Array.isArray(value)) {
        return fallback.slice();
    }

    return value.map((item) => asBoolean(item));
}

function asRole(value: unknown, fallback = Role.Unknown): Role {
    const role = asNumber(value, fallback);
    return Number.isInteger(role) && role >= Role.Unknown && role <= Role.Mordred ? role as Role : fallback;
}

function asStage(value: unknown, fallback: GameStage): GameStage {
    const stage = asNumber(value, fallback);
    return Number.isInteger(stage) && stage >= GameStage.Preparing && stage <= GameStage.End ? stage as GameStage : fallback;
}

function normalizePlayer(raw: any): PlayerInfo {
    return {
        userId: asString(raw?.userId ?? raw?.UID ?? raw?.uid),
        nickname: asString(raw?.nickname ?? raw?.Nickname, "Player"),
        avatar: asString(raw?.avatar ?? raw?.Avatar),
        isReady: asBoolean(raw?.isReady ?? raw?.IsReady),
        seatIndex: asNumber(raw?.seatIndex ?? raw?.SeatIndex ?? raw?.Seat, -1),
        role: asRole(raw?.role ?? raw?.Role),
        isAi: asBoolean(raw?.isAi ?? raw?.IsAI),
    };
}

export class AvalonGameState {
    private static _instance: AvalonGameState | null = null;

    public static get instance(): AvalonGameState {
        if (!this._instance) {
            this._instance = new AvalonGameState();
        }

        return this._instance;
    }

    public serverUrl = "ws://127.0.0.1:8888";
    public roomId = "888";
    public myId = "";
    public nickname = "Guest";
    public players: PlayerInfo[] = [];
    public stage: GameStage = GameStage.Preparing;
    public captainSeat = -1;
    public currentRound = 1;
    public failedVotes = 0;
    public myRole: Role = Role.Unknown;
    public visibleSeats: number[] = [];
    public selectedSeats: number[] = [];
    public missionResults: boolean[] = [];
    public lastVotes: boolean[] = [];
    public lastVotePassed = false;
    public timeoutSec = 0;
    public winReason = "";
    public isGoodWin: boolean | null = null;
    public isLocalDemo = false;

    public ensureUserId(): string {
        if (!this.myId) {
            this.myId = String(100000 + Math.floor(Math.random() * 900000));
        }

        return this.myId;
    }

    public resetRoom(): void {
        this.players = [];
        this.stage = GameStage.Preparing;
        this.captainSeat = -1;
        this.currentRound = 1;
        this.failedVotes = 0;
        this.myRole = Role.Unknown;
        this.visibleSeats = [];
        this.selectedSeats = [];
        this.missionResults = [];
        this.lastVotes = [];
        this.lastVotePassed = false;
        this.timeoutSec = 0;
        this.winReason = "";
        this.isGoodWin = null;
        this.isLocalDemo = false;
    }

    public updateLogin(data: any): void {
        const userId = data?.userId ?? data?.UID ?? data?.uid;
        if (userId !== undefined && userId !== null) {
            this.myId = asString(userId);
        }
    }

    public updateRoomInfo(data: any): void {
        const room = data?.room ?? data?.Room ?? data;
        if (!room || typeof room !== "object" || Array.isArray(room)) {
            return;
        }

        const nextRoomId = asString(room.roomId ?? room.ID ?? room.id, this.roomId);
        const nextStage = asStage(room.stage ?? room.Stage, this.stage);
        const enteringFreshRoom = nextStage === GameStage.Preparing
            && (this.stage !== GameStage.Preparing || this.myRole !== Role.Unknown || this.isGoodWin !== null);
        if (this.players.length > 0 && (nextRoomId !== this.roomId || enteringFreshRoom)) this.resetRoom();
        this.isLocalDemo = false;
        this.roomId = nextRoomId;
        const players = room.players ?? room.Players;
        if (Array.isArray(players)) this.players = players
            .map((item: any) => normalizePlayer(item))
            .filter((item: PlayerInfo) => item.seatIndex >= 0 && item.seatIndex < 10)
            .sort((a: PlayerInfo, b: PlayerInfo) => a.seatIndex - b.seatIndex);
        this.stage = nextStage;
        this.captainSeat = asNumber(room.captainIdx ?? room.currentCaptainIdx ?? room.CaptainIdx ?? room.captainSeat, this.captainSeat);
        this.currentRound = Math.max(1, Math.min(5, asNumber(room.round ?? room.currentRound ?? room.Round, this.currentRound || 1)));
        this.failedVotes = Math.max(0, asNumber(room.failedVotes ?? room.failedVotesCount ?? room.FailedVotes, this.failedVotes));
        this.selectedSeats = asNumberArray(room.selectedSeats ?? room.SelectedSeats, this.selectedSeats);
        this.missionResults = asBooleanArray(room.missionResults ?? room.MissionResults, this.missionResults).slice(0, 5);
        this.applyMyRoleToPlayer();
    }

    public applyStageChange(data: any): void {
        this.stage = asStage(data?.stage ?? data?.Stage, this.stage);
        this.timeoutSec = Math.max(0, asNumber(data?.timeout ?? data?.Timeout, 0));
        if (this.stage === GameStage.Preparing) {
            this.myRole = Role.Unknown;
            this.visibleSeats = [];
            this.lastVotes = [];
            this.isGoodWin = null;
            this.winReason = "";
        }
    }

    public applyIdentity(data: any): void {
        this.myRole = asRole(data?.role ?? data?.Role);
        this.visibleSeats = asNumberArray(data?.visibleSeats ?? data?.VisibleSeats);
        this.applyMyRoleToPlayer();
    }

    public applyTeamProposed(data: any): void {
        this.captainSeat = asNumber(data?.captainSeat ?? data?.CaptainSeat, this.captainSeat);
        this.selectedSeats = asNumberArray(data?.selectedSeats ?? data?.SelectedSeats);
        this.stage = GameStage.Voting;
        this.lastVotes = [];
    }

    public applyVoteResult(data: any): VoteResultInfo {
        this.lastVotes = asBooleanArray(data?.votes ?? data?.Votes);
        this.lastVotePassed = asBoolean(data?.isPassed ?? data?.IsPassed);

        return {
            votes: this.lastVotes,
            isPassed: this.lastVotePassed,
        };
    }

    public applyMissionResult(data: any): MissionResultInfo {
        const result: MissionResultInfo = {
            isSuccess: asBoolean(data?.isSuccess ?? data?.IsSuccess),
            failCount: asNumber(data?.failCount ?? data?.FailCount, 0),
            round: Math.max(1, Math.min(5, asNumber(data?.round ?? data?.Round, this.currentRound))),
        };

        this.missionResults[result.round - 1] = result.isSuccess;
        this.currentRound = Math.max(this.currentRound, result.round);
        return result;
    }

    public applyGameEnd(data: any): GameEndInfo {
        this.stage = GameStage.End;
        this.isGoodWin = asBoolean(data?.isGoodWin ?? data?.IsGoodWin);
        this.winReason = asString(data?.winReason ?? data?.WinReason);

        const allRoles = data?.allRoles ?? data?.AllRoles;
        if (Array.isArray(allRoles)) {
            this.players = allRoles.map((item: any) => normalizePlayer(item)).sort((a: PlayerInfo, b: PlayerInfo) => a.seatIndex - b.seatIndex);
        }

        return {
            isGoodWin: Boolean(this.isGoodWin),
            winReason: this.winReason,
            allRoles: this.players,
        };
    }

    public loadLocalDemo(): void {
        const myId = this.ensureUserId();
        const nickname = this.nickname || "Guest";

        this.resetRoom();
        this.roomId = this.roomId || "888";
        this.isLocalDemo = true;
        this.stage = GameStage.Proposing;
        this.captainSeat = 0;
        this.currentRound = 1;
        this.failedVotes = 0;
        this.myRole = Role.Merlin;
        this.visibleSeats = [3, 4];
        this.selectedSeats = [];
        this.lastVotes = [];
        this.missionResults = [];
        this.winReason = "";
        this.isGoodWin = null;
        this.players = [
            { userId: myId, nickname, avatar: "", isReady: true, seatIndex: 0, role: Role.Merlin, isAi: false },
            { userId: "2001", nickname: "AI_派西维尔", avatar: "", isReady: true, seatIndex: 1, role: Role.Percival, isAi: true },
            { userId: "2002", nickname: "AI_忠臣", avatar: "", isReady: true, seatIndex: 2, role: Role.Servant, isAi: true },
            { userId: "2003", nickname: "AI_刺客", avatar: "", isReady: true, seatIndex: 3, role: Role.Assassin, isAi: true },
            { userId: "2004", nickname: "AI_莫甘娜", avatar: "", isReady: true, seatIndex: 4, role: Role.Morgana, isAi: true },
        ];
    }

    public getMySeat(): number {
        const player = this.players.find((item) => item.userId === this.myId);
        return player ? player.seatIndex : -1;
    }

    public isCaptain(): boolean {
        return this.getMySeat() === this.captainSeat;
    }

    public isMissionMember(): boolean {
        return this.selectedSeats.indexOf(this.getMySeat()) >= 0;
    }

    public getExpectedTeamSize(): number {
        return missionTeamSize(this.players.length, this.currentRound || 1);
    }

    public getPlayerAtSeat(seatIndex: number): PlayerInfo | null {
        return this.players.find((item) => item.seatIndex === seatIndex) ?? null;
    }

    private applyMyRoleToPlayer(): void {
        const mySeat = this.getMySeat();
        if (mySeat < 0 || this.myRole === Role.Unknown) {
            return;
        }

        const player = this.getPlayerAtSeat(mySeat);
        if (player) {
            player.role = this.myRole;
        }
    }
}
