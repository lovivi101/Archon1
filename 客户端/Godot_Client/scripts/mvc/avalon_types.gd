extends RefCounted
class_name AvalonTypes

enum Route {
	LOGIN = 101, JOIN_ROOM = 102, READY = 103, LEAVE_ROOM = 104, CREATE_ROOM = 105, QUICK_MATCH = 106,
	ROOM_INFO_INIT = 201, PLAYER_JOIN = 202, PLAYER_READY = 203,
	GAME_START = 301, STAGE_CHANGE = 302, IDENTITY_PUSH = 303,
	PROPOSE_TEAM = 401, TEAM_PROPOSED = 402,
	VOTE_TEAM = 501, VOTE_RESULT = 502,
	MISSION_ACTION = 601, MISSION_RESULT = 602,
	ASSASSINATE = 701, GAME_END = 702, EVIL_REVEALED = 703,
	CHAT = 801, CHAT_MESSAGE = 802, END_SPEECH = 803, SPEAKER_CHANGE = 804,
	LADY_CHECK = 901, LADY_RESULT = 902, LADY_USED = 903,
	EXCALIBUR_USE = 904, EXCALIBUR_RESULT = 905, EXCALIBUR_USED = 906,
}

enum Role { UNKNOWN, MERLIN, PERCIVAL, SERVANT, ASSASSIN, MORGANA, MINION, OBERON, MORDRED }
enum Stage { PREPARING, NIGHT, PROPOSING, VOTING, MISSION, ASSASSINATING, END, SPEAKING, LADY_OF_LAKE, EXCALIBUR }

const DEFAULT_SERVER_URL := "ws://127.0.0.1:8888"
const DEFAULT_ROOM_ID := "888"

static func role_name(role: int) -> String:
	var names := ["未分配", "梅林", "派西维尔", "忠臣", "刺客", "莫甘娜", "爪牙", "奥伯伦", "莫德雷德"]
	return names[role] if role >= 0 and role < names.size() else "未知"

static func stage_name(stage: int) -> String:
	var names := ["准备中", "黑夜验人", "队长组队", "全员投票", "任务执行", "刺杀梅林", "结算", "轮流发言", "湖中仙女", "王者之剑"]
	return names[stage] if stage >= 0 and stage < names.size() else "未知"

static func is_bad_role(role: int) -> bool:
	return role in [Role.ASSASSIN, Role.MORGANA, Role.MINION, Role.OBERON, Role.MORDRED]

static func team_size(player_count: int, round_number: int) -> int:
	var sizes: Dictionary = {5: [2, 3, 2, 3, 3], 6: [2, 3, 4, 3, 4], 7: [2, 3, 3, 4, 4], 8: [3, 4, 4, 5, 5], 9: [3, 4, 4, 5, 5], 10: [3, 4, 4, 5, 5]}
	var table: Array = sizes.get(player_count, sizes[5])
	return int(table[clamp(round_number - 1, 0, table.size() - 1)])

## Players needing two failure cards on round 4.
static func needs_two_fails(player_count: int, round_number: int) -> bool:
	return player_count >= 7 and round_number == 4

## "梅林、派西维尔、忠臣×2…" from a role id list.
static func role_set_text(roles: Array) -> String:
	var counts := {}
	var order: Array = []
	for role in roles:
		var id := int(role)
		if not counts.has(id):
			order.append(id)
			counts[id] = 0
		counts[id] += 1
	var parts: Array = []
	for id in order:
		parts.append(role_name(id) + ("×%d" % counts[id] if counts[id] > 1 else ""))
	return "、".join(parts)

## Role ids for each table size (same table as the server).
static func roles_for(player_count: int) -> Array:
	var sets := {
		5: [Role.MERLIN, Role.PERCIVAL, Role.SERVANT, Role.ASSASSIN, Role.MORGANA],
		6: [Role.MERLIN, Role.PERCIVAL, Role.SERVANT, Role.SERVANT, Role.ASSASSIN, Role.MORGANA],
		7: [Role.MERLIN, Role.PERCIVAL, Role.SERVANT, Role.SERVANT, Role.ASSASSIN, Role.MORGANA, Role.OBERON],
		8: [Role.MERLIN, Role.PERCIVAL, Role.SERVANT, Role.SERVANT, Role.SERVANT, Role.ASSASSIN, Role.MORGANA, Role.OBERON],
		9: [Role.MERLIN, Role.PERCIVAL, Role.SERVANT, Role.SERVANT, Role.SERVANT, Role.SERVANT, Role.ASSASSIN, Role.MORGANA, Role.MINION],
		10: [Role.MERLIN, Role.PERCIVAL, Role.SERVANT, Role.SERVANT, Role.SERVANT, Role.SERVANT, Role.ASSASSIN, Role.MORGANA, Role.MORDRED, Role.MINION],
	}
	return sets.get(player_count, sets[5])

## Special rules for a table size, matching the server (Lady of the Lake at 7, Excalibur at 10).
static func rules_text(player_count: int) -> String:
	var parts: Array = []
	if player_count == 7:
		parts.append("湖中仙女")
	if player_count == 10:
		parts.append("王者之剑")
	if player_count >= 7:
		parts.append("第4轮需2张失败票")
	return "、".join(parts) if not parts.is_empty() else "无"
