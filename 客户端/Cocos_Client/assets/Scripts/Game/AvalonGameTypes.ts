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

export enum GameStage {
    Preparing = 0,
    Night = 1,
    Proposing = 2,
    Voting = 3,
    Mission = 4,
    Assassinating = 5,
    End = 6,
}

export interface PlayerInfo {
    userId: string;
    nickname: string;
    avatar: string;
    isReady: boolean;
    seatIndex: number;
    role: Role;
    isAi: boolean;
}

export interface VoteResultInfo {
    votes: boolean[];
    isPassed: boolean;
}

export interface MissionResultInfo {
    isSuccess: boolean;
    failCount: number;
    round: number;
}

export interface GameEndInfo {
    isGoodWin: boolean;
    winReason: string;
    allRoles: PlayerInfo[];
}

export const RouteNames: { [route: number]: string } = {
    [Route.Login]: "登录",
    [Route.JoinRoom]: "加入房间",
    [Route.Ready]: "准备",
    [Route.RoomInfoInit]: "房间初始化",
    [Route.PlayerJoin]: "玩家加入",
    [Route.PlayerReady]: "玩家准备",
    [Route.GameStart]: "游戏开始",
    [Route.StageChange]: "阶段切换",
    [Route.IdentityPush]: "身份下发",
    [Route.TeamProposed]: "队伍提议",
    [Route.VoteResult]: "投票结果",
    [Route.MissionResult]: "任务结果",
    [Route.GameEnd]: "游戏结束",
};

export const RoleNames: { [role: number]: string } = {
    [Role.Unknown]: "未分配",
    [Role.Merlin]: "梅林",
    [Role.Percival]: "派西维尔",
    [Role.Servant]: "忠臣",
    [Role.Assassin]: "刺客",
    [Role.Morgana]: "莫甘娜",
    [Role.Minion]: "爪牙",
    [Role.Oberon]: "奥伯伦",
    [Role.Mordred]: "莫德雷德",
};

export const StageNames: { [stage: number]: string } = {
    [GameStage.Preparing]: "准备中",
    [GameStage.Night]: "黑夜验人",
    [GameStage.Proposing]: "队长组队",
    [GameStage.Voting]: "全员投票",
    [GameStage.Mission]: "任务执行",
    [GameStage.Assassinating]: "刺杀梅林",
    [GameStage.End]: "结算",
};

export const MissionTeamSizeMap: { [playerCount: number]: number[] } = {
    5: [2, 3, 2, 3, 3],
    6: [2, 3, 4, 3, 4],
    7: [2, 3, 3, 4, 4],
    8: [3, 4, 4, 5, 5],
    9: [3, 4, 4, 5, 5],
    10: [3, 4, 4, 5, 5],
};

export function routeName(route: number): string {
    return RouteNames[route] ?? `Route ${route}`;
}

export function roleName(role: Role | number): string {
    return RoleNames[role] ?? `身份 ${role}`;
}

export function stageName(stage: GameStage | number): string {
    return StageNames[stage] ?? `阶段 ${stage}`;
}

export function isBadRole(role: Role | number): boolean {
    return role === Role.Assassin || role === Role.Morgana || role === Role.Minion || role === Role.Oberon || role === Role.Mordred;
}

export function missionTeamSize(playerCount: number, round: number): number {
    const sizes = MissionTeamSizeMap[playerCount] ?? MissionTeamSizeMap[5];
    const index = Math.max(0, Math.min(sizes.length - 1, round - 1));
    return sizes[index] ?? 2;
}
