import { failsNeeded, isBadRole, MissionRecord, ProposalRecord, Role, roleSetFor } from "./avalon.types";

/**
 * Everything one seat is allowed to know: its own role, the seats revealed to it at night,
 * and the public history. The AI never sees other players' hidden roles.
 */
export interface AiView {
    seat: number;
    role: Role;
    visibleSeats: number[];
    playerCount: number;
    round: number;
    failedVotes: number;
    proposals: ProposalRecord[];
    missions: MissionRecord[];
    /** Loyalties this seat learned privately (Lady of the Lake checks, cards seen through Excalibur). */
    facts: Fact[];
    /** Holder of Excalibur on the current team, or -1. */
    excaliburSeat?: number;
    /** During the assassination: evil seats Merlin could not see (Mordred), shared by the evil team. */
    hiddenFromMerlin?: number[];
}

export interface Fact {
    seat: number;
    isGood: boolean;
}

export type Random = () => number;

/** Seats this player knows to be evil (including itself when evil). Oberon knows only itself. */
function knownEvil(view: AiView): Set<number> {
    const learned = view.facts.filter((fact) => !fact.isGood).map((fact) => fact.seat);
    if (view.role === Role.Merlin) return new Set([...view.visibleSeats, ...learned]);
    if (isBadRole(view.role)) return new Set([view.seat, ...view.visibleSeats, ...learned]);
    return new Set(learned);
}

function knownGood(view: AiView): Set<number> {
    return new Set(view.facts.filter((fact) => fact.isGood).map((fact) => fact.seat));
}

/**
 * Suspicion per seat from mission and vote history; higher means more likely evil.
 * `trusted` seats are known good to the viewer, so failure cards are blamed on the other members only.
 */
function missionSuspicion(view: AiView, trusted: Set<number>): number[] {
    const score = new Array<number>(view.playerCount).fill(0);
    for (const mission of view.missions) {
        const suspects = mission.team.filter((seat) => !trusted.has(seat));
        for (const seat of suspects) {
            score[seat] += mission.success ? -0.4 : (mission.failCount / suspects.length) * 3;
        }
        const proposal = [...view.proposals].reverse().find((item) => item.round === mission.round && item.passed);
        if (proposal && !mission.success) {
            if (!trusted.has(proposal.captainSeat)) score[proposal.captainSeat] += 0.4;
            proposal.votes.forEach((approve, seat) => {
                if (approve && !mission.team.includes(seat) && !trusted.has(seat)) score[seat] += 0.3;
            });
        }
    }
    return score;
}

/** How suspicious everyone looks to outsiders; evil players use it to blend in. */
function publicSuspicion(view: AiView): number[] {
    return missionSuspicion(view, new Set());
}

/** Suspicion as a good seat sees it: it trusts itself, and Merlin weighs in what the night revealed. */
function suspicion(view: AiView, merlinWeight = 0): number[] {
    const trusted = new Set([view.seat, ...knownGood(view)]);
    const score = missionSuspicion(view, trusted);
    for (const seat of trusted) score[seat] = -100;
    if (view.role === Role.Merlin) for (const seat of view.visibleSeats) score[seat] += merlinWeight;
    // Loyalties proven by the Lady of the Lake or Excalibur are certain, unlike Merlin's hidden knowledge.
    for (const fact of view.facts) if (!fact.isGood) score[fact.seat] += 100;
    return score;
}

/** How likely an evil team member plays a failure card; used to weigh possible worlds. */
const FAIL_RATE = 0.7;

function binomial(n: number, k: number): number {
    let result = 1;
    for (let i = 1; i <= k; i += 1) result = (result * (n - k + i)) / i;
    return result;
}

/** Every k-seat subset of `pool`. */
function combinations(pool: number[], k: number): number[][] {
    if (k === 0) return [[]];
    const result: number[][] = [];
    const walk = (start: number, picked: number[]): void => {
        if (picked.length === k) {
            result.push(picked.slice());
            return;
        }
        for (let index = start; index <= pool.length - (k - picked.length); index += 1) {
            picked.push(pool[index]);
            walk(index + 1, picked);
            picked.pop();
        }
    };
    walk(0, []);
    return result;
}

export interface Beliefs {
    /** P(seat is evil) for every seat, from this seat's point of view. */
    evil: number[];
    /** Possible evil teams with their (normalised) weights. */
    worlds: { evil: Set<number>; weight: number }[];
}

/**
 * Possible-worlds reasoning for a good seat: enumerate every evil team consistent with what this
 * seat knows (itself, night information, Lady/Excalibur facts, failure counts) and weigh each by how
 * well it explains the mission results and votes. `useNight` false ignores Merlin's night
 * information, so Merlin can act like an ordinary good player when it needs to stay hidden.
 */
export function goodBeliefs(view: AiView, useNight = true): Beliefs {
    const count = view.playerCount;
    const evilCount = roleSetFor(count).filter((role) => isBadRole(role)).length;
    const mustEvil = new Set(view.facts.filter((fact) => !fact.isGood).map((fact) => fact.seat));
    const mustGood = new Set([view.seat, ...view.facts.filter((fact) => fact.isGood).map((fact) => fact.seat)]);
    if (useNight && view.role === Role.Merlin) for (const seat of view.visibleSeats) mustEvil.add(seat);
    const pool = range(count).filter((seat) => !mustEvil.has(seat) && !mustGood.has(seat));
    const need = evilCount - mustEvil.size;
    const worlds: { evil: Set<number>; weight: number }[] = [];
    if (need >= 0 && need <= pool.length) {
        for (const pick of combinations(pool, need)) {
            const evil = new Set([...mustEvil, ...pick]);
            // Percival sees Merlin and Morgana: exactly one of the two is evil.
            if (useNight && view.role === Role.Percival && view.visibleSeats.length === 2
                && view.visibleSeats.filter((seat) => evil.has(seat)).length !== 1) continue;
            let weight = 1;
            for (const mission of view.missions) {
                if (mission.excalibur && mission.excalibur.targetSeat >= 0) continue; // A flipped card hides who played what.
                const onTeam = mission.team.filter((seat) => evil.has(seat)).length;
                if (mission.failCount > onTeam) {
                    weight = 0;
                    break;
                }
                weight *= binomial(onTeam, mission.failCount) * FAIL_RATE ** mission.failCount * (1 - FAIL_RATE) ** (onTeam - mission.failCount);
            }
            if (weight === 0) continue;
            // Evil players tend to approve teams carrying evil and reject clean ones; tempered, since humans vary.
            for (const proposal of view.proposals) {
                const dirty = proposal.team.some((seat) => evil.has(seat));
                for (const seat of evil) {
                    const approve = proposal.votes[seat];
                    const chance = dirty ? (approve ? 0.85 : 0.15) : (approve ? 0.4 : 0.6);
                    weight *= Math.sqrt(chance);
                }
            }
            worlds.push({ evil, weight });
        }
    }
    const total = worlds.reduce((sum, world) => sum + world.weight, 0);
    const odds = new Array<number>(count).fill(0);
    if (total <= 0) {
        // Nothing consistent (e.g. a lying human claim was taken as fact): fall back to an even prior.
        for (const seat of range(count)) odds[seat] = mustGood.has(seat) ? 0 : mustEvil.has(seat) ? 1 : evilCount / Math.max(1, count - 1);
        return { evil: odds, worlds: [] };
    }
    for (const world of worlds) {
        world.weight /= total;
        for (const seat of world.evil) odds[seat] += world.weight;
    }
    return { evil: odds, worlds };
}

/** Probability that none of `team` (other than known-good seats) is evil. */
export function cleanChance(beliefs: Beliefs, team: number[]): number {
    if (beliefs.worlds.length === 0) return team.reduce((chance, seat) => chance * (1 - beliefs.evil[seat]), 1);
    return beliefs.worlds.filter((world) => !team.some((seat) => world.evil.has(seat))).reduce((sum, world) => sum + world.weight, 0);
}

function byScore(seats: number[], score: number[], random: Random, noise = 0.5): number[] {
    const keyed = seats.map((seat) => ({ seat, key: score[seat] + random() * noise }));
    return keyed.sort((a, b) => a.key - b.key).map((item) => item.seat);
}

function range(count: number): number[] {
    return Array.from({ length: count }, (_, index) => index);
}

export function aiProposeTeam(view: AiView, size: number, random: Random): number[] {
    const others = range(view.playerCount).filter((seat) => seat !== view.seat);
    const team = [view.seat];
    if (isBadRole(view.role)) {
        const evil = knownEvil(view);
        const looks = publicSuspicion(view);
        const mates = byScore(others.filter((seat) => evil.has(seat)), looks, random);
        if (size >= 3 && mates.length > 0 && random() < 0.3) team.push(mates[0]);
        for (const seat of byScore(others.filter((seat) => !evil.has(seat)), looks, random)) {
            if (team.length >= size) break;
            team.push(seat);
        }
    } else if (view.role === Role.Merlin) {
        // Merlin plays like an ordinary good player plus a nudge away from known evil, so the pattern is not a giveaway.
        const odds = goodBeliefs(view, false).evil.map((chance, seat) => chance + (view.visibleSeats.includes(seat) ? 0.35 : 0));
        for (const seat of byScore(others, odds, random, 0.3)) {
            if (team.length >= size) break;
            team.push(seat);
        }
    } else {
        for (const seat of byScore(others, goodBeliefs(view).evil, random, 0.05)) {
            if (team.length >= size) break;
            team.push(seat);
        }
    }
    return team.slice(0, size).sort((a, b) => a - b);
}

export function aiVote(view: AiView, team: number[], random: Random): boolean {
    const onTeam = team.includes(view.seat);
    const evil = knownEvil(view);
    if (isBadRole(view.role)) {
        const dirty = team.some((seat) => evil.has(seat));
        const evilWins = view.missions.filter((mission) => !mission.success).length;
        // Decisive moments: push a team carrying evil through, or reject the fifth clean team to win.
        if (dirty && evilWins >= 2) return true;
        if (!dirty && view.failedVotes >= 4) return false;
        // Otherwise vote like a good player would about half the time, so the voting record does not give evil away.
        if (random() < 0.5) return goodLookingVote(view, team, random);
        return dirty || random() < 0.3;
    }
    // Rejecting the fifth proposal hands evil the game.
    if (view.failedVotes >= 4) return true;
    // Merlin mostly blocks teams it knows are dirty, but not always, to stay hidden from the assassin.
    if (view.role === Role.Merlin && team.some((seat) => view.visibleSeats.includes(seat))) return random() < 0.3;
    // Proven evil (Lady of the Lake / Excalibur) is always rejected.
    if (team.some((seat) => evil.has(seat))) return false;
    if (view.missions.length === 0 && view.proposals.length === 0) return onTeam || random() < 0.7;
    // Approve a team about as likely to be clean as the best team this player could build itself.
    const beliefs = goodBeliefs(view, view.role !== Role.Merlin);
    const members = team.filter((seat) => seat !== view.seat);
    if (members.length === 0) return true;
    const clean = cleanChance(beliefs, members);
    const others = range(view.playerCount).filter((seat) => seat !== view.seat).sort((a, b) => beliefs.evil[a] - beliefs.evil[b]);
    const best = cleanChance(beliefs, others.slice(0, onTeam ? members.length : members.length - 1));
    return clean >= best * 0.8 - 0.02;
}

/** The vote an ordinary good player in this seat would cast (used by evil players to blend in). */
function goodLookingVote(view: AiView, team: number[], random: Random): boolean {
    const pretend: AiView = { ...view, role: Role.Servant, visibleSeats: [], facts: [] };
    if (view.failedVotes >= 4) return true;
    if (view.missions.length === 0 && view.proposals.length === 0) return team.includes(view.seat) || random() < 0.7;
    const beliefs = goodBeliefs(pretend);
    const members = team.filter((seat) => seat !== view.seat);
    if (members.length === 0) return true;
    const others = range(view.playerCount).filter((seat) => seat !== view.seat).sort((a, b) => beliefs.evil[a] - beliefs.evil[b]);
    const best = cleanChance(beliefs, others.slice(0, team.includes(view.seat) ? members.length : members.length - 1));
    return cleanChance(beliefs, members) >= best * 0.8 - 0.02;
}

/** Returns true for a success card. Good players always succeed. */
export function aiMissionCard(view: AiView, team: number[], random: Random): boolean {
    if (!isBadRole(view.role)) return true;
    if (view.role === Role.Oberon) return random() < 0.2;
    const evil = knownEvil(view);
    const evilOnTeam = team.filter((seat) => evil.has(seat)).sort((a, b) => a - b);
    // Excalibur in non-evil hands can flip one failure back: spend a spare evil card to cover it.
    const holder = view.excaliburSeat ?? -1;
    const flipRisk = holder >= 0 && !evil.has(holder) ? 1 : 0;
    const need = Math.min(evilOnTeam.length, failsNeeded(view.playerCount, view.round) + flipRisk);
    // Coordinate so exactly the needed number of known evil players fail; a lone card that cannot fail the mission stays hidden.
    if (evilOnTeam.length < need || evilOnTeam.indexOf(view.seat) >= need) return true;
    const evilWins = view.missions.filter((mission) => !mission.success).length;
    if (evilWins >= 2) return false;
    if (view.round === 1 && random() < 0.3) return true;
    return false;
}

/** Picks the seat that played most like Merlin, judged only from the assassin's own knowledge. */
export function aiAssassinTarget(view: AiView, random: Random): number {
    const evil = knownEvil(view);
    const candidates = range(view.playerCount).filter((seat) => !evil.has(seat));
    const score = new Map<number, number>(candidates.map((seat) => [seat, random() * 0.5]));
    // Judge teams as Merlin saw them: Mordred looked clean to Merlin.
    const blind = new Set(view.hiddenFromMerlin ?? []);
    for (const proposal of view.proposals) {
        const dirty = proposal.team.some((seat) => evil.has(seat) && !blind.has(seat));
        // Early calls say the most: before failed missions, only Merlin can reliably tell a dirty team.
        const failedBefore = view.missions.filter((mission) => mission.round < proposal.round && !mission.success).length;
        const weight = 1 / (1 + failedBefore);
        for (const seat of candidates) {
            const approve = proposal.votes[seat];
            let delta = dirty ? (approve ? -0.5 : 1) : (approve ? 0.25 : -0.25);
            if (proposal.captainSeat === seat) delta += dirty ? -0.75 : 0.75;
            score.set(seat, (score.get(seat) ?? 0) + delta * weight);
        }
    }
    return candidates.reduce((best, seat) => ((score.get(seat) ?? 0) > (score.get(best) ?? 0) ? seat : best), candidates[0]);
}

/** Captain hands Excalibur to a team member other than itself. */
export function aiExcaliburHolder(view: AiView, team: number[], random: Random): number {
    const candidates = team.filter((seat) => seat !== view.seat);
    if (isBadRole(view.role)) {
        const evil = knownEvil(view);
        const mate = candidates.find((seat) => evil.has(seat));
        if (mate !== undefined) return mate;
        return byScore(candidates, publicSuspicion(view), random)[0];
    }
    return byScore(candidates, goodBeliefs(view).evil, random, 0.05)[0];
}

/**
 * Excalibur holder: -1 keeps the cards as played. Good holders flip the member they suspect most
 * (turning a possible failure into a success); evil holders flip a good-looking member to sabotage.
 */
export function aiExcaliburTarget(view: AiView, team: number[], myCard: boolean, random: Random): number {
    const others = team.filter((seat) => seat !== view.seat);
    if (others.length === 0) return -1;
    if (isBadRole(view.role)) {
        const evil = knownEvil(view);
        if (!myCard) return -1; // Already failing it; a flip would only draw attention.
        const goodLooking = others.filter((seat) => !evil.has(seat));
        return goodLooking.length > 0 && random() < 0.6 ? goodLooking[Math.floor(random() * goodLooking.length)] : -1;
    }
    const odds = goodBeliefs(view).evil;
    const target = others.reduce((best, seat) => (odds[seat] > odds[best] ? seat : best), others[0]);
    return odds[target] >= 0.5 ? target : -1;
}

/** Lady of the Lake holder picks whom to check among the eligible seats. */
export function aiLadyTarget(view: AiView, eligible: number[], random: Random): number {
    if (isBadRole(view.role)) {
        const evil = knownEvil(view);
        const mates = eligible.filter((seat) => evil.has(seat));
        if (mates.length > 0 && random() < 0.4) return mates[0];
        return eligible[Math.floor(random() * eligible.length)];
    }
    const known = new Set(view.facts.map((fact) => fact.seat));
    const unknown = eligible.filter((seat) => !known.has(seat));
    const pool = unknown.length > 0 ? unknown : eligible;
    // Check whoever is most uncertain: the answer then tells the most.
    const odds = goodBeliefs(view).evil;
    const doubt = (seat: number): number => Math.abs(odds[seat] - 0.5) + random() * 0.05;
    return pool.reduce((best, seat) => (doubt(seat) < doubt(best) ? seat : best), pool[0]);
}

export interface SpeechContext {
    isCaptain: boolean;
    /** The team this AI captain intends to propose. */
    plan?: number[];
    /** The Lady check this seat made last, if it just used the Lady of the Lake. */
    ladyCheck?: Fact;
}

function seats(list: number[]): string {
    return list.map((seat) => `${seat + 1}号`).join("、");
}

function pick<T>(items: T[], random: Random): T {
    return items[Math.floor(random() * items.length)];
}

/**
 * One short line of table talk. Good AIs share what they believe; evil AIs claim to be good and
 * steer suspicion elsewhere. It only uses what this seat knows.
 */
export function aiSpeech(view: AiView, context: SpeechContext, random: Random): string {
    const evil = isBadRole(view.role);
    const parts: string[] = [];
    if (context.ladyCheck) {
        const truth = context.ladyCheck.isGood;
        // Evil holders lie about good targets half the time and always vouch for teammates.
        const claim = evil ? (knownEvil(view).has(context.ladyCheck.seat) ? true : (random() < 0.5 ? !truth : truth)) : truth;
        parts.push(`我用湖中仙女查验了${context.ladyCheck.seat + 1}号，是${claim ? "好人" : "坏人"}。`);
    }
    // Good players name whoever is most likely evil (and only when it is more likely than not).
    const score = evil ? publicSuspicion(view) : goodBeliefs(view, view.role !== Role.Merlin).evil.map((chance) => chance * 2);
    // A captain never accuses someone it is about to take on its own team.
    const others = range(view.playerCount).filter((seat) => seat !== view.seat && !(context.plan ?? []).includes(seat));
    const suspect = others.reduce((best, seat) => (score[seat] > score[best] ? seat : best), others[0]);
    const lastFailed = [...view.missions].reverse().find((mission) => !mission.success && mission.team.includes(view.seat));
    const wasOnSuccess = view.missions.some((mission) => mission.success && mission.team.includes(view.seat));
    if (view.missions.length === 0 && !context.ladyCheck) {
        parts.push(pick(["第一轮信息太少，我先听听大家的想法。", "我是好人，希望这轮任务顺利。", "我会看队长怎么组队再决定投票。", "先别急着下结论，看看第一轮的结果。"], random));
    } else if (evil) {
        const known = knownEvil(view);
        const good = others.filter((seat) => !known.has(seat));
        const target = good.length > 0 ? pick(good, random) : suspect;
        const blame = lastFailed ? lastFailed.team.filter((seat) => others.includes(seat) && !known.has(seat)) : [];
        if (lastFailed && blame.length > 0) {
            parts.push(`失败那轮我出的是成功票，${pick(blame, random) + 1}号更可疑。`);
        } else if (wasOnSuccess && random() < 0.5) {
            parts.push("我上过成功的任务，可以放心带我。");
        } else {
            parts.push(pick([`我是好人。${target + 1}号的投票有点奇怪，大家留意一下。`, `${target + 1}号一直在带节奏，我不太信他。`], random));
        }
    } else if (lastFailed && lastFailed.team.length > 1 && !lastFailed.team.some((seat) => seat !== view.seat && (context.plan ?? []).includes(seat))) {
        const rest = lastFailed.team.filter((seat) => seat !== view.seat);
        parts.push(`上一轮失败的队伍里有我，我出的是成功票，问题在 ${seats(rest)} 里。`);
    } else if (view.role === Role.Merlin && view.visibleSeats.length > 0 && random() < 0.4) {
        parts.push(`说不上为什么，我对${pick(view.visibleSeats, random) + 1}号感觉不太好。`);
    } else if (suspect !== undefined && score[suspect] >= 1) {
        const onFailed = view.missions.some((mission) => !mission.success && mission.team.includes(suspect));
        parts.push(onFailed
            ? pick([`我比较怀疑${suspect + 1}号，失败的任务里有他。`, `${suspect + 1}号的嫌疑最大，有他的队我不会投。`], random)
            : pick([`我觉得${suspect + 1}号嫌疑最大。`, `${suspect + 1}号给我的感觉不太对，我会留意他。`], random));
    } else {
        parts.push(pick(["目前还看不出谁有问题，我先保留意见。", "我是好人，这轮我倾向于相信队长。", "成功的队伍可以继续用，我支持稳一点。"], random));
    }
    if (context.isCaptain && context.plan) parts.push(`这轮我打算带 ${seats(context.plan)}。`);
    return parts.join("");
}
