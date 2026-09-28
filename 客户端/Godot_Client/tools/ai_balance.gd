extends SceneTree
## All-AI balance for offline practice (local_game.gd + local_ai.gd): good win rate per table size.
##   godot --headless --path . --script res://tools/ai_balance.gd -- games=100
## Compare with the server simulation; the two AIs are meant to behave the same.

func _initialize() -> void:
	call_deferred("run")

func run() -> void:
	var games := 100
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("games="):
			games = int(arg.split("=")[1])
	var LocalGame = load("res://scripts/services/local_game.gd")
	var sizes: Array = [5, 6, 7, 8, 9, 10]
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("sizes="):
			sizes = Array(arg.split("=")[1].split(",")).map(func(v): return int(v))
	for n in sizes:
		var c := {"good": 0, "assassinations": 0, "hits": 0, "unfinished": 0}
		var started := Time.get_ticks_msec()
		for seed in games:
			var game: Node = LocalGame.new()
			root.add_child(game)
			game.create_room("me", "me", n, seed * 31 + n + int(OS.get_environment("SEED_OFFSET")))
			game.command(103, {}, 0)
			for i in 5000:
				if not game.running:
					break
				game.bot_tick(true)
			if game.running:
				c.unfinished += 1
			elif game.outcome.isGoodWin:
				c.good += 1
			if not game.outcome.is_empty() and str(game.outcome.winReason).begins_with("刺客"):
				c.assassinations += 1
				if not game.outcome.isGoodWin:
					c.hits += 1
			game.free()
		print("AI_BALANCE %d人 好人胜率 %.1f%% | 刺中梅林 %d/%d | 未结束 %d | %.0fms/局" % [n, 100.0 * c.good / games, c.hits, c.assassinations, c.unfinished, float(Time.get_ticks_msec() - started) / games])
	quit()
