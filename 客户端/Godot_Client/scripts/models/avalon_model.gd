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
var stage := 0
var round := 1
var captain_seat := 0
var failed_votes := 0
var timeout_sec := 0
## Local ticks (ms) when the current stage times out; 0 when the stage has no timer.
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

func reset() -> void:
	stage = 0
	round = 1
	captain_seat = 0
	failed_votes = 0
	timeout_sec = 0
	deadline_ticks = 0
	phase_key = ""
	my_role = 0
	visible_seats = []
	selected_seats = []
	mission_results = []
	last_votes = []
	last_vote_passed = false
	is_good_win = null
	win_reason = ""
	players = []
	history = []
	voted = false
	acted = false
	last_mission = {}
	changed.emit()

const MAX_HISTORY := 60

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

func apply_packet(route: int, data: Dictionary) -> void:
	match route:
		101:
			user_id = str(data.get("userId", user_id))
			session = "logged_in"
		102, 201, 202, 203:
			var room: Dictionary = data.get("room", data)
			room_id = str(room.get("roomId", room_id))
			stage = int(room.get("stage", stage))
			_apply_progress(room)
			players = room.get("players", players).duplicate(true)
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
				my_role = 0
				visible_seats = []
				is_good_win = null
				win_reason = ""
			timeout_sec = int(data.get("timeout", 0))
			deadline_ticks = Time.get_ticks_msec() + timeout_sec * 1000 if timeout_sec > 0 else 0
		303:
			my_role = int(data.get("role", 0))
			visible_seats = _seats(data.get("visibleSeats", []))
		402:
			captain_seat = int(data.get("captainSeat", captain_seat))
			selected_seats = _seats(data.get("selectedSeats", []))
			voted = false
		502:
			# Captain, round and vote counters come from the following RoomInfoInit/StageChange.
			last_votes = data.get("votes", []).duplicate()
			last_vote_passed = bool(data.get("isPassed", false))
		602:
			last_mission = data.duplicate(true)
			var result_round := int(data.get("round", round))
			while mission_results.size() < result_round:
				mission_results.append(false)
			mission_results[result_round - 1] = bool(data.get("isSuccess", false))
		702:
			stage = 6
			deadline_ticks = 0
			is_good_win = bool(data.get("isGoodWin", false))
			win_reason = str(data.get("winReason", "对局结束"))
			players = data.get("allRoles", players).duplicate(true)
	if route in [303, 402, 502, 602, 702]:
		_push_history({"route": route, "round": round, "data": data.duplicate(true), "time": Time.get_datetime_string_from_system()})
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
		"won": did_i_win(), "seconds_left": seconds_left()}
