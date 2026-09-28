extends SceneTree
## Local practice page flow: identity -> speeches -> proposing -> vote result -> next stage page.

func _initialize() -> void:
	call_deferred("run")

func fail(message: String) -> void:
	push_error(message)
	quit(1)

func run() -> void:
	var app: Node = root.get_node("AvalonApp")
	var controller: AvalonController = app.controller
	var model: AvalonModel = app.model
	controller.create_local_room(5, 42)
	controller.ready()
	controller.confirm_identity()
	if controller.page != 7:
		return fail("IDENTITY_CONFIRM_PAGE_FAILED page=%d" % controller.page)
	for i in 20:
		if model.stage == 2:
			break
		app.local_game.bot_tick(true)
		if model.stage == 7 and controller.page != 7:
			return fail("SPEAKING_PAGE_FAILED page=%d" % controller.page)
	if model.stage != 2 or controller.page != 8:
		return fail("PROPOSING_PAGE_FAILED stage=%d page=%d" % [model.stage, controller.page])
	if model.chat.filter(func(entry): return int(entry.seat) > 0).size() < 4:
		return fail("AI_SPEECHES_MISSING")
	app.local_game.bot_tick(true)
	app.local_game.bot_tick(true)
	if controller.page != 11 or not model.stage in [4, 7]:
		return fail("VOTE_RESULT_NOT_HELD page=%d stage=%d" % [controller.page, model.stage])
	controller.show_page(controller.page_for_stage(model.stage))
	if controller.page != (10 if model.stage == 4 else 7):
		return fail("NEXT_PAGE_FAILED page=%d stage=%d" % [controller.page, model.stage])
	print("CLIENT_PHASE_FLOW_OK")
	quit()
