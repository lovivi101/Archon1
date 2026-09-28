extends Control
## Login screen. Logging in requires accepting the terms; the documents open in a dialog.

signal login_requested(provider: String)
signal settings_requested
signal document_requested(document: String)

## Draft texts. They must be replaced by legally reviewed versions before release.
const DOCUMENTS := {
	"terms": ["用户协议（草案）", "1. 《阿瓦隆：暗影对决》是一款多人社交推理游戏，请文明发言，不得发布辱骂、广告、违法或侵犯他人权益的内容。\n2. 请勿使用外挂、脚本或利用漏洞破坏游戏公平，违者可能被限制登录。\n3. 游客账号仅保存在本设备和服务器令牌中，卸载或更换设备可能导致数据丢失。\n4. 本协议为草案，正式上线前将以审核后的版本为准。"],
	"privacy": ["隐私政策（草案）", "我们仅收集运行游戏所必需的信息：\n· 账号标识：游客随机编号，或微信登录时由微信 openid 生成的不可逆编号；\n· 你设置的昵称和头像；\n· 对局中的发言、投票和结果，用于对局进行和复盘。\n我们不会出售你的个人信息。如需删除账号数据，请通过游戏内反馈联系我们。本政策为草案，正式上线前将以审核后的版本为准。"],
	"age": ["适龄提示", "本游戏为多人社交推理类游戏，不含暴力血腥内容，适合 12 周岁以上用户。未成年人请在监护人指导下合理安排游戏时间。"],
}

@onready var agreement: CheckBox = $Agreement/CheckBox
@onready var sound: Button = $Toolbar/SoundButton

func _ready() -> void:
	$Actions/WechatButton.pressed.connect(func(): _request_login("wechat"))
	$Actions/GuestButton.pressed.connect(func(): _request_login("guest"))
	$Toolbar/SettingsButton.pressed.connect(func(): settings_requested.emit())
	$Agreement/Terms.pressed.connect(func(): document_requested.emit("terms"))
	$Agreement/Privacy.pressed.connect(func(): document_requested.emit("privacy"))
	$AgeNotice.pressed.connect(func(): document_requested.emit("age"))
	settings_requested.connect(func(): show_message("设置", "登录后点击主界面左上角的头像，可以修改昵称、头像和声音。"))
	document_requested.connect(func(document: String): show_message(DOCUMENTS[document][0], DOCUMENTS[document][1]))
	sound.toggled.connect(_on_sound_toggled)
	if has_node("/root/AvalonApp"):
		agreement.button_pressed = bool(AvalonApp.profile.data.get("agreed", false))
		sound.button_pressed = bool(AvalonApp.profile.data.get("muted", false))
	for button: BaseButton in [$Actions/WechatButton, $Actions/GuestButton]:
		button.mouse_entered.connect(func(): button.modulate = Color(1.12, 1.12, 1.12))
		button.mouse_exited.connect(func(): button.modulate = Color.WHITE)
		button.button_down.connect(func(): button.modulate = Color(0.83, 0.83, 0.83))
		button.button_up.connect(func(): button.modulate = Color.WHITE)

func _on_sound_toggled(muted: bool) -> void:
	AudioServer.set_bus_mute(0, muted)
	$Toolbar/SoundButton/MuteMark.visible = muted
	sound.tooltip_text = "开启声音" if muted else "关闭声音"
	if has_node("/root/AvalonApp"):
		AvalonApp.profile.data.muted = muted
		AvalonApp.profile.save()

func show_message(title: String, text: String) -> void:
	var dialog := AcceptDialog.new()
	dialog.title = title
	dialog.dialog_text = text
	dialog.dialog_autowrap = true
	dialog.ok_button_text = "知道了"
	add_child(dialog)
	dialog.confirmed.connect(dialog.queue_free)
	dialog.canceled.connect(dialog.queue_free)
	dialog.popup_centered(Vector2i(620, 420))

func _request_login(provider: String) -> void:
	if has_node("/root/AvalonApp"):
		AvalonApp.audio.play_sfx("ui_click")
	if not agreement.button_pressed:
		show_message("提示", "请先阅读并勾选《用户协议》和《隐私政策》")
		return
	login_requested.emit(provider)
	if has_node("/root/AvalonApp"):
		AvalonApp.profile.data.agreed = true
		AvalonApp.profile.save()
		AvalonApp.login_requested(provider)
