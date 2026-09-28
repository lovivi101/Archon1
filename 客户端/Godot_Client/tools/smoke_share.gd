extends SceneTree
## Sharing: invite text and room-code parsing, clipboard invite and paste, launch code, and the result
## card (rendered, saved, previewed on the results page and shared). Run with `-- room=654321`.

func _initialize() -> void:
	call_deferred("run")

func fail(message: String) -> void:
	push_error("SHARE_FAILED " + message)
	quit(1)

func run() -> void:
	var app: Node = root.get_node("AvalonApp")
	var controller: AvalonController = app.controller
	var model: AvalonModel = app.model
	var share: AvalonShare = app.share

	for case in [["123456", "123456"], ["房间号 654321（含湖中仙女）", "654321"], ["1234567", ""], ["abc", ""], ["第4轮 房间号 000123。", "000123"]]:
		if AvalonShare.extract_room_code(case[0]) != case[1]:
			return fail("extract %s" % case[0])
	var invite := AvalonShare.invite_text("123456", 7, AvalonTypes.rules_text(7))
	if not ("123456" in invite and "湖中仙女" in invite and AvalonShare.extract_room_code(invite) == "123456"):
		return fail("invite text " + invite)
	if "room=654321" in OS.get_cmdline_user_args() and controller.invite_code != "654321":
		return fail("launch code %s" % controller.invite_code)
	print("SHARE platform=%s launch=%s" % [share.platform(), controller.invite_code])

	# Offline, the invite is refused; in an online room it lands on the clipboard and pastes back.
	controller.create_local_room(7, 3)
	controller.share_invite()
	if not "本地练习" in controller.last_notice:
		return fail("local invite notice " + controller.last_notice)
	model.mode = "network"
	model.room_id = "246810"
	model.target_players = 7
	controller.share_invite()
	var clip := DisplayServer.clipboard_get()
	if not ("246810" in clip and "湖中仙女" in clip):
		return fail("clipboard " + clip)
	DisplayServer.clipboard_set("快来！" + clip)
	if controller.paste_invite() != "246810":
		return fail("paste")
	DisplayServer.clipboard_set("没有房间号")
	if controller.paste_invite() != "" or not "没有" in controller.last_notice:
		return fail("paste without code")

	# Finish a local 7-player game and share its card.
	controller.create_local_room(7, 3)
	controller.ready()
	for i in 3000:
		if not app.local_game.running:
			break
		app.local_game.bot_tick(true)
	if model.stage != AvalonTypes.Stage.END:
		return fail("local game did not finish")
	var data := AvalonShare.card_data(model)
	if data.players.size() != 7 or int(data.my_role) == 0 or data.won == null or data.missions.size() < 3 or str(data.reason).is_empty():
		return fail("card data %s" % data)
	var text := AvalonShare.card_text(data)
	if not (AvalonTypes.role_name(int(data.my_role)) in text):
		return fail("card text " + text)
	var image: Image = await share.render_card(data)
	if image == null or image.get_size() != AvalonShare.CARD_SIZE:
		return fail("render")
	if image.get_pixel(375, 500).is_equal_approx(image.get_pixel(40, 40)) and image.get_pixel(375, 270).is_equal_approx(image.get_pixel(40, 40)):
		return fail("card looks blank")
	image.save_png(ProjectSettings.globalize_path("res://verification/share_card.png"))

	var viewport := SubViewport.new()
	viewport.size = Vector2i(750, 1334)
	viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	root.add_child(viewport)
	var page: Control = load("res://scenes/page_13.tscn").instantiate()
	viewport.add_child(page)
	for i in 3:
		await process_frame
	await page.share_result()
	var overlay: Node = page.get_node_or_null("SharePreview")
	if overlay == null:
		return fail("no preview")
	if not FileAccess.file_exists(AvalonShare.CARD_PATH):
		return fail("card not saved")
	for i in 3:
		await process_frame
	viewport.get_texture().get_image().save_png(ProjectSettings.globalize_path("res://verification/page_13_share.png"))
	var send: Button = null
	for child in overlay.get_children():
		if child is Button and child.text == share.share_label():
			send = child
	if send == null:
		return fail("no share button")
	DisplayServer.clipboard_set("")
	send.pressed.emit()
	if DisplayServer.clipboard_get() != text:
		return fail("shared text %s" % DisplayServer.clipboard_get())
	page.close_share_preview()
	await process_frame
	if page.get_node_or_null("SharePreview") != null:
		return fail("preview not closed")

	# A stored server replay makes its own card: roles, missions and the date it ended.
	model.user_id = "me"
	model.replay = {"matchId": 7, "isGoodWin": true, "winReason": "梅林存活，好人胜利", "endedAt": 1790000000000.0,
		"missions": [{"round": 1, "success": true}, {"round": 2, "success": false}, {"round": 3, "success": true}, {"round": 4, "success": true}],
		"players": [{"userId": "me", "nickname": "我", "role": 3.0, "isAi": false}, {"userId": "x", "nickname": "甲", "role": 4.0, "isAi": true},
			{"userId": "y", "nickname": "乙", "role": 1.0, "isAi": true}, {"userId": "z", "nickname": "丙", "role": 5.0, "isAi": true}, {"userId": "w", "nickname": "丁", "role": 2.0, "isAi": true}]}
	var stored := AvalonShare.card_data(model)
	if stored.player_count != 5 or stored.my_role != 3 or stored.won != true or stored.missions != [true, false, true, true] or stored.date != "2026-09-21":
		return fail("replay card %s" % stored)
	model.replay = {}

	# An invite code from launch sends the player to the lobby after login, with the code filled in.
	controller.invite_code = "135790"
	controller.login("guest")
	if controller.page != 3 or not "135790" in controller.last_notice:
		return fail("invite after login page=%d" % controller.page)
	print("SHARE card=%s" % text)
	print("GODOT_SHARE_OK")
	quit()
