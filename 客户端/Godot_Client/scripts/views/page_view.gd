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
var _rebuild_queued := false
var _signature := ""

## Seats sit evenly on an ellipse around the table, seat 1 at the top, clockwise.
const SEAT_CENTER := Vector2(334, 455)
const SEAT_RADIUS := Vector2(250, 185)

static func seat_position(index: int, count: int) -> Vector2:
	var angle := -PI / 2.0 + TAU * float(index) / float(maxi(count, 1))
	return SEAT_CENTER + Vector2(cos(angle) * SEAT_RADIUS.x, sin(angle) * SEAT_RADIUS.y)
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
	return JSON.stringify([snapshot, controller.team_choice, controller.last_notice, controller.last_result_route, controller.lobby_count,
		controller.excalibur_choice, controller.avatar_choice, AvalonApp.profile.data.get("muted", false),
		AvalonApp.profile.data.get("music_on", true), AvalonApp.profile.data.get("sfx_on", true),
		AvalonApp.profile.data.friends.size(), AvalonApp.profile.data.matches.size()])

func _process(_delta: float) -> void:
	if is_instance_valid(timer_label):
		var left: int = AvalonApp.model.seconds_left()
		timer_label.text = "%d 秒" % left if left >= 0 else ""

func _notice(message: String) -> void:
	if is_instance_valid(status):
		status.text = message

func save_share_card() -> void:
	await RenderingServer.frame_post_draw
	var target := "user://avalon-share.png"
	var result := get_viewport().get_texture().get_image().save_png(target)
	_notice("分享图已保存：%s" % ProjectSettings.globalize_path(target) if result == OK else "保存分享图失败")

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
	text_label(title, 100, 42, 550, 86, 30)
	if not subtitle.is_empty():
		text_label(subtitle, 120, 112, 510, 42, 18)
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
	status = text_label(notice_text if not notice_text.is_empty() else message, 60, 1125 if page_id == 2 else 1234, 630, 43, 18)

func dark_panel(x: float, y: float, width: float, height: float, border := Color(0.51, 0.4, 0.24), fill := Color(0.025, 0.04, 0.06, 0.92)) -> void:
	var panel := Panel.new()
	panel.position = Vector2(x, y)
	panel.size = Vector2(width, height)
	panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var style := StyleBoxFlat.new()
	style.bg_color = fill
	style.border_color = border
	style.set_border_width_all(3)
	style.set_corner_radius_all(8)
	panel.add_theme_stylebox_override("panel", style)
	layer.add_child(panel)

func nav() -> void:
	var items := [["主页", 2], ["对局", 4], ["排行", 15], ["好友", 16]]
	for i in items.size():
		var item: Array = items[i]
		var x := 50 + i * 168
		art(["home-icon", "invite-swords-icon", "leaderboard-icon", "friends-icon"][i], x + 47, 1170, 36)
		var b := Button.new()
		b.text = str(item[0])
		b.flat = true
		b.position = Vector2(x, 1215)
		b.size = Vector2(125, 55)
		b.pressed.connect(AvalonApp.controller.show_page.bind(int(item[1])))
		layer.add_child(b)

func player_avatar(seat: int, x: float, y: float, width := 83.0) -> void:
	var model: AvalonModel = AvalonApp.model
	var avatars: Array = AvalonController.AVATARS
	var name := "avatar-empty-slot"
	if seat >= 0 and seat < model.players.size():
		var chosen := str(model.players[seat].get("avatar", ""))
		name = chosen if chosen in avatars else avatars[seat % avatars.size()]
	var avatar := art(name, x, y, width)
	if seat >= 0 and seat < model.players.size():
		var p: Dictionary = model.players[seat]
		if not bool(p.get("isOnline", true)):
			avatar.modulate = Color(0.45, 0.45, 0.45)
		if bool(p.get("isAi", false)):
			text_label("AI", x - 6, y - 4, 30, 22, 13, HORIZONTAL_ALIGNMENT_CENTER, Color(0.7, 0.75, 0.85))
		var label := "%d %s" % [seat + 1, str(p.get("nickname", "玩家")).trim_prefix("AI_").left(4)]
		text_label(label + ("(你)" if seat == model.my_seat() else ""), x - 22, y + width + 2, width + 44, 29, 15)

## Seats around the table with markers: captain, team, speaker, Excalibur, Lady, revealed evil and what I learned.
func seats(interactive := false) -> void:
	var model: AvalonModel = AvalonApp.model
	var controller: AvalonController = AvalonApp.controller
	# Empty chairs only matter while players are still joining.
	var count := model.target_players if model.stage == T.Stage.PREPARING and model.mode != "local_demo" else model.players.size()
	count = mini(10, count)
	for i in count:
		var pos := seat_position(i, count)
		player_avatar(i, pos.x, pos.y)
		var ready_in_lobby: bool = model.stage == T.Stage.PREPARING and i < model.players.size() and bool(model.players[i].get("isReady", false))
		if ready_in_lobby or i in model.selected_seats or i in controller.team_choice:
			art("check-icon", pos.x + 62, pos.y + 56, 27)
		if i == model.captain_seat and model.stage != T.Stage.PREPARING:
			art("crown-icon", pos.x + 28, pos.y - 28, 36)
		if model.stage == T.Stage.SPEAKING and i == model.speaker_seat:
			art("microphone-icon", pos.x - 12, pos.y - 8, 34)
		if i == model.excalibur_seat or (model.stage == T.Stage.PROPOSING and i == controller.excalibur_choice):
			art("invite-swords-icon", pos.x - 14, pos.y + 50, 32)
		if bool(model.rules.get("lady", false)) and i == model.lady_holder and model.stage != T.Stage.PREPARING:
			text_label("仙女", pos.x - 22, pos.y + 18, 44, 26, 15, HORIZONTAL_ALIGNMENT_CENTER, BLUE)
		if i in model.revealed_evil:
			art("mission-failure-emblem", pos.x + 58, pos.y - 6, 30)
		for fact in model.facts:
			if int(fact.seat) == i:
				text_label("查:好" if fact.isGood else "查:坏", pos.x + 50, pos.y + 22, 50, 24, 14, HORIZONTAL_ALIGNMENT_CENTER, BLUE if fact.isGood else RED)
		if interactive and i < model.players.size():
			var hit := Button.new()
			hit.flat = true
			hit.position = pos
			hit.size = Vector2(90, 110)
			hit.pressed.connect(controller.choose_seat.bind(i))
			layer.add_child(hit)

## Round, stage, captain, mission track with team sizes, and the countdown.
func progress() -> void:
	var model: AvalonModel = AvalonApp.model
	text_label("第 %d 轮    %s    队长：%d 号" % [model.round, T.stage_name(model.stage), model.captain_seat + 1], 90, 158, 570, 44, 23)
	var count := model.players.size()
	for i in 5:
		art("mission-success-emblem" if i < model.mission_results.size() and model.mission_results[i] else "mission-failure-emblem" if i < model.mission_results.size() else "slot_team_member", 198 + i * 76, 202, 48)
		var size_text := "%d人%s" % [T.team_size(count, i + 1), "*" if T.needs_two_fails(count, i + 1) else ""]
		text_label(size_text, 190 + i * 76, 246, 64, 22, 14, HORIZONTAL_ALIGNMENT_CENTER, GOLD if i == model.round - 1 else Color(0.8, 0.75, 0.65))
	if model.seconds_left() >= 0:
		art("timer-icon", 590, 204, 36)
		timer_label = text_label("", 622, 202, 80, 40, 20, HORIZONTAL_ALIGNMENT_LEFT)
		_process(0.0)

## Seat list like "2号 小明、5号 阿强" for identity and vote summaries.
func seat_names(list: Array) -> String:
	var model: AvalonModel = AvalonApp.model
	var names: Array = []
	for seat in list:
		var index := int(seat)
		var nickname := str(model.players[index].get("nickname", "玩家")) if index >= 0 and index < model.players.size() else "玩家"
		names.append("%d号 %s" % [index + 1, nickname])
	return "、".join(names) if not names.is_empty() else "无"

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

## Last `limit` chat lines (optionally only one channel) drawn from `top`.
func chat_lines(top: float, limit: int, channel := "", line_height := 42.0) -> void:
	var model: AvalonModel = AvalonApp.model
	var lines: Array = model.chat.filter(func(entry): return channel.is_empty() or str(entry.get("channel", "all")) == channel)
	lines = lines.slice(maxi(0, lines.size() - limit))
	if lines.is_empty():
		text_label("还没有人发言", 80, top, 590, line_height, 18, HORIZONTAL_ALIGNMENT_LEFT, Color(0.7, 0.65, 0.55))
	for i in lines.size():
		var entry: Dictionary = lines[i]
		var seat := int(entry.get("seat", -1))
		if seat < 0:
			text_label("【系统】%s" % entry.get("text", ""), 80, top + i * line_height, 590, line_height, 16, HORIZONTAL_ALIGNMENT_LEFT, BLUE)
			continue
		var prefix := "[坏人] " if str(entry.get("channel", "all")) == "evil" else ""
		var color := GOLD if seat == model.my_seat() else Color(0.95, 0.9, 0.78)
		text_label("%s%d号 %s：%s" % [prefix, seat + 1, str(entry.get("nickname", "")).left(6), entry.get("text", "")], 80, top + i * line_height, 590, line_height, 17, HORIZONTAL_ALIGNMENT_LEFT, color)

## Warns on pages that wait for a tap (identity, results) while the player's own clock is running.
func turn_alert(y: float) -> void:
	var action: String = AvalonApp.model.pending_action()
	if not action.is_empty():
		text_label("轮到你%s了，请尽快继续" % action, 80, y, 590, 44, 24, HORIZONTAL_ALIGNMENT_CENTER, RED)

func room_rules_text() -> String:
	var model: AvalonModel = AvalonApp.model
	var roles: Array = model.role_set if not model.role_set.is_empty() else T.roles_for(model.target_players)
	return "身份：%s\n特殊规则：%s" % [T.role_set_text(roles), T.rules_text(roles.size())]

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
			text_label(model.nickname, 138, 45, 250, 45, 21, HORIZONTAL_ALIGNMENT_LEFT)
			art("sound-icon", 570, 42, 41)
			art("settings-icon", 666, 42, 41)
			var profile_button := Button.new()
			profile_button.flat = true
			profile_button.position = Vector2(40, 25)
			profile_button.size = Vector2(340, 95)
			profile_button.tooltip_text = "修改昵称和头像"
			profile_button.pressed.connect(func(): controller.show_page(18))
			layer.add_child(profile_button)
			var muted: bool = AvalonApp.profile.data.get("muted", false)
			chip("静音" if muted else "声音", 552, 92, 76, 34, func(): controller.set_muted(not muted), muted)
			chip("设置", 648, 92, 76, 34, func(): controller.show_page(18))
			art("game_logo_title", 145, 268, 460)
			button("联机对战", 145, 880, 460, func(): controller.show_page(3))
			button("本地练习（5人）", 190, 990, 370, func(): controller.create_local_room(), "button_secondary_dark")
			nav()
			state_line("联机：快速匹配、创建房间或输入房间号；本地练习可离线运行")
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
			line_edit("code", "", "输入 6 位房间号", 90, 828, 360, 56)
			chip("加入", 470, 826, 190, 60, func(): controller.join_room_code(field_text("url"), field_text("code")))
			button("返回主界面", 220, 1000, 310, func(): controller.show_page(2), "button_secondary_dark")
			state_line("连接状态：%s" % model.connection)
		4:
			header("房间 " + model.room_id, "%d人局 · %s" % [model.target_players, "公开匹配" if model.is_public else ("私人房间" if model.mode != "local_demo" else "本地练习")])
			seats()
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
				state_line("把房间号 %s 发给好友，一起加入" % model.room_id)
			else:
				state_line("等待其他玩家加入并准备")
		5:
			header("随机分配角色")
			for i in 5:
				art("card_role_back", 98 + i * 115, 350 + abs(i - 2) * 48, 120)
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
			text_label(identity_hint(), 110, 715, 530, 100, 22)
			text_label("请记住你的身份，不要向其他玩家展示", 110, 830, 530, 50, 20)
			turn_alert(975)
			button("确认身份", 160, 1035, 430, func(): controller.confirm_identity())
		7:
			header("第 %d 轮 发言" % model.round, "队长先发言，然后按座位顺序")
			progress()
			seats()
			dark_panel(60, 760, 630, 285)
			if model.stage == T.Stage.SPEAKING:
				chat_lines(772, 6)
				if model.is_speaker():
					line_edit("chat", "", "说说你的看法（最多80字）", 60, 1055, 440, 56)
					chip("发送", 510, 1053, 180, 60, func(): if controller.send_chat(field_text("chat")): (inputs["chat"] as LineEdit).clear())
					button("结束发言", 195, 1130, 360, func(): controller.end_speech())
					state_line("轮到你发言了")
				else:
					text_label("正在发言：%s" % seat_names([model.speaker_seat]), 60, 1065, 630, 50, 22)
					state_line("等待其他玩家发言")
			else:
				chat_lines(772, 6)
				if model.stage == T.Stage.PROPOSING:
					button("进入组队", 165, 1080, 420, func(): controller.show_page(8))
				else:
					text_label("本地练习没有发言环节" if model.mode == "local_demo" else "等待进入发言阶段", 125, 1080, 500, 60, 22)
		8:
			header("队长组队")
			progress()
			seats(true)
			text_label("需要选择 %d 名队员，已选择 %d 名" % [model.get_team_size(), controller.team_choice.size()], 65, 780, 620, 50, 24)
			var excalibur: bool = bool(model.rules.get("excalibur", false))
			if model.is_captain() and excalibur and controller.team_choice.size() == model.get_team_size():
				text_label("把王者之剑交给：", 65, 840, 620, 40, 20, HORIZONTAL_ALIGNMENT_LEFT)
				var holders: Array = controller.team_choice.filter(func(seat): return seat != model.my_seat())
				for i in holders.size():
					var seat: int = holders[i]
					chip("%d号" % (seat + 1), 65 + i * 125, 885, 115, 54, func(): controller.choose_excalibur(seat), seat == controller.excalibur_choice)
			if model.is_captain():
				button("清空选择", 74, 1025, 274, func(): controller.team_choice.clear(); controller.excalibur_choice = -1; _refresh(), "button_secondary_dark")
				button("确认队伍", 394, 1025, 274, func(): controller.submit_team())
			state_line(("点击头像选择队员" + ("，再选王者之剑持有者" if excalibur else "")) if model.is_captain() else "等待队长选择队员")
		9:
			header("全员投票")
			progress()
			text_label("本轮任务队伍", 125, 375, 500, 55, 29)
			for i in model.selected_seats.size():
				player_avatar(int(model.selected_seats[i]), 110 + i * 105, 450, 84)
			if model.excalibur_seat >= 0:
				text_label("王者之剑：%s" % seat_names([model.excalibur_seat]), 90, 600, 570, 40, 20)
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
				text_label("本轮队伍：" + seat_names(model.selected_seats), 90, 300, 570, 60, 20)
				var holder_seat := model.excalibur_seat
				if holder_seat == model.my_seat() and not model.acted:
					text_label("你可以翻转一名队员的任务牌（成功↔失败），并得知他原本出的牌", 90, 400, 570, 80, 22)
					var targets: Array = model.selected_seats.filter(func(seat): return seat != model.my_seat())
					for i in targets.size():
						var seat: int = targets[i]
						chip("翻转 %d号" % (seat + 1), 90 + (i % 3) * 195, 520 + (i / 3) * 80, 180, 62, func(): controller.use_excalibur(seat))
					button("不使用", 195, 820, 360, func(): controller.use_excalibur(-1), "button_secondary_dark")
				else:
					text_label("王者之剑持有者 %s 正在决定" % seat_names([holder_seat]) if not model.acted else "已决定，等待任务结果", 90, 470, 570, 80, 26)
				state_line("王者之剑持有者可以改变一张任务牌")
			else:
				header("任务执行")
				progress()
				text_label("你是任务队员" if model.is_member() else "等待任务队员行动", 110, 520, 530, 70, 34)
				art("mission-success-emblem", 160, 675, 142)
				art("mission-failure-emblem", 458, 675, 142)
				text_label("本轮队伍：" + seat_names(model.selected_seats), 90, 300, 570, 60, 20)
				if model.excalibur_seat >= 0:
					text_label("王者之剑：%s（出牌后可翻转一名队员的牌）" % seat_names([model.excalibur_seat]), 90, 370, 570, 60, 18)
				if model.is_member() and not model.acted:
					button("任务成功", 80, 875, 285, func(): controller.mission(true))
					if T.is_bad_role(model.my_role):
						button("任务失败", 385, 875, 285, func(): controller.mission(false), "button_danger_red")
				state_line("已提交，等待任务结果" if model.acted else ("好人只能选择任务成功" if model.is_member() else "等待队员提交任务牌"))
		11:
			var is_vote := controller.last_result_route == T.Route.VOTE_RESULT
			header("投票结果" if is_vote else "第 %d 轮任务结果" % int(model.last_mission.get("round", model.round)))
			progress()
			var mission_ok := model.last_vote_passed if is_vote else bool(model.last_mission.get("isSuccess", false))
			art("mission-success-emblem" if mission_ok else "mission-failure-emblem", 240, 440, 270)
			text_label(("队伍通过" if mission_ok else "队伍未通过") if is_vote else ("任务成功" if mission_ok else "任务失败"), 100, 750, 550, 80, 42)
			text_label("连续否决 %d / 5" % model.failed_votes if is_vote else "失败牌 %d 张    累计 成功 %d 失败 %d" % [int(model.last_mission.get("failCount", 0)), model.mission_results.count(true), model.mission_results.count(false)], 100, 835, 550, 50, 25)
			if is_vote:
				var approvals: Array = []
				var rejections: Array = []
				for i in model.last_votes.size():
					(approvals if model.last_votes[i] else rejections).append(i)
				text_label("赞成：" + seat_names(approvals), 90, 890, 570, 60, 19)
				text_label("反对：" + seat_names(rejections), 90, 950, 570, 60, 19)
			elif not model.last_excalibur.is_empty():
				var target := int(model.last_excalibur.get("targetSeat", -1))
				var holder := int(model.last_excalibur.get("holderSeat", -1))
				text_label("王者之剑：%d号%s" % [holder + 1, "翻转了%d号的牌" % (target + 1) if target >= 0 else "没有使用"], 90, 900, 570, 50, 20)
			turn_alert(995)
			button("查看结算" if model.stage == T.Stage.END else "继续", 175, 1050, 400, func(): controller.show_page(controller.page_for_stage(model.stage)))
		12:
			header("刺杀阶段", "坏人亮明身份，刺客选择梅林")
			progress()
			var is_assassin := model.my_role == T.Role.ASSASSIN
			var is_evil := T.is_bad_role(model.my_role)
			seats(is_assassin)
			text_label("坏人：" + seat_names(model.revealed_evil), 80, 760, 590, 50, 20, HORIZONTAL_ALIGNMENT_CENTER, RED)
			if is_evil:
				dark_panel(60, 815, 630, 170)
				chat_lines(822, 4, "evil", 40.0)
				line_edit("chat", "", "和同伴商量刺杀目标", 60, 995, 440, 52)
				chip("发送", 510, 993, 180, 56, func(): if controller.send_chat(field_text("chat")): (inputs["chat"] as LineEdit).clear())
			if is_assassin:
				text_label("目标：" + seat_names(controller.team_choice) if not controller.team_choice.is_empty() else "点击头像选择刺杀目标", 80, 1060, 590, 40, 22)
				button("确认刺杀", 195, 1110, 360, func(): controller.assassinate(int(controller.team_choice[0])) if not controller.team_choice.is_empty() else _notice("请选择目标"), "button_danger_red")
			elif not is_evil:
				text_label("好人完成了三次任务，坏人正在商议刺杀目标", 100, 870, 550, 75, 24)
			state_line("你是刺客，只能刺杀好人" if is_assassin else ("坏人私聊只有坏人可见" if is_evil else "等待刺客行动"))
		13:
			header("游戏结算")
			var fr: Dictionary = model.final_result if not model.final_result.is_empty() else model.snapshot()
			var won: Variant = fr.get("won")
			var headline := "好人胜利" if fr.get("winner") else "坏人胜利"
			if won != null:
				headline += "  ·  你%s" % ("赢了" if won else "输了")
			text_label(headline, 90, 215, 570, 90, 42)
			text_label(str(fr.get("reason", "")), 110, 305, 530, 80, 22)
			art("panel_content_large", 105, 405, 545)
			var roster: Array = fr.get("players", [])
			var row := 580.0 / maxf(8.0, roster.size())
			for i in mini(10, roster.size()):
				var player: Dictionary = roster[i]
				var me := " （你）" if i == int(fr.get("me", -1)) else (" AI" if player.get("isAi", false) else "")
				var role := int(player.get("role", 0))
				text_label("%d. %s    %s%s" % [i + 1, str(player.get("nickname", "玩家")).left(8), T.role_name(role), me], 162, 470 + i * row, 430, row - 4, 20, HORIZONTAL_ALIGNMENT_LEFT, RED if T.is_bad_role(role) else Color(0.95, 0.9, 0.78))
			button("查看复盘", 60, 1070, 200, func(): controller.show_page(14))
			button("再来一局", 275, 1070, 200, func(): controller.play_again())
			button("主界面", 490, 1070, 200, func(): controller.leave_room(), "button_secondary_dark")
		14:
			header("对局复盘", "本局关键事件")
			var fr: Dictionary = model.final_result if not model.final_result.is_empty() else model.snapshot()
			art("panel_content_large", 100, 245, 550)
			var results: Array = fr.get("results", [])
			text_label("完成 %d 轮任务：成功 %d 次，失败 %d 次" % [results.size(), results.count(true), results.count(false)], 150, 290, 460, 50, 21)
			text_label("结论：" + str(fr.get("reason", "")), 150, 340, 460, 60, 19)
			var events: Array = Array(fr.get("history", [])).filter(func(event): return int(event.get("route", 0)) in [402, 502, 602, 903, 906, 702])
			var recent: Array = events.slice(maxi(0, events.size() - 11))
			for i in recent.size():
				text_label(history_text(recent[i]), 150, 410 + i * 56, 460, 52, 18, HORIZONTAL_ALIGNMENT_LEFT)
			button("保存分享图", 100, 1080, 270, save_share_card)
			button("返回结算", 390, 1080, 270, func(): controller.show_page(13), "button_secondary_dark")
			state_line("复盘根据本局公开事件生成")
		15:
			header("排行榜", "本机对局记录")
			art("panel_content_large", 103, 235, 545)
			var matches: Array = AvalonApp.profile.data.matches
			for i in mini(9, matches.size()):
				var match_data: Dictionary = matches[i]
				var won_match: Variant = match_data.get("won")
				var outcome := "胜利" if won_match == true else "失败" if won_match == false else ("好人胜" if match_data.get("winner", false) else "坏人胜")
				text_label("%d. %s  %s  %s" % [i + 1, T.role_name(int(match_data.get("role", 0))), "联机" if match_data.get("mode") == "network" else "练习", outcome], 155, 310 + i * 80, 445, 55, 22, HORIZONTAL_ALIGNMENT_LEFT)
			if matches.is_empty():
				text_label("暂无对局记录", 160, 510, 430, 60)
			nav()
		16:
			header("好友", "本机联系人")
			art("panel_content_large", 103, 225, 545)
			line_edit("friend", search_text, "输入好友昵称", 138, 282, 420, 58)
			button("添加", 560, 282, 115, func(): search_text = field_text("friend"); AvalonApp.profile.add_friend(search_text); _refresh())
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
			text_label("持有者：%s" % seat_names([model.lady_holder]), 80, 765, 590, 44, 24, HORIZONTAL_ALIGNMENT_CENTER, BLUE)
			if is_holder and not model.acted:
				text_label("选择一名玩家查验阵营，结果只有你知道；之后仙女交给他", 80, 810, 590, 60, 20)
				text_label("查验：" + seat_names(controller.team_choice) if not controller.team_choice.is_empty() else "点击头像选择（不能查验自己和曾经的持有者）", 80, 868, 590, 50, 20)
				button("查验", 195, 925, 360, func(): controller.lady_check(int(controller.team_choice[0])) if not controller.team_choice.is_empty() else _notice("请选择查验对象"))
			else:
				text_label("等待持有者查验" if model.stage == T.Stage.LADY_OF_LAKE and not model.acted else "查验完成", 80, 830, 590, 50, 22)
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
				dark_panel(x, y, 150, 165, GOLD if key == controller.avatar_choice else Color(0.51, 0.4, 0.24))
				art(key, x + 20, y + 12, 110)
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
