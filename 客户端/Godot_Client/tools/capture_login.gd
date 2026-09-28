extends SceneTree
## Render the real login scene at its fixed design size, independently of monitor size.

func _initialize() -> void:
	call_deferred("_capture")

func _capture() -> void:
	root.size = Vector2i(64, 64)
	var viewport := SubViewport.new()
	viewport.size = Vector2i(750, 1334)
	viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	root.add_child(viewport)
	var scene: Control = load("res://scenes/login.tscn").instantiate()
	viewport.add_child(scene)
	for frame in range(8):
		await process_frame
	await RenderingServer.frame_post_draw
	var screenshot := viewport.get_texture().get_image()
	var directory := ProjectSettings.globalize_path("res://verification")
	DirAccess.make_dir_recursive_absolute(directory)
	var result := screenshot.save_png(directory.path_join("login-preview.png"))
	if result != OK:
		push_error("Unable to save login preview: %s" % result)
		quit(1)
		return
	print("LOGIN_RENDER_OK: %s (%s x %s)" % [directory, screenshot.get_width(), screenshot.get_height()])
	quit()
