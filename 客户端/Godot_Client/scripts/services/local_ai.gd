extends RefCounted
class_name LocalAi
## GDScript port of the server AI (服务器端/AvalonTsServer/src/avalon.ai.ts) for offline practice.
## Keep the two in step when changing AI behaviour.
##
## A view is what one seat may know:
## {seat, role, visible, count, round, failed_votes, proposals, missions, facts}
## proposals: [{round, captainSeat, team, votes, passed}], missions: [{round, team, failCount, success}],
## facts: [{seat, isGood}] learned from the Lady of the Lake or Excalibur.
## Optional: excalibur_seat (current holder), hidden (evil seats Merlin could not see, during the assassination).

const T = preload("res://scripts/mvc/avalon_types.gd")

static func _range(count: int) -> Array:
	return range(count)

## Seats this player knows to be evil (including itself when evil). Oberon knows only itself.
static func known_evil(view: Dictionary) -> Dictionary:
	var result := {}
	for fact in view.facts:
		if not fact.isGood:
			result[int(fact.seat)] = true
	if view.role == T.Role.MERLIN:
		for seat in view.visible:
			result[int(seat)] = true
	elif T.is_bad_role(view.role):
		result[int(view.seat)] = true
		for seat in view.visible:
			result[int(seat)] = true
	return result

static func known_good(view: Dictionary) -> Dictionary:
	var result := {}
	for fact in view.facts:
		if fact.isGood:
			result[int(fact.seat)] = true
	return result

## Suspicion per seat from mission and vote history; `trusted` seats are never blamed.
static func mission_suspicion(view: Dictionary, trusted: Dictionary) -> Array:
	var score: Array = []
	score.resize(view.count)
	score.fill(0.0)
	for mission in view.missions:
		var suspects: Array = mission.team.filter(func(seat): return not trusted.has(int(seat)))
		for seat in suspects:
			score[int(seat)] += -0.4 if mission.success else float(mission.failCount) / suspects.size() * 3.0
		if not mission.success:
			var proposal: Variant = null
			for item in view.proposals:
				if int(item.round) == int(mission.round) and item.passed:
					proposal = item
			if proposal != null:
				if not trusted.has(int(proposal.captainSeat)):
					score[int(proposal.captainSeat)] += 0.4
				for seat in proposal.votes.size():
					if proposal.votes[seat] and not seat in mission.team and not trusted.has(seat):
						score[seat] += 0.3
	return score

static func public_suspicion(view: Dictionary) -> Array:
	return mission_suspicion(view, {})

## Suspicion as a good seat sees it: it trusts itself and proven-good seats; proven evil is certain.
static func suspicion(view: Dictionary, merlin_weight := 0.0) -> Array:
	var trusted := known_good(view)
	trusted[int(view.seat)] = true
	var score := mission_suspicion(view, trusted)
	for seat in trusted:
		score[seat] = -100.0
	if view.role == T.Role.MERLIN:
		for seat in view.visible:
			score[int(seat)] += merlin_weight
	for fact in view.facts:
		if not fact.isGood:
			score[int(fact.seat)] += 100.0
	return score

## How likely an evil team member plays a failure card; used to weigh possible worlds.
const FAIL_RATE := 0.7

static func _binomial(n: int, k: int) -> float:
	var result := 1.0
	for i in range(1, k + 1):
		result = result * float(n - k + i) / float(i)
	return result

## Every k-seat subset of `pool`.
static func _combinations(pool: Array, k: int) -> Array:
	var result: Array = []
	_walk(pool, k, 0, [], result)
	return result

static func _walk(pool: Array, k: int, start: int, picked: Array, result: Array) -> void:
	if picked.size() == k:
		result.append(picked.duplicate())
		return
	for index in range(start, pool.size() - (k - picked.size()) + 1):
		picked.append(pool[index])
		_walk(pool, k, index + 1, picked, result)
		picked.pop_back()

## Possible-worlds reasoning for a good seat (see goodBeliefs in avalon.ai.ts):
## {"evil": P(seat is evil) per seat, "worlds": [{"evil": {seat: true}, "weight": float}]}.
static func good_beliefs(view: Dictionary, use_night := true) -> Dictionary:
	var count: int = view.count
	var evil_count: int = T.roles_for(count).filter(func(role): return T.is_bad_role(role)).size()
	var must_evil := {}
	var must_good := {int(view.seat): true}
	for fact in view.facts:
		if fact.isGood:
			must_good[int(fact.seat)] = true
		else:
			must_evil[int(fact.seat)] = true
	if use_night and view.role == T.Role.MERLIN:
		for seat in view.visible:
			must_evil[int(seat)] = true
	var pool: Array = _range(count).filter(func(seat): return not must_evil.has(seat) and not must_good.has(seat))
	var need: int = evil_count - must_evil.size()
	var worlds: Array = []
	if need >= 0 and need <= pool.size():
		for pick in _combinations(pool, need):
			var evil := must_evil.duplicate()
			for seat in pick:
				evil[seat] = true
			# Percival sees Merlin and Morgana: exactly one of the two is evil.
			if use_night and view.role == T.Role.PERCIVAL and view.visible.size() == 2 and view.visible.filter(func(seat): return evil.has(int(seat))).size() != 1:
				continue
			var weight := 1.0
			for mission in view.missions:
				if mission.has("excalibur") and int(mission.excalibur.targetSeat) >= 0:
					continue # A flipped card hides who played what.
				var on_team: int = mission.team.filter(func(seat): return evil.has(int(seat))).size()
				var fails := int(mission.failCount)
				if fails > on_team:
					weight = 0.0
					break
				weight *= _binomial(on_team, fails) * pow(FAIL_RATE, fails) * pow(1.0 - FAIL_RATE, on_team - fails)
			if weight == 0.0:
				continue
			# Evil players tend to approve teams carrying evil and reject clean ones; tempered, since humans vary.
			for proposal in view.proposals:
				var dirty: bool = proposal.team.any(func(seat): return evil.has(int(seat)))
				for seat in evil:
					var approve: bool = proposal.votes[seat]
					var chance := (0.85 if approve else 0.15) if dirty else (0.4 if approve else 0.6)
					weight *= sqrt(chance)
			worlds.append({"evil": evil, "weight": weight})
	var total := 0.0
	for world in worlds:
		total += world.weight
	var odds: Array = []
	odds.resize(count)
	odds.fill(0.0)
	if total <= 0.0:
		for seat in count:
			odds[seat] = 0.0 if must_good.has(seat) else (1.0 if must_evil.has(seat) else float(evil_count) / maxf(1.0, count - 1))
		return {"evil": odds, "worlds": []}
	for world in worlds:
		world.weight /= total
		for seat in world.evil:
			odds[seat] += world.weight
	return {"evil": odds, "worlds": worlds}

## Probability that none of `team` is evil.
static func clean_chance(beliefs: Dictionary, team: Array) -> float:
	if beliefs.worlds.is_empty():
		var chance := 1.0
		for seat in team:
			chance *= 1.0 - beliefs.evil[int(seat)]
		return chance
	var sum := 0.0
	for world in beliefs.worlds:
		if not team.any(func(seat): return world.evil.has(int(seat))):
			sum += world.weight
	return sum

## Approve a team about as likely to be clean as the best team this seat could build.
static func _belief_vote(view: Dictionary, team: Array, beliefs: Dictionary) -> bool:
	var on_team: bool = int(view.seat) in team
	var members: Array = team.filter(func(seat): return int(seat) != int(view.seat))
	if members.is_empty():
		return true
	var others: Array = _range(view.count).filter(func(seat): return seat != int(view.seat))
	others.sort_custom(func(a, b): return beliefs.evil[a] < beliefs.evil[b])
	var best := clean_chance(beliefs, others.slice(0, members.size() if on_team else members.size() - 1))
	return clean_chance(beliefs, members) >= best * 0.8 - 0.02

## The vote an ordinary good player in this seat would cast (evil players use it to blend in).
static func _good_looking_vote(view: Dictionary, team: Array, rng: RandomNumberGenerator) -> bool:
	if view.failed_votes >= 4:
		return true
	if view.missions.is_empty() and view.proposals.is_empty():
		return int(view.seat) in team or rng.randf() < 0.7
	var pretend := view.duplicate()
	pretend.role = T.Role.SERVANT
	pretend.visible = []
	pretend.facts = []
	return _belief_vote(pretend, team, good_beliefs(pretend))

static func by_score(seats: Array, score: Array, rng: RandomNumberGenerator, noise := 0.5) -> Array:
	var keyed: Array = seats.map(func(seat): return [score[int(seat)] + rng.randf() * noise, int(seat)])
	keyed.sort_custom(func(a, b): return a[0] < b[0])
	return keyed.map(func(item): return item[1])

static func _pick(items: Array, rng: RandomNumberGenerator) -> Variant:
	return items[rng.randi_range(0, items.size() - 1)]

static func propose_team(view: Dictionary, size: int, rng: RandomNumberGenerator) -> Array:
	var others: Array = _range(view.count).filter(func(seat): return seat != view.seat)
	var team: Array = [int(view.seat)]
	if T.is_bad_role(view.role):
		var evil := known_evil(view)
		var looks := public_suspicion(view)
		var mates := by_score(others.filter(func(seat): return evil.has(seat)), looks, rng)
		if size >= 3 and not mates.is_empty() and rng.randf() < 0.3:
			team.append(mates[0])
		for seat in by_score(others.filter(func(seat): return not evil.has(seat)), looks, rng):
			if team.size() >= size:
				break
			team.append(seat)
	elif view.role == T.Role.MERLIN:
		# Merlin plays like an ordinary good player plus a nudge away from known evil.
		var odds: Array = good_beliefs(view, false).evil
		for seat in view.visible:
			odds[int(seat)] += 0.35
		for seat in by_score(others, odds, rng, 0.3):
			if team.size() >= size:
				break
			team.append(seat)
	else:
		for seat in by_score(others, good_beliefs(view).evil, rng, 0.05):
			if team.size() >= size:
				break
			team.append(seat)
	team = team.slice(0, size)
	team.sort()
	return team

static func vote(view: Dictionary, team: Array, rng: RandomNumberGenerator) -> bool:
	var on_team: bool = int(view.seat) in team
	var evil := known_evil(view)
	var has_evil: bool = team.any(func(seat): return evil.has(int(seat)))
	if T.is_bad_role(view.role):
		var evil_wins: int = view.missions.filter(func(mission): return not mission.success).size()
		# Decisive moments: push a team carrying evil through, or reject the fifth clean team to win.
		if has_evil and evil_wins >= 2:
			return true
		if not has_evil and view.failed_votes >= 4:
			return false
		# Otherwise vote like a good player about half the time, so the record does not give evil away.
		if rng.randf() < 0.5:
			return _good_looking_vote(view, team, rng)
		return has_evil or rng.randf() < 0.3
	# Rejecting the fifth proposal hands evil the game.
	if view.failed_votes >= 4:
		return true
	# Merlin mostly blocks teams it knows are dirty, but not always, to stay hidden.
	if view.role == T.Role.MERLIN and team.any(func(seat): return int(seat) in view.visible):
		return rng.randf() < 0.3
	if has_evil:
		return false
	if view.missions.is_empty() and view.proposals.is_empty():
		return on_team or rng.randf() < 0.7
	return _belief_vote(view, team, good_beliefs(view, view.role != T.Role.MERLIN))

## True for a success card. Good players always succeed.
static func mission_card(view: Dictionary, team: Array, rng: RandomNumberGenerator) -> bool:
	if not T.is_bad_role(view.role):
		return true
	if view.role == T.Role.OBERON:
		return rng.randf() < 0.2
	var evil := known_evil(view)
	var evil_on_team: Array = team.filter(func(seat): return evil.has(int(seat)))
	evil_on_team.sort()
	# Excalibur in non-evil hands can flip one failure back: spend a spare evil card to cover it.
	var holder := int(view.get("excalibur_seat", -1))
	var flip_risk := 1 if holder >= 0 and not evil.has(holder) else 0
	var need := mini(evil_on_team.size(), (2 if T.needs_two_fails(view.count, view.round) else 1) + flip_risk)
	# Coordinate so exactly the needed number of known evil players fail.
	if evil_on_team.size() < need or evil_on_team.find(int(view.seat)) >= need:
		return true
	var evil_wins: int = view.missions.filter(func(mission): return not mission.success).size()
	if evil_wins >= 2:
		return false
	if view.round == 1 and rng.randf() < 0.3:
		return true
	return false

## The seat that played most like Merlin, judged only from the assassin's own knowledge.
static func assassin_target(view: Dictionary, rng: RandomNumberGenerator) -> int:
	var evil := known_evil(view)
	var candidates: Array = _range(view.count).filter(func(seat): return not evil.has(seat))
	var score := {}
	for seat in candidates:
		score[seat] = rng.randf() * 0.5
	# Judge teams as Merlin saw them: Mordred looked clean to Merlin.
	var blind: Array = view.get("hidden", [])
	for proposal in view.proposals:
		var dirty: bool = proposal.team.any(func(seat): return evil.has(int(seat)) and not int(seat) in blind)
		# Early calls say the most: before failed missions, only Merlin can reliably tell a dirty team.
		var failed_before: int = view.missions.filter(func(mission): return int(mission.round) < int(proposal.round) and not mission.success).size()
		var weight := 1.0 / (1.0 + failed_before)
		for seat in candidates:
			var approve: bool = proposal.votes[seat]
			var delta := (-0.5 if approve else 1.0) if dirty else (0.25 if approve else -0.25)
			if int(proposal.captainSeat) == seat:
				delta += -0.75 if dirty else 0.75
			score[seat] += delta * weight
	var best: int = candidates[0]
	for seat in candidates:
		if score[seat] > score[best]:
			best = seat
	return best

static func excalibur_holder(view: Dictionary, team: Array, rng: RandomNumberGenerator) -> int:
	var candidates: Array = team.filter(func(seat): return int(seat) != int(view.seat))
	if T.is_bad_role(view.role):
		var evil := known_evil(view)
		for seat in candidates:
			if evil.has(int(seat)):
				return int(seat)
		return by_score(candidates, public_suspicion(view), rng)[0]
	return by_score(candidates, good_beliefs(view).evil, rng, 0.05)[0]

## -1 keeps the cards as played.
static func excalibur_target(view: Dictionary, team: Array, my_card: bool, rng: RandomNumberGenerator) -> int:
	var others: Array = team.filter(func(seat): return int(seat) != int(view.seat))
	if others.is_empty():
		return -1
	if T.is_bad_role(view.role):
		if not my_card:
			return -1
		var evil := known_evil(view)
		var good_looking: Array = others.filter(func(seat): return not evil.has(int(seat)))
		return int(_pick(good_looking, rng)) if not good_looking.is_empty() and rng.randf() < 0.6 else -1
	var odds: Array = good_beliefs(view).evil
	var target: int = others[0]
	for seat in others:
		if odds[int(seat)] > odds[target]:
			target = int(seat)
	return target if odds[target] >= 0.5 else -1

static func lady_target(view: Dictionary, eligible: Array, rng: RandomNumberGenerator) -> int:
	if T.is_bad_role(view.role):
		var evil := known_evil(view)
		var mates: Array = eligible.filter(func(seat): return evil.has(int(seat)))
		if not mates.is_empty() and rng.randf() < 0.4:
			return int(mates[0])
		return int(_pick(eligible, rng))
	var known := {}
	for fact in view.facts:
		known[int(fact.seat)] = true
	var unknown: Array = eligible.filter(func(seat): return not known.has(int(seat)))
	var pool: Array = unknown if not unknown.is_empty() else eligible
	# Check whoever is most uncertain: the answer then tells the most.
	var odds: Array = good_beliefs(view).evil
	var best: int = pool[0]
	var best_doubt := 2.0
	for seat in pool:
		var doubt := absf(odds[int(seat)] - 0.5) + rng.randf() * 0.05
		if doubt < best_doubt:
			best_doubt = doubt
			best = int(seat)
	return best

static func _seat_list(list: Array) -> String:
	return "、".join(PackedStringArray(list.map(func(seat): return "%d号" % (int(seat) + 1))))

## One short line of table talk; context: {is_captain, plan (Array or null), lady_check (Dictionary or null)}.
static func speech(view: Dictionary, context: Dictionary, rng: RandomNumberGenerator) -> String:
	var evil_side := T.is_bad_role(view.role)
	var parts: Array = []
	var plan: Array = context.get("plan", [])
	var lady_check: Variant = context.get("lady_check")
	if lady_check != null:
		var truth: bool = lady_check.isGood
		var claim := truth
		if evil_side:
			claim = true if known_evil(view).has(int(lady_check.seat)) else ((not truth) if rng.randf() < 0.5 else truth)
		parts.append("我用湖中仙女查验了%d号，是%s。" % [int(lady_check.seat) + 1, "好人" if claim else "坏人"])
	# Good players name whoever is most likely evil (and only when it is more likely than not).
	var score: Array = public_suspicion(view) if evil_side else good_beliefs(view, view.role != T.Role.MERLIN).evil.map(func(chance): return chance * 2.0)
	# A captain never accuses someone it is about to take on its own team.
	var others: Array = _range(view.count).filter(func(seat): return seat != view.seat and not seat in plan)
	var suspect: int = -1
	for seat in others:
		if suspect == -1 or score[seat] > score[suspect]:
			suspect = seat
	var last_failed: Variant = null
	var was_on_success := false
	for mission in view.missions:
		if int(view.seat) in mission.team:
			if mission.success:
				was_on_success = true
			else:
				last_failed = mission
	if view.missions.is_empty() and lady_check == null:
		parts.append(_pick(["第一轮信息太少，我先听听大家的想法。", "我是好人，希望这轮任务顺利。", "我会看队长怎么组队再决定投票。", "先别急着下结论，看看第一轮的结果。"], rng))
	elif evil_side:
		var known := known_evil(view)
		var good: Array = others.filter(func(seat): return not known.has(seat))
		var target: int = _pick(good, rng) if not good.is_empty() else suspect
		var blame: Array = last_failed.team.filter(func(seat): return int(seat) in others and not known.has(int(seat))) if last_failed != null else []
		if last_failed != null and not blame.is_empty():
			parts.append("失败那轮我出的是成功票，%d号更可疑。" % (int(_pick(blame, rng)) + 1))
		elif was_on_success and rng.randf() < 0.5:
			parts.append("我上过成功的任务，可以放心带我。")
		else:
			parts.append(_pick(["我是好人。%d号的投票有点奇怪，大家留意一下。" % (target + 1), "%d号一直在带节奏，我不太信他。" % (target + 1)], rng))
	elif last_failed != null and last_failed.team.size() > 1 and not last_failed.team.any(func(seat): return int(seat) != int(view.seat) and int(seat) in plan):
		var rest: Array = last_failed.team.filter(func(seat): return int(seat) != int(view.seat))
		parts.append("上一轮失败的队伍里有我，我出的是成功票，问题在 %s 里。" % _seat_list(rest))
	elif view.role == T.Role.MERLIN and not view.visible.is_empty() and rng.randf() < 0.4:
		parts.append("说不上为什么，我对%d号感觉不太好。" % (int(_pick(view.visible, rng)) + 1))
	elif suspect >= 0 and score[suspect] >= 1.0:
		var on_failed: bool = view.missions.any(func(mission): return not mission.success and suspect in mission.team)
		if on_failed:
			parts.append(_pick(["我比较怀疑%d号，失败的任务里有他。" % (suspect + 1), "%d号的嫌疑最大，有他的队我不会投。" % (suspect + 1)], rng))
		else:
			parts.append(_pick(["我觉得%d号嫌疑最大。" % (suspect + 1), "%d号给我的感觉不太对，我会留意他。" % (suspect + 1)], rng))
	else:
		parts.append(_pick(["目前还看不出谁有问题，我先保留意见。", "我是好人，这轮我倾向于相信队长。", "成功的队伍可以继续用，我支持稳一点。"], rng))
	if context.get("is_captain", false) and not plan.is_empty():
		parts.append("这轮我打算带 %s。" % _seat_list(plan))
	return "".join(PackedStringArray(parts))
