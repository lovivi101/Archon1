extends Node
const Model = preload("res://scripts/models/avalon_model.gd")
const Network = preload("res://scripts/network/avalon_network.gd")
const LocalGame = preload("res://scripts/services/local_game.gd")
const Profile = preload("res://scripts/services/profile_store.gd")
const Controller = preload("res://scripts/controllers/avalon_controller.gd")
const Audio = preload("res://scripts/services/audio_service.gd")
const Share = preload("res://scripts/services/share_service.gd")
var model: AvalonModel = Model.new()
var network: AvalonNetwork = Network.new()
var local_game: Node = LocalGame.new()
var profile: RefCounted = Profile.new()
var controller: AvalonController = Controller.new()
var audio: AvalonAudio = Audio.new()
var share: AvalonShare = Share.new()

func _ready() -> void:
	profile.load_data()
	AudioServer.set_bus_mute(0, bool(profile.data.get("muted", false)))
	add_child(audio)
	audio.set_enabled(AvalonAudio.MUSIC_BUS, bool(profile.data.get("music_on", true)))
	audio.set_enabled(AvalonAudio.SFX_BUS, bool(profile.data.get("sfx_on", true)))
	add_child(network)
	add_child(local_game)
	add_child(controller)
	controller.setup(model,network,local_game,profile)
	controller.audio = audio
	add_child(share)
	controller.share = share
	controller.invite_code = share.launch_room_code()
	controller.game_event.connect(audio.play_sfx)
	controller.page_changed.connect(func(page: int): audio.play_music(audio.music_for_page(page, model)))
	audio.play_music("bgm_lobby")

func _process(_delta: float) -> void:
	audio.update_countdown(model)

func login_requested(provider: String) -> void:
	controller.login(provider)
