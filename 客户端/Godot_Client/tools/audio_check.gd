extends SceneTree
## Lists which sound files from assets/audio/README.md are present.
##   godot --headless --path . --script res://tools/audio_check.gd

func _initialize() -> void:
	call_deferred("run")

func run() -> void:
	var audio: AvalonAudio = root.get_node("AvalonApp").audio
	var missing := 0
	for kind in ["sfx", "music"]:
		var names: Array = AvalonAudio.SFX_NAMES if kind == "sfx" else AvalonAudio.MUSIC_NAMES
		for sound in names:
			var found := audio.has_sound(kind, sound)
			if not found:
				missing += 1
			print("%s  %s/%s" % ["OK  " if found else "缺少", kind, sound])
	print("AUDIO_CHECK %d/%d 个声音文件就位" % [AvalonAudio.SFX_NAMES.size() + AvalonAudio.MUSIC_NAMES.size() - missing, AvalonAudio.SFX_NAMES.size() + AvalonAudio.MUSIC_NAMES.size()])
	quit()
