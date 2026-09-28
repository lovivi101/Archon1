extends SceneTree

var routes: Array[int] = []

func _initialize() -> void:
	call_deferred("run")

func run() -> void:
	var app: Node = root.get_node("AvalonApp")
	var controller: AvalonController = app.controller
	var model: AvalonModel = app.model
	app.network.packet_received.connect(func(route: int, _payload: Dictionary): routes.append(route))
	controller.connect_server("ws://127.0.0.1:8899")
	var ready_sent := false
	var start_time := Time.get_ticks_msec()
	while Time.get_ticks_msec() - start_time < 60000:
		await process_frame
		if model.session == "in_room" and not ready_sent:
			ready_sent = true
			controller.ready()
		if model.stage == 2 and model.is_captain() and not 402 in routes.slice(maxi(0, routes.size() - 3)):
			var chosen: Array = []
			for i in model.get_team_size():
				chosen.append(i)
			controller._send(401, {"userId": model.user_id, "selectedSeats": chosen})
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
		if model.stage == 6:
			print("GODOT_SERVER_END_TO_END_OK routes=%s reason=%s" % [str(routes), model.win_reason])
			quit()
			return
	push_error("GODOT_SERVER_TIMEOUT routes=%s stage=%d connection=%s" % [str(routes), model.stage, model.connection])
	quit(1)
