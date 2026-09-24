extends RefCounted
class_name AvalonTypes

enum Route {
	LOGIN = 101, JOIN_ROOM = 102, READY = 103, LEAVE_ROOM = 104,
	ROOM_INFO_INIT = 201, PLAYER_JOIN = 202, PLAYER_READY = 203,
	GAME_START = 301, STAGE_CHANGE = 302, IDENTITY_PUSH = 303,
	PROPOSE_TEAM = 401, TEAM_PROPOSED = 402,
	VOTE_TEAM = 501, VOTE_RESULT = 502,
	MISSION_ACTION = 601, MISSION_RESULT = 602,
	ASSASSINATE = 701, GAME_END = 702,
}

enum Role { UNKNOWN, MERLIN, PERCIVAL, SERVANT, ASSASSIN, MORGANA, MINION, OBERON, MORDRED }
enum Stage { PREPARING, NIGHT, PROPOSING, VOTING, MISSION, ASSASSINATING, END }

const DEFAULT_SERVER_URL := "ws://127.0.0.1:8888"
const DEFAULT_ROOM_ID := "888"

static func role_name(role: int) -> String:
	var names := ["未分配", "梅林", "派西维尔", "忠臣", "刺客", "莫甘娜", "爪牙", "奥伯伦", "莫德雷德"]
	return names[role] if role >= 0 and role < names.size() else "未知"

static func stage_name(stage: int) -> String:
	var names := ["准备中", "黑夜验人", "队长组队", "全员投票", "任务执行", "刺杀梅林", "结算"]
	return names[stage] if stage >= 0 and stage < names.size() else "未知"

static func is_bad_role(role: int) -> bool:
	return role in [Role.ASSASSIN, Role.MORGANA, Role.MINION, Role.OBERON, Role.MORDRED]

static func team_size(player_count: int, round_number: int) -> int:
	var sizes: Dictionary = {5: [2, 3, 2, 3, 3], 6: [2, 3, 4, 3, 4], 7: [2, 3, 3, 4, 4], 8: [3, 4, 4, 5, 5], 9: [3, 4, 4, 5, 5], 10: [3, 4, 4, 5, 5]}
	var table: Array = sizes.get(player_count, sizes[5])
	return int(table[clamp(round_number - 1, 0, table.size() - 1)])
