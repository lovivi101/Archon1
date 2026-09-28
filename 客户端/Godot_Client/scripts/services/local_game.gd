extends Node
## Offline authority for practice against AI: a GDScript port of the server room
## (服务器端/AvalonTsServer/src/avalon.room.ts). It emits the same routes and payloads, so the client
## treats a local game exactly like an online one. Keep the two in step when changing rules.
##
## Differences from the server: one human (seat 0), no timeouts for the human, and AI players act
## on a short delay so their moves can be followed.
const T = preload("res://scripts/mvc/avalon_types.gd")
const Ai = preload("res://scripts/services/local_ai.gd")
signal packet_received(route: int, payload: Dictionary)

const NIGHT_SECONDS := 1.0
const AI_DELAY := 1.0
const AI_SPEECH := 1.8
const TICK := 0.25
const MAX_CHAT_LENGTH := 80
const MAX_MESSAGES_PER_TURN := 5
const AI_NAMES := ["灰袍贤者", "北境女王", "林中旅人", "山岭铁卫", "暗影祭司", "夜鸦", "堕落骑士", "湖畔游侠", "银月守卫"]

var players: Array = []
var stage := 0
var round_number := 1
var captain := 0
var rejections := 0
var team: Array = []
var results: Array = []
var votes: Dictionary = {}
var cards: Dictionary = {}
var proposals: Array = []
var missions: Array = []
var speech_order: Array = []
var speaker_index := 0
var speaker_messages := 0
var lady_holder := -1
var lady_history: Array = []
var excalibur_seat := -1
var revealed_evil: Array = []
var rules: Dictionary = {"lady": false, "excalibur": false}
var target_players := 5
var room_id := "练习"
var outcome: Dictionary = {}
var running := false
var rng := RandomNumberGenerator.new()
## Reason the last command was refused, shown to the player.
var last_error := ""
var _facts: Dictionary = {}
var _visibility: Dictionary = {}
var _ai_plans: Dictionary = {}
var _stage_clock := 0.0
var _tick_clock := 0.0
## Time multiplier for AI pacing; tests raise it to play fast.
var speed := 1.0

# ---- setup ----

func create_room(user_id: String, nickname: String, count := 5, seed_value := -1, avatar := "") -> void:
	rng.randomize()
	if seed_value >= 0:
		rng.seed = seed_value
	target_players = clampi(count, 5, 10)
	players = [{"userId":user_id, "nickname":nickname, "avatar":avatar, "seatIndex":0, "isAi":false, "isReady":false, "role":0, "isOnline":true}]
	for i in range(1, target_players):
		players.append({"userId":"bot-%d" % i, "nickname":"AI_" + AI_NAMES[i - 1], "avatar":"", "seatIndex":i, "isAi":true, "isReady":true, "role":0, "isOnline":true})
	stage = T.Stage.PREPARING
	rules = T.rules_for(target_players)
	_clear_game()
	running = false
	packet_received.emit(T.Route.JOIN_ROOM, {"code":0, "room":snapshot()})

func _clear_game() -> void:
	round_number = 1
	captain = 0
	rejections = 0
	team = []
	results = []
	votes = {}
	cards = {}
	proposals = []
	missions = []
	speech_order = []
	speaker_index = 0
	speaker_messages = 0
	lady_holder = -1
	lady_history = []
	excalibur_seat = -1
	revealed_evil = []
	outcome = {}
	_facts = {}
	_visibility = {}
	_ai_plans = {}

func _start() -> void:
	var roles: Array = T.roles_for(players.size()).duplicate()
	for i in range(roles.size() - 1, 0, -1):
		var j := rng.randi_range(0, i)
		var old = roles[i]
		roles[i] = roles[j]
		roles[j] = old
	for i in players.size():
		players[i].role = roles[i]
		players[i].isReady = true
	_clear_game()
	captain = rng.randi_range(0, players.size() - 1)
	# The Lady of the Lake starts with the player to the first captain's right.
	lady_holder = (captain - 1 + players.size()) % players.size() if rules.lady else -1
	for p in players:
		_visibility[int(p.seatIndex)] = visible_seats(int(p.seatIndex))
	running = true
	packet_received.emit(T.Route.GAME_START, {"roomId":room_id})
	packet_received.emit(T.Route.IDENTITY_PUSH, identity(0))
	_set_stage(T.Stage.NIGHT)

# ---- views ----

func public_room() -> Dictionary:
	return snapshot()

func snapshot() -> Dictionary:
	var visible := players.duplicate(true)
	for p in visible:
		p.role = 0
	var room := {"roomId":room_id, "players":visible, "stage":stage, "captainIdx":captain, "round":round_number,
		"failedVotes":rejections, "selectedSeats":team.duplicate(), "missionResults":results.duplicate(), "deadline":0,
		"targetPlayers":target_players, "isPublic":false, "rules":rules.duplicate(), "roleSet":T.roles_for(players.size())}
	room.merge(_progress())
	return room

func _progress() -> Dictionary:
	return {"speakerSeat":current_speaker(), "speechOrder":speech_order.duplicate() if stage == T.Stage.SPEAKING else [],
		"ladyHolder":lady_holder, "ladyHistory":lady_history.duplicate(true), "ladyEligible":lady_eligible() if stage == T.Stage.LADY_OF_LAKE else [],
		"excaliburSeat":excalibur_seat, "revealedEvil":revealed_evil.duplicate()}

func _stage_payload() -> Dictionary:
	var payload := {"stage":stage, "timeout":0, "deadline":0, "captainIdx":captain, "round":round_number, "failedVotes":rejections,
		"selectedSeats":team.duplicate(), "missionResults":results.duplicate()}
	payload.merge(_progress())
	return payload

func identity(seat: int) -> Dictionary:
	return {"role":players[seat].role, "visibleSeats":_visibility.get(seat, []), "facts":_facts.get(seat, []).duplicate(true)}

## Seats revealed to this seat at night.
func visible_seats(seat: int) -> Array:
	var role := int(players[seat].role)
	var seen: Array = []
	for p in players:
		var other := int(p.seatIndex)
		var other_role := int(p.role)
		if other == seat:
			continue
		if role == T.Role.MERLIN and T.is_bad_role(other_role) and other_role != T.Role.MORDRED:
			seen.append(other)
		elif role == T.Role.PERCIVAL and other_role in [T.Role.MERLIN, T.Role.MORGANA]:
			seen.append(other)
		elif T.is_bad_role(role) and role != T.Role.OBERON and T.is_bad_role(other_role) and other_role != T.Role.OBERON:
			seen.append(other)
	return seen

func current_speaker() -> int:
	return int(speech_order[speaker_index]) if stage == T.Stage.SPEAKING and speaker_index < speech_order.size() else -1

func team_size() -> int:
	return T.team_size(players.size(), round_number)

## Seats the Lady holder may check: anyone except itself and earlier holders.
func lady_eligible() -> Array:
	var earlier := {}
	earlier[int(lady_history[0].holderSeat) if not lady_history.is_empty() else lady_holder] = true
	for record in lady_history:
		earlier[int(record.targetSeat)] = true
	return range(players.size()).filter(func(seat): return seat != lady_holder and not earlier.has(seat))

# ---- stage flow ----

func _set_stage(next: int) -> void:
	stage = next
	_stage_clock = 0.0
	if stage == T.Stage.PROPOSING:
		team = []
	packet_received.emit(T.Route.ROOM_INFO_INIT, {"room":snapshot()})
	packet_received.emit(T.Route.STAGE_CHANGE, _stage_payload())

## Captain speaks first, then everyone else clockwise.
func _begin_speaking() -> void:
	speech_order = range(players.size()).map(func(offset): return (captain + offset) % players.size())
	speaker_index = 0
	speaker_messages = 0
	_ai_plans = {}
	_set_stage(T.Stage.SPEAKING)
	_announce_speaker()

func _next_speaker() -> void:
	speaker_index += 1
	speaker_messages = 0
	if speaker_index >= speech_order.size():
		_set_stage(T.Stage.PROPOSING)
		return
	_stage_clock = 0.0
	_announce_speaker()

func _announce_speaker() -> void:
	packet_received.emit(T.Route.SPEAKER_CHANGE, {"speakerSeat":current_speaker(), "speakerIndex":speaker_index,
		"speechOrder":speech_order.duplicate(), "timeout":0, "deadline":0})

func _post_chat(seat: int, text: String, channel: String) -> void:
	var entry := {"seat":seat, "nickname":players[seat].nickname, "text":text, "channel":channel, "round":round_number, "time":Time.get_ticks_msec()}
	# Evil-only messages reach the human only when the human is evil.
	if channel == "all" or T.is_bad_role(int(players[0].role)):
		packet_received.emit(T.Route.CHAT_MESSAGE, entry)

func _resolve_mission(excalibur := {}) -> void:
	var fails: int = cards.values().count(false)
	var success := fails < (2 if T.needs_two_fails(players.size(), round_number) else 1)
	results.append(success)
	var record := {"round":round_number, "team":team.duplicate(), "failCount":fails, "success":success}
	if not excalibur.is_empty():
		record["excalibur"] = excalibur
	missions.append(record)
	packet_received.emit(T.Route.MISSION_RESULT, {"round":round_number, "isSuccess":success, "failCount":fails})
	if results.count(false) >= 3:
		_finish(false, "三次任务失败，坏人胜利")
	elif results.count(true) >= 3:
		# Evil players reveal themselves to everyone before the assassin chooses.
		revealed_evil = range(players.size()).filter(func(seat): return T.is_bad_role(int(players[seat].role)))
		packet_received.emit(T.Route.EVIL_REVEALED, {"evilSeats":revealed_evil.duplicate()})
		_set_stage(T.Stage.ASSASSINATING)
	elif rules.lady and round_number in [2, 3, 4] and not lady_eligible().is_empty():
		_set_stage(T.Stage.LADY_OF_LAKE)
	else:
		_next_round()

func _next_round() -> void:
	round_number += 1
	captain = (captain + 1) % players.size()
	excalibur_seat = -1
	_begin_speaking()

func _learn(seat: int, fact: Dictionary) -> void:
	var known: Array = _facts.get(seat, [])
	if not known.any(func(item): return int(item.seat) == int(fact.seat)):
		known.append(fact)
	_facts[seat] = known

func _finish(good: bool, reason: String) -> void:
	stage = T.Stage.END
	running = false
	outcome = {"isGoodWin":good, "winReason":reason, "allRoles":players.duplicate(true)}
	packet_received.emit(T.Route.GAME_END, outcome)

# ---- commands ----

func _fail(message: String) -> bool:
	last_error = message
	return false

## Applies one action for `seat`; returns false (with `last_error`) when it is not allowed.
func command(route: int, data: Dictionary, seat := 0) -> bool:
	last_error = ""
	if seat < 0 or seat >= players.size():
		return _fail("你不在该房间中")
	match route:
		T.Route.READY:
			if stage == T.Stage.END:
				stage = T.Stage.PREPARING
			if stage != T.Stage.PREPARING:
				return _fail("游戏已经开始")
			_start()
			return true
		T.Route.CHAT:
			var text := str(data.get("text", "")).strip_edges()
			if text.is_empty():
				return _fail("发言内容不能为空")
			if text.length() > MAX_CHAT_LENGTH:
				return _fail("每条发言最多 %d 个字" % MAX_CHAT_LENGTH)
			if stage == T.Stage.SPEAKING:
				if seat != current_speaker():
					return _fail("还没轮到你发言")
				if speaker_messages >= MAX_MESSAGES_PER_TURN:
					return _fail("每轮最多发送 %d 条" % MAX_MESSAGES_PER_TURN)
				speaker_messages += 1
				_post_chat(seat, text, "all")
				return true
			if stage == T.Stage.ASSASSINATING:
				if not T.is_bad_role(int(players[seat].role)):
					return _fail("刺杀阶段只有坏人可以商议")
				_post_chat(seat, text, "evil")
				return true
			return _fail("现在不是发言时间")
		T.Route.END_SPEECH:
			if stage != T.Stage.SPEAKING:
				return _fail("当前不是发言阶段")
			if seat != current_speaker():
				return _fail("还没轮到你发言")
			_next_speaker()
			return true
		T.Route.PROPOSE_TEAM:
			if stage != T.Stage.PROPOSING:
				return _fail("当前不是组队阶段")
			if seat != captain:
				return _fail("只有队长可以组队")
			var selected: Array = data.get("selectedSeats", [])
			var unique := {}
			for s in selected:
				if not (s is int or s is float) or float(s) != floor(float(s)) or int(s) < 0 or int(s) >= players.size() or unique.has(int(s)):
					return _fail("需要选择 %d 名不重复的队员" % team_size())
				unique[int(s)] = true
			if unique.size() != team_size():
				return _fail("需要选择 %d 名不重复的队员" % team_size())
			var holder := -1
			if rules.excalibur:
				holder = int(data.get("excaliburSeat", -1))
				if not unique.has(holder) or holder == captain:
					return _fail("请把王者之剑交给队伍中除队长以外的一名队员")
			team = unique.keys()
			excalibur_seat = holder
			votes = {}
			packet_received.emit(T.Route.TEAM_PROPOSED, {"captainSeat":captain, "selectedSeats":team.duplicate(), "excaliburSeat":holder})
			_set_stage(T.Stage.VOTING)
			return true
		T.Route.VOTE_TEAM:
			if stage != T.Stage.VOTING:
				return _fail("当前不是投票阶段")
			if not data.get("approve") is bool:
				return _fail("approve 必须是布尔值")
			if votes.has(seat):
				return _fail("你已经投过票")
			votes[seat] = data.approve
			if votes.size() < players.size():
				return true
			var ordered: Array = range(players.size()).map(func(i): return votes[i])
			var passed: bool = ordered.count(true) > players.size() / 2.0
			proposals.append({"round":round_number, "captainSeat":captain, "team":team.duplicate(), "votes":ordered, "passed":passed})
			packet_received.emit(T.Route.VOTE_RESULT, {"votes":ordered, "isPassed":passed})
			if passed:
				rejections = 0
				cards = {}
				_set_stage(T.Stage.MISSION)
			else:
				rejections += 1
				if rejections >= 5:
					_finish(false, "连续 5 次组队被否决，坏人胜利")
				else:
					captain = (captain + 1) % players.size()
					excalibur_seat = -1
					_begin_speaking()
			return true
		T.Route.MISSION_ACTION:
			if stage != T.Stage.MISSION:
				return _fail("当前不是任务阶段")
			if not data.get("success") is bool:
				return _fail("success 必须是布尔值")
			if not seat in team:
				return _fail("你不在任务队伍中")
			if cards.has(seat):
				return _fail("你已经提交过任务牌")
			if not data.success and not T.is_bad_role(int(players[seat].role)):
				return _fail("好人只能提交任务成功")
			cards[seat] = data.success
			if cards.size() < team.size():
				return true
			if rules.excalibur and excalibur_seat >= 0:
				_set_stage(T.Stage.EXCALIBUR)
			else:
				_resolve_mission()
			return true
		T.Route.EXCALIBUR_USE:
			if stage != T.Stage.EXCALIBUR:
				return _fail("当前不是王者之剑阶段")
			if seat != excalibur_seat:
				return _fail("只有王者之剑持有者可以使用")
			var target := int(data.get("targetSeat", -1))
			if target != -1 and (not target in team or target == seat):
				return _fail("只能对其他任务队员使用王者之剑")
			if target >= 0:
				var original: bool = cards[target]
				cards[target] = not original
				if seat == 0:
					packet_received.emit(T.Route.EXCALIBUR_RESULT, {"targetSeat":target, "originalSuccess":original})
				if not original:
					_learn(seat, {"seat":target, "isGood":false})
			packet_received.emit(T.Route.EXCALIBUR_USED, {"holderSeat":seat, "targetSeat":target})
			_resolve_mission({"holderSeat":seat, "targetSeat":target})
			return true
		T.Route.LADY_CHECK:
			if stage != T.Stage.LADY_OF_LAKE:
				return _fail("当前不是湖中仙女阶段")
			if seat != lady_holder:
				return _fail("只有湖中仙女持有者可以查验")
			var target := int(data.get("targetSeat", -1))
			if not target in lady_eligible():
				return _fail("不能查验自己或曾经持有湖中仙女的玩家")
			var is_good := not T.is_bad_role(int(players[target].role))
			if seat == 0:
				packet_received.emit(T.Route.LADY_RESULT, {"targetSeat":target, "isGood":is_good})
			_learn(seat, {"seat":target, "isGood":is_good})
			lady_history.append({"round":round_number, "holderSeat":seat, "targetSeat":target})
			lady_holder = target
			packet_received.emit(T.Route.LADY_USED, {"holderSeat":seat, "targetSeat":target, "round":round_number})
			_next_round()
			return true
		T.Route.ASSASSINATE:
			if stage != T.Stage.ASSASSINATING:
				return _fail("当前不是刺杀阶段")
			if int(players[seat].role) != T.Role.ASSASSIN:
				return _fail("只有刺客可以刺杀")
			var target := int(data.get("targetSeat", -1))
			if target < 0 or target >= players.size() or T.is_bad_role(int(players[target].role)):
				return _fail("只能刺杀好人阵营玩家")
			var merlin_killed := int(players[target].role) == T.Role.MERLIN
			_finish(not merlin_killed, "刺客选择了 %s，%s" % [players[target].nickname, "梅林被刺杀，坏人胜利" if merlin_killed else "梅林存活，好人胜利"])
			return true
	return _fail("当前阶段无法执行此操作")

# ---- AI ----

func _process(delta: float) -> void:
	if not running:
		return
	_stage_clock += delta * speed
	_tick_clock += delta * speed
	if _tick_clock >= TICK:
		_tick_clock = 0.0
		_tick()

## Lets AI seats act once their delay has passed. The human is never timed out.
func _tick() -> void:
	if stage == T.Stage.NIGHT:
		if _stage_clock >= NIGHT_SECONDS:
			_begin_speaking()
		return
	var wait := AI_SPEECH if stage == T.Stage.SPEAKING else AI_DELAY
	if _stage_clock < wait:
		return
	_act_pending(false)

## Acts for every pending AI seat right away (and the human too when `include_human`). Used by tests.
func bot_tick(include_human := false) -> void:
	if stage == T.Stage.NIGHT:
		_begin_speaking()
		return
	_act_pending(include_human)

func _act_pending(include_human: bool) -> void:
	var current := stage
	for seat in _pending_actors():
		if seat == 0 and not include_human:
			continue
		_ai_act(seat)
		# A speech turn or stage change moves on to a new actor; handle it next time.
		if stage != current or current == T.Stage.SPEAKING or not running:
			return

func _pending_actors() -> Array:
	match stage:
		T.Stage.SPEAKING:
			return [current_speaker()] if current_speaker() >= 0 else []
		T.Stage.PROPOSING:
			return [captain]
		T.Stage.VOTING:
			return range(players.size()).filter(func(seat): return not votes.has(seat))
		T.Stage.MISSION:
			return team.filter(func(seat): return not cards.has(seat))
		T.Stage.EXCALIBUR:
			return [excalibur_seat] if excalibur_seat >= 0 else []
		T.Stage.LADY_OF_LAKE:
			return [lady_holder] if lady_holder >= 0 else []
		T.Stage.ASSASSINATING:
			return range(players.size()).filter(func(seat): return int(players[seat].role) == T.Role.ASSASSIN)
	return []

func _view(seat: int) -> Dictionary:
	# Evil players reveal themselves before the assassination, so the assassin then knows every evil seat.
	var visible: Array = revealed_evil.filter(func(s): return s != seat) if stage == T.Stage.ASSASSINATING else _visibility.get(seat, [])
	return {"seat":seat, "role":int(players[seat].role), "visible":visible, "count":players.size(), "round":round_number,
		"failed_votes":rejections, "proposals":proposals, "missions":missions, "facts":_facts.get(seat, [])}

func _ai_act(seat: int) -> void:
	var view := _view(seat)
	var ok := true
	match stage:
		T.Stage.SPEAKING:
			# The human is never spoken for; a test driving the human just ends the turn.
			if players[seat].isAi:
				var is_captain := seat == captain
				var plan: Array = Ai.propose_team(view, team_size(), rng) if is_captain else []
				if is_captain:
					_ai_plans[seat] = plan
				var lady_check: Variant = null
				if not lady_history.is_empty():
					var last: Dictionary = lady_history[-1]
					if int(last.holderSeat) == seat and int(last.round) == round_number - 1:
						for fact in view.facts:
							if int(fact.seat) == int(last.targetSeat):
								lady_check = fact
				var line := Ai.speech(view, {"is_captain":is_captain, "plan":plan, "lady_check":lady_check}, rng)
				command(T.Route.CHAT, {"text":line.left(MAX_CHAT_LENGTH)}, seat)
			ok = command(T.Route.END_SPEECH, {}, seat)
		T.Stage.PROPOSING:
			var chosen: Array = _ai_plans.get(seat, Ai.propose_team(view, team_size(), rng))
			var holder := Ai.excalibur_holder(view, chosen, rng) if rules.excalibur else -1
			ok = command(T.Route.PROPOSE_TEAM, {"selectedSeats":chosen, "excaliburSeat":holder}, seat)
		T.Stage.VOTING:
			ok = command(T.Route.VOTE_TEAM, {"approve":Ai.vote(view, team, rng)}, seat)
		T.Stage.MISSION:
			ok = command(T.Route.MISSION_ACTION, {"success":Ai.mission_card(view, team, rng)}, seat)
		T.Stage.EXCALIBUR:
			ok = command(T.Route.EXCALIBUR_USE, {"targetSeat":Ai.excalibur_target(view, team, cards.get(seat, true), rng)}, seat)
		T.Stage.LADY_OF_LAKE:
			ok = command(T.Route.LADY_CHECK, {"targetSeat":Ai.lady_target(view, lady_eligible(), rng)}, seat)
		T.Stage.ASSASSINATING:
			var target := Ai.assassin_target(view, rng)
			if players[seat].isAi:
				command(T.Route.CHAT, {"text":"我觉得%d号最像梅林，准备刺杀他。" % (target + 1)}, seat)
			ok = command(T.Route.ASSASSINATE, {"targetSeat":target}, seat)
	if not ok:
		push_warning("Local AI move refused (%s); using a safe default" % last_error)
		_fallback_act(seat)

## A safe move so the game can never stall on an AI mistake.
func _fallback_act(seat: int) -> void:
	match stage:
		T.Stage.SPEAKING:
			_next_speaker()
		T.Stage.PROPOSING:
			var chosen: Array = range(team_size())
			var holder := -1
			for s in chosen:
				if s != captain:
					holder = s
					break
			command(T.Route.PROPOSE_TEAM, {"selectedSeats":chosen, "excaliburSeat":holder}, seat)
		T.Stage.VOTING:
			command(T.Route.VOTE_TEAM, {"approve":true}, seat)
		T.Stage.MISSION:
			command(T.Route.MISSION_ACTION, {"success":true}, seat)
		T.Stage.EXCALIBUR:
			command(T.Route.EXCALIBUR_USE, {"targetSeat":-1}, seat)
		T.Stage.LADY_OF_LAKE:
			command(T.Route.LADY_CHECK, {"targetSeat":lady_eligible()[0]}, seat)
		T.Stage.ASSASSINATING:
			for s in players.size():
				if not T.is_bad_role(int(players[s].role)):
					command(T.Route.ASSASSINATE, {"targetSeat":s}, seat)
					return
