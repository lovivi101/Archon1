extends Node
const Model = preload("res://scripts/models/avalon_model.gd")
const Network = preload("res://scripts/network/avalon_network.gd")
const LocalGame = preload("res://scripts/services/local_game.gd")
const Profile = preload("res://scripts/services/profile_store.gd")
const Controller = preload("res://scripts/controllers/avalon_controller.gd")
var model: AvalonModel = Model.new()
var network: AvalonNetwork = Network.new()
var local_game: Node = LocalGame.new()
var profile: RefCounted = Profile.new()
var controller: AvalonController = Controller.new()

func _ready() -> void:
	profile.load_data()
	add_child(network)
	add_child(local_game)
	add_child(controller)
	controller.setup(model,network,local_game,profile)

func login_requested(provider: String) -> void:
	controller.login(provider)
