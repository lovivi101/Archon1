export enum Route {
    Login = 101,
    JoinRoom = 102,
    Ready = 103,
    LeaveRoom = 104,
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

export enum Role {
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

export enum Stage {
    Preparing = 0,
    Night = 1,
    Proposing = 2,
    Voting = 3,
    Mission = 4,
    Assassinating = 5,
    End = 6,
}

/** Error codes sent back on the request route as `{ code, message, seq }`. */
export enum ErrorCode {
    BadRequest = 400,
    Unauthorized = 401,
    Forbidden = 403,
    NotFound = 404,
    Conflict = 409,
    TooManyRequests = 429,
    Unavailable = 503,
}

export interface Player {
    userId: string;
    nickname: string;
    avatar: string;
    isReady: boolean;
    seatIndex: number;
    role: Role;
    isAi: boolean;
    /** Human has a live connection bound to this room. */
    isOnline: boolean;
    /** Human left mid-game; the server plays for them without waiting for timeouts. */
    autopilot: boolean;
}

/** Public record of one team proposal and its vote, as every player saw it. */
export interface ProposalRecord {
    round: number;
    captainSeat: number;
    team: number[];
    votes: boolean[];
    passed: boolean;
}

/** Public record of one mission result, as every player saw it. */
export interface MissionRecord {
    round: number;
    team: number[];
    failCount: number;
    success: boolean;
}

export class RoomError extends Error {
    public constructor(public readonly code: ErrorCode, message: string) {
        super(message);
    }
}

const badRoles = new Set<Role>([Role.Assassin, Role.Morgana, Role.Minion, Role.Oberon, Role.Mordred]);

export function isBadRole(role: Role): boolean {
    return badRoles.has(role);
}

const teamSizes: Record<number, number[]> = {
    5: [2, 3, 2, 3, 3],
    6: [2, 3, 4, 3, 4],
    7: [2, 3, 3, 4, 4],
    8: [3, 4, 4, 5, 5],
    9: [3, 4, 4, 5, 5],
    10: [3, 4, 4, 5, 5],
};

export function teamSizeFor(playerCount: number, round: number): number {
    return teamSizes[playerCount]?.[round - 1] ?? 2;
}

/** Round 4 with 7+ players needs two failure cards to fail. */
export function failsNeeded(playerCount: number, round: number): number {
    return playerCount >= 7 && round === 4 ? 2 : 1;
}

const roleSets: Record<number, Role[]> = {
    5: [Role.Merlin, Role.Percival, Role.Servant, Role.Assassin, Role.Morgana],
    6: [Role.Merlin, Role.Percival, Role.Servant, Role.Servant, Role.Assassin, Role.Morgana],
    7: [Role.Merlin, Role.Percival, Role.Servant, Role.Servant, Role.Assassin, Role.Morgana, Role.Oberon],
    8: [Role.Merlin, Role.Percival, Role.Servant, Role.Servant, Role.Servant, Role.Assassin, Role.Morgana, Role.Oberon],
    9: [Role.Merlin, Role.Percival, Role.Servant, Role.Servant, Role.Servant, Role.Servant, Role.Assassin, Role.Morgana, Role.Minion],
    10: [Role.Merlin, Role.Percival, Role.Servant, Role.Servant, Role.Servant, Role.Servant, Role.Assassin, Role.Morgana, Role.Mordred, Role.Minion],
};

export function roleSetFor(playerCount: number): Role[] {
    const roles = roleSets[playerCount];
    if (!roles) throw new Error(`Unsupported player count ${playerCount}`);
    return roles.slice();
}
