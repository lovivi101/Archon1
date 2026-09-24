extends SceneTree

func _initialize() -> void:
	call_deferred("run")

func run() -> void:
	var app: Node = root.get_node("AvalonApp")
	var controller: AvalonController = app.controller
	controller.create_local_room(5, 42)
	controller.ready()
	controller.confirm_identity()
	if controller.page != 7:
		push_error("IDENTITY_CONFIRM_PAGE_FAILED")
		quit(1)
		return
	app.local_game.bot_tick(true)
	if controller.page != 8:
		push_error("PROPOSING_PAGE_FAILED")
		quit(1)
		return
	app.local_game.bot_tick(true)
	app.local_game.bot_tick(true)
	if controller.page != 11 or app.model.stage != 4:
		push_error("VOTE_RESULT_NOT_HELD page=%d stage=%d" % [controller.page, app.model.stage])
		quit(1)
		return
	controller.show_page(controller.page_for_stage(app.model.stage))
	if controller.page != 10:
		push_error("MISSION_PAGE_FAILED")
		quit(1)
		return
	print("CLIENT_PHASE_FLOW_OK")
	quit()
