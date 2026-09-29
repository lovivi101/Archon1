extends Node
class_name AvalonController
const T = preload("res://scripts/mvc/avalon_types.gd")
signal changed
signal notice(message: String)
signal page_changed(page: int)
## Named sound cue for the audio service (see assets/audio/README.md).
signal game_event(name: String)
var model: AvalonModel
var network: AvalonNetwork
var local_game: Node
var profile: RefCounted
## Set by the app root; toggles the audio buses from the settings page.
var audio: Node
## AvalonShare (set by the app root, like audio); null in tools that do not need it.
var share: Node
## Room code the game was launched with (share card, web link); offered after login.
var invite_code := ""
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
var login_with_token := false
## Join the room after (re)login; off once the player leaves, so a later reconnect does not pull them back in.
var auto_join := false
## Last notice shown to the player; pages redraw it after rebuilding.
var last_notice := ""
## What to do once logged in: {"type": "quick"|"create"|"join", "count": int, "roomId": String}; empty joins the default room.
var pending_entry: Dictionary = {}
## Table size chosen in the lobby.
var lobby_count := 5
## Leaderboard page tab: "board" (全服排行), "friends" (好友排行), "history" (我的战绩) or "local" (本机记录).
var board_tab := "board"
## Excalibur recipient picked by the captain (10-player games).
var excalibur_choice := -1
## Second tap on "退出对局" within this tick deadline confirms leaving.
var exit_armed_until := 0
## Friends page tab: "friends", "requests", "recent" or "search".
var friends_tab := "friends"
## Friend whose "删除" was tapped once; a second tap within three seconds removes them.
var remove_armed := ""
var remove_armed_until := 0

func setup(next_model: AvalonModel, next_network: AvalonNetwork, demo: Node, store: RefCounted) -> void:
	model = next_model
	network = next_network
	local_game = demo
	profile = store
	network.packet_received.connect(_on_packet)
	network.state_changed.connect(_on_network_state)
	local_game.packet_received.connect(_on_packet)
	notice.connect(func(message: String): last_notice = message)
	model.changed.connect(func(): changed.emit())
	model.user_id = str(profile.data.id)
	model.nickname = str(profile.data.nickname)
	model.avatar = str(profile.data.get("avatar", model.avatar))
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
	if clampi(next_page, 1, 18) != page:
		last_notice = ""
	page = clampi(next_page, 1, 18)
	if page == 18:
		avatar_choice = model.avatar
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
	elif provider == "wechat":
		model.mode = "network"
		show_page(2)
		notice.emit("桌面版无微信授权；请在主界面选择连接服务器或本地练习")
	if not invite_code.is_empty():
		show_page(3)
		notice.emit("收到房间 %s 的邀请，点击“加入”即可进入" % invite_code)

func create_local_room(count := 5, seed_value := -1) -> void:
	manual_close = true
	network.close()
	model.mode = "local_demo"
	model.reset()
	local_game.create_room(model.user_id, model.nickname, count, seed_value, model.avatar)
	show_page(4)

## Connects (if needed), logs in, then performs `entry` (quick match / create / join by code).
## Without an entry the player joins the default room, as older builds did.
func connect_server(url: String, entry: Dictionary = {}) -> void:
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
	auto_join = true
	pending_entry = entry.duplicate()
	reconnect_attempts = 0
	if network.state == "open" and model.session in ["logged_in", "in_room"] and network.url == normalized:
		_enter_room()
	else:
		network.connect_to_url(normalized)
	show_page(3)

const AVATARS := ["avatar-player-knight", "avatar-loyal-female", "avatar-dwarf-warrior", "avatar-merlin", "avatar-morgana",
	"avatar-assassin", "avatar-loyal-male", "avatar-percival", "avatar-silver-queen", "avatar-green-ranger"]
## Avatar picked on the settings page before saving.
var avatar_choice := ""

## Saves nickname (1-12 characters) and avatar; they are sent with the next room join.
func save_profile(nickname: String, avatar: String) -> bool:
	var name := nickname.strip_edges()
	if name.is_empty() or name.length() > 12:
		notice.emit("昵称需要 1 到 12 个字")
		return false
	model.nickname = name
	model.avatar = avatar if avatar in AVATARS else AVATARS[0]
	profile.data.nickname = model.nickname
	profile.data.avatar = model.avatar
	profile.save()
	notice.emit("已保存")
	model.changed.emit()
	return true

func set_muted(muted: bool) -> void:
	AudioServer.set_bus_mute(0, muted)
	profile.data.muted = muted
	profile.save()
	model.changed.emit()

func quick_match(url: String, count: int) -> void:
	connect_server(url, {"type": "quick", "count": count})

func create_room(url: String, count: int) -> void:
	connect_server(url, {"type": "create", "count": count})

## Accepts a bare room code or a whole pasted invite message.
func join_room_code(url: String, code: String) -> void:
	var room_code := AvalonShare.extract_room_code(code)
	if room_code.is_empty():
		room_code = code.strip_edges()
	if room_code.is_empty():
		notice.emit("请输入房间号")
		return
	invite_code = ""
	connect_server(url, {"type": "join", "roomId": room_code})

## Room code from the clipboard (a code or an invite message), or "" with a notice.
func paste_invite() -> String:
	var code := AvalonShare.extract_room_code(share.paste_text()) if share != null else ""
	if code.is_empty():
		notice.emit("剪贴板里没有 6 位房间号")
	return code

## Sends the current room's invite (share sheet, WeChat card or clipboard, per platform).
func share_invite() -> void:
	if model.mode != "network" or model.room_id.is_empty():
		notice.emit("本地练习不能邀请好友，请先创建联机房间")
		return
	if share != null:
		notice.emit(share.share_invite(model.room_id, model.target_players, T.rules_text(model.target_players)))

func _enter_room() -> void:
	match str(pending_entry.get("type", "")):
		"none":
			# Connected only to browse records; stay out of rooms until the player picks one.
			pending_entry = {}
			auto_join = false
			return
		"quick":
			network.send(T.Route.QUICK_MATCH, {"playerCount": int(pending_entry.count), "nickname": model.nickname, "avatar": model.avatar})
		"create":
			network.send(T.Route.CREATE_ROOM, {"playerCount": int(pending_entry.count), "nickname": model.nickname, "avatar": model.avatar})
		"join":
			network.send(T.Route.JOIN_ROOM, {"roomId": str(pending_entry.roomId), "mustExist": true, "nickname": model.nickname, "avatar": model.avatar})
		_:
			network.send(T.Route.JOIN_ROOM, {"roomId": model.room_id, "nickname": model.nickname, "avatar": model.avatar})
	# After the first join, reconnects go back to the same room by id.
	pending_entry = {}

func leave_room() -> void:
	if model.mode == "local_demo":
		local_game.running = false
	elif network.state == "open":
		# Tell the server so the seat is freed (or handed to autopilot mid-game); stay connected and logged in.
		network.send(T.Route.LEAVE_ROOM, {})
		model.session = "logged_in"
	auto_join = false
	model.reset()
	if share != null:
		share.set_share_target(AvalonShare.TITLE)
	show_page(2)

## "Play again" from the results page: online, a Ready resets the finished room (or readies in the new lobby).
func play_again() -> void:
	if model.mode == "network" and network.state == "open" and model.session == "in_room":
		_send(T.Route.READY, {"ready": true})
		show_page(4)
	else:
		create_local_room()

## Leaving mid-game needs a second tap within three seconds; the server then plays the seat.
func exit_game() -> void:
	if Time.get_ticks_msec() > exit_armed_until:
		exit_armed_until = Time.get_ticks_msec() + 3000
		notice.emit("再点一次“退出”确认离开，你的座位将由 AI 托管")
		return
	exit_armed_until = 0
	leave_room()

func is_online() -> bool:
	return network.state == "open" and model.session in ["logged_in", "in_room"]

## Leaderboard page: fetch from the server when connected.
func open_leaderboard() -> void:
	show_page(15)
	if is_online():
		_request_boards()

func _request_boards() -> void:
	network.send(T.Route.LEADERBOARD, {"limit": 50})
	network.send(T.Route.LEADERBOARD, {"limit": 50, "scope": "friends"})
	network.send(T.Route.MATCH_HISTORY, {"limit": 30})

## Connects and logs in without joining a room, to browse records.
func connect_for_records() -> void:
	connect_server(model.server_url, {"type": "none"})
	show_page(15)

## Friends page: fetch the lists from the server when connected.
func open_friends(tab := "") -> void:
	if not tab.is_empty():
		friends_tab = tab
	show_page(16)
	if is_online():
		network.send(T.Route.FRIEND_LIST, {})

## Connects and logs in without joining a room, to manage friends.
func connect_for_friends() -> void:
	connect_server(model.server_url, {"type": "none"})
	show_page(16)

func search_players(query: String) -> void:
	if query.strip_edges().is_empty():
		notice.emit("请输入玩家昵称或 ID")
		return
	friends_tab = "search"
	_social(T.Route.FRIEND_SEARCH, {"query": query.strip_edges()})

func request_friend(user_id: String) -> void:
	_social(T.Route.FRIEND_REQUEST, {"targetId": user_id})

func reply_friend(user_id: String, accept: bool) -> void:
	_social(T.Route.FRIEND_REPLY, {"requesterId": user_id, "accept": accept})

## Needs a second tap within three seconds, like leaving a game.
func remove_friend(user_id: String) -> void:
	if remove_armed != user_id or Time.get_ticks_msec() > remove_armed_until:
		remove_armed = user_id
		remove_armed_until = Time.get_ticks_msec() + 3000
		notice.emit("再点一次“删除”确认删除好友")
		return
	remove_armed = ""
	_social(T.Route.FRIEND_REMOVE, {"targetId": user_id})

func open_direct(user_id: String) -> void:
	model.dm_target = user_id
	model.dm_messages = []
	model.dm_unread.erase(user_id)
	_social(T.Route.DIRECT_HISTORY, {"targetId": user_id})
	model.changed.emit()

func close_direct() -> void:
	model.dm_target = ""
	model.dm_messages = []
	model.changed.emit()

func send_direct(text: String) -> bool:
	var message := text.strip_edges()
	if message.is_empty() or model.dm_target.is_empty():
		return false
	return _social(T.Route.DIRECT_CHAT, {"targetId": model.dm_target, "text": message})

## Invites an online friend to the room I am in (before the game starts).
func invite_friend(user_id: String) -> void:
	if model.mode != "network" or model.session != "in_room":
		notice.emit("先创建或加入联机房间，再邀请好友")
		return
	_social(T.Route.ROOM_INVITE, {"targetId": user_id})

func accept_room_invite() -> void:
	var room_id := str(model.room_invite.get("roomId", ""))
	model.room_invite = {}
	if not room_id.is_empty():
		connect_server(model.server_url, {"type": "join", "roomId": room_id})

func dismiss_room_invite() -> void:
	model.room_invite = {}
	model.changed.emit()

## Friends need the server even while a local practice game is open.
func _social(route: int, payload: Dictionary) -> bool:
	if not is_online():
		notice.emit("好友功能需要先连接服务器")
		return false
	return network.send(route, payload)

## Opens the full replay of a past match on the replay page.
func open_match(match_id: int) -> void:
	_send(T.Route.MATCH_DETAIL, {"matchId": match_id})

## Replay of the game that just ended (not a server record).
func show_final_replay() -> void:
	model.replay = {}
	show_page(14)

func toggle_ready() -> bool:
	if model.mode == "local_demo":
		return ready()
	var me := model.my_seat()
	var is_ready: bool = me >= 0 and me < model.players.size() and bool(model.players[me].get("isReady", false))
	return _send(T.Route.READY, {"ready": not is_ready})

func send_chat(text: String) -> bool:
	var message := text.strip_edges()
	if message.is_empty():
		return false
	return _send(T.Route.CHAT, {"text": message})

func end_speech() -> bool:
	return _send(T.Route.END_SPEECH, {})

func lady_check(seat: int) -> bool:
	if model.stage != T.Stage.LADY_OF_LAKE or model.lady_holder != model.my_seat() or model.acted:
		return false
	model.acted = true
	var sent := _send(T.Route.LADY_CHECK, {"targetSeat": seat})
	if not sent:
		model.acted = false
	model.changed.emit()
	return sent

## seat -1 keeps the cards as played.
func use_excalibur(seat: int) -> bool:
	if model.stage != T.Stage.EXCALIBUR or model.excalibur_seat != model.my_seat() or model.acted:
		return false
	model.acted = true
	var sent := _send(T.Route.EXCALIBUR_USE, {"targetSeat": seat})
	if not sent:
		model.acted = false
	model.changed.emit()
	return sent

func choose_excalibur(seat: int) -> void:
	if seat in team_choice and seat != model.my_seat():
		excalibur_choice = seat
		model.changed.emit()

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
			if seat == excalibur_choice:
				excalibur_choice = -1
		elif team_choice.size() < model.get_team_size():
			team_choice.append(seat)
		model.changed.emit()
	elif model.stage == T.Stage.ASSASSINATING and model.my_role == T.Role.ASSASSIN:
		if seat in model.revealed_evil:
			notice.emit("不能刺杀坏人同伴")
			return
		team_choice = [seat]
		model.changed.emit()
	elif model.stage == T.Stage.LADY_OF_LAKE and model.lady_holder == model.my_seat():
		if not seat in model.lady_eligible:
			notice.emit("不能查验自己或曾经持有湖中仙女的玩家")
			return
		team_choice = [seat]
		model.changed.emit()

func submit_team() -> bool:
	if not model.is_captain() or model.stage != T.Stage.PROPOSING or team_choice.size() != model.get_team_size():
		notice.emit("请先选择 %d 名队员" % model.get_team_size())
		return false
	var payload := {"userId":model.user_id, "selectedSeats":team_choice.duplicate()}
	if bool(model.rules.get("excalibur", false)):
		if not excalibur_choice in team_choice or excalibur_choice == model.my_seat():
			notice.emit("请把王者之剑交给一名队员（不能是自己）")
			return false
		payload["excaliburSeat"] = excalibur_choice
	return _send(T.Route.PROPOSE_TEAM, payload)

func vote(approve: bool) -> bool:
	if model.stage != T.Stage.VOTING or model.voted:
		return false
	# Mark before sending: a local game answers synchronously and may already have moved on
	# (resetting the flag for the next stage) by the time _send returns.
	model.voted = true
	var sent := _send(T.Route.VOTE_TEAM, {"userId":model.user_id,"approve":approve})
	if not sent:
		model.voted = false
	model.changed.emit()
	return sent

func mission(success: bool) -> bool:
	if model.stage != T.Stage.MISSION or model.acted or not model.is_member():
		return false
	if not success and not T.is_bad_role(model.my_role):
		notice.emit("好人只能提交任务成功")
		return false
	model.acted = true
	var sent := _send(T.Route.MISSION_ACTION, {"userId":model.user_id,"success":success})
	if not sent:
		model.acted = false
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
			game_event.emit("ui_error")
			notice.emit(local_game.last_error if not local_game.last_error.is_empty() else "当前阶段无法执行此操作")
		return accepted
	if network.state != "open":
		notice.emit("服务器未连接")
		return false
	return network.send(route,payload)

func _on_network_state(state: String, message: String) -> void:
	model.connection = state
	notice.emit(message)
	model.changed.emit()
	if state == "closed" and network.close_code == network.CLOSE_LOGGED_IN_ELSEWHERE:
		manual_close = true # Reconnecting would just kick the other session back.
	if state == "open" and model.mode == "network":
		_send_login()

## Resumes the saved account for this server when a token exists, otherwise logs in as a new guest.
func _send_login() -> void:
	var tokens: Dictionary = profile.data.get("tokens", {})
	var token := str(tokens.get(model.server_url, ""))
	login_with_token = not token.is_empty()
	var payload := {"nickname":model.nickname}
	if login_with_token:
		payload["token"] = token
	network.send(T.Route.LOGIN, payload)

func _on_error(route: int, payload: Dictionary) -> void:
	match route:
		T.Route.LOGIN:
			if login_with_token and int(payload.get("code", 0)) == 401:
				# Expired or foreign token: forget it and start over as a guest.
				var tokens: Dictionary = profile.data.get("tokens", {})
				tokens.erase(model.server_url)
				profile.data.tokens = tokens
				profile.save()
				_send_login()
				return
		T.Route.VOTE_TEAM:
			model.voted = false
		T.Route.MISSION_ACTION:
			model.acted = false
	game_event.emit("ui_error")
	notice.emit(str(payload.get("message", "服务器拒绝请求")))
	model.changed.emit()

func _on_packet(route: int, payload: Dictionary) -> void:
	if int(payload.get("code",0)) != 0:
		_on_error(route, payload)
		return
	var turn_before := model.pending_action()
	var players_before := model.players.size()
	model.apply_packet(route,payload)
	_play_cue(route, payload, players_before)
	var turn_after := model.pending_action()
	if not turn_after.is_empty() and turn_after != turn_before:
		game_event.emit("your_turn")
	match route:
		T.Route.LOGIN:
			reconnect_attempts = 0
			if model.mode == "network":
				var tokens: Dictionary = profile.data.get("tokens", {})
				if payload.has("token"):
					tokens[model.server_url] = str(payload.token)
				profile.data.tokens = tokens
				profile.save()
				network.send(T.Route.MY_STATS, {})
				if auto_join:
					_enter_room()
				if page == 15:
					_request_boards()
				network.send(T.Route.FRIEND_LIST, {})
		T.Route.JOIN_ROOM:
			if share != null:
				share.set_share_target("%d 人局等你来，房间号 %s" % [model.target_players, model.room_id], model.room_id)
			show_page(4)
		T.Route.GAME_START:
			team_choice.clear()
			excalibur_choice = -1
			model.final_result = {}
			reveal_seen = false
			show_page(5)
		T.Route.IDENTITY_PUSH:
			reveal_seen = false
			show_page(6)
		T.Route.STAGE_CHANGE:
			team_choice.clear()
			excalibur_choice = -1
			if model.stage == T.Stage.PREPARING and page in [13, 14]:
				notice.emit("有玩家开始了新一局，点击“再来一局”回到房间")
			elif model.stage == T.Stage.NIGHT:
				if page < 5:
					show_page(5)
			elif page == 11:
				pass # Keep the result visible until the player taps Continue.
			elif reveal_seen or page not in [5,6]:
				show_page(page_for_stage(model.stage))
		T.Route.TEAM_PROPOSED:
			team_choice = model.selected_seats.duplicate()
		T.Route.MATCH_DETAIL:
			show_page(14)
		T.Route.FRIEND_REQUEST:
			notice.emit("已成为好友" if payload.get("accepted", false) else "好友申请已发送")
			network.send(T.Route.FRIEND_LIST, {})
			if friends_tab == "search":
				friends_tab = "friends"
		T.Route.FRIEND_REPLY:
			notice.emit("已添加好友" if payload.get("accept", false) else "已拒绝申请")
			network.send(T.Route.FRIEND_LIST, {})
		T.Route.FRIEND_REMOVE:
			if str(payload.get("targetId", "")) == model.dm_target:
				close_direct()
			notice.emit("已删除好友")
			network.send(T.Route.FRIEND_LIST, {})
		T.Route.FRIEND_UPDATE:
			var who := str(payload.get("nickname", "好友"))
			match str(payload.get("kind", "")):
				"request": notice.emit("%s 请求添加你为好友" % who)
				"accepted": notice.emit("%s 已成为你的好友" % who)
				"removed":
					if str(payload.get("userId", "")) == model.dm_target:
						close_direct()
			network.send(T.Route.FRIEND_LIST, {})
		T.Route.DIRECT_MESSAGE:
			if str(payload.get("senderId", "")) != model.dm_target or page != 16:
				notice.emit("%s：%s" % [payload.get("nickname", "好友"), str(payload.get("text", "")).left(30)])
		T.Route.ROOM_INVITE:
			notice.emit("邀请已发送")
		T.Route.ROOM_INVITE_PUSH:
			notice.emit("%s 邀请你加入 %d 人局（房间 %s），到好友页接受" % [payload.get("nickname", "好友"), int(payload.get("playerCount", 5)), payload.get("roomId", "")])
		T.Route.RATING_UPDATE:
			var delta := int(payload.get("delta", 0))
			notice.emit("段位分 %s%d（%s）" % ["+" if delta >= 0 else "", delta, payload.get("tier", "")])
		T.Route.LADY_RESULT:
			notice.emit("湖中仙女：%d号是%s" % [int(payload.get("targetSeat", -1)) + 1, "好人" if payload.get("isGood", true) else "坏人"])
		T.Route.EXCALIBUR_RESULT:
			notice.emit("王者之剑：%d号原本出的是%s" % [int(payload.get("targetSeat", -1)) + 1, "成功" if payload.get("originalSuccess", true) else "失败"])
		T.Route.VOTE_RESULT:
			last_result_route = route
			show_page(11)
		T.Route.MISSION_RESULT:
			last_result_route = route
			show_page(11)
		T.Route.GAME_END:
			auto_demo = false
			profile.record(model.snapshot())
			if page != 11:
				show_page(13) # From the last result page, "Continue" leads here instead.

## Sound cue for a server (or local game) event.
func _play_cue(route: int, payload: Dictionary, players_before: int) -> void:
	match route:
		T.Route.JOIN_ROOM: game_event.emit("room_enter")
		T.Route.PLAYER_JOIN:
			if model.players.size() > players_before:
				game_event.emit("player_join")
		T.Route.PLAYER_READY: game_event.emit("player_ready")
		T.Route.GAME_START: game_event.emit("game_start")
		T.Route.IDENTITY_PUSH: game_event.emit("role_reveal")
		T.Route.CHAT_MESSAGE:
			if int(payload.get("seat", -1)) != model.my_seat() and not payload.get("history", false):
				game_event.emit("speech_message")
		T.Route.TEAM_PROPOSED: game_event.emit("team_proposed")
		T.Route.VOTE_RESULT: game_event.emit("vote_pass" if payload.get("isPassed", false) else "vote_reject")
		T.Route.MISSION_RESULT: game_event.emit("mission_success" if payload.get("isSuccess", false) else "mission_fail")
		T.Route.EVIL_REVEALED: game_event.emit("evil_revealed")
		T.Route.LADY_USED: game_event.emit("lady_check")
		T.Route.LADY_RESULT: game_event.emit("lady_result")
		T.Route.EXCALIBUR_USED:
			if int(payload.get("targetSeat", -1)) >= 0:
				game_event.emit("excalibur_flip")
		T.Route.GAME_END:
			if str(payload.get("winReason", "")).begins_with("刺客"):
				game_event.emit("assassination")

func set_audio_bus(bus_name: String, enabled: bool) -> void:
	if audio:
		audio.set_enabled(bus_name, enabled)
	profile.data["music_on" if bus_name == AvalonAudio.MUSIC_BUS else "sfx_on"] = enabled
	profile.save()
	model.changed.emit()

func page_for_stage(stage: int) -> int:
	match stage:
		T.Stage.PREPARING: return 4
		T.Stage.NIGHT: return 5
		T.Stage.PROPOSING: return 8
		T.Stage.VOTING: return 9
		T.Stage.MISSION: return 10
		T.Stage.ASSASSINATING: return 12
		T.Stage.END: return 13
		T.Stage.SPEAKING: return 7
		T.Stage.LADY_OF_LAKE: return 17
		T.Stage.EXCALIBUR: return 10
	return 2
