extends SceneTree
## Friends against a local server on 8899: search a second player, add them, private messages both ways,
## invite them to my room, receive their invite, then remove them. The second player is a raw socket.
##   godot --path . --script res://tools/smoke_friends.gd -- shots=D:/tmp/shots

const URL := "ws://127.0.0.1:8899"
var args := {"shots": ""}
var buddy := WebSocketPeer.new()
var buddy_packets: Array = []
var buddy_id := ""
var buddy_name := ""

func _initialize() -> void:
	for arg in OS.get_cmdline_user_args():
		var parts := arg.split("=", true, 1)
		if parts.size() == 2:
			args[parts[0]] = parts[1]
	call_deferred("run")

func fail(message: String) -> void:
	push_error("FRIENDS_FAILED %s buddy=%s" % [message, str(buddy_packets.map(func(p): return p.route))])
	quit(1)

func shot(name: String) -> void:
	if str(args.shots).is_empty():
		return
	for i in 4:
		await process_frame
	DirAccess.make_dir_recursive_absolute(args.shots)
	root.get_texture().get_image().save_png("%s/%s.png" % [args.shots, name])

func buddy_send(route: int, payload: Dictionary) -> void:
	buddy.send(AvalonProtocol.encode(route, payload), WebSocketPeer.WRITE_MODE_BINARY)

## Pumps both connections until `done` returns true or time runs out.
func wait_for(done: Callable, seconds := 8.0) -> bool:
	var start := Time.get_ticks_msec()
	while Time.get_ticks_msec() - start < seconds * 1000:
		await process_frame
		buddy.poll()
		while buddy.get_available_packet_count() > 0:
			var packet := AvalonProtocol.decode(buddy.get_packet())
			if not packet.is_empty():
				buddy_packets.append(packet)
		if done.call():
			return true
	return false

func buddy_got(route: int, match: Callable = func(_p): return true) -> Dictionary:
	for packet in buddy_packets:
		if int(packet.route) == route and match.call(packet.payload):
			return packet.payload
	return {}

func run() -> void:
	var app: Node = root.get_node("AvalonApp")
	var controller: AvalonController = app.controller
	var model: AvalonModel = app.model

	controller.connect_for_friends()
	if not await wait_for(func(): return model.session == "logged_in" and controller.page == 16):
		return fail("login")
	if not await wait_for(func(): return controller.page == 16):
		return fail("friends page")

	buddy_name = "好友%d" % (Time.get_ticks_msec() % 100000)
	buddy.connect_to_url(URL)
	if not await wait_for(func(): return buddy.get_ready_state() == WebSocketPeer.STATE_OPEN):
		return fail("buddy connect")
	buddy_send(101, {"nickname": buddy_name})
	if not await wait_for(func(): return not buddy_got(101).is_empty()):
		return fail("buddy login")
	buddy_id = str(buddy_got(101).userId)

	controller.open_friends("search")
	controller.search_players(buddy_name)
	if not await wait_for(func(): return model.friend_search.any(func(e): return str(e.userId) == buddy_id)):
		return fail("search did not find the buddy")
	await shot("friends_search")
	controller.request_friend(buddy_id)
	if not await wait_for(func(): return not buddy_got(1106, func(p): return p.kind == "request").is_empty()):
		return fail("buddy did not get the request")
	buddy_send(1104, {"requesterId": model.user_id, "accept": true})
	if not await wait_for(func(): return model.friends.any(func(e): return str(e.userId) == buddy_id)):
		return fail("accepted friend did not show up")
	if controller.friends_tab != "friends":
		controller.friends_tab = "friends"

	buddy_send(1107, {"targetId": model.user_id, "text": "来一局？"})
	if not await wait_for(func(): return buddy_id in model.dm_unread):
		return fail("private message not marked unread")
	await shot("friends_list")
	controller.open_direct(buddy_id)
	if not await wait_for(func(): return model.dm_messages.any(func(m): return m.text == "来一局？")):
		return fail("private history missing")
	controller.send_direct("好")
	if not await wait_for(func(): return not buddy_got(1108, func(p): return p.text == "好").is_empty()):
		return fail("buddy did not get my message")
	if not await wait_for(func(): return model.dm_messages.any(func(m): return m.text == "好")):
		return fail("my message not shown")
	await shot("friends_direct")
	controller.close_direct()

	controller.create_room(URL, 5)
	if not await wait_for(func(): return model.session == "in_room"):
		return fail("create room")
	controller.invite_friend(buddy_id)
	if not await wait_for(func(): return str(buddy_got(1111).get("roomId", "")) == model.room_id):
		return fail("buddy did not get my room invite")

	buddy_send(102, {"roomId": "fr%d" % (Time.get_ticks_msec() % 100000)})
	if not await wait_for(func(): return not buddy_got(102).is_empty()):
		return fail("buddy join")
	buddy_send(1110, {"targetId": model.user_id})
	if not await wait_for(func(): return not model.room_invite.is_empty()):
		return fail("invite from buddy not received")
	controller.open_friends("friends")
	await shot("friends_invite")
	controller.dismiss_room_invite()

	controller.friends_tab = "recent"
	await shot("friends_recent")
	controller.board_tab = "friends"
	controller.open_leaderboard()
	await wait_for(func(): return false, 1.0)
	await shot("board_friends")
	controller.show_page(18)
	await shot("settings")
	controller.open_friends("friends")

	controller.remove_friend(buddy_id)
	controller.remove_friend(buddy_id)
	if not await wait_for(func(): return not model.friends.any(func(e): return str(e.userId) == buddy_id) and not buddy_got(1106, func(p): return p.kind == "removed").is_empty()):
		return fail("remove friends=%s notice=%s" % [str(model.friends), controller.last_notice])
	controller.leave_room()
	buddy.close()
	print("GODOT_FRIENDS_OK")
	quit()
