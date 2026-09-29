extends SceneTree
## Seat 0 plays like the AI, except that whenever it holds Excalibur the flip goes through the
## controller (as a tap would): the private result must arrive, be learned, and the game must go on.
func _initialize() -> void:
	call_deferred("run")
func run() -> void:
	var app: Node = root.get_node("AvalonApp")
	var c: AvalonController = app.controller
	var flips := 0
	var results := 0
	var seen := {"results": 0, "last": {}, "fails": 0}
	app.local_game.packet_received.connect(func(route, p):
		if route == AvalonTypes.Route.EXCALIBUR_RESULT:
			seen.results += 1
			seen.last = p)
	for g in 60:
		c.create_local_room(10, 5000 + g)
		c.ready()
		for step in 6000:
			if not app.local_game.running:
				break
			var m: AvalonModel = app.model
			if m.stage == AvalonTypes.Stage.EXCALIBUR and m.excalibur_seat == 0 and not m.acted:
				if flips == 0:
					var vp := SubViewport.new()
					vp.size = Vector2i(750, 1334)
					vp.render_target_update_mode = SubViewport.UPDATE_ALWAYS
					root.add_child(vp)
					var page: Control = load("res://scenes/page_10.tscn").instantiate()
					vp.add_child(page)
					for i in 4:
						await process_frame
					vp.get_texture().get_image().save_png(ProjectSettings.globalize_path("res://verification/page_10_excalibur.png"))
					vp.queue_free()
				var target: int = m.selected_seats.filter(func(s): return s != 0)[0]
				var before: int = seen.results
				if not c.use_excalibur(target):
					push_error("use_excalibur refused"); quit(1); return
				flips += 1
				if seen.results != before + 1 or int(seen.last.targetSeat) != target:
					push_error("no private result for flip on %d" % target); quit(1); return
				var learned: bool = m.facts.any(func(f): return int(f.seat) == target and not f.isGood)
				if learned == bool(seen.last.originalSuccess):
					push_error("fact mismatch: original success %s, learned evil %s" % [seen.last.originalSuccess, learned]); quit(1); return
				if not bool(seen.last.originalSuccess):
					seen.fails += 1
				continue
			app.local_game.bot_tick(true)
		if app.model.stage != AvalonTypes.Stage.END:
			push_error("game %d stuck at stage %d" % [g, app.model.stage]); quit(1); return
		if flips >= 6 and seen.fails >= 1:
			break
	print("EXC_HUMAN flips=%d results=%d revealed_fails=%d notice=%s" % [flips, seen.results, seen.fails, c.last_notice])
	print("GODOT_EXCALIBUR_OK")
	quit()
