extends RefCounted
class_name AvalonModel
## Client-visible state only. Hidden roles live in the local engine or on the server.
const Types = preload("res://scripts/mvc/avalon_types.gd")
signal changed
var mode := "local"
var connection := "offline"
var session := "offline"
var server_url := Types.DEFAULT_SERVER_URL
var room_id := Types.DEFAULT_ROOM_ID
var user_id := ""
var nickname := "湖中之剑"
var avatar := "avatar-player-knight"
var stage := 0
var round := 1
var captain_seat := 0
var failed_votes := 0
var timeout_sec := 0
## Local ticks (ms) when the current stage (or speech turn) times out; 0 when there is no timer.
var deadline_ticks := 0
## Identifies the current decision point, so voted/acted reset exactly once per stage entry.
var phase_key := ""
var my_role := 0
var visible_seats: Array = []
var selected_seats: Array = []
var mission_results: Array = []
var last_votes: Array = []
var last_vote_passed := false
var is_good_win: Variant = null
var win_reason := ""
var players: Array = []
var history: Array = []
var voted := false
var acted := false
var last_mission: Dictionary = {}

# Room settings
var target_players := 5
var is_public := false
var rules: Dictionary = {"lady": false, "excalibur": false}
var role_set: Array = []

# Speeches
var speaker_seat := -1
var speech_order: Array = []
var chat: Array = []

# Lady of the Lake / Excalibur / assassination
var lady_holder := -1
var lady_history: Array = []
var lady_eligible: Array = []
var excalibur_seat := -1
var last_excalibur: Dictionary = {}
var revealed_evil: Array = []
## Loyalties this player learned privately: [{seat, isGood}] from Lady checks and Excalibur.
var facts: Array = []

## Snapshot taken when the game ended; the results and replay pages read it, so a new game
## started by someone else does not wipe what this player is still looking at.
var final_result: Dictionary = {}

# Server records (online only)
## {rating, tier, games, wins, rank}
var stats: Dictionary = {}
var leaderboard: Array = []
var match_history: Array = []
## Full server replay of a past match, shown on the replay page instead of final_result.
var replay: Dictionary = {}
## Rating change pushed after the last game: {matchId, rating, delta, tier, games, wins}.
var last_rating: Dictionary = {}

const MAX_HISTORY := 60
const MAX_CHAT := 60

func reset() -> void:
	stage = 0
	round = 1
	captain_seat = 0
	failed_votes = 0
	timeout_sec = 0
	deadline_ticks = 0
	phase_key = ""
	players = []
	history = []
	voted = false
	acted = false
	last_mission = {}
	target_players = 5
	is_public = false
	rules = {"lady": false, "excalibur": false}
	role_set = []
	_clear_game()
	changed.emit()

## Per-game state that goes away when a room returns to the lobby.
func _clear_game() -> void:
	my_role = 0
	visible_seats = []
	selected_seats = []
	mission_results = []
	last_votes = []
	last_vote_passed = false
	is_good_win = null
	win_reason = ""
	speaker_seat = -1
	speech_order = []
	chat = []
	lady_holder = -1
	lady_history = []
	lady_eligible = []
	excalibur_seat = -1
	last_excalibur = {}
	revealed_evil = []
	facts = []

func log_event(message: String) -> void:
	_push_history({"route":0, "message":message, "round":round})
	changed.emit()

func _push_history(entry: Dictionary) -> void:
	history.append(entry)
	while history.size() > MAX_HISTORY:
		history.pop_front()

## Seconds left in the current stage, or -1 when it has no timer.
func seconds_left() -> int:
	if deadline_ticks <= 0:
		return -1
	return maxi(0, ceili((deadline_ticks - Time.get_ticks_msec()) / 1000.0))

func _set_timeout(seconds: int) -> void:
	timeout_sec = seconds
	deadline_ticks = Time.get_ticks_msec() + seconds * 1000 if seconds > 0 else 0

## JSON numbers arrive as floats, and `0 in [0.0]` is false in GDScript, so seat lists are normalized to ints.
static func _seats(value: Variant) -> Array:
	var result: Array = []
	if value is Array:
		for item in value:
			result.append(int(item))
	return result

func _apply_progress(data: Dictionary) -> void:
	captain_seat = int(data.get("captainIdx", captain_seat))
	round = int(data.get("round", round))
	failed_votes = int(data.get("failedVotes", failed_votes))
	selected_seats = _seats(data.get("selectedSeats", selected_seats))
	mission_results = data.get("missionResults", mission_results).duplicate()
	speaker_seat = int(data.get("speakerSeat", speaker_seat))
	speech_order = _seats(data.get("speechOrder", speech_order))
	lady_holder = int(data.get("ladyHolder", lady_holder))
	lady_history = data.get("ladyHistory", lady_history).duplicate(true)
	lady_eligible = _seats(data.get("ladyEligible", lady_eligible))
	excalibur_seat = int(data.get("excaliburSeat", excalibur_seat))
	revealed_evil = _seats(data.get("revealedEvil", revealed_evil))

func _apply_room(room: Dictionary) -> void:
	room_id = str(room.get("roomId", room_id))
	stage = int(room.get("stage", stage))
	target_players = int(room.get("targetPlayers", target_players))
	is_public = bool(room.get("isPublic", is_public))
	rules = room.get("rules", rules).duplicate()
	role_set = _seats(room.get("roleSet", role_set))
	_apply_progress(room)
	players = room.get("players", players).duplicate(true)

## Public events are logged into the chat as system lines, so the discussion shows what just happened.
func _system(text: String) -> void:
	chat.append({"seat": -1, "nickname": "", "text": text, "channel": "system", "round": round})
	while chat.size() > MAX_CHAT:
		chat.pop_front()

static func _seat_list(seats: Array) -> String:
	return "、".join(PackedStringArray(seats.map(func(seat): return "%d号" % (int(seat) + 1))))

func _learn(seat: int, is_good: bool) -> void:
	for fact in facts:
		if int(fact.seat) == seat:
			return
	facts.append({"seat": seat, "isGood": is_good})

func apply_packet(route: int, data: Dictionary) -> void:
	match route:
		101:
			user_id = str(data.get("userId", user_id))
			session = "logged_in"
		102, 201, 202, 203:
			_apply_room(data.get("room", data))
			if route == 102:
				session = "in_room"
		302:
			stage = int(data.get("stage", stage))
			_apply_progress(data)
			# RoomInfoInit may already have moved `stage`, so compare against the last StageChange instead.
			var key := "%d:%d:%d" % [stage, round, failed_votes]
			if key != phase_key:
				phase_key = key
				voted = false
				acted = false
			if stage == Types.Stage.PREPARING:
				_clear_game()
			_set_timeout(int(data.get("timeout", 0)))
		303:
			my_role = int(data.get("role", 0))
			visible_seats = _seats(data.get("visibleSeats", []))
			for fact in data.get("facts", []):
				_learn(int(fact.get("seat", -1)), bool(fact.get("isGood", true)))
		402:
			captain_seat = int(data.get("captainSeat", captain_seat))
			selected_seats = _seats(data.get("selectedSeats", []))
			excalibur_seat = int(data.get("excaliburSeat", -1))
			voted = false
			_system("第%d轮 队长%d号提名 %s" % [round, captain_seat + 1, _seat_list(selected_seats)] + ("，王者之剑给%d号" % (excalibur_seat + 1) if excalibur_seat >= 0 else ""))
		502:
			# Captain, round and vote counters come from the following RoomInfoInit/StageChange.
			last_votes = data.get("votes", []).duplicate()
			last_vote_passed = bool(data.get("isPassed", false))
			var approvals: Array = []
			for seat in last_votes.size():
				if last_votes[seat]:
					approvals.append(seat)
			_system("投票%s，赞成：%s" % ["通过" if last_vote_passed else "否决", _seat_list(approvals) if not approvals.is_empty() else "无"])
		602:
			last_mission = data.duplicate(true)
			var result_round := int(data.get("round", round))
			while mission_results.size() < result_round:
				mission_results.append(false)
			mission_results[result_round - 1] = bool(data.get("isSuccess", false))
			_system("第%d轮任务%s，失败票 %d 张" % [result_round, "成功" if data.get("isSuccess", false) else "失败", int(data.get("failCount", 0))])
		702:
			stage = Types.Stage.END
			deadline_ticks = 0
			is_good_win = bool(data.get("isGoodWin", false))
			win_reason = str(data.get("winReason", "对局结束"))
			players = data.get("allRoles", players).duplicate(true)
		703:
			revealed_evil = _seats(data.get("evilSeats", []))
			_system("坏人亮明身份：%s" % _seat_list(revealed_evil))
		802:
			chat.append(data.duplicate(true))
			while chat.size() > MAX_CHAT:
				chat.pop_front()
		804:
			speaker_seat = int(data.get("speakerSeat", -1))
			speech_order = _seats(data.get("speechOrder", speech_order))
			_set_timeout(int(data.get("timeout", 0)))
		902:
			_learn(int(data.get("targetSeat", -1)), bool(data.get("isGood", true)))
		903:
			lady_history.append({"round": int(data.get("round", round)), "holderSeat": int(data.get("holderSeat", -1)), "targetSeat": int(data.get("targetSeat", -1))})
			lady_holder = int(data.get("targetSeat", lady_holder))
			_system("%d号用湖中仙女查验了%d号" % [int(data.get("holderSeat", -1)) + 1, int(data.get("targetSeat", -1)) + 1])
		905:
			if not bool(data.get("originalSuccess", true)):
				_learn(int(data.get("targetSeat", -1)), false)
		1001:
			match_history = data.get("matches", []).duplicate(true)
		1002:
			replay = data.get("match", {}).duplicate(true)
		1003:
			leaderboard = data.get("top", []).duplicate(true)
			stats = data.get("me", stats).duplicate()
		1004:
			stats = data.duplicate()
			stats.erase("code")
		1005:
			last_rating = data.duplicate()
			stats = {"rating": data.get("rating", 1000), "tier": data.get("tier", ""), "games": data.get("games", 0), "wins": data.get("wins", 0), "rank": stats.get("rank", 0)}
		906:
			last_excalibur = data.duplicate(true)
			var flipped := int(data.get("targetSeat", -1))
			_system("%d号%s" % [int(data.get("holderSeat", -1)) + 1, "用王者之剑翻转了%d号的牌" % (flipped + 1) if flipped >= 0 else "没有使用王者之剑"])
	if route in [303, 402, 502, 602, 702, 903, 906]:
		_push_history({"route": route, "round": round, "data": data.duplicate(true), "time": Time.get_datetime_string_from_system()})
	if route == 702:
		final_result = snapshot()
	changed.emit()

func my_seat() -> int:
	for player in players:
		if str(player.get("userId", "")) == user_id:
			return int(player.get("seatIndex", -1))
	return -1

func is_captain() -> bool:
	return my_seat() >= 0 and captain_seat == my_seat()

func is_member() -> bool:
	return my_seat() in selected_seats

## What this player must do right now in the current stage, or "" when nothing is pending.
func pending_action() -> String:
	var me := my_seat()
	if me < 0:
		return ""
	match stage:
		Types.Stage.SPEAKING:
			return "发言" if speaker_seat == me else ""
		Types.Stage.PROPOSING:
			return "组队" if captain_seat == me else ""
		Types.Stage.VOTING:
			return "" if voted else "投票"
		Types.Stage.MISSION:
			return "出任务牌" if is_member() and not acted else ""
		Types.Stage.EXCALIBUR:
			return "决定王者之剑" if excalibur_seat == me and not acted else ""
		Types.Stage.LADY_OF_LAKE:
			return "用湖中仙女查验" if lady_holder == me and not acted else ""
		Types.Stage.ASSASSINATING:
			return "刺杀梅林" if my_role == Types.Role.ASSASSIN else ""
	return ""

func is_speaker() -> bool:
	return stage == Types.Stage.SPEAKING and my_seat() >= 0 and speaker_seat == my_seat()

## Whether this player's side won the finished game; null before the end or without a known role.
func did_i_win() -> Variant:
	if is_good_win == null or my_role == Types.Role.UNKNOWN:
		return null
	return bool(is_good_win) != Types.is_bad_role(my_role)

func get_team_size() -> int:
	return Types.team_size(players.size(), round)

func snapshot() -> Dictionary:
	return {"mode": mode, "connection": connection, "session": session, "room": room_id,
		"nickname": nickname, "players": players.duplicate(true), "role": my_role, "visible": visible_seats.duplicate(),
		"stage": stage, "round": round, "captain": captain_seat, "me": my_seat(), "team": selected_seats.duplicate(),
		"results": mission_results.duplicate(), "votes": last_votes.duplicate(), "passed": last_vote_passed,
		"failed_votes": failed_votes, "voted": voted, "acted": acted, "winner": is_good_win, "reason": win_reason,
		"mission": last_mission.duplicate(), "history": history.duplicate(true), "team_size": get_team_size(),
		"won": did_i_win(), "seconds_left": seconds_left(),
		"target_players": target_players, "rules": rules.duplicate(), "role_set": role_set.duplicate(),
		"speaker": speaker_seat, "chat": chat.duplicate(true), "lady_holder": lady_holder, "lady_history": lady_history.duplicate(true),
		"lady_eligible": lady_eligible.duplicate(), "excalibur": excalibur_seat, "last_excalibur": last_excalibur.duplicate(),
		"evil": revealed_evil.duplicate(), "facts": facts.duplicate(true), "final": not final_result.is_empty(),
		"stats": stats.duplicate(), "board": leaderboard.size(), "history_count": match_history.size(), "replay": replay.get("matchId", 0),
		"rating_update": last_rating.duplicate()}
