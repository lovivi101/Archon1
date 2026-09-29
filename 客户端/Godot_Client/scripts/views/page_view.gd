extends Control

const T = preload("res://scripts/mvc/avalon_types.gd")
@export_range(2, 18) var page_id := 2
var catalog: Dictionary = {}
var layer: Control
var status: Label
## Text fields by name; their text, caret and focus survive rebuilds.
var inputs: Dictionary = {}
var search_text := ""
var timer_label: Label
## Chat boxes that stay scrolled to the newest message (see _process).
var pinned_scrolls: Array = []
var _rebuild_queued := false
var _signature := ""

## Seats sit evenly on an ellipse around the table, seat 1 at the top, clockwise.
## Positions are avatar centres; the band 330..760 is kept free for seats below the mission track.
const SEAT_CENTER := Vector2(375, 535)
const SEAT_RADIUS := Vector2(255, 160)
## Circle centres inside panel_mission_hud, as fractions of its width (measured from the art).
const TRACK_SLOTS := [0.302, 0.455, 0.605, 0.757, 0.910]
const TRACK_X := 95.0
const TRACK_Y := 206.0
const TRACK_WIDTH := 560.0

static func seat_position(index: int, count: int) -> Vector2:
	var angle := -PI / 2.0 + TAU * float(index) / float(maxi(count, 1))
	return SEAT_CENTER + Vector2(cos(angle) * SEAT_RADIUS.x, sin(angle) * SEAT_RADIUS.y)

## Avatar size for a table: smaller at 8-10 seats so neighbours do not overlap.
static func seat_size(count: int) -> float:
	return 83.0 if count <= 7 else 72.0

## Nickname for seat plates and lists; AI seats carry a badge instead of the "AI_" prefix.
static func display_name(nickname: String) -> String:
	return nickname.trim_prefix("AI_")
const GOLD := Color(0.95, 0.78, 0.4)
const RED := Color(0.95, 0.45, 0.4)
const BLUE := Color(0.55, 0.75, 1.0)

func _ready() -> void:
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string("res://assets/ui/catalog.json"))
	if parsed is Dictionary:
		catalog = parsed
	layer = Control.new()
	layer.name = "DynamicContent"
	layer.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(layer)
	AvalonApp.controller.changed.connect(_refresh)
	AvalonApp.controller.notice.connect(_notice)
	_refresh()

func _exit_tree() -> void:
	if AvalonApp.controller.changed.is_connected(_refresh):
		AvalonApp.controller.changed.disconnect(_refresh)
	if AvalonApp.controller.notice.is_connected(_notice):
		AvalonApp.controller.notice.disconnect(_notice)

## Coalesces change notifications into at most one rebuild per frame.
func _refresh() -> void:
	if _rebuild_queued:
		return
	_rebuild_queued = true
	_rebuild.call_deferred()

func _rebuild() -> void:
	_rebuild_queued = false
	if not is_instance_valid(layer):
		return
	var signature := _page_signature()
	if signature == _signature:
		return
	_signature = signature
	# Keep whatever the player is typing across rebuilds.
	var kept := {}
	for key in inputs:
		var field: LineEdit = inputs[key]
		if is_instance_valid(field):
			kept[key] = [field.text, field.caret_column, field.has_focus()]
	for child in layer.get_children():
		child.queue_free()
	inputs = {}
	pinned_scrolls = []
	status = null
	timer_label = null
	build_page()
	for key in kept:
		if inputs.has(key) and not str(kept[key][0]).is_empty():
			var field: LineEdit = inputs[key]
			field.text = kept[key][0]
			field.caret_column = kept[key][1]
			if kept[key][2]:
				field.grab_focus()

## Everything a page draws from; an unchanged signature means nothing to redraw.
func _page_signature() -> String:
	var snapshot: Dictionary = AvalonApp.model.snapshot()
	snapshot.erase("seconds_left")
	var controller: AvalonController = AvalonApp.controller
	return JSON.stringify([snapshot, controller.team_choice, controller.last_notice, controller.last_result_route, controller.lobby_count, controller.board_tab,
		controller.excalibur_choice, controller.avatar_choice, AvalonApp.profile.data.get("muted", false),
		AvalonApp.profile.data.get("music_on", true), AvalonApp.profile.data.get("sfx_on", true),
		AvalonApp.profile.data.friends.size(), AvalonApp.profile.data.matches.size()])

func _process(_delta: float) -> void:
	# Jump to the bottom only when the content height changes, so reading back up is not undone.
	for scroll in pinned_scrolls:
		if is_instance_valid(scroll):
			var bottom: float = scroll.get_v_scroll_bar().max_value
			if bottom != float(scroll.get_meta("pinned_bottom", -1.0)):
				scroll.set_meta("pinned_bottom", bottom)
				scroll.scroll_vertical = int(bottom)
	if is_instance_valid(timer_label):
		var left: int = AvalonApp.model.seconds_left()
		timer_label.text = "%d 秒" % left if left >= 0 else ""

func _notice(message: String) -> void:
	if is_instance_valid(status):
		status.text = message

## Draws the result card for the finished game (or the open server replay), saves it and shows a preview
## with the platform's share button. The preview sits above the page layer, so rebuilds keep it.
func share_result() -> void:
	var share: AvalonShare = AvalonApp.share
	var data := AvalonShare.card_data(AvalonApp.model)
	var image: Image = await share.render_card(data)
	if image == null or image.is_empty():
		_notice("无法生成分享图，战绩文字已复制")
		share.copy_text(AvalonShare.card_text(data))
		return
	close_share_preview()
	var saved := share.save_card(image)
	var overlay := Control.new()
	overlay.name = "SharePreview"
	overlay.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(overlay)
	var dim := ColorRect.new()
	dim.color = Color(0, 0, 0, 0.85)
	dim.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	dim.mouse_filter = Control.MOUSE_FILTER_STOP
	overlay.add_child(dim)
	var preview := TextureRect.new()
	preview.texture = ImageTexture.create_from_image(image)
	preview.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	preview.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	preview.position = Vector2(105, 90)
	preview.size = Vector2(540, 720)
	overlay.add_child(preview)
	var page_layer := layer
	layer = overlay
	var hint := text_label("分享图已保存：%s" % saved if not saved.is_empty() else "分享图未能保存到文件", 60, 830, 630, 80, 17)
	button(share.share_label(), 90, 930, 280, func():
		var rect := get_viewport().get_final_transform() * preview.get_global_rect()
		hint.text = share.share_card(image, data, rect, saved))
	button("关闭", 380, 930, 280, close_share_preview, "button_secondary_dark")
	layer = page_layer

func close_share_preview() -> void:
	var overlay := get_node_or_null("SharePreview")
	if overlay != null:
		overlay.name = "SharePreviewClosing"
		overlay.queue_free()

# ---- building blocks ----

func art(name: String, x: float, y: float, width: float, parent: Control = layer) -> TextureRect:
	var rect := TextureRect.new()
	var path := "res://assets/ui/%s.png" % name
	var source: Texture2D = load(path)
	if source == null:
		return rect
	var box: Array = catalog.get(name, [0, 0, source.get_width(), source.get_height()])
	var atlas := AtlasTexture.new()
	atlas.atlas = source
	atlas.region = Rect2(float(box[0]), float(box[1]), float(box[2]), float(box[3]))
	rect.texture = atlas
	rect.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	rect.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	rect.position = Vector2(x, y)
	rect.size = Vector2(width, width * float(box[3]) / float(box[2]))
	rect.mouse_filter = Control.MOUSE_FILTER_IGNORE
	parent.add_child(rect)
	return rect

func text_label(value: String, x: float, y: float, width: float, height: float, size := 26, align := HORIZONTAL_ALIGNMENT_CENTER, color := Color(0.95, 0.9, 0.78)) -> Label:
	var label := Label.new()
	label.text = value
	label.position = Vector2(x, y)
	label.size = Vector2(width, height)
	label.horizontal_alignment = align
	label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	label.add_theme_font_size_override("font_size", size)
	label.add_theme_color_override("font_color", color)
	label.add_theme_color_override("font_shadow_color", Color(0, 0, 0, 0.9))
	label.add_theme_constant_override("shadow_offset_x", 2)
	label.add_theme_constant_override("shadow_offset_y", 2)
	layer.add_child(label)
	return label

func button(value: String, x: float, y: float, width: float, action: Callable, kind := "button_primary_blue") -> Button:
	var bg := art(kind, x, y, width)
	var control := Button.new()
	control.flat = true
	control.text = value
	control.position = bg.position
	control.size = bg.size
	control.add_theme_font_size_override("font_size", 25)
	control.add_theme_color_override("font_color", Color(0.97, 0.9, 0.75))
	control.add_theme_color_override("font_hover_color", Color.WHITE)
	control.pressed.connect(func(): AvalonApp.audio.play_sfx("ui_click"))
	control.pressed.connect(action)
	layer.add_child(control)
	return control

## Small framed button for choices (player count, seat pickers); `selected` draws it highlighted.
func chip(value: String, x: float, y: float, width: float, height: float, action: Callable, selected := false) -> Button:
	dark_panel(x, y, width, height, GOLD if selected else Color(0.51, 0.4, 0.24), Color(0.16, 0.12, 0.05, 0.95) if selected else Color(0.025, 0.04, 0.06, 0.92))
	var control := Button.new()
	control.flat = true
	control.text = value
	control.position = Vector2(x, y)
	control.size = Vector2(width, height)
	control.add_theme_font_size_override("font_size", 22)
	control.add_theme_color_override("font_color", GOLD if selected else Color(0.95, 0.9, 0.78))
	control.pressed.connect(func(): AvalonApp.audio.play_sfx("ui_click"))
	control.pressed.connect(action)
	layer.add_child(control)
	return control

func line_edit(key: String, value: String, placeholder: String, x: float, y: float, width: float, height: float) -> LineEdit:
	var field := LineEdit.new()
	field.text = value
	field.placeholder_text = placeholder
	field.position = Vector2(x, y)
	field.size = Vector2(width, height)
	field.add_theme_font_size_override("font_size", 22)
	layer.add_child(field)
	inputs[key] = field
	return field

func field_text(key: String) -> String:
	return (inputs[key] as LineEdit).text if inputs.has(key) and is_instance_valid(inputs[key]) else ""

func header(title: String, subtitle := "") -> void:
	art("panel_header_empty", 75, 20, 600)
	# The frame's dark interior runs from about y 58 to 140; both lines stay inside it.
	if subtitle.is_empty():
		text_label(title, 100, 42, 550, 86, 30)
	else:
		text_label(title, 100, 50, 550, 46, 29)
		text_label(subtitle, 120, 96, 510, 34, 17, HORIZONTAL_ALIGNMENT_CENTER, Color(0.85, 0.8, 0.68))
	# Inside a room or a game, "back" means leaving, which has its own buttons.
	if page_id not in [2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 17]:
		var back := Button.new()
		back.text = "‹"
		back.flat = true
		back.position = Vector2(31, 38)
		back.size = Vector2(60, 70)
		back.add_theme_font_size_override("font_size", 48)
		back.pressed.connect(func(): AvalonApp.controller.show_page(2 if page_id in [3,15,16,18] else AvalonApp.controller.resume_page))
		layer.add_child(back)
	if page_id in [5, 6, 7, 8, 9, 10, 11, 12, 17] and AvalonApp.model.stage != T.Stage.END:
		var leave := Button.new()
		leave.text = "退出"
		leave.flat = true
		leave.position = Vector2(655, 45)
		leave.size = Vector2(80, 50)
		leave.add_theme_font_size_override("font_size", 20)
		leave.add_theme_color_override("font_color", Color(0.85, 0.75, 0.6))
		leave.pressed.connect(func(): AvalonApp.controller.exit_game())
		layer.add_child(leave)

## Bottom status text; a recent notice (e.g. a server error) takes precedence over the page's default hint.
func state_line(message: String) -> void:
	var notice_text: String = AvalonApp.controller.last_notice
	status = text_label(notice_text if not notice_text.is_empty() else message, 60, 1110 if page_id == 2 else 1234, 630, 43, 19)

func dark_panel(x: float, y: float, width: float, height: float, border := Color(0.51, 0.4, 0.24), fill := Color(0.025, 0.04, 0.06, 0.92), border_width := 3, radius := 8) -> Panel:
	var panel := Panel.new()
	panel.position = Vector2(x, y)
	panel.size = Vector2(width, height)
	panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var style := StyleBoxFlat.new()
	style.bg_color = fill
	style.border_color = border
	style.set_border_width_all(border_width)
	style.set_corner_radius_all(radius)
	panel.add_theme_stylebox_override("panel", style)
	layer.add_child(panel)
	return panel

## Translucent band behind text that sits on busy background art.
func strip(y: float, height: float, x := 40.0, width := 670.0) -> void:
	dark_panel(x, y, width, height, Color(0, 0, 0, 0), Color(0.01, 0.015, 0.025, 0.72), 0, 10)

## Small rounded tag (AI, 仙女, 查:好) drawn on seats.
func badge(value: String, x: float, y: float, color: Color, width := 0.0) -> void:
	var w := width if width > 0.0 else 14.0 + value.length() * 15.0
	dark_panel(x, y, w, 22, color, Color(0.02, 0.03, 0.05, 0.95), 2, 6)
	text_label(value, x, y - 1, w, 24, 14, HORIZONTAL_ALIGNMENT_CENTER, color)

## First art in `names` that exists, so new art (e.g. excalibur-icon) replaces a stand-in once it is added.
func art_any(names: Array, x: float, y: float, width: float) -> TextureRect:
	for name in names:
		if ResourceLoader.exists("res://assets/ui/%s.png" % name):
			return art(name, x, y, width)
	return art(str(names.back()), x, y, width)

func nav() -> void:
	var items := [["主页", 2], ["对局", 4], ["排行", 15], ["好友", 16]]
	for i in items.size():
		var item: Array = items[i]
		var x := 50 + i * 168
		var current := int(item[1]) == page_id
		art(["home-icon", "invite-swords-icon", "leaderboard-icon", "friends-icon"][i], x + 38, 1162, 48)
		text_label(str(item[0]), x, 1214, 125, 40, 19, HORIZONTAL_ALIGNMENT_CENTER, GOLD if current else Color(0.9, 0.85, 0.75))
		# The whole icon + label block is the tap target.
		var b := Button.new()
		b.flat = true
		b.position = Vector2(x, 1158)
		b.size = Vector2(125, 105)
		if int(item[1]) == 15:
			b.pressed.connect(AvalonApp.controller.open_leaderboard)
		else:
			b.pressed.connect(AvalonApp.controller.show_page.bind(int(item[1])))
		layer.add_child(b)

## Avatar with its name plate (seat number and name; gold for me, red border once revealed as evil).
## (x, y) is the avatar's top-left corner.
func player_avatar(seat: int, x: float, y: float, width := 83.0) -> void:
	var model: AvalonModel = AvalonApp.model
	var avatars: Array = AvalonController.AVATARS
	var name := "avatar-empty-slot"
	if seat >= 0 and seat < model.players.size():
		var chosen := str(model.players[seat].get("avatar", ""))
		name = chosen if chosen in avatars else avatars[seat % avatars.size()]
	var avatar := art(name, x, y, width)
	var plate_width := width + 34.0
	var plate_x := x + width / 2.0 - plate_width / 2.0
	if seat < 0 or seat >= model.players.size():
		dark_panel(plate_x, y + width + 2, plate_width, 26, Color(0.35, 0.3, 0.22), Color(0.02, 0.03, 0.05, 0.6), 1, 6)
		text_label("%d 空位" % (seat + 1) if seat >= 0 else "空位", plate_x, y + width + 1, plate_width, 28, 16, HORIZONTAL_ALIGNMENT_CENTER, Color(0.65, 0.62, 0.55))
		return
	var p: Dictionary = model.players[seat]
	var mine := seat == model.my_seat()
	var evil := seat in model.revealed_evil
	var online := bool(p.get("isOnline", true))
	if not online:
		avatar.modulate = Color(0.45, 0.45, 0.45)
	var border := RED if evil else (GOLD if mine else Color(0.45, 0.38, 0.26))
	dark_panel(plate_x, y + width + 2, plate_width, 26, border, Color(0.02, 0.03, 0.05, 0.85), 2 if mine or evil else 1, 6)
	var label := "%d %s" % [seat + 1, display_name(str(p.get("nickname", "玩家"))).left(4 if width < 80.0 else 5)]
	text_label(label if online else "%d 离线" % (seat + 1), plate_x, y + width + 1, plate_width, 28, 16, HORIZONTAL_ALIGNMENT_CENTER, GOLD if mine else Color(0.95, 0.9, 0.8))
	if bool(p.get("isAi", false)):
		badge("AI", x - 4, y - 2, Color(0.65, 0.75, 0.9), 30)

## Seats around the table with markers: a ring for the speaker (blue), the team or my pick (gold) and
## revealed evil (red); the captain's crown; ready / picked checks; Excalibur, Lady and what I learned.
func seats(interactive := false) -> void:
	var model: AvalonModel = AvalonApp.model
	var controller: AvalonController = AvalonApp.controller
	# Empty chairs only matter while players are still joining.
	var count := model.target_players if model.stage == T.Stage.PREPARING and model.mode != "local_demo" else model.players.size()
	count = mini(10, count)
	var size := seat_size(count)
	var half := size / 2.0
	for i in count:
		var center := seat_position(i, count)
		var x := center.x - half
		var y := center.y - half
		var speaking := model.stage == T.Stage.SPEAKING and i == model.speaker_seat
		var picked: bool = i in model.selected_seats or i in controller.team_choice
		var ring := BLUE if speaking else (GOLD if picked else (RED if i in model.revealed_evil else Color(0, 0, 0, 0)))
		if ring.a > 0.0:
			dark_panel(x - 5, y - 5, size + 10, size + 10, ring, Color(ring.r, ring.g, ring.b, 0.18), 4, 14)
		player_avatar(i, x, y, size)
		var ready_in_lobby: bool = model.stage == T.Stage.PREPARING and i < model.players.size() and bool(model.players[i].get("isReady", false))
		if ready_in_lobby or picked:
			art("check-icon", x + size - 20, y + size - 30, 30)
		if i == model.captain_seat and model.stage != T.Stage.PREPARING:
			art("crown-icon", center.x - 21, y - 30, 42)
		if speaking:
			art("microphone-icon", x + size - 14, y - 8, 30)
		if i == model.excalibur_seat or (model.stage == T.Stage.PROPOSING and i == controller.excalibur_choice):
			art_any(["excalibur-icon", "invite-swords-icon"], x - 16, y + size - 34, 34)
		if bool(model.rules.get("lady", false)) and i == model.lady_holder and model.stage != T.Stage.PREPARING:
			if ResourceLoader.exists("res://assets/ui/lady-of-lake-icon.png"):
				art("lady-of-lake-icon", x - 16, y + 18, 34)
			else:
				badge("仙女", x - 18, y + 22, BLUE, 44)
		if i in model.revealed_evil:
			art("mission-failure-emblem", x + size - 18, y - 8, 28)
		for fact in model.facts:
			if int(fact.seat) == i:
				badge("查:好" if fact.isGood else "查:坏", x + size - 30, y + half - 6, BLUE if fact.isGood else RED, 50)
		if interactive and i < model.players.size():
			var hit := Button.new()
			hit.flat = true
			hit.position = Vector2(x - 10, y - 10)
			hit.size = Vector2(size + 20, size + 40)
			hit.pressed.connect(controller.choose_seat.bind(i))
			layer.add_child(hit)

## Round, stage and captain (unless `show_status` is off, e.g. on result pages that show an earlier
## round), the countdown, and the mission track: five slots with results or team sizes, and the
## rejected-team counter in the track's left box.
func progress(show_status := true) -> void:
	var model: AvalonModel = AvalonApp.model
	if show_status:
		# Left of the header's bottom ornament, which hangs down to about y 190 in the middle.
		text_label("第 %d 轮 · %s · 队长 %d 号" % [model.round, T.stage_name(model.stage), model.captain_seat + 1], 70, 170, 290, 34, 20, HORIZONTAL_ALIGNMENT_LEFT)
		if model.seconds_left() >= 0:
			art("timer-icon", 590, 170, 30)
			timer_label = text_label("", 622, 166, 90, 40, 22, HORIZONTAL_ALIGNMENT_LEFT, GOLD)
			_process(0.0)
	var track_height := TRACK_WIDTH * 369.0 / 2145.0
	art("panel_mission_hud", TRACK_X, TRACK_Y, TRACK_WIDTH)
	var middle := TRACK_Y + track_height / 2.0
	text_label("否决\n%d / 5" % model.failed_votes, TRACK_X + 26, middle - 30, 92, 60, 16, HORIZONTAL_ALIGNMENT_CENTER, RED if model.failed_votes >= 3 else Color(0.85, 0.8, 0.7))
	var count := model.players.size()
	for i in 5:
		var cx: float = TRACK_X + TRACK_WIDTH * TRACK_SLOTS[i]
		if i < model.mission_results.size():
			art("mission-success-emblem" if model.mission_results[i] else "mission-failure-emblem", cx - 27, middle - 28, 54)
			continue
		var current := i == model.round - 1 and model.stage != T.Stage.END
		if current:
			dark_panel(cx - 27, middle - 27, 54, 54, GOLD, Color(0.3, 0.22, 0.05, 0.35), 3, 27)
		text_label("%d人" % T.team_size(count, i + 1), cx - 30, middle - 18, 60, 36, 18, HORIZONTAL_ALIGNMENT_CENTER, GOLD if current else Color(0.85, 0.8, 0.7))
		if T.needs_two_fails(count, i + 1):
			text_label("需2败", cx - 32, TRACK_Y + track_height - 4, 64, 22, 14, HORIZONTAL_ALIGNMENT_CENTER, Color(0.95, 0.6, 0.5))

## Seat list like "2号 小明、5号 阿强" for identity and vote summaries.
func seat_names(list: Array) -> String:
	var model: AvalonModel = AvalonApp.model
	var names: Array = []
	for seat in list:
		var index := int(seat)
		var nickname := display_name(str(model.players[index].get("nickname", "玩家"))) if index >= 0 and index < model.players.size() else "玩家"
		names.append("%d号 %s" % [index + 1, nickname])
	return "、".join(names) if not names.is_empty() else "无"

## Seat numbers only, like "1、2、5 号" (vote summaries, where names would not fit).
static func seat_numbers(list: Array) -> String:
	return "、".join(PackedStringArray(list.map(func(seat): return str(int(seat) + 1)))) + " 号" if not list.is_empty() else "无"

## What the night revealed, phrased for this player's role.
func identity_hint() -> String:
	var model: AvalonModel = AvalonApp.model
	var seen := seat_names(model.visible_seats)
	match model.my_role:
		T.Role.MERLIN:
			return "你看到的坏人：%s\n（莫德雷德不会被你看到）" % seen
		T.Role.PERCIVAL:
			return "梅林和莫甘娜在这些人中：%s" % seen
		T.Role.OBERON:
			return "你看不到同伴，同伴也看不到你"
	if T.is_bad_role(model.my_role):
		return "你的坏人同伴：%s" % seen
	return "你没有夜间信息，请通过发言和投票找出坏人"

## Chat (optionally one channel) in a scrolling box `limit` lines tall from `top`, pinned to the newest
## message; long messages wrap instead of running into the next line.
func chat_lines(top: float, limit: int, channel := "", line_height := 42.0) -> void:
	var model: AvalonModel = AvalonApp.model
	var lines: Array = model.chat.filter(func(entry): return channel.is_empty() or str(entry.get("channel", "all")) == channel)
	lines = lines.slice(maxi(0, lines.size() - 40))
	if lines.is_empty():
		text_label("还没有人发言", 80, top, 590, line_height, 19, HORIZONTAL_ALIGNMENT_LEFT, Color(0.7, 0.65, 0.55))
		return
	var rows: Array = []
	for entry in lines:
		var seat := int(entry.get("seat", -1))
		if seat < 0:
			rows.append(["【系统】%s" % entry.get("text", ""), BLUE])
			continue
		var prefix := "[坏人] " if str(entry.get("channel", "all")) == "evil" else ""
		rows.append(["%s%d号 %s：%s" % [prefix, seat + 1, display_name(str(entry.get("nickname", ""))).left(6), entry.get("text", "")], GOLD if seat == model.my_seat() else Color(0.95, 0.9, 0.78)])
	var scroll := scroll_lines(rows, 76, top, 604, limit * line_height, 19, 6)
	pinned_scrolls.append(scroll)

## Warns on pages that wait for a tap (identity, results) while the player's own clock is running.
func turn_alert(y: float) -> void:
	var action: String = AvalonApp.model.pending_action()
	if not action.is_empty():
		text_label("轮到你%s了，请尽快继续" % action, 80, y, 590, 44, 24, HORIZONTAL_ALIGNMENT_CENTER, RED)

func room_rules_text() -> String:
	var model: AvalonModel = AvalonApp.model
	var roles: Array = model.role_set if not model.role_set.is_empty() else T.roles_for(model.target_players)
	return "身份：%s\n特殊规则：%s" % [T.role_set_text(roles), T.rules_text(roles.size())]

## A scrolling list of lines; each line is a String or [text, color]. Entries with a Callable third item are buttons.
func scroll_lines(lines: Array, x: float, y: float, width: float, height: float, size := 19, separation := 10) -> ScrollContainer:
	var scroll := ScrollContainer.new()
	scroll.position = Vector2(x, y)
	scroll.size = Vector2(width, height)
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	var box := VBoxContainer.new()
	box.custom_minimum_size = Vector2(width - 16, 0)
	box.add_theme_constant_override("separation", separation)
	for line in lines:
		var text: String = line if line is String else str(line[0])
		var color: Color = line[1] if line is Array and line.size() > 1 else Color(0.95, 0.9, 0.78)
		var control: Control
		if line is Array and line.size() > 2:
			var entry := Button.new()
			entry.text = text
			entry.alignment = HORIZONTAL_ALIGNMENT_LEFT
			entry.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
			entry.pressed.connect(line[2])
			entry.add_theme_color_override("font_color", color)
			control = entry
		else:
			var label := Label.new()
			label.text = text
			label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
			label.add_theme_color_override("font_color", color)
			control = label
		control.custom_minimum_size = Vector2(width - 16, 0)
		control.add_theme_font_size_override("font_size", size)
		box.add_child(control)
	scroll.add_child(box)
	layer.add_child(scroll)
	return scroll

## Timeline of a stored match (server replay): roles, then every proposal, mission and Lady check.
func record_lines(record: Dictionary) -> Array:
	var roster: Array = record.get("players", [])
	var name_of := func(seat: int) -> String:
		return "%d号 %s" % [seat + 1, str(roster[seat].get("nickname", "")) if seat >= 0 and seat < roster.size() else ""]
	var good: Array = []
	var evil: Array = []
	for player in roster:
		var text := "%d号 %s（%s）" % [int(player.seat) + 1, player.nickname, T.role_name(int(player.role))]
		(evil if T.is_bad_role(int(player.role)) else good).append(text)
	var lines: Array = [["好人：" + "、".join(PackedStringArray(good)), BLUE], ["坏人：" + "、".join(PackedStringArray(evil)), RED]]
	var proposals: Array = record.get("proposals", [])
	var missions: Array = record.get("missions", [])
	var ladies: Array = record.get("ladyHistory", [])
	for round_number in range(1, 6):
		for proposal in proposals.filter(func(item): return int(item.round) == round_number):
			var votes: Array = proposal.get("votes", [])
			var team := "、".join(PackedStringArray(Array(proposal.team).map(func(seat): return "%d号" % (int(seat) + 1))))
			lines.append("第%d轮 %s 提名 %s → %s（赞成 %d/%d）" % [round_number, name_of.call(int(proposal.captainSeat)), team, "通过" if proposal.passed else "否决", votes.count(true), votes.size()])
		for mission in missions.filter(func(item): return int(item.round) == round_number):
			var text := "第%d轮任务%s，失败票 %d 张" % [round_number, "成功" if mission.success else "失败", int(mission.failCount)]
			var sword: Dictionary = mission.get("excalibur", {})
			if not sword.is_empty():
				var target := int(sword.targetSeat)
				text += "；%d号%s" % [int(sword.holderSeat) + 1, "用王者之剑翻转了%d号的牌" % (target + 1) if target >= 0 else "没有使用王者之剑"]
			lines.append([text, Color(0.6, 0.9, 0.6) if mission.success else RED])
		for lady in ladies.filter(func(item): return int(item.round) == round_number):
			var target := int(lady.targetSeat)
			var truth := "坏人" if target < roster.size() and T.is_bad_role(int(roster[target].role)) else "好人"
			lines.append(["%s 用湖中仙女查验了 %s（实际是%s）" % [name_of.call(int(lady.holderSeat)), name_of.call(target), truth], BLUE])
	lines.append([("好人胜利：" if record.get("isGoodWin", false) else "坏人胜利：") + str(record.get("winReason", "")), GOLD])
	return lines

## Replay line for one history event.
func history_text(event: Dictionary) -> String:
	var data: Dictionary = event.get("data", {})
	match int(event.get("route", 0)):
		303:
			return "你的身份：%s" % T.role_name(int(data.get("role", 0)))
		402:
			return "队长%d号提名：%s" % [int(data.get("captainSeat", 0)) + 1, ",".join(PackedStringArray(Array(data.get("selectedSeats", [])).map(func(s): return "%d号" % (int(s) + 1))))]
		502:
			var votes: Array = data.get("votes", [])
			return "投票%s（赞成 %d / %d）" % ["通过" if data.get("isPassed", false) else "否决", votes.count(true), votes.size()]
		602:
			return "第%d轮任务%s（失败票 %d）" % [int(data.get("round", 0)), "成功" if data.get("isSuccess", false) else "失败", int(data.get("failCount", 0))]
		903:
			return "%d号用湖中仙女查验了%d号" % [int(data.get("holderSeat", 0)) + 1, int(data.get("targetSeat", 0)) + 1]
		906:
			var target := int(data.get("targetSeat", -1))
			return "%d号%s" % [int(data.get("holderSeat", 0)) + 1, "用王者之剑翻转了%d号的牌" % (target + 1) if target >= 0 else "没有使用王者之剑"]
		702:
			return "游戏结束：%s" % data.get("winReason", "")
	return str(event.get("message", "对局事件"))

# ---- pages ----

func build_page() -> void:
	var model: AvalonModel = AvalonApp.model
	var controller: AvalonController = AvalonApp.controller
	match page_id:
		2:
			art(model.avatar, 48, 30, 83)
			text_label(model.nickname, 138, 35, 250, 40, 21, HORIZONTAL_ALIGNMENT_LEFT)
			if not model.stats.is_empty():
				text_label("%s · %d 分" % [model.stats.get("tier", ""), int(model.stats.get("rating", 0))], 138, 72, 300, 30, 16, HORIZONTAL_ALIGNMENT_LEFT, GOLD)
			var muted: bool = AvalonApp.profile.data.get("muted", false)
			var sound := art("sound-icon", 566, 36, 48)
			if muted:
				sound.modulate = Color(0.45, 0.45, 0.45)
			art("settings-icon", 664, 36, 48)
			text_label("静音" if muted else "声音", 550, 88, 80, 28, 17, HORIZONTAL_ALIGNMENT_CENTER, RED if muted else Color(0.9, 0.85, 0.75))
			text_label("设置", 648, 88, 80, 28, 17)
			for icon in [[550, func(): controller.set_muted(not muted)], [648, func(): controller.show_page(18)]]:
				var tap := Button.new()
				tap.flat = true
				tap.position = Vector2(icon[0], 30)
				tap.size = Vector2(80, 90)
				tap.pressed.connect(icon[1])
				layer.add_child(tap)
			var profile_button := Button.new()
			profile_button.flat = true
			profile_button.position = Vector2(40, 25)
			profile_button.size = Vector2(340, 95)
			profile_button.tooltip_text = "修改昵称和头像"
			profile_button.pressed.connect(func(): controller.show_page(18))
			layer.add_child(profile_button)
			art("game_logo_title", 145, 268, 460)
			button("联机对战", 145, 820, 460, func(): controller.show_page(3))
			text_label("本地练习人数", 90, 925, 570, 36, 19, HORIZONTAL_ALIGNMENT_LEFT)
			for i in 6:
				var count := 5 + i
				chip("%d人" % count, 90 + i * 96, 965, 86, 50, func(): controller.lobby_count = count; _refresh(), controller.lobby_count == count)
			button("本地练习（%d人）" % controller.lobby_count, 190, 1030, 370, func(): controller.create_local_room(controller.lobby_count), "button_secondary_dark")
			nav()
			state_line("本地练习可离线与 AI 对战，规则与联机相同")
		3:
			header("联机大厅", "选择人数后匹配或创建房间")
			dark_panel(60, 180, 630, 1030)
			text_label("服务器地址", 90, 200, 570, 40, 20, HORIZONTAL_ALIGNMENT_LEFT)
			line_edit("url", model.server_url, "ws://服务器地址:8888", 90, 245, 570, 56)
			text_label("对局人数", 90, 320, 570, 40, 20, HORIZONTAL_ALIGNMENT_LEFT)
			for i in 6:
				var count := 5 + i
				chip("%d人" % count, 90 + i * 96, 368, 86, 58, func(): controller.lobby_count = count; _refresh(), controller.lobby_count == count)
			text_label("身份：%s\n特殊规则：%s" % [T.role_set_text(T.roles_for(controller.lobby_count)), T.rules_text(controller.lobby_count)], 90, 440, 570, 90, 18, HORIZONTAL_ALIGNMENT_LEFT)
			button("快速匹配", 145, 555, 460, func(): controller.quick_match(field_text("url"), controller.lobby_count))
			button("创建房间", 190, 665, 370, func(): controller.create_room(field_text("url"), controller.lobby_count), "button_secondary_dark")
			text_label("加入好友的房间", 90, 780, 570, 40, 20, HORIZONTAL_ALIGNMENT_LEFT)
			line_edit("code", controller.invite_code, "输入 6 位房间号", 90, 828, 250, 56)
			chip("粘贴", 352, 826, 106, 60, func():
				var pasted := controller.paste_invite()
				if not pasted.is_empty():
					(inputs["code"] as LineEdit).text = pasted)
			chip("加入", 470, 826, 190, 60, func(): controller.join_room_code(field_text("url"), field_text("code")))
			button("返回主界面", 220, 1000, 310, func(): controller.show_page(2), "button_secondary_dark")
			state_line("连接状态：%s" % model.connection)
		4:
			header("房间 " + model.room_id, "%d人局 · %s" % [model.target_players, "公开匹配" if model.is_public else ("私人房间" if model.mode != "local_demo" else "本地练习")])
			seats()
			if model.mode == "network":
				chip("邀请好友", 545, 180, 170, 52, controller.share_invite)
			dark_panel(80, 790, 590, 400)
			var ready_count := model.players.filter(func(p): return bool(p.get("isReady", false))).size()
			var seat_total := model.target_players if model.mode != "local_demo" else model.players.size()
			text_label("%d / %d 人，%d 人已准备" % [model.players.size(), seat_total, ready_count], 100, 805, 550, 46, 27)
			text_label(room_rules_text() + ("\n空位在开局时由 AI 补齐" if model.mode != "local_demo" else ""), 110, 855, 530, 110, 18, HORIZONTAL_ALIGNMENT_LEFT)
			var me := model.my_seat()
			var i_am_ready: bool = me >= 0 and me < model.players.size() and bool(model.players[me].get("isReady", false))
			button("取消准备" if i_am_ready and model.mode != "local_demo" else "准备", 165, 975, 420, func(): controller.toggle_ready())
			button("退出房间", 220, 1085, 310, func(): controller.leave_room(), "button_secondary_dark")
			if model.mode == "local_demo":
				state_line("本地对局：其余席位由 AI 控制")
			elif not model.is_public:
				state_line("点“邀请好友”把房间号 %s 发给好友" % model.room_id)
			else:
				state_line("等待其他玩家加入并准备")
		5:
			header("随机分配角色")
			var cards := clampi(model.players.size(), 5, 10)
			var per_row := cards if cards <= 6 else ceili(cards / 2.0)
			var card_width := minf(120.0, 560.0 / per_row)
			for i in cards:
				var row := i / per_row
				var column := i % per_row
				var in_row := per_row if row == 0 else cards - per_row
				var middle := (in_row - 1) / 2.0
				art("card_role_back", 375 - (in_row * (card_width + 8)) / 2.0 + column * (card_width + 8), 300 + row * 240 + abs(column - middle) * 24, card_width)
			text_label("正在随机分配角色", 95, 850, 560, 70, 34)
			text_label("请保持身份保密", 95, 930, 560, 48, 22)
			button("查看身份", 185, 1055, 380, func(): controller.show_page(6))
		6:
			header("你的身份")
			art("card_role_front", 130, 220, 490)
			var badges := {T.Role.MERLIN:"role-merlin", T.Role.PERCIVAL:"role-percival", T.Role.SERVANT:"role-servant", T.Role.ASSASSIN:"role-assassin",
				T.Role.MORGANA:"role-morgana", T.Role.MINION:"role-minion", T.Role.OBERON:"role-oberon", T.Role.MORDRED:"role-mordred"}
			art(str(badges.get(model.my_role, "avatar-empty-slot")), 275, 320, 200)
			text_label(T.role_name(model.my_role) + ("（坏人阵营）" if T.is_bad_role(model.my_role) else "（好人阵营）"), 140, 635, 470, 65, 34)
			text_label(identity_hint(), 165, 708, 420, 112, 20)
			text_label("请记住你的身份，不要向其他玩家展示", 110, 830, 530, 50, 20)
			turn_alert(975)
			button("确认身份", 160, 1035, 430, func(): controller.confirm_identity())
		7:
			header("第 %d 轮 发言" % model.round, "队长先发言，然后按座位顺序")
			progress()
			seats()
			dark_panel(60, 780, 630, 262)
			chat_lines(790, 6, "", 40.0)
			if model.stage == T.Stage.SPEAKING:
				if model.is_speaker():
					line_edit("chat", "", "说说你的看法（最多80字）", 60, 1052, 440, 58)
					chip("发送", 510, 1051, 180, 60, func(): if controller.send_chat(field_text("chat")): (inputs["chat"] as LineEdit).clear())
					button("结束发言", 195, 1126, 360, func(): controller.end_speech())
					state_line("轮到你发言了")
				else:
					strip(1058, 56)
					text_label("正在发言：%s" % seat_names([model.speaker_seat]), 60, 1061, 630, 50, 23, HORIZONTAL_ALIGNMENT_CENTER, BLUE)
					state_line("等待其他玩家发言")
			else:
				if model.stage == T.Stage.PROPOSING:
					button("进入组队", 165, 1080, 420, func(): controller.show_page(8))
				else:
					text_label("等待进入发言阶段", 125, 1080, 500, 60, 22)
		8:
			header("队长组队")
			progress()
			seats(true)
			strip(782, 50)
			text_label("需要选择 %d 名队员，已选择 %d 名" % [model.get_team_size(), controller.team_choice.size()], 65, 782, 620, 50, 24)
			var excalibur: bool = bool(model.rules.get("excalibur", false))
			if model.is_captain() and excalibur and controller.team_choice.size() == model.get_team_size():
				text_label("把王者之剑交给：", 65, 845, 620, 40, 21, HORIZONTAL_ALIGNMENT_LEFT)
				var holders: Array = controller.team_choice.filter(func(seat): return seat != model.my_seat())
				for i in holders.size():
					var seat: int = holders[i]
					chip("%d号" % (seat + 1), 65 + i * 125, 890, 115, 56, func(): controller.choose_excalibur(seat), seat == controller.excalibur_choice)
			if not model.is_captain():
				# Nothing to do but wait: show what was said this round.
				dark_panel(60, 850, 630, 262)
				chat_lines(860, 6, "", 40.0)
			if model.is_captain():
				button("清空选择", 74, 1025, 274, func(): controller.team_choice.clear(); controller.excalibur_choice = -1; _refresh(), "button_secondary_dark")
				button("确认队伍", 394, 1025, 274, func(): controller.submit_team())
			state_line(("点击头像选择队员" + ("，再选王者之剑持有者" if excalibur else "")) if model.is_captain() else "等待队长选择队员")
		9:
			header("全员投票")
			progress()
			strip(320, 320, 60, 630)
			text_label("队长 %s 提名的队伍" % seat_names([model.captain_seat]), 70, 330, 610, 50, 26)
			var members := model.selected_seats.size()
			for i in members:
				player_avatar(int(model.selected_seats[i]), 375 - members * 60 + i * 120 + 18, 400, 84)
			if model.excalibur_seat >= 0:
				art_any(["excalibur-icon", "invite-swords-icon"], 150, 572, 34)
				text_label("王者之剑：%s" % seat_names([model.excalibur_seat]), 190, 570, 440, 40, 21, HORIZONTAL_ALIGNMENT_LEFT)
			art("thumbs-approve-icon", 169, 735, 130)
			art("thumbs-reject-icon", 458, 735, 130)
			if not model.voted:
				button("赞成", 85, 900, 280, func(): controller.vote(true))
				button("反对", 385, 900, 280, func(): controller.vote(false), "button_danger_red")
			state_line("已投票，等待其他玩家" if model.voted else "请投票决定是否执行任务")
		10:
			if model.stage == T.Stage.EXCALIBUR:
				header("王者之剑", "任务牌已交齐")
				progress()
				strip(318, 70)
				text_label("本轮队伍：" + seat_names(model.selected_seats), 60, 318, 630, 70, 20)
				art_any(["excalibur-icon", "invite-swords-icon"], 315, 400, 120)
				var holder_seat := model.excalibur_seat
				if holder_seat == model.my_seat() and not model.acted:
					strip(538, 84)
					text_label("你可以翻转一名队员的任务牌（成功↔失败），并得知他原本出的牌", 70, 540, 610, 80, 22)
					var targets: Array = model.selected_seats.filter(func(seat): return seat != model.my_seat())
					for i in targets.size():
						var seat: int = targets[i]
						chip("翻转 %d号" % (seat + 1), 90 + (i % 3) * 195, 640 + (i / 3) * 80, 180, 62, func(): controller.use_excalibur(seat))
					button("不使用", 195, 900, 360, func(): controller.use_excalibur(-1), "button_secondary_dark")
				else:
					strip(560, 90)
					text_label("王者之剑持有者 %s 正在决定" % seat_names([holder_seat]) if not model.acted else "已决定，等待任务结果", 60, 560, 630, 90, 25)
				state_line("王者之剑持有者可以改变一张任务牌")
			else:
				header("任务执行")
				progress()
				strip(318, 118 if model.excalibur_seat >= 0 else 70)
				text_label("本轮队伍：" + seat_names(model.selected_seats), 60, 318, 630, 70, 20)
				if model.excalibur_seat >= 0:
					text_label("王者之剑：%s（出牌后可翻转一名队员的牌）" % seat_names([model.excalibur_seat]), 60, 386, 630, 46, 18, HORIZONTAL_ALIGNMENT_CENTER, GOLD)
				strip(500, 80)
				text_label("你是任务队员，请出牌" if model.is_member() and not model.acted else ("等待任务队员行动" if not model.is_member() else "已出牌"), 60, 500, 630, 80, 32)
				art("mission-success-emblem", 150, 640, 150)
				art("mission-failure-emblem", 450, 640, 150)
				if model.is_member() and not model.acted:
					button("任务成功", 80, 875, 285, func(): controller.mission(true))
					if T.is_bad_role(model.my_role):
						button("任务失败", 385, 875, 285, func(): controller.mission(false), "button_danger_red")
				state_line("已提交，等待任务结果" if model.acted else ("好人只能选择任务成功" if model.is_member() else "等待队员提交任务牌"))
		11:
			var is_vote := controller.last_result_route == T.Route.VOTE_RESULT
			header("投票结果" if is_vote else "第 %d 轮任务结果" % int(model.last_mission.get("round", model.round)))
			# The track, not the status line: the model has already moved on to the next stage.
			progress(false)
			var mission_ok := model.last_vote_passed if is_vote else bool(model.last_mission.get("isSuccess", false))
			if is_vote:
				art_any(["vote-approve-emblem" if mission_ok else "vote-reject-emblem", "thumbs-approve-icon" if mission_ok else "thumbs-reject-icon"], 270, 330, 210)
			else:
				art("mission-success-emblem" if mission_ok else "mission-failure-emblem", 255, 320, 240)
			dark_panel(60, 590, 630, 380, Color(0.51, 0.4, 0.24), Color(0.02, 0.03, 0.05, 0.85))
			text_label(("队伍通过" if mission_ok else "队伍被否决") if is_vote else ("任务成功" if mission_ok else "任务失败"), 70, 600, 610, 80, 42, HORIZONTAL_ALIGNMENT_CENTER, (Color(0.6, 0.9, 0.6) if mission_ok else RED))
			text_label("连续否决 %d / 5" % model.failed_votes if is_vote else "失败牌 %d 张 · 累计成功 %d 次、失败 %d 次" % [int(model.last_mission.get("failCount", 0)), model.mission_results.count(true), model.mission_results.count(false)], 70, 680, 610, 44, 23)
			if is_vote:
				var approvals: Array = []
				var rejections: Array = []
				for i in model.last_votes.size():
					(approvals if model.last_votes[i] else rejections).append(i)
				text_label("赞成（%d）：%s" % [approvals.size(), seat_numbers(approvals)], 90, 745, 570, 80, 22, HORIZONTAL_ALIGNMENT_LEFT, Color(0.6, 0.9, 0.6))
				text_label("反对（%d）：%s" % [rejections.size(), seat_numbers(rejections)], 90, 835, 570, 80, 22, HORIZONTAL_ALIGNMENT_LEFT, Color(0.95, 0.6, 0.55))
			elif not model.last_excalibur.is_empty():
				var target := int(model.last_excalibur.get("targetSeat", -1))
				var holder := int(model.last_excalibur.get("holderSeat", -1))
				text_label("王者之剑：%d号%s" % [holder + 1, "翻转了%d号的牌" % (target + 1) if target >= 0 else "没有使用"], 90, 760, 570, 50, 21, HORIZONTAL_ALIGNMENT_CENTER, GOLD)
			turn_alert(985)
			button("查看结算" if model.stage == T.Stage.END else "继续", 175, 1050, 400, func(): controller.show_page(controller.page_for_stage(model.stage)))
		12:
			header("刺杀阶段", "坏人亮明身份，刺客选择梅林")
			progress()
			var is_assassin := model.my_role == T.Role.ASSASSIN
			var is_evil := T.is_bad_role(model.my_role)
			seats(is_assassin)
			strip(772, 52)
			text_label("坏人：" + seat_names(model.revealed_evil), 60, 772, 630, 52, 20, HORIZONTAL_ALIGNMENT_CENTER, RED)
			if is_evil:
				dark_panel(60, 832, 630, 172)
				chat_lines(840, 4, "evil", 40.0)
				line_edit("chat", "", "  和同伴商量刺杀目标", 60, 1010, 440, 52)
				chip("发送", 510, 1008, 180, 56, func(): if controller.send_chat(field_text("chat")): (inputs["chat"] as LineEdit).clear())
			if is_assassin:
				art("target-icon", 90, 1070, 40)
				text_label("目标：" + seat_names(controller.team_choice) if not controller.team_choice.is_empty() else "点击头像选择刺杀目标", 140, 1068, 530, 44, 22, HORIZONTAL_ALIGNMENT_LEFT)
				button("确认刺杀", 195, 1120, 360, func(): controller.assassinate(int(controller.team_choice[0])) if not controller.team_choice.is_empty() else _notice("请选择目标"), "button_danger_red")
			elif not is_evil:
				text_label("好人完成了三次任务，坏人正在商议刺杀目标", 80, 832, 590, 60, 23)
				dark_panel(60, 900, 630, 262)
				chat_lines(910, 6, "all", 40.0)
			state_line("你是刺客，只能刺杀好人" if is_assassin else ("坏人私聊只有坏人可见" if is_evil else "等待刺客行动"))
		13:
			header("游戏结算")
			var fr: Dictionary = model.final_result if not model.final_result.is_empty() else model.snapshot()
			var won: Variant = fr.get("won")
			var headline := "好人胜利" if fr.get("winner") else "坏人胜利"
			if won != null:
				headline += "  ·  你%s" % ("赢了" if won else "输了")
			var good_won: bool = fr.get("winner") == true
			text_label(headline, 60, 180, 630, 80, 40, HORIZONTAL_ALIGNMENT_CENTER, BLUE if good_won else RED)
			text_label(str(fr.get("reason", "")), 80, 260, 590, 60, 21)
			if not model.last_rating.is_empty() and model.mode == "network":
				var delta := int(model.last_rating.get("delta", 0))
				text_label("段位分 %s%d → %d · %s" % ["+" if delta >= 0 else "", delta, int(model.last_rating.get("rating", 0)), model.last_rating.get("tier", "")], 80, 320, 590, 40, 21, HORIZONTAL_ALIGNMENT_CENTER, GOLD)
			art("panel_content_large", 140, 370, 470)
			var roster: Array = fr.get("players", [])
			var row := 590.0 / maxf(8.0, roster.size())
			for i in mini(10, roster.size()):
				var player: Dictionary = roster[i]
				var mine_row := i == int(fr.get("me", -1))
				var tag := "（你）" if mine_row else (" · AI" if player.get("isAi", false) else "")
				var role := int(player.get("role", 0))
				text_label("%d. %s  %s%s" % [i + 1, display_name(str(player.get("nickname", "玩家"))).left(7), T.role_name(role), tag], 180, 440 + i * row, 400, row - 4, 21, HORIZONTAL_ALIGNMENT_LEFT, RED if T.is_bad_role(role) else BLUE)
			# Buttons sit below the roster panel (which ends near y 1075), in two rows.
			button("再来一局", 90, 1092, 275, func(): controller.play_again())
			button("查看复盘", 385, 1092, 275, func(): controller.show_final_replay(), "button_secondary_dark")
			button("分享战绩", 90, 1162, 275, share_result, "button_secondary_dark")
			button("主界面", 385, 1162, 275, func(): controller.leave_room(), "button_secondary_dark")
			state_line("")
		14:
			var from_server := not model.replay.is_empty()
			header("对局复盘", "第 %d 局完整记录" % int(model.replay.matchId) if from_server else "本局关键事件")
			art("panel_content_large", 100, 225, 550)
			if from_server:
				scroll_lines(record_lines(model.replay), 145, 290, 470, 760)
				button("分享战绩", 100, 1080, 270, share_result)
				button("返回战绩", 390, 1080, 270, func(): controller.board_tab = "history"; controller.open_leaderboard(), "button_secondary_dark")
			else:
				var fr: Dictionary = model.final_result if not model.final_result.is_empty() else model.snapshot()
				var results: Array = fr.get("results", [])
				var lines: Array = [["完成 %d 轮任务：成功 %d 次，失败 %d 次" % [results.size(), results.count(true), results.count(false)], GOLD], "结论：" + str(fr.get("reason", ""))]
				for event in Array(fr.get("history", [])).filter(func(event): return int(event.get("route", 0)) in [402, 502, 602, 903, 906, 702]):
					lines.append(history_text(event))
				scroll_lines(lines, 145, 290, 470, 760)
				button("分享战绩", 100, 1080, 270, share_result)
				button("返回结算", 390, 1080, 270, func(): controller.show_page(13), "button_secondary_dark")
			state_line("拖动列表查看全部记录")
		15:
			header("排行榜", "段位分按 Elo 计算")
			var tabs := [["全服排行", "board"], ["我的战绩", "history"], ["本机记录", "local"]]
			for i in tabs.size():
				var key: String = tabs[i][1]
				chip(tabs[i][0], 95 + i * 190, 180, 175, 56, func(): controller.board_tab = key; controller.open_leaderboard(), controller.board_tab == key)
			art("panel_content_large", 103, 250, 545)
			var tab: String = controller.board_tab
			if tab != "local" and not controller.is_online():
				text_label("连接服务器后可查看全服排行和你的战绩", 150, 520, 450, 80, 22)
				button("连接服务器", 195, 640, 360, func(): controller.connect_for_records())
			elif tab == "board":
				var me: Dictionary = model.stats
				if not me.is_empty():
					var rank_text := "第 %d 名" % int(me.get("rank", 0)) if int(me.get("rank", 0)) > 0 else "暂无排名"
					text_label("我：%s · %d 分 · %s · %d 局 %d 胜" % [me.get("tier", ""), int(me.get("rating", 0)), rank_text, int(me.get("games", 0)), int(me.get("wins", 0))], 140, 300, 470, 50, 18, HORIZONTAL_ALIGNMENT_CENTER, GOLD)
				var rows: Array = model.leaderboard.map(func(row): return ["%d. %s  %s  %d分（%d局%d胜）" % [int(row.rank), str(row.nickname).left(8), row.tier, int(row.rating), int(row.games), int(row.wins)], GOLD if str(row.userId) == model.user_id else Color(0.95, 0.9, 0.78)])
				if rows.is_empty():
					rows = ["还没有人完成对局"]
				scroll_lines(rows, 145, 360, 470, 700)
			elif tab == "history":
				var rows: Array = model.match_history.map(func(entry):
					var delta: Variant = entry.get("ratingDelta")
					var delta_text := "" if delta == null else ("  %s%d分" % ["+" if int(delta) >= 0 else "", int(delta)])
					return ["%d人局 · %s · %s%s\n%s" % [int(entry.playerCount), T.role_name(int(entry.role)), "胜利" if entry.won else "失败", delta_text, entry.reason], Color(0.6, 0.9, 0.6) if entry.won else Color(0.95, 0.7, 0.6), controller.open_match.bind(int(entry.matchId))])
				if rows.is_empty():
					rows = ["还没有联机对局记录"]
				scroll_lines(rows, 145, 310, 470, 750, 18)
			else:
				var matches: Array = AvalonApp.profile.data.matches
				var rows: Array = []
				for match_data in matches:
					var won_match: Variant = match_data.get("won")
					var outcome := "胜利" if won_match == true else "失败" if won_match == false else ("好人胜" if match_data.get("winner", false) else "坏人胜")
					var when := str(match_data.get("time", "")).left(16).replace("T", " ")
					var size_text := "%d人" % Array(match_data.get("players", [])).size()
					rows.append(["%s · %s%s · %s\n%s%s" % [outcome, size_text, "联机" if match_data.get("mode") == "network" else "练习", T.role_name(int(match_data.get("role", 0))), when + "  " if not when.is_empty() else "", str(match_data.get("reason", ""))],
						Color(0.6, 0.9, 0.6) if won_match == true else (Color(0.95, 0.65, 0.6) if won_match == false else Color(0.95, 0.9, 0.78))])
				if rows.is_empty():
					rows = ["暂无对局记录"]
				scroll_lines(rows, 145, 310, 470, 750)
			nav()
		16:
			header("好友", "本机联系人")
			art("panel_content_large", 103, 225, 545)
			line_edit("friend", search_text, "输入好友昵称", 140, 282, 330, 58)
			chip("添加", 482, 281, 128, 60, func(): search_text = field_text("friend"); AvalonApp.profile.add_friend(search_text); _refresh())
			var friends: Array = AvalonApp.profile.data.friends
			for i in mini(9, friends.size()):
				art("panel_list_row", 125, 375 + i * 78, 500)
				text_label(str(friends[i]), 165, 388 + i * 78, 405, 50, 22, HORIZONTAL_ALIGNMENT_LEFT)
			if friends.is_empty():
				text_label("暂无好友，输入昵称添加本机联系人", 130, 520, 490, 90, 21)
			nav()
		17:
			header("湖中仙女", "第 %d 轮任务后" % model.round)
			progress()
			var is_holder := model.lady_holder == model.my_seat() and model.stage == T.Stage.LADY_OF_LAKE
			seats(is_holder and not model.acted)
			strip(775, 48)
			text_label("持有者：%s" % seat_names([model.lady_holder]), 60, 775, 630, 48, 24, HORIZONTAL_ALIGNMENT_CENTER, BLUE)
			if is_holder and not model.acted:
				text_label("选择一名玩家查验阵营，结果只有你知道；之后仙女交给他", 80, 828, 590, 60, 20)
				text_label("查验：" + seat_names(controller.team_choice) if not controller.team_choice.is_empty() else "点击头像选择（不能查验自己和曾经的持有者）", 80, 884, 590, 50, 20, HORIZONTAL_ALIGNMENT_CENTER, GOLD)
				button("查验", 195, 940, 360, func(): controller.lady_check(int(controller.team_choice[0])) if not controller.team_choice.is_empty() else _notice("请选择查验对象"))
			else:
				text_label("等待持有者查验" if model.stage == T.Stage.LADY_OF_LAKE and not model.acted else "查验完成", 80, 840, 590, 50, 22)
			var checks: Array = model.lady_history.slice(maxi(0, model.lady_history.size() - 3))
			for i in checks.size():
				var record: Dictionary = checks[i]
				text_label("第%d轮：%d号查验了%d号" % [int(record.round), int(record.holderSeat) + 1, int(record.targetSeat) + 1], 80, 1025 + i * 36, 590, 34, 18)
			var mine: Array = model.facts.map(func(fact): return "%d号是%s" % [int(fact.seat) + 1, "好人" if fact.isGood else "坏人"])
			if not mine.is_empty():
				text_label("你查验到：" + "，".join(mine), 80, 1140, 590, 40, 20, HORIZONTAL_ALIGNMENT_CENTER, GOLD)
			state_line("查验关系公开，结果仅持有者可见")
		18:
			header("个人设置", "昵称和头像会在进入房间时显示给其他玩家")
			dark_panel(60, 180, 630, 900)
			text_label("昵称（1～12 个字）", 90, 205, 570, 40, 20, HORIZONTAL_ALIGNMENT_LEFT)
			line_edit("nickname", model.nickname, "输入昵称", 90, 250, 570, 56)
			text_label("头像", 90, 330, 570, 40, 20, HORIZONTAL_ALIGNMENT_LEFT)
			var avatars: Array = AvalonController.AVATARS
			for i in avatars.size():
				var key: String = avatars[i]
				var x := 95 + (i % 3) * 190
				var y := 385 + (i / 3) * 190
				var chosen := key == controller.avatar_choice
				dark_panel(x, y, 150, 165, GOLD if chosen else Color(0.35, 0.3, 0.22), Color(0.16, 0.12, 0.05, 0.95) if chosen else Color(0.025, 0.04, 0.06, 0.92), 5 if chosen else 2)
				art(key, x + 20, y + 12, 110)
				if chosen:
					art("check-icon", x + 108, y + 118, 38)
				var pick := Button.new()
				pick.flat = true
				pick.position = Vector2(x, y)
				pick.size = Vector2(150, 165)
				pick.pressed.connect(func(): controller.avatar_choice = key; _refresh())
				layer.add_child(pick)
			var muted: bool = AvalonApp.profile.data.get("muted", false)
			var music_on: bool = AvalonApp.profile.data.get("music_on", true)
			var sfx_on: bool = AvalonApp.profile.data.get("sfx_on", true)
			text_label("声音", 90, 790, 120, 50, 20, HORIZONTAL_ALIGNMENT_LEFT)
			chip("全部静音" if muted else "声音开启", 200, 785, 150, 58, func(): controller.set_muted(not muted), muted)
			chip("音乐 开" if music_on else "音乐 关", 365, 785, 140, 58, func(): controller.set_audio_bus(AvalonAudio.MUSIC_BUS, not music_on), not music_on)
			chip("音效 开" if sfx_on else "音效 关", 520, 785, 140, 58, func(): controller.set_audio_bus(AvalonAudio.SFX_BUS, not sfx_on), not sfx_on)
			button("保存", 195, 900, 360, func(): if controller.save_profile(field_text("nickname"), controller.avatar_choice): controller.show_page(2))
			button("返回", 220, 1110, 310, func(): controller.show_page(2), "button_secondary_dark")
			state_line("修改会在下次进入房间时生效")
