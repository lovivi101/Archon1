extends Control

const T = preload("res://scripts/mvc/avalon_types.gd")
@export_range(2, 16) var page_id := 2
var catalog: Dictionary = {}
var layer: Control
var status: Label
var input: LineEdit
var selected_action := true
var search_text := ""

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

func _refresh() -> void:
	if not is_instance_valid(layer):
		return
	for child in layer.get_children():
		child.queue_free()
	build_page()

func _notice(message: String) -> void:
	if is_instance_valid(status):
		status.text = message

func save_share_card() -> void:
	await RenderingServer.frame_post_draw
	var target := "user://avalon-share.png"
	var result := get_viewport().get_texture().get_image().save_png(target)
	_notice("分享图已保存：%s" % ProjectSettings.globalize_path(target) if result == OK else "保存分享图失败")

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
	control.pressed.connect(action)
	layer.add_child(control)
	return control

func header(title: String, subtitle := "") -> void:
	art("panel_header_empty", 75, 20, 600)
	text_label(title, 100, 42, 550, 86, 30)
	if not subtitle.is_empty():
		text_label(subtitle, 120, 112, 510, 42, 18)
	if page_id != 2:
		var back := Button.new()
		back.text = "‹"
		back.flat = true
		back.position = Vector2(31, 38)
		back.size = Vector2(60, 70)
		back.add_theme_font_size_override("font_size", 48)
		back.pressed.connect(func(): AvalonApp.controller.show_page(2 if page_id in [3,4,15,16] else AvalonApp.controller.resume_page))
		layer.add_child(back)

func state_line(message: String) -> void:
	status = text_label(message, 78, 1125 if page_id == 2 else 1234, 594, 43, 18)

func dark_panel(x: float, y: float, width: float, height: float) -> void:
	var panel := Panel.new()
	panel.position = Vector2(x, y)
	panel.size = Vector2(width, height)
	panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var style := StyleBoxFlat.new()
	style.bg_color = Color(0.025, 0.04, 0.06, 0.92)
	style.border_color = Color(0.51, 0.4, 0.24)
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
	var avatars := ["avatar-player-knight", "avatar-merlin", "avatar-loyal-female", "avatar-dwarf-warrior", "avatar-morgana", "avatar-assassin"]
	var name := "avatar-empty-slot"
	if seat >= 0 and seat < model.players.size():
		name = avatars[seat % avatars.size()]
	art(name, x, y, width)
	if seat >= 0 and seat < model.players.size():
		var p: Dictionary = model.players[seat]
		text_label(str(p.get("nickname", "玩家")).left(6), x - 25, y + width + 2, width + 50, 29, 16)

func seats(interactive := false) -> void:
	var positions := [Vector2(335, 235), Vector2(520, 280), Vector2(570, 405), Vector2(535, 555), Vector2(400, 630), Vector2(260, 630), Vector2(130, 555), Vector2(90, 405), Vector2(145, 280), Vector2(245, 230)]
	var model: AvalonModel = AvalonApp.model
	for i in mini(10, maxi(model.players.size(), 10)):
		var pos: Vector2 = positions[i]
		player_avatar(i, pos.x, pos.y)
		if i in model.selected_seats or i in AvalonApp.controller.team_choice:
			art("check-icon", pos.x + 62, pos.y + 56, 27)
		if i == model.captain_seat:
			art("crown-icon", pos.x + 28, pos.y - 28, 36)
		if interactive and i < model.players.size():
			var hit := Button.new()
			hit.flat = true
			hit.position = pos
			hit.size = Vector2(90, 110)
			hit.pressed.connect(AvalonApp.controller.choose_seat.bind(i))
			layer.add_child(hit)

func progress() -> void:
	var model: AvalonModel = AvalonApp.model
	text_label("第 %d 轮    %s    队长：%d 号" % [model.round, T.stage_name(model.stage), model.captain_seat + 1], 90, 165, 570, 48, 23)
	for i in 5:
		art("mission-success-emblem" if i < model.mission_results.size() and model.mission_results[i] else "mission-failure-emblem" if i < model.mission_results.size() else "slot_team_member", 198 + i * 76, 215, 48)

func build_page() -> void:
	var model: AvalonModel = AvalonApp.model
	match page_id:
		2:
			art("avatar-player-knight", 48, 30, 83)
			text_label(model.nickname, 125, 45, 250, 45, 21, HORIZONTAL_ALIGNMENT_LEFT)
			art("sound-icon", 570, 42, 41)
			art("settings-icon", 666, 42, 41)
			art("game_logo_title", 145, 268, 460)
			button("开始本地练习", 145, 900, 460, func(): AvalonApp.controller.create_local_room())
			button("连接 TS 服务器", 190, 1005, 370, func(): AvalonApp.controller.connect_server(model.server_url), "button_secondary_dark")
			text_label("服务器地址：" + model.server_url, 100, 1085, 550, 45, 18)
			nav()
			state_line("本地练习可离线运行；联机默认连接 127.0.0.1:8888")
		3:
			header("连接服务器", "自动登录并加入房间")
			seats()
			art("panel_modal_large", 105, 780, 540)
			text_label("服务器地址", 150, 840, 450, 55)
			input = LineEdit.new()
			input.text = model.server_url
			input.position = Vector2(148, 908)
			input.size = Vector2(454, 60)
			layer.add_child(input)
			button("连接 / 重试", 185, 994, 380, func(): AvalonApp.controller.connect_server(input.text))
			button("返回主界面", 220, 1085, 310, func(): AvalonApp.controller.show_page(2), "button_secondary_dark")
			state_line(model.connection)
		4:
			header("房间 " + model.room_id, "等待所有玩家准备")
			seats()
			dark_panel(92, 807, 566, 368)
			text_label("%d / %d 玩家" % [model.players.size(), model.players.size()], 150, 835, 450, 50, 31)
			button("准备 / 开始", 165, 953, 420, func(): AvalonApp.controller.ready())
			button("退出房间", 220, 1075, 310, func(): AvalonApp.controller.leave_room(), "button_secondary_dark")
			state_line("本地对局：其余席位由 AI 控制" if model.mode == "local_demo" else "联机房间：等待服务端开局")
		5:
			header("随机分配角色")
			for i in 5:
				art("card_role_back", 98 + i * 115, 350 + abs(i - 2) * 48, 120)
			text_label("正在随机分配角色", 95, 850, 560, 70, 34)
			text_label("请保持身份保密", 95, 930, 560, 48, 22)
			button("查看身份", 185, 1055, 380, func(): AvalonApp.controller.show_page(6))
		6:
			header("你的身份")
			art("card_role_front", 130, 220, 490)
			art("avatar-merlin" if model.my_role == T.Role.MERLIN else "avatar-assassin" if model.my_role == T.Role.ASSASSIN else "avatar-player-knight", 275, 320, 200)
			text_label(T.role_name(model.my_role), 160, 635, 430, 65, 37)
			text_label("可见席位：" + str(model.visible_seats), 120, 735, 510, 65, 22)
			text_label("请记住你的身份，不要向其他玩家展示", 110, 818, 530, 60, 21)
			button("确认身份", 160, 1035, 430, func(): AvalonApp.controller.confirm_identity())
		7:
			header("轮流发言")
			progress()
			seats()
			art("panel_mission_hud", 90, 885, 570)
			text_label("队长：%d 号玩家    自由讨论" % [model.captain_seat + 1], 125, 924, 500, 62)
			if model.stage == T.Stage.PROPOSING:
				button("进入组队", 165, 1050, 420, func(): AvalonApp.controller.show_page(8))
			else:
				text_label("等待队长组队阶段", 125, 1060, 500, 65, 25)
		8:
			header("队长组队")
			progress()
			seats(true)
			text_label("需要选择 %d 名队员，已选择 %d 名" % [model.get_team_size(), AvalonApp.controller.team_choice.size()], 65, 856, 620, 60, 25)
			button("清空选择", 74, 1025, 274, func(): AvalonApp.controller.team_choice.clear(); _refresh(), "button_secondary_dark")
			button("确认队伍", 394, 1025, 274, func(): AvalonApp.controller.submit_team())
			state_line("点击头像选择队员" if model.is_captain() else "等待队长选择队员")
		9:
			header("全员投票")
			progress()
			text_label("本轮任务队伍", 125, 375, 500, 55, 29)
			for i in model.selected_seats.size():
				player_avatar(int(model.selected_seats[i]), 190 + i * 105, 450, 84)
			art("thumbs-approve-icon", 169, 735, 130)
			art("thumbs-reject-icon", 458, 735, 130)
			button("赞成", 85, 900, 280, func(): AvalonApp.controller.vote(true))
			button("反对", 385, 900, 280, func(): AvalonApp.controller.vote(false), "button_danger_red")
			state_line("已投票，等待其他玩家" if model.voted else "请投票决定是否执行任务")
		10:
			header("任务执行")
			progress()
			text_label("你是任务队员" if model.is_member() else "等待任务队员行动", 110, 535, 530, 80, 34)
			art("mission-success-emblem", 160, 675, 142)
			art("mission-failure-emblem", 458, 675, 142)
			button("任务成功", 80, 875, 285, func(): AvalonApp.controller.mission(true))
			if T.is_bad_role(model.my_role):
				button("任务失败", 385, 875, 285, func(): AvalonApp.controller.mission(false), "button_danger_red")
			state_line("已提交，等待任务结果" if model.acted else "好人只能选择任务成功")
		11:
			var is_vote := AvalonApp.controller.last_result_route == T.Route.VOTE_RESULT
			header("投票结果" if is_vote else "第 %d 轮任务结果" % maxi(1, model.round - 1))
			progress()
			var mission_ok := model.last_vote_passed if is_vote else bool(model.last_mission.get("isSuccess", false))
			art("mission-success-emblem" if mission_ok else "mission-failure-emblem", 240, 450, 270)
			text_label(("队伍通过" if mission_ok else "队伍未通过") if is_vote else ("任务成功" if mission_ok else "任务失败"), 100, 760, 550, 80, 42)
			text_label("反对次数 %d / 5" % model.failed_votes if is_vote else "成功 %d    失败 %d" % [model.mission_results.count(true), model.mission_results.count(false)], 130, 870, 490, 58, 29)
			button("继续", 175, 1050, 400, func(): AvalonApp.controller.show_page(AvalonApp.controller.page_for_stage(model.stage)))
		12:
			header("刺杀阶段", "刺客选择梅林")
			progress()
			seats(true)
			text_label("目标席位：%d" % [AvalonApp.controller.team_choice[0] + 1] if not AvalonApp.controller.team_choice.is_empty() else "选择刺杀目标", 100, 860, 550, 75, 30)
			button("确认刺杀", 155, 1030, 440, func(): AvalonApp.controller.assassinate(int(AvalonApp.controller.team_choice[0])) if not AvalonApp.controller.team_choice.is_empty() else _notice("请选择目标"), "button_danger_red")
			state_line("等待刺客行动" if model.my_role != T.Role.ASSASSIN else "点击头像选择目标")
		13:
			header("游戏结算")
			text_label("好人胜利" if model.is_good_win else "坏人胜利", 90, 225, 570, 100, 50)
			text_label(model.win_reason, 110, 325, 530, 80, 24)
			art("panel_content_large", 105, 425, 545)
			for i in mini(8, model.players.size()):
				var player: Dictionary = model.players[i]
				text_label("%d. %s    %s" % [i + 1, player.get("nickname", "玩家"), T.role_name(int(player.get("role", 0)))], 162, 500 + i * 70, 430, 55, 20, HORIZONTAL_ALIGNMENT_LEFT)
			button("查看复盘", 100, 1070, 260, func(): AvalonApp.controller.show_page(14))
			button("再来一局", 390, 1070, 260, func(): AvalonApp.controller.create_local_room())
			state_line("返回主界面：点击左上角返回")
		14:
			header("对局复盘", "本地规则摘要")
			art("panel_content_large", 100, 245, 550)
			text_label("完成 %d 轮任务：成功 %d 次，失败 %d 次" % [model.mission_results.size(), model.mission_results.count(true), model.mission_results.count(false)], 150, 310, 460, 64, 22)
			text_label("结论：" + model.win_reason, 150, 380, 460, 66, 20)
			for i in mini(7, model.history.size()):
				var event: Dictionary = model.history[i]
				text_label("第 %d 轮  %s" % [int(event.get("round", 1)), {303:"身份确认", 402:"队伍提出", 502:"投票结果", 602:"任务结果", 702:"游戏结束"}.get(int(event.get("route", 0)), "对局事件")], 155, 470 + i * 74, 445, 55, 22, HORIZONTAL_ALIGNMENT_LEFT)
			button("保存分享图", 100, 1080, 270, save_share_card)
			button("返回结算", 390, 1080, 270, func(): AvalonApp.controller.show_page(13), "button_secondary_dark")
			state_line("复盘根据本局公开事件生成")
		15:
			header("排行榜", "本机练习记录")
			art("panel_content_large", 103, 235, 545)
			var matches: Array = AvalonApp.profile.data.matches
			for i in mini(9, matches.size()):
				var match_data: Dictionary = matches[i]
				text_label("%d. %s    %s" % [i + 1, match_data.get("nickname", "玩家"), "胜利" if match_data.get("winner", false) else "失败"], 155, 310 + i * 80, 445, 55, 22, HORIZONTAL_ALIGNMENT_LEFT)
			if matches.is_empty():
				text_label("暂无对局记录", 160, 510, 430, 60)
			nav()
		16:
			header("好友", "本机联系人")
			art("panel_content_large", 103, 225, 545)
			input = LineEdit.new()
			input.placeholder_text = "输入好友昵称"
			input.text = search_text
			input.position = Vector2(138, 282)
			input.size = Vector2(420, 58)
			layer.add_child(input)
			button("添加", 560, 282, 115, func(): search_text = input.text; AvalonApp.profile.add_friend(search_text); _refresh())
			var friends: Array = AvalonApp.profile.data.friends
			for i in mini(9, friends.size()):
				art("panel_list_row", 125, 375 + i * 78, 500)
				text_label(str(friends[i]), 165, 388 + i * 78, 405, 50, 22, HORIZONTAL_ALIGNMENT_LEFT)
			if friends.is_empty():
				text_label("暂无好友，输入昵称添加本机联系人", 130, 520, 490, 90, 21)
			nav()
