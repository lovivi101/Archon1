export enum Route {
    Login = 101,
    JoinRoom = 102,
    Ready = 103,
    LeaveRoom = 104,
    /** Create a private room with a 6-digit code; success is answered on JoinRoom. */
    CreateRoom = 105,
    /** Join (or open) a public room for the requested player count; success is answered on JoinRoom. */
    QuickMatch = 106,
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
    /** Evil players reveal themselves when the assassination starts. */
    EvilRevealed = 703,
    Chat = 801,
    ChatMessage = 802,
    EndSpeech = 803,
    SpeakerChange = 804,
    LadyCheck = 901,
    /** Private to the Lady holder: the checked player's loyalty. */
    LadyResult = 902,
    LadyUsed = 903,
    ExcaliburUse = 904,
    /** Private to the Excalibur holder: the flipped player's original card. */
    ExcaliburResult = 905,
    ExcaliburUsed = 906,
    /** My recent games: `{ limit }` -> `{ matches }`. */
    MatchHistory = 1001,
    /** Full replay of a game I played: `{ matchId }` -> `{ match }`. */
    MatchDetail = 1002,
    /** Top players by rating: `{ limit }` -> `{ top, me }`. */
    Leaderboard = 1003,
    /** My rating, tier, games, wins and rank. */
    MyStats = 1004,
    /** Pushed after each game: `{ matchId, rating, delta, tier, games, wins }`. */
    RatingUpdate = 1005,
    /** Friends and pending requests: `{}` -> `{ friends, incoming, outgoing }`, entries `{ userId, nickname, avatar, online, roomId }`. */
    FriendList = 1101,
    /** Players by nickname or id: `{ query }` -> `{ players }`; entries also carry `isFriend` and `pending`. */
    FriendSearch = 1102,
    /** `{ targetId }` -> `{ targetId, accepted }`; accepted is true when the target had already asked us. */
    FriendRequest = 1103,
    /** `{ requesterId, accept }` -> `{ requesterId, accept }`. */
    FriendReply = 1104,
    /** `{ targetId }` -> `{ targetId }`. */
    FriendRemove = 1105,
    /** Pushed when the friend list changes: `{ kind: "request"|"accepted"|"removed"|"online"|"offline", userId, nickname }`. */
    FriendUpdate = 1106,
    /** Private message to a friend: `{ targetId, text }` -> `{ message }`; the friend also gets DirectMessage. */
    DirectChat = 1107,
    /** Pushed private message: `{ senderId, targetId, nickname, text, time }`. */
    DirectMessage = 1108,
    /** Recent private messages with a friend: `{ targetId }` -> `{ targetId, messages }`. */
    DirectHistory = 1109,
    /** Invites an online friend to my room: `{ targetId }` -> `{ targetId }`; the friend gets RoomInvitePush. */
    RoomInvite = 1110,
    /** `{ fromId, nickname, roomId, playerCount }`. */
    RoomInvitePush = 1111,
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
    /** Captain first, then clockwise; one speaker at a time. */
    Speaking = 7,
    /** Lady of the Lake holder checks a player (after missions 2-4). */
    LadyOfLake = 8,
    /** Excalibur holder may flip one team member's mission card. */
    Excalibur = 9,
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
    /** Excalibur use on this mission, if any (target -1 = not used). */
    excalibur?: { holderSeat: number; targetSeat: number };
}

/** Public record of one Lady of the Lake check; only the holder learns the result. */
export interface LadyRecord {
    round: number;
    holderSeat: number;
    targetSeat: number;
}

/** Optional modules. Per the design doc: Lady of the Lake at 7 players, Excalibur at 10. */
export interface GameRules {
    lady: boolean;
    excalibur: boolean;
}

export function rulesFor(playerCount: number): GameRules {
    return { lady: playerCount === 7, excalibur: playerCount === 10 };
}

/** Rounds after which the Lady of the Lake is used. */
export const ladyRounds = new Set([2, 3, 4]);

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
