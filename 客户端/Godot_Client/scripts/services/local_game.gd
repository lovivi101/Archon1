extends Node
## Offline authority. Emits the same routes as the TypeScript server.
const T = preload("res://scripts/mvc/avalon_types.gd")
signal packet_received(route: int, payload: Dictionary)
var players: Array = []
var stage := 0
var round_number := 1
var captain := 0
var rejections := 0
var team: Array = []
var results: Array = []
var votes: Dictionary = {}
var cards: Dictionary = {}
var clock := 0.0
var interval := 2.5
var running := false
var rng := RandomNumberGenerator.new()
var outcome: Dictionary = {}
var room_id := "练习"

func create_room(user_id: String, nickname: String, count := 5, seed_value := -1) -> void:
	rng.randomize()
	if seed_value >= 0:
		rng.seed = seed_value
	players = [{"userId":user_id, "nickname":nickname, "seatIndex":0, "isAi":false, "isReady":false, "role":0}]
	var names := ["灰袍贤者", "北境女王", "林中旅人", "山岭铁卫", "暗影祭司", "夜鸦", "堕落骑士", "湖畔游侠", "银月守卫"]
	for i in range(1, clampi(count, 5, 10)):
		players.append({"userId":"bot-%d" % i, "nickname":names[i-1], "seatIndex":i, "isAi":true, "isReady":true, "role":0})
	stage = 0
	round_number = 1
	captain = 0
	rejections = 0
	team = []
	results = []
	votes = {}
	cards = {}
	outcome = {}
	running = false
	publish_room(102)

func public_room() -> Dictionary:
	var visible := players.duplicate(true)
	for p in visible:
		p.role = 0
	return {"roomId":room_id, "players":visible, "stage":stage, "captainIdx":captain, "round":round_number, "failedVotes":rejections, "selectedSeats":team.duplicate(), "missionResults":results.duplicate()}

func publish_room(route := 201) -> void:
	packet_received.emit(route, {"code":0, "room":public_room()})

func start() -> void:
	if stage != 0 or players.is_empty():
		return
	var roles: Array = {
		5:[1,2,3,4,5], 6:[1,2,3,3,4,5], 7:[1,2,3,3,4,5,7],
		8:[1,2,3,3,3,4,5,7], 9:[1,2,3,3,3,3,4,5,6], 10:[1,2,3,3,3,3,4,5,8,6]
	}[players.size()].duplicate()
	for i in range(roles.size()-1, 0, -1):
		var j := rng.randi_range(0,i)
		var old = roles[i]
		roles[i] = roles[j]
		roles[j] = old
	for i in players.size():
		players[i].role = roles[i]
		players[i].isReady = true
	captain = 0
	running = true
	packet_received.emit(301, {"roomId":room_id})
	stage = 1
	publish_room()
	packet_received.emit(303, {"role":roles[0], "visibleSeats":visibility(0)})
	set_stage(1)

func visibility(seat: int) -> Array:
	var seen: Array = []
	var role := int(players[seat].role)
	for p in players:
		if int(p.seatIndex) == seat:
			continue
		if (role == 1 and T.is_bad_role(p.role) and p.role != 8) or (role == 2 and p.role in [1,5]) or (T.is_bad_role(role) and role != 7 and p.role in [4,5,6,8]):
			seen.append(p.seatIndex)
	return seen

func set_stage(next: int) -> void:
	stage = next
	clock = 0.0
	publish_room()
	packet_received.emit(302, {"stage":stage, "timeout":0})

func command(route: int, data: Dictionary, seat := 0) -> bool:
	if seat < 0 or seat >= players.size():
		return false
	match route:
		103:
			start()
			return true
		401:
			if stage != 2 or seat != captain:
				return false
			var selected: Array = data.get("selectedSeats", [])
			if selected.size() != T.team_size(players.size(),round_number):
				return false
			var unique := {}
			for s in selected:
				if not (s is int or s is float) or float(s) != floor(float(s)) or int(s) < 0 or int(s) >= players.size() or unique.has(int(s)):
					return false
				unique[int(s)] = true
			team = unique.keys()
			votes = {}
			packet_received.emit(402, {"captainSeat":captain, "selectedSeats":team.duplicate()})
			set_stage(3)
			return true
		501:
			if stage != 3 or votes.has(seat) or not data.get("approve") is bool:
				return false
			votes[seat] = data.approve
			if votes.size() == players.size():
				var ordered: Array = []
				for i in players.size():
					ordered.append(votes[i])
				var passed := ordered.count(true) > players.size()/2.0
				packet_received.emit(502, {"votes":ordered,"isPassed":passed})
				if passed:
					rejections = 0
					cards = {}
					set_stage(4)
				else:
					rejections += 1
					if rejections >= 5:
						finish(false,"连续五次组队被否决")
					else:
						captain = (captain+1)%players.size()
						set_stage(2)
			return true
		601:
			if stage != 4 or seat not in team or cards.has(seat) or not data.get("success") is bool:
				return false
			if not data.success and not T.is_bad_role(players[seat].role):
				return false
			cards[seat] = data.success
			if cards.size() == team.size():
				var fails := cards.values().count(false)
				var success := fails < (2 if players.size() >= 7 and round_number == 4 else 1)
				results.append(success)
				packet_received.emit(602,{"round":round_number,"isSuccess":success,"failCount":fails})
				if results.count(false) >= 3:
					finish(false,"三次任务失败")
				elif results.count(true) >= 3:
					set_stage(5)
				else:
					round_number += 1
					captain = (captain+1)%players.size()
					set_stage(2)
			return true
		701:
			var target := int(data.get("targetSeat",-1))
			if stage != 5 or players[seat].role != 4 or target < 0 or target >= players.size() or T.is_bad_role(players[target].role):
				return false
			finish(players[target].role != 1, "刺客选择了 %s，%s" % [players[target].nickname, "梅林阵亡" if players[target].role == 1 else "梅林存活"])
			return true
	return false

func finish(good: bool, reason: String) -> void:
	stage = 6
	running = false
	outcome = {"isGoodWin":good,"winReason":reason,"allRoles":players.duplicate(true)}
	packet_received.emit(702,outcome)

func _process(delta: float) -> void:
	if not running:
		return
	clock += delta
	if clock >= interval:
		clock = 0.0
		bot_tick()

func bot_tick(include_human := false) -> void:
	match stage:
		1:
			set_stage(2)
		2:
			if captain != 0 or include_human:
				var candidates: Array = range(players.size())
				var selected: Array = [captain]
				candidates.erase(captain)
				while selected.size() < T.team_size(players.size(),round_number):
					var index := rng.randi_range(0,candidates.size()-1)
					selected.append(candidates.pop_at(index))
				command(401,{"selectedSeats":selected},captain)
		3:
			for i in players.size():
				if (i != 0 or include_human) and not votes.has(i):
					command(501,{"approve":rng.randf() > 0.12},i)
		4:
			for i in team.duplicate():
				if (i != 0 or include_human) and not cards.has(i):
					command(601,{"success":not T.is_bad_role(players[i].role) or rng.randf() < 0.2},i)
		5:
			for p in players:
				if p.role == 4 and (p.seatIndex != 0 or include_human):
					var targets: Array = players.filter(func(q): return not T.is_bad_role(q.role))
					command(701,{"targetSeat":targets[rng.randi_range(0,targets.size()-1)].seatIndex},p.seatIndex)
