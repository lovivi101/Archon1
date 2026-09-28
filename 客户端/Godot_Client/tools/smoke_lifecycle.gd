extends SceneTree
## Online lifecycle against a local server on 8899: finish a game, play again, leave the room,
## then get replaced by a second login with the same token (close code 4001) and stay disconnected.

const URL := "ws://127.0.0.1:8899"
var routes: Array[int] = []

func _initialize() -> void:
	call_deferred("run")

func fail(message: String) -> void:
	push_error("LIFECYCLE_FAILED %s routes=%s" % [message, str(routes)])
	quit(1)

## Plays whatever the local player is asked to do until `done` returns true or time runs out.
func play_until(done: Callable, seconds := 40.0) -> bool:
	var app: Node = root.get_node("AvalonApp")
	var controller: AvalonController = app.controller
	var model: AvalonModel = app.model
	var start := Time.get_ticks_msec()
	while Time.get_ticks_msec() - start < seconds * 1000:
		await process_frame
		if done.call():
			return true
		if controller.page in [5, 6] and model.my_role != 0:
			controller.confirm_identity()
		if controller.page == 11:
			controller.show_page(controller.page_for_stage(model.stage))
		if model.stage == 2 and model.is_captain() and controller.team_choice.is_empty():
			for i in model.get_team_size():
				controller.team_choice.append(i)
			controller.submit_team()
		if model.stage == 3 and not model.voted:
			controller.vote(true)
		if model.stage == 4 and model.is_member() and not model.acted:
			controller.mission(true)
		if model.stage == 5 and model.my_role == 4:
			for player in model.players:
				var seat := int(player.get("seatIndex", -1))
				if seat != model.my_seat() and seat not in model.visible_seats:
					controller.assassinate(seat)
					break
	return false

func run() -> void:
	var app: Node = root.get_node("AvalonApp")
	var controller: AvalonController = app.controller
	var model: AvalonModel = app.model
	app.network.packet_received.connect(func(route: int, _payload: Dictionary): routes.append(route))

	controller.connect_server(URL)
	if not await play_until(func(): return model.session == "in_room"):
		return fail("join")
	controller.ready()
	if not await play_until(func(): return model.stage == 6):
		return fail("first game did not end")

	var mark := routes.size()
	controller.play_again()
	if not await play_until(func(): return 301 in routes.slice(mark)):
		return fail("play again did not start a new game")
	if model.my_role == 0 or model.stage == 6:
		return fail("new game state was not applied")

	mark = routes.size()
	controller.leave_room()
	if not await play_until(func(): return 104 in routes.slice(mark), 5.0):
		return fail("leave was not acknowledged")
	if model.session != "logged_in" or controller.auto_join:
		return fail("left room but still marked as joining")

	# Same account logs in on another connection: this client must be closed with 4001 and stay offline.
	var token := str(app.profile.data.tokens.get(URL, ""))
	var other := WebSocketPeer.new()
	other.connect_to_url(URL)
	var start := Time.get_ticks_msec()
	var sent := false
	while Time.get_ticks_msec() - start < 5000 and app.network.state != "closed":
		await process_frame
		other.poll()
		if not sent and other.get_ready_state() == WebSocketPeer.STATE_OPEN:
			other.send(AvalonProtocol.encode(101, {"token": token}), WebSocketPeer.WRITE_MODE_BINARY)
			sent = true
	if app.network.close_code != 4001 or not controller.manual_close:
		return fail("expected close code 4001, got %d" % app.network.close_code)
	for i in 120:
		await process_frame
	if app.network.state != "closed":
		return fail("client reconnected after being replaced")
	other.close()
	print("GODOT_LIFECYCLE_OK routes=%d" % routes.size())
	quit()
