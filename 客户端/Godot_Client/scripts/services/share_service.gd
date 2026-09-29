extends Node
class_name AvalonShare
## Room invites and result cards, and the platform hooks that send them.
##
## What each platform does (details and the Android plugin interface in docs/分享与邀请.md):
## - WeChat mini-game (web export through godot-minigame, where the global `wx` exists):
##   invites open wx.shareAppMessage with the query "room=<code>", and the "转发" menu shares the
##   current room too; starting the game from such a card joins that room (see launch_room_code).
##   The result card is captured from the screen with canvas.toTempFilePathSync and shared the same way.
## - Web: the invite text carries a link with ?room=<code>, which launch_room_code reads.
## - Android: when an Android plugin singleton named "AvalonShare" is present, text and images go to
##   the system share sheet; without it text goes to the clipboard and the card to Pictures/Avalon.
## - Desktop: text goes to the clipboard and the card is saved to Pictures/Avalon.
## The card PNG is always also saved to user://avalon-share.png.

const TITLE := "阿瓦隆：暗影对决"
const CARD_SIZE := Vector2i(750, 1000)
const CARD_PATH := "user://avalon-share.png"
const ROOM_PARAM := "room"
const ANDROID_PLUGIN := "AvalonShare"
const GOLD := Color(0.95, 0.78, 0.4)
const RED := Color(0.95, 0.45, 0.4)
const BLUE := Color(0.55, 0.75, 1.0)
const TEXT := Color(0.95, 0.9, 0.78)

var _catalog: Dictionary = {}

func _ready() -> void:
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string("res://assets/ui/catalog.json"))
	if parsed is Dictionary:
		_catalog = parsed
	if platform() == "wechat":
		# The share menu reads globalThis.__avalonShare, which set_share_target keeps up to date.
		_js("""(function(){try{
			wx.showShareMenu({withShareTicket:false, menus:['shareAppMessage','shareTimeline']});
			wx.onShareAppMessage(function(){return globalThis.__avalonShare||{title:%s};});
			wx.onShareTimeline(function(){var s=globalThis.__avalonShare||{title:%s};return {title:s.title, query:s.query||''};});
		}catch(e){}})()""" % [JSON.stringify(TITLE), JSON.stringify(TITLE)])

## "wechat", "web", "android_plugin", "android" or "desktop".
func platform() -> String:
	if OS.has_feature("web"):
		return "wechat" if _js("typeof wx !== 'undefined' && typeof wx.shareAppMessage === 'function'") == true else "web"
	if OS.has_feature("android"):
		return "android_plugin" if Engine.has_singleton(ANDROID_PLUGIN) else "android"
	return "desktop"

## Label for the button that sends a card or invite on this platform.
func share_label() -> String:
	return "分享给好友" if platform() in ["wechat", "android_plugin"] else "复制战绩文字"

# ---- invites ----

static func invite_text(room_id: String, player_count: int, rules: String, link := "") -> String:
	var text := "【%s】邀请你加入 %d 人局，房间号 %s%s。打开游戏 → 联机对战 → 输入房间号即可加入。" % [
		TITLE, player_count, room_id, "（%s）" % rules if not rules.is_empty() and rules != "无" else ""]
	return text + ("\n" + link if not link.is_empty() else "")

## Finds a 6-digit room code in pasted text (a bare code or a whole invite message); "" when there is none.
static func extract_room_code(text: String) -> String:
	var regex := RegEx.create_from_string("(?<![0-9])[0-9]{6}(?![0-9])")
	var found := regex.search(text)
	return found.get_string() if found != null else ""

## Link that opens the game straight into the room, on platforms that have one.
func invite_link(room_id: String) -> String:
	if platform() != "web":
		return ""
	var base: Variant = _js("location.origin + location.pathname")
	return "%s?%s=%s" % [base, ROOM_PARAM, room_id] if base is String else ""

## Sends an invite; returns the message to show the player.
func share_invite(room_id: String, player_count: int, rules: String) -> String:
	var text := invite_text(room_id, player_count, rules, invite_link(room_id))
	match platform():
		"wechat":
			set_share_target("%d 人局等你来，房间号 %s" % [player_count, room_id], room_id)
			_js("(function(){try{wx.shareAppMessage(globalThis.__avalonShare);}catch(e){}})()")
			return "已打开微信分享，好友点开卡片即可加入"
		"android_plugin":
			Engine.get_singleton(ANDROID_PLUGIN).shareText(TITLE, text)
			copy_text(text)
			return "已打开分享面板，邀请文字也已复制"
	copy_text(text)
	return "邀请已复制（房间号 %s），发给好友即可" % room_id

## What the WeChat share menu sends: a room invite while in a room, the plain game otherwise.
func set_share_target(title: String, room_id := "") -> void:
	if platform() != "wechat":
		return
	var target := {"title": title}
	if not room_id.is_empty():
		target.query = "%s=%s" % [ROOM_PARAM, room_id]
	_js("globalThis.__avalonShare = %s;" % JSON.stringify(target))

## Room code the game was opened with: a WeChat share card, a web link (?room=) or `room=` on the command line.
func launch_room_code() -> String:
	var raw := ""
	match platform():
		"wechat":
			var value: Variant = _js("(function(){try{var q=wx.getLaunchOptionsSync().query||{};return String(q.%s||'');}catch(e){return '';}})()" % ROOM_PARAM)
			raw = str(value) if value != null else ""
		"web":
			var value: Variant = _js("new URLSearchParams(location.search).get('%s')||''" % ROOM_PARAM)
			raw = str(value) if value != null else ""
		_:
			for arg in OS.get_cmdline_user_args():
				if arg.begins_with(ROOM_PARAM + "="):
					raw = arg.substr(ROOM_PARAM.length() + 1)
	return extract_room_code(raw)

func copy_text(text: String) -> void:
	if platform() == "wechat":
		_js("(function(){try{wx.setClipboardData({data:%s});}catch(e){}})()" % JSON.stringify(text))
	else:
		DisplayServer.clipboard_set(text)

func paste_text() -> String:
	return DisplayServer.clipboard_get() if DisplayServer.clipboard_has() else ""

# ---- result card ----

## Card contents from the game that just ended, or from a stored server replay when `replay` is set.
static func card_data(model: AvalonModel) -> Dictionary:
	var data := {"nickname": model.nickname, "rating": {}, "date": Time.get_date_string_from_system()}
	if not model.replay.is_empty():
		var record: Dictionary = model.replay
		data.good_win = bool(record.get("isGoodWin", false))
		data.reason = str(record.get("winReason", ""))
		data.missions = Array(record.get("missions", [])).map(func(mission): return bool(mission.get("success", false)))
		data.players = Array(record.get("players", [])).map(func(player): return {"nickname": str(player.get("nickname", "")), "role": int(player.get("role", 0)), "is_ai": bool(player.get("isAi", false)), "me": str(player.get("userId", "")) == model.user_id})
		if record.has("endedAt"):
			var local_offset := int(Time.get_time_zone_from_system().get("bias", 0)) * 60
			data.date = Time.get_date_string_from_unix_time(int(float(record.endedAt) / 1000.0) + local_offset)
	else:
		var result: Dictionary = model.final_result if not model.final_result.is_empty() else model.snapshot()
		data.good_win = result.get("winner") == true
		data.reason = str(result.get("reason", ""))
		data.missions = Array(result.get("results", [])).map(func(ok): return bool(ok))
		var me := int(result.get("me", -1))
		var roster: Array = result.get("players", [])
		data.players = []
		for i in roster.size():
			var player: Dictionary = roster[i]
			data.players.append({"nickname": str(player.get("nickname", "")), "role": int(player.get("role", 0)), "is_ai": bool(player.get("isAi", false)), "me": i == me})
		if model.mode == "network":
			data.rating = model.last_rating.duplicate()
	data.player_count = data.players.size()
	data.my_role = 0
	for player in data.players:
		if player.me:
			data.my_role = player.role
	data.won = null if data.my_role == 0 else (data.good_win != AvalonTypes.is_bad_role(data.my_role))
	return data

## One-line summary that goes with the card (clipboard text, share title).
static func card_text(data: Dictionary) -> String:
	var missions: Array = data.get("missions", [])
	var text := "我在【%s】%d 人局中扮演%s，%s！%s（任务 %d 成 %d 败）" % [TITLE, int(data.get("player_count", 0)),
		AvalonTypes.role_name(int(data.get("my_role", 0))), "赢了" if data.get("won") == true else ("惜败" if data.get("won") == false else "观战"),
		"好人胜利" if data.get("good_win", false) else "坏人胜利", missions.count(true), missions.count(false)]
	var rating: Dictionary = data.get("rating", {})
	if not rating.is_empty():
		text += " 段位：%s %d 分" % [rating.get("tier", ""), int(rating.get("rating", 0))]
	return text

## Draws the card off screen and returns it (null when the renderer cannot read pixels back, e.g. --headless).
func render_card(data: Dictionary) -> Image:
	var viewport := SubViewport.new()
	viewport.size = CARD_SIZE
	viewport.transparent_bg = false
	viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	viewport.add_child(build_card(data))
	add_child(viewport)
	# The first frame lays out wrapped labels; the second draws them in place.
	await RenderingServer.frame_post_draw
	await RenderingServer.frame_post_draw
	var image: Image = viewport.get_texture().get_image()
	viewport.queue_free()
	return image

## Saves the card and hands it to the platform; returns the message to show the player.
## `screen_rect` is where the card preview is on screen, in window pixels (used by WeChat);
## `saved` is the path from an earlier save_card, so the card is not written twice.
func share_card(image: Image, data: Dictionary, screen_rect := Rect2(), saved := "") -> String:
	var text := card_text(data)
	if saved.is_empty():
		saved = save_card(image)
	match platform():
		"wechat":
			var ok: Variant = _js("""(function(){try{
				var c = globalThis.canvas || (typeof GameGlobal !== 'undefined' ? GameGlobal.canvas : null);
				var r = %s;
				var p = c.toTempFilePathSync({x:r.x, y:r.y, width:r.w, height:r.h, destWidth:750, destHeight:1000});
				wx.shareAppMessage({title:%s, imageUrl:p});
				return true;
			}catch(e){return false;}})()""" % [JSON.stringify({"x": screen_rect.position.x, "y": screen_rect.position.y, "w": screen_rect.size.x, "h": screen_rect.size.y}), JSON.stringify(text)])
			if ok == true:
				return "已打开微信分享"
			copy_text(text)
			return "无法截取分享图，战绩文字已复制"
		"android_plugin":
			if not saved.is_empty():
				Engine.get_singleton(ANDROID_PLUGIN).shareImage(saved, TITLE, text)
				return "已打开分享面板"
	copy_text(text)
	return "战绩文字已复制" + ("，分享图已保存：%s" % saved if not saved.is_empty() else "")

## Writes the card PNG; returns the most useful absolute path (Pictures/Avalon when writable), or "".
func save_card(image: Image) -> String:
	if image == null or image.is_empty():
		return ""
	if image.save_png(CARD_PATH) != OK:
		return ""
	var saved := ProjectSettings.globalize_path(CARD_PATH)
	if OS.has_feature("web"):
		return saved
	var pictures := OS.get_system_dir(OS.SYSTEM_DIR_PICTURES)
	if not pictures.is_empty() and DirAccess.make_dir_recursive_absolute(pictures.path_join("Avalon")) == OK:
		var target := pictures.path_join("Avalon").path_join("avalon-%s.png" % Time.get_datetime_string_from_system().replace(":", "-"))
		if image.save_png(target) == OK:
			return target
	return saved

## Control tree of the result card (CARD_SIZE), also used for on-screen previews.
func build_card(data: Dictionary) -> Control:
	var card := Control.new()
	card.size = Vector2(CARD_SIZE)
	card.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var background := _art(card, "bg-records-hall-750x1334", 0, 0, 750)
	background.size = Vector2(CARD_SIZE)
	background.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_COVERED
	var dim := ColorRect.new()
	dim.color = Color(0.01, 0.015, 0.025, 0.72)
	dim.size = Vector2(CARD_SIZE)
	card.add_child(dim)
	_frame(card, Rect2(18, 18, 714, 964), GOLD, Color(0, 0, 0, 0))
	_art(card, "game_logo_title", 185, 30, 380)

	var good_win: bool = data.get("good_win", false)
	_frame(card, Rect2(165, 232, 420, 84), GOLD, Color(0.08, 0.18, 0.4, 0.9) if good_win else Color(0.4, 0.07, 0.06, 0.9), 12)
	_label(card, "好人胜利" if good_win else "坏人胜利", 0, 226, 750, 96, 46, TEXT)
	var won: Variant = data.get("won")
	var me_line := "%s · %s" % [str(data.get("nickname", "")).left(12), AvalonTypes.role_name(int(data.get("my_role", 0)))]
	if won != null:
		me_line += " · %s" % ("胜利" if won else "失败")
	_label(card, me_line, 40, 330, 670, 50, 30, GOLD if won == true else (RED if won == false else TEXT))

	var missions: Array = data.get("missions", [])
	for i in 5:
		var x := 120 + i * 110
		if i < missions.size():
			_art(card, "mission-success-emblem" if missions[i] else "mission-failure-emblem", x, 395, 70)
		else:
			_frame(card, Rect2(x + 5, 400, 60, 60), Color(0.4, 0.4, 0.45), Color(0.08, 0.09, 0.12, 0.9), 30)
		_label(card, "第%d轮" % (i + 1), x - 15, 468, 100, 28, 16, Color(0.75, 0.72, 0.65))
	_label(card, str(data.get("reason", "")), 60, 502, 630, 56, 22, TEXT)

	var rating: Dictionary = data.get("rating", {})
	if not rating.is_empty():
		var delta := int(rating.get("delta", 0))
		_label(card, "段位分 %s%d → %d · %s" % ["+" if delta >= 0 else "", delta, int(rating.get("rating", 0)), rating.get("tier", "")], 40, 560, 670, 40, 24, GOLD)

	var players: Array = data.get("players", [])
	_frame(card, Rect2(50, 610, 650, 290), Color(0.51, 0.4, 0.24), Color(0.025, 0.04, 0.06, 0.85), 8)
	var per_column := int(ceil(players.size() / 2.0))
	for i in players.size():
		var player: Dictionary = players[i]
		var role := int(player.get("role", 0))
		var suffix := "（我）" if player.get("me", false) else (" AI" if player.get("is_ai", false) else "")
		var column := i / maxi(per_column, 1)
		var row := i % maxi(per_column, 1)
		_label(card, "%d. %s  %s%s" % [i + 1, str(player.get("nickname", "")).left(7), AvalonTypes.role_name(role), suffix],
			75 + column * 315, 625 + row * 54, 305, 50, 20, RED if AvalonTypes.is_bad_role(role) else BLUE, HORIZONTAL_ALIGNMENT_LEFT)
	_label(card, "%d 人局 · %s · %s" % [int(data.get("player_count", 0)), data.get("date", ""), TITLE], 40, 918, 670, 40, 18, Color(0.75, 0.72, 0.65))
	return card

# ---- helpers ----

func _art(parent: Control, name: String, x: float, y: float, width: float) -> TextureRect:
	var rect := TextureRect.new()
	rect.mouse_filter = Control.MOUSE_FILTER_IGNORE
	# Before any size is set, or the rect is clamped to the texture's full size.
	rect.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	rect.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	var source: Texture2D = load("res://assets/ui/%s.png" % name) if ResourceLoader.exists("res://assets/ui/%s.png" % name) else null
	if source != null:
		var box: Array = _catalog.get(name, [0, 0, source.get_width(), source.get_height()])
		var atlas := AtlasTexture.new()
		atlas.atlas = source
		atlas.region = Rect2(float(box[0]), float(box[1]), float(box[2]), float(box[3]))
		rect.texture = atlas
		rect.size = Vector2(width, width * float(box[3]) / float(box[2]))
	rect.position = Vector2(x, y)
	parent.add_child(rect)
	return rect

func _label(parent: Control, value: String, x: float, y: float, width: float, height: float, size: int, color: Color, align := HORIZONTAL_ALIGNMENT_CENTER) -> Label:
	var label := Label.new()
	label.text = value
	label.position = Vector2(x, y)
	label.size = Vector2(width, height)
	label.horizontal_alignment = align
	label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	label.clip_text = true
	label.add_theme_font_size_override("font_size", size)
	label.add_theme_color_override("font_color", color)
	label.add_theme_color_override("font_shadow_color", Color(0, 0, 0, 0.9))
	label.add_theme_constant_override("shadow_offset_x", 2)
	label.add_theme_constant_override("shadow_offset_y", 2)
	parent.add_child(label)
	return label

func _frame(parent: Control, rect: Rect2, border: Color, fill: Color, radius := 10) -> void:
	var panel := Panel.new()
	panel.position = rect.position
	panel.size = rect.size
	panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var style := StyleBoxFlat.new()
	style.bg_color = fill
	style.border_color = border
	style.set_border_width_all(3)
	style.set_corner_radius_all(radius)
	panel.add_theme_stylebox_override("panel", style)
	parent.add_child(panel)

func _js(code: String) -> Variant:
	if not OS.has_feature("web"):
		return null
	return JavaScriptBridge.eval(code, true)
