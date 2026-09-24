extends Node
class_name AvalonController
const T = preload("res://scripts/mvc/avalon_types.gd")
signal changed
signal notice(message: String)
signal page_changed(page: int)
var model: AvalonModel
var network: AvalonNetwork
var local_game: Node
var profile: RefCounted
var page := 1
var resume_page := 2
var auto_demo := false
var auto_elapsed := 0.0
var reveal_seen := false
var team_choice: Array = []
var last_result_route := 0
var reconnect_elapsed := 0.0
var reconnect_attempts := 0
var manual_close := false

func setup(next_model: AvalonModel, next_network: AvalonNetwork, demo: Node, store: RefCounted) -> void:
	model = next_model
	network = next_network
	local_game = demo
	profile = store
	network.packet_received.connect(_on_packet)
	network.state_changed.connect(_on_network_state)
	local_game.packet_received.connect(_on_packet)
	model.changed.connect(func(): changed.emit())
	model.user_id = str(profile.data.id)
	model.nickname = str(profile.data.nickname)
	model.server_url = str(profile.data.url)

func _process(delta: float) -> void:
	if auto_demo and model.mode == "local_demo" and local_game.running:
		auto_elapsed += delta
		if auto_elapsed >= 1.0:
			auto_elapsed = 0.0
			local_game.bot_tick(true)
	if model.mode == "network" and not manual_close and network.state in ["closed", "error"] and model.session in ["logged_in", "in_room"]:
		reconnect_elapsed += delta
		if reconnect_elapsed > mini(8.0, pow(2.0, reconnect_attempts)):
			reconnect_elapsed = 0.0
			reconnect_attempts += 1
			network.connect_to_url(model.server_url)

func show_page(next_page: int) -> void:
	page = clampi(next_page, 1, 16)
	if page in [14,15,16]:
		resume_page = 13 if model.stage == T.Stage.END else (4 if model.stage == T.Stage.PREPARING else maxi(7, page_for_stage(model.stage)))
	page_changed.emit(page)
	changed.emit()
	get_tree().change_scene_to_file("res://scenes/page_%02d.tscn" % page)

func login(provider: String) -> void:
	if provider == "guest":
		model.mode = "local_demo"
		model.session = "logged_in"
		show_page(2)
		return
	if provider == "wechat":
		notice.emit("桌面版无微信授权；请在主界面选择连接服务器或本地练习")
		model.mode = "network"
		show_page(2)

func create_local_room(count := 5, seed_value := -1) -> void:
	manual_close = true
	network.close()
	model.mode = "local_demo"
	model.reset()
	local_game.create_room(model.user_id, model.nickname, count, seed_value)
	show_page(4)

func connect_server(url: String) -> void:
	var normalized := url.strip_edges()
	if not normalized.begins_with("ws://") and not normalized.begins_with("wss://"):
		notice.emit("请输入 ws:// 或 wss:// 地址")
		return
	if normalized != model.server_url:
		model.reset()
	model.mode = "network"
	model.server_url = normalized
	profile.data.url = normalized
	profile.save()
	manual_close = false
	reconnect_attempts = 0
	network.connect_to_url(normalized)
	show_page(3)

func leave_room() -> void:
	if model.mode == "local_demo":
		local_game.running = false
	else:
		manual_close = true
		network.close()
	model.reset()
	show_page(2)

func ready() -> bool:
	if model.mode == "local_demo":
		return local_game.command(T.Route.READY, {}, 0)
	return _send(T.Route.READY, {"userId":model.user_id})

func confirm_identity() -> void:
	reveal_seen = true
	show_page(7 if model.stage == T.Stage.NIGHT else page_for_stage(model.stage))

func choose_seat(seat: int) -> void:
	if model.stage == T.Stage.PROPOSING and model.is_captain():
		if seat in team_choice:
			team_choice.erase(seat)
		elif team_choice.size() < model.get_team_size():
			team_choice.append(seat)
		model.changed.emit()
	elif model.stage == T.Stage.ASSASSINATING and model.my_role == T.Role.ASSASSIN:
		team_choice = [seat]
		model.changed.emit()

func submit_team() -> bool:
	if not model.is_captain() or model.stage != T.Stage.PROPOSING or team_choice.size() != model.get_team_size():
		notice.emit("请先选择 %d 名队员" % model.get_team_size())
		return false
	return _send(T.Route.PROPOSE_TEAM, {"userId":model.user_id, "selectedSeats":team_choice.duplicate()})

func vote(approve: bool) -> bool:
	if model.stage != T.Stage.VOTING or model.voted:
		return false
	var sent := _send(T.Route.VOTE_TEAM, {"userId":model.user_id,"approve":approve})
	if sent:
		model.voted = true
		model.changed.emit()
	return sent

func mission(success: bool) -> bool:
	if model.stage != T.Stage.MISSION or model.acted or not model.is_member():
		return false
	if not success and not T.is_bad_role(model.my_role):
		notice.emit("好人只能提交任务成功")
		return false
	var sent := _send(T.Route.MISSION_ACTION, {"userId":model.user_id,"success":success})
	if sent:
		model.acted = true
		model.changed.emit()
	return sent

func assassinate(seat: int) -> bool:
	if model.stage != T.Stage.ASSASSINATING or model.my_role != T.Role.ASSASSIN:
		return false
	return _send(T.Route.ASSASSINATE, {"userId":model.user_id,"targetSeat":seat})

func _send(route: int, payload: Dictionary) -> bool:
	if model.mode == "local_demo":
		var accepted: bool = local_game.command(route, payload, model.my_seat())
		if not accepted:
			notice.emit("当前阶段无法执行此操作")
		return accepted
	if network.state != "open":
		notice.emit("服务器未连接")
		return false
	return network.send(route,payload)

func _on_network_state(state: String, message: String) -> void:
	model.connection = state
	notice.emit(message)
	model.changed.emit()
	if state == "open" and model.mode == "network":
		network.send(T.Route.LOGIN, {"userId":model.user_id,"nickname":model.nickname})

func _on_packet(route: int, payload: Dictionary) -> void:
	if model.mode == "network" and int(payload.get("code",0)) != 0:
		notice.emit(str(payload.get("message","服务器拒绝请求")))
		return
	model.apply_packet(route,payload)
	match route:
		T.Route.LOGIN:
			reconnect_attempts = 0
			if model.mode == "network":
				network.send(T.Route.JOIN_ROOM, {"roomId":model.room_id,"userId":model.user_id,"nickname":model.nickname})
		T.Route.JOIN_ROOM:
			show_page(4)
		T.Route.GAME_START:
			team_choice.clear()
			reveal_seen = false
			show_page(5)
		T.Route.IDENTITY_PUSH:
			reveal_seen = false
			show_page(6)
		T.Route.STAGE_CHANGE:
			team_choice.clear()
			if model.stage == T.Stage.NIGHT:
				if page < 5:
					show_page(5)
			elif page == 11:
				pass # Keep the result visible until the player taps Continue.
			elif reveal_seen or page not in [5,6]:
				show_page(page_for_stage(model.stage))
		T.Route.TEAM_PROPOSED:
			team_choice = model.selected_seats.duplicate()
		T.Route.VOTE_RESULT:
			last_result_route = route
			show_page(11)
		T.Route.MISSION_RESULT:
			last_result_route = route
			show_page(11)
		T.Route.GAME_END:
			auto_demo = false
			profile.record(model.snapshot())
			show_page(13)

func page_for_stage(stage: int) -> int:
	match stage:
		T.Stage.PREPARING: return 4
		T.Stage.NIGHT: return 5
		T.Stage.PROPOSING: return 8
		T.Stage.VOTING: return 9
		T.Stage.MISSION: return 10
		T.Stage.ASSASSINATING: return 12
		T.Stage.END: return 13
	return 2
