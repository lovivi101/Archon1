extends SceneTree
## Screenshots every page in a real state, stepping local games one bot action at a time.
var viewport: SubViewport
var out := ""
var taken := {}

func _initialize() -> void:
	call_deferred("run")

func shot(page: int, tag: String) -> void:
	var key := "%02d-%s" % [page, tag]
	if taken.has(key):
		return
	taken[key] = true
	var scene: Control = load("res://scenes/page_%02d.tscn" % page).instantiate()
	viewport.add_child(scene)
	for i in 4:
		await process_frame
	viewport.get_texture().get_image().save_png("%s/%s.png" % [out, key])
	scene.queue_free()
	await process_frame

func run() -> void:
	out = OS.get_environment("OUT")
	viewport = SubViewport.new()
	viewport.size = Vector2i(750, 1334)
	viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	root.add_child(viewport)
	var app: Node = root.get_node("AvalonApp")
	var c: AvalonController = app.controller
	var m: AvalonModel = app.model
	var login: Control = load("res://scenes/login.tscn").instantiate()
	viewport.add_child(login)
	for i in 4:
		await process_frame
	viewport.get_texture().get_image().save_png("%s/01-login.png" % out)
	login.queue_free()
	await shot(2, "home")
	await shot(3, "lobby")
	await shot(18, "settings")
	await shot(16, "friends")
	for setup in [[7, 21], [10, 5], [5, 9]]:
		c.create_local_room(setup[0], setup[1])
		await shot(4, "room-%dp" % setup[0])
		c.ready()
		await shot(5, "deal")
		await shot(6, "identity-%dp" % setup[0])
		var last_stage := -1
		for step in 4000:
			if not app.local_game.running:
				break
			if m.stage != last_stage:
				last_stage = m.stage
				var page := c.page_for_stage(m.stage)
				await shot(page, "%s-%dp" % [AvalonTypes.stage_name(m.stage), setup[0]])
				if m.stage == AvalonTypes.Stage.PROPOSING and m.is_captain():
					await shot(8, "captain-%dp" % setup[0])
			if c.last_result_route != 0 and not taken.has("11-result-%d" % c.last_result_route):
				await shot(11, "result-%d" % c.last_result_route)
			app.local_game.bot_tick(true)
		await shot(13, "end-%dp" % setup[0])
		c.show_final_replay()
		await shot(14, "replay-%dp" % setup[0])
	c.board_tab = "local"
	await shot(15, "board-local")
	c.board_tab = "board"
	await shot(15, "board-offline")
	quit()
