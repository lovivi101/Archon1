extends SceneTree
## Self-play: a random "human" plays full online games through the real client against server AI.
## Every action goes through AvalonController, the same calls the page buttons make.
##
##   godot --path . --script res://tools/smoke_selfplay.gd -- players=7 games=3 seed=1 shots=/tmp/shots url=ws://127.0.0.1:8899
## url=local plays offline practice against the client's own AI (local_game.gd) instead of a server.
##
## Fails if the server rejects a legal move, a page does not follow the stage, a private result is
## missing, or a game stalls.

const T = preload("res://scripts/mvc/avalon_types.gd")
var args := {"players": "7", "games": "3", "seed": "1", "shots": "", "url": "ws://127.0.0.1:8899"}
var rng := RandomNumberGenerator.new()
var errors: Array = []
var rejections: Array = []
var shots_taken := {}
var stats := {"speeches": 0, "ai_lines": 0, "lady_uses": 0, "lady_results": 0, "excalibur_uses": 0, "excalibur_results": 0,
	"evil_reveals": 0, "evil_chats": 0, "assassinations": 0, "games": 0, "good_wins": 0, "my_wins": 0, "pages": {}}
var acted_turns := {}

func _initialize() -> void:
	for arg in OS.get_cmdline_user_args():
		var parts := arg.split("=", true, 1)
		if parts.size() == 2:
			args[parts[0]] = parts[1]
	rng.seed = int(args.seed)
	call_deferred("run")

func fail(message: String) -> void:
	errors.append(message)

func shot(name: String) -> void:
	if str(args.shots).is_empty() or shots_taken.has(name):
		return
	shots_taken[name] = true
	for i in 4:
		await process_frame
	DirAccess.make_dir_recursive_absolute(args.shots)
	root.get_texture().get_image().save_png("%s/%s.png" % [args.shots, name])

func pick(list: Array) -> Variant:
	return list[rng.randi_range(0, list.size() - 1)]

func once(key: String) -> bool:
	if acted_turns.has(key):
		return false
	acted_turns[key] = true
	return true

func run() -> void:
	var app: Node = root.get_node("AvalonApp")
	var controller: AvalonController = app.controller
	var model: AvalonModel = app.model
	app.network.packet_received.connect(func(route: int, payload: Dictionary): _count(route, payload, model))
	controller.notice.connect(func(message: String):
		if message.begins_with("当前") or message.begins_with("只有") or message.begins_with("还没") or message.begins_with("你") or message.begins_with("请"):
			rejections.append("notice: %s (stage %d)" % [message, model.stage]))


	controller.lobby_count = int(args.players)
	var local: bool = args.url == "local"
	if local:
		app.local_game.speed = 12.0
		app.local_game.packet_received.connect(func(route: int, payload: Dictionary): _count(route, payload, model))
		controller.create_local_room(int(args.players), int(args.seed))
	else:
		controller.show_page(3)
		await shot("03-lobby")
		controller.quick_match(args.url, int(args.players))
	var games := int(args.games)
	var start := Time.get_ticks_msec()
	var last_progress := start
	var last_state := ""
	while stats.games < games and Time.get_ticks_msec() - start < 600000:
		await process_frame
		var state := "%d:%d:%d:%d:%d" % [model.stage, model.round, model.failed_votes, model.speaker_seat, controller.page]
		if state != last_state:
			last_state = state
			last_progress = Time.get_ticks_msec()
			stats.pages[controller.page] = int(stats.pages.get(controller.page, 0)) + 1
		elif Time.get_ticks_msec() - last_progress > 45000:
			fail("stalled at stage %d page %d" % [model.stage, controller.page])
			break
		await play_step(app, controller, model)
	if not local and errors.is_empty():
		await check_records(controller, model, games)
	print("SELFPLAY players=%s games=%d good_wins=%d my_wins=%d" % [args.players, stats.games, stats.good_wins, stats.my_wins])
	print("SELFPLAY stats=%s" % JSON.stringify(stats))
	if not rejections.is_empty():
		print("SELFPLAY rejections=%s" % JSON.stringify(rejections))
	for message in errors:
		push_error("SELFPLAY_ERROR %s" % message)
	if errors.is_empty() and stats.games >= games:
		print("GODOT_SELFPLAY_OK")
		quit()
	else:
		quit(1)

func play_step(app: Node, controller: AvalonController, model: AvalonModel) -> void:
	var me := model.my_seat()
	# Stay on the page that belongs to the current stage (the identity and result pages wait for a tap).
	if controller.page in [5, 6] and model.my_role != 0:
		await shot("06-identity-%s" % T.role_name(model.my_role))
		controller.confirm_identity()
		return
	if controller.page == 11:
		await shot("11-result")
		controller.show_page(controller.page_for_stage(model.stage))
		return
	match model.stage:
		T.Stage.PREPARING:
			if controller.page == 4 and model.session == "in_room" and me >= 0 and not bool(model.players[me].get("isReady", false)) and once("ready:%d" % stats.games):
				await shot("04-room")
				controller.toggle_ready()
		T.Stage.SPEAKING:
			check_page(controller, 7)
			if model.is_speaker() and once("speak:%d:%d:%d:%d" % [stats.games, model.round, model.failed_votes, model.speaker_seat]):
				stats.speeches += 1
				if rng.randf() < 0.8:
					controller.send_chat(pick(["我是好人，先听听大家的", "上一轮失败的队伍有问题", "这轮我支持队长", "我觉得%d号可疑" % rng.randi_range(1, model.players.size())]))
				await shot("07-speaking")
				controller.end_speech()
		T.Stage.PROPOSING:
			check_page(controller, 8)
			if model.is_captain() and once("propose:%d:%d:%d" % [stats.games, model.round, model.failed_votes]):
				var seats: Array = range(model.players.size())
				seats.shuffle()
				controller.team_choice = seats.slice(0, model.get_team_size())
				if bool(model.rules.get("excalibur", false)):
					controller.choose_excalibur(pick(controller.team_choice.filter(func(seat): return seat != me)))
					await shot("08-propose-excalibur")
				if not controller.submit_team():
					fail("submit_team refused a valid team")
		T.Stage.VOTING:
			check_page(controller, 9)
			if not model.voted and once("vote:%d:%d:%d" % [stats.games, model.round, model.failed_votes]):
				controller.vote(rng.randf() < 0.7)
		T.Stage.MISSION:
			check_page(controller, 10)
			if model.is_member() and not model.acted and once("mission:%d:%d" % [stats.games, model.round]):
				controller.mission(not T.is_bad_role(model.my_role) or rng.randf() < 0.5)
		T.Stage.EXCALIBUR:
			check_page(controller, 10)
			if model.excalibur_seat == me and not model.acted and once("excalibur:%d:%d" % [stats.games, model.round]):
				await shot("10-excalibur")
				var others: Array = model.selected_seats.filter(func(seat): return seat != me)
				controller.use_excalibur(pick(others) if rng.randf() < 0.6 else -1)
		T.Stage.LADY_OF_LAKE:
			check_page(controller, 17)
			if model.lady_holder == me and not model.acted and once("lady:%d:%d" % [stats.games, model.round]):
				if model.lady_eligible.is_empty():
					fail("Lady holder has nobody to check")
					return
				controller.choose_seat(pick(model.lady_eligible))
				await shot("17-lady")
				controller.lady_check(controller.team_choice[0])
		T.Stage.ASSASSINATING:
			check_page(controller, 12)
			if model.revealed_evil.is_empty():
				fail("assassination started without the evil reveal")
			if T.is_bad_role(model.my_role) and once("evilchat:%d" % stats.games):
				controller.send_chat("我觉得梅林是%d号" % rng.randi_range(1, model.players.size()))
				await shot("12-assassin-evil")
			elif once("assassin-view:%d" % stats.games):
				await shot("12-assassin-good")
			if model.my_role == T.Role.ASSASSIN and once("assassinate:%d" % stats.games):
				var targets: Array = range(model.players.size()).filter(func(seat): return not seat in model.revealed_evil)
				controller.choose_seat(pick(targets))
				stats.assassinations += 1
				controller.assassinate(controller.team_choice[0])
		T.Stage.END:
			if controller.page == 13 and once("end:%d" % stats.games):
				stats.games += 1
				if model.is_good_win:
					stats.good_wins += 1
				if model.did_i_win() == true:
					stats.my_wins += 1
				await shot("13-result")
				controller.show_page(14)
				await shot("14-replay")
				verify_private_results(model)
				if stats.games < int(args.games):
					controller.play_again()

func check_page(controller: AvalonController, expected: int) -> void:
	# Pages move one frame after the stage; allow for that before complaining.
	if controller.page != expected and controller.page not in [5, 6, 11]:
		await process_frame
		await process_frame
		if controller.page != expected and controller.page not in [5, 6, 11] and root.get_node("AvalonApp").model.stage != T.Stage.END:
			fail("stage %d shows page %d (expected %d)" % [root.get_node("AvalonApp").model.stage, controller.page, expected])

func verify_private_results(model: AvalonModel) -> void:
	# Whenever this seat used the Lady or flipped a card, its private result must have arrived.
	for record in model.lady_history:
		if int(record.holderSeat) == model.my_seat():
			var learned := model.facts.any(func(fact): return int(fact.seat) == int(record.targetSeat))
			if not learned:
				fail("Lady check by me on %d号 has no result" % (int(record.targetSeat) + 1))

func _count(route: int, payload: Dictionary, model: AvalonModel) -> void:
	if int(payload.get("code", 0)) != 0:
		rejections.append("%d: %s (stage %d)" % [route, payload.get("message", ""), model.stage])
	match route:
		T.Route.CHAT_MESSAGE:
			if int(payload.get("seat", -1)) != model.my_seat():
				stats.ai_lines += 1
			if str(payload.get("channel", "")) == "evil":
				stats.evil_chats += 1
		T.Route.LADY_USED:
			stats.lady_uses += 1
		T.Route.LADY_RESULT:
			stats.lady_results += 1
		T.Route.EXCALIBUR_USED:
			if int(payload.get("targetSeat", -1)) >= 0:
				stats.excalibur_uses += 1
		T.Route.EXCALIBUR_RESULT:
			stats.excalibur_results += 1
		T.Route.EVIL_REVEALED:
			stats.evil_reveals += 1


## Online only: leaderboard, match history and a stored replay must reflect the games just played.
func check_records(controller: AvalonController, model: AvalonModel, games: int) -> void:
	controller.board_tab = "board"
	controller.open_leaderboard()
	if not await wait_for(func(): return not model.leaderboard.is_empty() and model.match_history.size() >= games):
		fail("leaderboard or history did not arrive (history %d)" % model.match_history.size())
		return
	await shot("15-board")
	if int(model.stats.get("games", 0)) < games:
		fail("stats count %d games, played %d" % [int(model.stats.get("games", 0)), games])
	controller.board_tab = "history"
	controller.open_leaderboard()
	await shot("15-history")
	controller.open_match(int(model.match_history[0].matchId))
	if not await wait_for(func(): return not model.replay.is_empty() and controller.page == 14):
		fail("stored replay did not open")
		return
	if Array(model.replay.get("players", [])).any(func(player): return int(player.role) == 0):
		fail("stored replay is missing roles")
	await shot("14-server-replay")
	print("SELFPLAY records ok: history=%d rating=%s tier=%s" % [model.match_history.size(), model.stats.get("rating"), model.stats.get("tier")])

func wait_for(condition: Callable, seconds := 10.0) -> bool:
	var start := Time.get_ticks_msec()
	while Time.get_ticks_msec() - start < seconds * 1000:
		if condition.call():
			return true
		await process_frame
	return false
