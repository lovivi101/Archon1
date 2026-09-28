extends Node
class_name AvalonAudio
## Plays sound effects and background music by name.
##
## Files live in res://assets/audio/sfx/<name>.<ext> and res://assets/audio/music/<name>.<ext>
## (ogg, wav or mp3). A missing file is skipped silently, so the game runs before any audio exists.
## The full list of names, and when each plays, is in assets/audio/README.md.

const EXTENSIONS := ["ogg", "wav", "mp3"]
const MUSIC_BUS := "Music"
const SFX_BUS := "SFX"
const SFX_VOICES := 8
const FADE_SECONDS := 0.8
## Every sound the game asks for; see assets/audio/README.md for when each plays.
const SFX_NAMES := ["ui_click", "ui_error", "room_enter", "player_join", "player_ready", "game_start", "role_reveal",
	"your_turn", "countdown_tick", "speech_message", "team_proposed", "vote_pass", "vote_reject", "mission_success",
	"mission_fail", "lady_check", "lady_result", "excalibur_flip", "evil_revealed", "assassination"]
const MUSIC_NAMES := ["bgm_lobby", "bgm_table", "bgm_assassination", "victory", "defeat"]
## Music that loops; anything else (victory/defeat stings) plays once.
const LOOPING_MUSIC := ["bgm_lobby", "bgm_table", "bgm_assassination"]

var _streams := {}
var _sfx: Array[AudioStreamPlayer] = []
var _music: Array[AudioStreamPlayer] = []
var _active_music := 0
var current_music := ""
var _last_tick := -1

func _ready() -> void:
	_ensure_bus(MUSIC_BUS)
	_ensure_bus(SFX_BUS)
	for i in SFX_VOICES:
		var player := AudioStreamPlayer.new()
		player.bus = SFX_BUS
		add_child(player)
		_sfx.append(player)
	for i in 2:
		var player := AudioStreamPlayer.new()
		player.bus = MUSIC_BUS
		player.finished.connect(_on_music_finished.bind(player))
		add_child(player)
		_music.append(player)

func _ensure_bus(bus_name: String) -> void:
	if AudioServer.get_bus_index(bus_name) != -1:
		return
	AudioServer.add_bus()
	var index := AudioServer.bus_count - 1
	AudioServer.set_bus_name(index, bus_name)
	AudioServer.set_bus_send(index, "Master")

## Enables or silences a bus: "Master", "Music" or "SFX".
func set_enabled(bus_name: String, enabled: bool) -> void:
	var index := AudioServer.get_bus_index(bus_name)
	if index != -1:
		AudioServer.set_bus_mute(index, not enabled)

func _stream(kind: String, sound: String) -> AudioStream:
	var key := "%s/%s" % [kind, sound]
	if _streams.has(key):
		return _streams[key]
	var stream: AudioStream = null
	for ext in EXTENSIONS:
		var path := "res://assets/audio/%s.%s" % [key, ext]
		if ResourceLoader.exists(path):
			stream = load(path)
			break
	_streams[key] = stream
	return stream

## True when a file exists for this sound (used by the audio checklist tool).
func has_sound(kind: String, sound: String) -> bool:
	return _stream(kind, sound) != null

func play_sfx(sound: String, volume_db := 0.0) -> void:
	var stream := _stream("sfx", sound)
	if stream == null:
		return
	var voice: AudioStreamPlayer = _sfx[0]
	for player in _sfx:
		if not player.playing:
			voice = player
			break
	voice.stream = stream
	voice.volume_db = volume_db
	voice.play()

## Crossfades to a track; the same track keeps playing. A missing file fades the music out.
func play_music(track: String) -> void:
	if track == current_music:
		return
	current_music = track
	var old: AudioStreamPlayer = _music[_active_music]
	var stream := _stream("music", track)
	if old.playing:
		var fade_out := create_tween()
		fade_out.tween_property(old, "volume_db", -40.0, FADE_SECONDS)
		fade_out.tween_callback(old.stop)
	if stream == null:
		return
	_active_music = 1 - _active_music
	var next: AudioStreamPlayer = _music[_active_music]
	next.stream = stream
	next.volume_db = -40.0
	next.play()
	create_tween().tween_property(next, "volume_db", 0.0, FADE_SECONDS)

func stop_music() -> void:
	play_music("")

func _on_music_finished(player: AudioStreamPlayer) -> void:
	# Loop background tracks regardless of the file's own loop setting.
	if player == _music[_active_music] and current_music in LOOPING_MUSIC:
		player.play()

## Music for a page; the results pages pick victory or defeat for this player.
func music_for_page(page: int, model: AvalonModel) -> String:
	match page:
		5, 6, 7, 8, 9, 10, 11, 17:
			return "bgm_table"
		12:
			return "bgm_assassination"
		13, 14:
			var result: Dictionary = model.final_result
			var won: Variant = result.get("won") if not result.is_empty() else model.did_i_win()
			if won == null:
				won = bool(result.get("winner", model.is_good_win))
			return "victory" if won else "defeat"
	return "bgm_lobby"

## Ticks once per second during the last five seconds of this player's own turn.
func update_countdown(model: AvalonModel) -> void:
	var left := model.seconds_left()
	if model.pending_action().is_empty() or left < 1 or left > 5:
		_last_tick = -1
		return
	if left != _last_tick:
		_last_tick = left
		play_sfx("countdown_tick")

func _exit_tree() -> void:
	for player in _sfx + _music:
		player.stop()
		player.stream = null
	_streams.clear()
