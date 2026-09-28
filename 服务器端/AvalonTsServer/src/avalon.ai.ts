import { failsNeeded, isBadRole, MissionRecord, ProposalRecord, Role } from "./avalon.types";

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
    } else {
        // Merlin steers away from evil, but with enough noise that the pattern is not a giveaway.
        const noise = view.role === Role.Merlin ? 1.5 : 0.5;
        for (const seat of byScore(others, suspicion(view, 1.2), random, noise)) {
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
        if (team.some((seat) => evil.has(seat))) return true;
        if (view.failedVotes >= 4) return false;
        return random() < 0.3;
    }
    // Rejecting the fifth proposal hands evil the game.
    if (view.failedVotes >= 4) return true;
    // Merlin mostly blocks teams it knows are dirty, but not always, to stay hidden from the assassin.
    if (view.role === Role.Merlin && team.some((seat) => view.visibleSeats.includes(seat))) return random() < 0.3;
    // Proven evil (Lady of the Lake / Excalibur) is always rejected.
    if (team.some((seat) => evil.has(seat))) return false;
    if (view.missions.length === 0) return onTeam || random() < 0.7;
    // Approve only teams about as clean as the one this player would pick.
    const score = suspicion(view);
    const others = range(view.playerCount).filter((seat) => seat !== view.seat).map((seat) => score[seat]).sort((a, b) => a - b);
    const members = team.filter((seat) => seat !== view.seat);
    if (members.length === 0) return true;
    const cut = others[members.length - 1] + 0.25;
    return Math.max(...members.map((seat) => score[seat])) <= cut;
}

/** Returns true for a success card. Good players always succeed. */
export function aiMissionCard(view: AiView, team: number[], random: Random): boolean {
    if (!isBadRole(view.role)) return true;
    if (view.role === Role.Oberon) return random() < 0.2;
    const need = failsNeeded(view.playerCount, view.round);
    const evil = knownEvil(view);
    const evilOnTeam = team.filter((seat) => evil.has(seat)).sort((a, b) => a - b);
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
    for (const proposal of view.proposals) {
        const dirty = proposal.team.some((seat) => evil.has(seat));
        for (const seat of candidates) {
            const approve = proposal.votes[seat];
            let delta = dirty ? (approve ? -0.5 : 1) : (approve ? 0.25 : 0);
            if (proposal.captainSeat === seat) delta += dirty ? -0.5 : 0.5;
            score.set(seat, (score.get(seat) ?? 0) + delta);
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
    return byScore(candidates, suspicion(view), random)[0];
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
    const score = suspicion(view, 1.5);
    const target = others.reduce((best, seat) => (score[seat] > score[best] ? seat : best), others[0]);
    return score[target] >= 1 ? target : -1;
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
    const score = suspicion(view);
    return pool.reduce((best, seat) => (score[seat] + random() * 0.3 > score[best] ? seat : best), pool[0]);
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
    const score = evil ? publicSuspicion(view) : suspicion(view);
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
        parts.push(pick([`我比较怀疑${suspect + 1}号，失败的任务里有他。`, `${suspect + 1}号的嫌疑最大，有他的队我不会投。`], random));
    } else {
        parts.push(pick(["目前还看不出谁有问题，我先保留意见。", "我是好人，这轮我倾向于相信队长。", "成功的队伍可以继续用，我支持稳一点。"], random));
    }
    if (context.isCaptain && context.plan) parts.push(`这轮我打算带 ${seats(context.plan)}。`);
    return parts.join("");
}
