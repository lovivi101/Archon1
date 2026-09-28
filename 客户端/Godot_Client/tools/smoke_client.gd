extends SceneTree

func _initialize() -> void:
	call_deferred("run")

func run() -> void:
	var viewport := SubViewport.new()
	viewport.size = Vector2i(750, 1334)
	viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	root.add_child(viewport)
	var controller: AvalonController = root.get_node("AvalonApp").controller
	controller.create_local_room(5, 42)
	controller.ready()
	for number in range(2, 17):
		print("OPEN_PAGE %d" % number)
		var packed: PackedScene = load("res://scenes/page_%02d.tscn" % number)
		if packed == null:
			push_error("PAGE_LOAD_FAILED %d" % number)
			quit(1)
			return
		var scene: Control = packed.instantiate()
		viewport.add_child(scene)
		for i in 3:
			await process_frame
		if number in [2, 4, 6, 8, 9, 10, 13]:
			var output := ProjectSettings.globalize_path("res://verification/page_%02d.png" % number)
			var result := viewport.get_texture().get_image().save_png(output)
			if result != OK:
				push_error("CAPTURE_FAILED %d" % number)
				quit(1)
				return
		scene.queue_free()
		await process_frame
	print("ALL_15_PAGES_RENDERED")
	for i in 160:
		if not root.get_node("AvalonApp").local_game.running:
			break
		root.get_node("AvalonApp").local_game.bot_tick(true)
	if root.get_node("AvalonApp").model.stage != 6:
		push_error("LOCAL_GAME_DID_NOT_FINISH")
		quit(1)
		return
	print("LOCAL_GAME_FINISHED: %s" % root.get_node("AvalonApp").model.win_reason)
	var ending: Control = load("res://scenes/page_13.tscn").instantiate()
	viewport.add_child(ending)
	for i in 3:
		await process_frame
	viewport.get_texture().get_image().save_png(ProjectSettings.globalize_path("res://verification/page_13.png"))
	quit()
