extends RefCounted
class_name AvalonEffects
## One-shot feedback: shake, vibration, pop-in, fade-in, press bounce and the countdown pulse.
## Every tween is created on the node it moves, so it dies with that node when a rebuild frees it.

## Vibrations actually requested (after the setting check); the effects smoke test reads it.
static var vibrations := 0

## Looked up at run time: tool scripts that use this class compile before the AvalonApp autoload exists.
static func vibration_enabled() -> bool:
	var tree := Engine.get_main_loop() as SceneTree
	var app: Node = tree.root.get_node_or_null("AvalonApp") if tree != null else null
	return app == null or bool(app.profile.data.get("vibration", true))

## Phones only; Input.vibrate_handheld does nothing on desktop.
static func vibrate(ms: int) -> void:
	if not vibration_enabled():
		return
	vibrations += 1
	Input.vibrate_handheld(ms)

## Jolts `target` and puts it back exactly where it was; a shake during a shake restarts from the
## original position instead of drifting.
static func shake(target: Control, strength := 12.0, duration := 0.35) -> void:
	if not is_instance_valid(target) or not target.is_inside_tree():
		return
	var origin: Vector2 = target.get_meta("shake_origin", target.position)
	if target.has_meta("shake_tween"):
		var running: Tween = target.get_meta("shake_tween")
		if running != null and running.is_valid():
			running.kill()
	target.set_meta("shake_origin", origin)
	var steps := 6
	var tween := target.create_tween()
	for i in steps:
		var fall := 1.0 - float(i) / steps
		var offset := Vector2(randf_range(-1.0, 1.0), randf_range(-1.0, 1.0)).normalized() * strength * fall
		tween.tween_property(target, "position", origin + offset, duration / (steps + 1))
	tween.tween_property(target, "position", origin, duration / (steps + 1))
	tween.finished.connect(func():
		target.position = origin
		target.remove_meta("shake_origin"))
	target.set_meta("shake_tween", tween)

## Grows from 60 % to full size around its centre while fading in.
## `delay` staggers a row of them.
static func pop_in(node: Control, duration := 0.25, delay := 0.0) -> void:
	if not is_instance_valid(node):
		return
	node.pivot_offset = node.size / 2.0
	node.scale = Vector2(0.6, 0.6)
	node.modulate.a = 0.0
	var tween := node.create_tween()
	if delay > 0.0:
		tween.tween_interval(delay)
	tween.tween_property(node, "scale", Vector2.ONE, duration).set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
	tween.parallel().tween_property(node, "modulate:a", 1.0, duration)

static func fade_in(node: CanvasItem, duration := 0.2) -> void:
	if not is_instance_valid(node):
		return
	node.modulate.a = 0.0
	node.create_tween().tween_property(node, "modulate:a", 1.0, duration)

## Shrinks `parts` (the button and its art) while held and springs back on release.
static func press_feedback(button: BaseButton, parts: Array) -> void:
	for part: Control in parts:
		part.pivot_offset = part.size / 2.0
	button.button_down.connect(func():
		for part: Control in parts:
			if is_instance_valid(part):
				part.create_tween().tween_property(part, "scale", Vector2(0.94, 0.94), 0.06))
	button.button_up.connect(func():
		for part: Control in parts:
			if is_instance_valid(part):
				part.create_tween().tween_property(part, "scale", Vector2.ONE, 0.12).set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT))
	button.pressed.connect(func(): vibrate(15))

## Endless beat for the last seconds of a countdown; it stops when the node is freed.
static func pulse(node: Control, amount := 1.2, period := 0.6) -> void:
	if not is_instance_valid(node) or node.has_meta("pulsing"):
		return
	node.set_meta("pulsing", true)
	node.pivot_offset = node.size / 2.0
	var tween := node.create_tween().set_loops()
	tween.tween_property(node, "scale", Vector2(amount, amount), period * 0.42).set_trans(Tween.TRANS_SINE)
	tween.tween_property(node, "scale", Vector2.ONE, period * 0.58).set_trans(Tween.TRANS_SINE)

## Turns a face-down card over: `back` folds away, then `face` unfolds in its place.
static func flip_reveal(back: Control, face: Control, delay := 0.0, duration := 0.26) -> void:
	if not is_instance_valid(back) or not is_instance_valid(face):
		return
	back.pivot_offset = back.size / 2.0
	face.pivot_offset = face.size / 2.0
	face.visible = false
	var tween := back.create_tween()
	tween.tween_interval(delay)
	tween.tween_property(back, "scale:x", 0.0, duration / 2.0).set_trans(Tween.TRANS_SINE)
	tween.tween_callback(func():
		back.visible = false
		if is_instance_valid(face):
			face.visible = true
			face.scale.x = 0.0
			face.create_tween().tween_property(face, "scale:x", 1.0, duration / 2.0).set_trans(Tween.TRANS_SINE))

## A gold banner in the middle of the screen that pops in and fades away. It lives on `host` (the app
## root), above the pages, so a page change right after it does not cut it short.
static func banner(host: Node, text: String, hold := 1.0) -> void:
	var old := host.get_node_or_null("TurnBanner")
	if old != null:
		old.name = "TurnBannerClosing" # Frees at the end of the frame; free the name now.
		old.queue_free()
	var canvas := CanvasLayer.new()
	canvas.name = "TurnBanner"
	canvas.layer = 50
	host.add_child(canvas)
	var panel := Panel.new()
	panel.position = Vector2(105, 560)
	panel.size = Vector2(540, 110)
	panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var style := StyleBoxFlat.new()
	style.bg_color = Color(0.1, 0.07, 0.03, 0.94)
	style.border_color = Color(0.95, 0.78, 0.4)
	style.set_border_width_all(3)
	style.set_corner_radius_all(14)
	panel.add_theme_stylebox_override("panel", style)
	canvas.add_child(panel)
	var label := Label.new()
	label.text = text
	label.size = panel.size
	label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	label.add_theme_font_size_override("font_size", 36)
	label.add_theme_color_override("font_color", Color(0.98, 0.86, 0.55))
	panel.add_child(label)
	pop_in(panel, 0.25)
	var tween := panel.create_tween()
	tween.tween_interval(0.25 + hold)
	tween.tween_property(panel, "modulate:a", 0.0, 0.3)
	tween.tween_callback(canvas.queue_free)

## Slides in from `offset` while fading in, after `delay`; for lists that fill in row by row.
static func slide_in(node: Control, delay := 0.0, offset := Vector2(-48, 0), duration := 0.22) -> void:
	if not is_instance_valid(node):
		return
	var home := node.position
	node.position = home + offset
	node.modulate.a = 0.0
	var tween := node.create_tween()
	if delay > 0.0:
		tween.tween_interval(delay)
	tween.tween_property(node, "position", home, duration).set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_OUT)
	tween.parallel().tween_property(node, "modulate:a", 1.0, duration)
