extends SceneTree
## Feedback effects: shakes return exactly to where they started (also when repeated or when the page
## rebuilds mid-shake), the vibration setting is honoured, and a result's effect plays once however
## often the page redraws.
##   godot --headless --path . --script res://tools/smoke_effects.gd

func _initialize() -> void:
	call_deferred("run")

func fail(message: String) -> void:
	push_error("EFFECTS_FAILED " + message)
	quit(1)

func frames(count: int) -> void:
	for i in count:
		await process_frame

func wait(seconds: float) -> void:
	await create_timer(seconds).timeout

func run() -> void:
	var app: Node = root.get_node("AvalonApp")
	var controller: AvalonController = app.controller
	var model: AvalonModel = app.model

	# 1. One shake, then three in a row: both end exactly at the start position.
	var box := Control.new()
	box.position = Vector2(30, 40)
	root.add_child(box)
	await frames(1)
	AvalonEffects.shake(box)
	await wait(0.6)
	if box.position != Vector2(30, 40):
		return fail("single shake ended at %s" % box.position)
	for i in 3:
		AvalonEffects.shake(box)
		await frames(3)
	await wait(0.6)
	if box.position != Vector2(30, 40):
		return fail("repeated shakes ended at %s" % box.position)
	box.queue_free()

	# 2. The vibration switch: off means nothing is requested.
	var before := AvalonEffects.vibrations
	app.profile.data.vibration = false
	AvalonEffects.vibrate(50)
	if AvalonEffects.vibrations != before:
		return fail("vibrated while switched off")
	app.profile.data.vibration = true
	AvalonEffects.vibrate(50)
	if AvalonEffects.vibrations != before + 1:
		return fail("did not vibrate while switched on")

	# 3. Play local games until a result page shows, redraw it a few times and shake it mid-rebuild.
	controller.create_local_room(5, 7)
	controller.ready()
	controller.confirm_identity()
	for step in 400:
		if controller.page == 11:
			break
		app.local_game.bot_tick(true)
	if controller.page != 11:
		return fail("no result page, page=%d stage=%d" % [controller.page, model.stage])
	await frames(4)
	var page: Control = current_scene
	if page == null or not page.has_method("build_page"):
		return fail("result page scene missing")
	var serial := controller.result_serial
	AvalonEffects.shake(page)
	for i in 3:
		model.changed.emit()
		controller.last_notice = "redraw %d" % i # Changes the signature, so the page really rebuilds.
		controller.changed.emit()
		await frames(2)
	await wait(0.6)
	if page.position != Vector2.ZERO:
		return fail("page left at %s after shaking through rebuilds" % page.position)
	var plays: Array = page.effects_played.filter(func(entry): return entry == ["result", serial])
	if plays.size() != 1:
		return fail("result %d effect played %d times: %s" % [serial, plays.size(), str(page.effects_played)])
	print("EFFECTS_OK result=%d vibrations=%d" % [serial, AvalonEffects.vibrations])
	quit()
