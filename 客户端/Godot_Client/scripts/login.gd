extends Control
## Login screen presentation only. Authentication is not connected yet.

signal login_requested(provider: String)
signal settings_requested
signal document_requested(document: String)

@onready var agreement: CheckBox = $Agreement/CheckBox
@onready var sound: Button = $Toolbar/SoundButton

func _ready() -> void:
	$Actions/WechatButton.pressed.connect(func(): _request_login("wechat"))
	$Actions/GuestButton.pressed.connect(func(): _request_login("guest"))
	$Toolbar/SettingsButton.pressed.connect(func(): settings_requested.emit())
	$Agreement/Terms.pressed.connect(func(): document_requested.emit("terms"))
	$Agreement/Privacy.pressed.connect(func(): document_requested.emit("privacy"))
	$AgeNotice.pressed.connect(func(): document_requested.emit("age"))
	sound.toggled.connect(_on_sound_toggled)
	for button: BaseButton in [$Actions/WechatButton, $Actions/GuestButton]:
		button.mouse_entered.connect(func(): button.modulate = Color(1.12, 1.12, 1.12))
		button.mouse_exited.connect(func(): button.modulate = Color.WHITE)
		button.button_down.connect(func(): button.modulate = Color(0.83, 0.83, 0.83))
		button.button_up.connect(func(): button.modulate = Color.WHITE)

func _on_sound_toggled(muted: bool) -> void:
	AudioServer.set_bus_mute(0, muted)
	$Toolbar/SoundButton/MuteMark.visible = muted
	sound.tooltip_text = "开启声音" if muted else "关闭声音"

func _request_login(provider: String) -> void:
	login_requested.emit(provider)
	if has_node("/root/AvalonApp"):
		AvalonApp.login_requested(provider)
