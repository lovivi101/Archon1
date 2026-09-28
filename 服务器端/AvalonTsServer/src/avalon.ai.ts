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
}

export type Random = () => number;

/** Seats this player knows to be evil (including itself when evil). Oberon knows only itself. */
function knownEvil(view: AiView): Set<number> {
    if (view.role === Role.Merlin) return new Set(view.visibleSeats);
    if (isBadRole(view.role)) return new Set([view.seat, ...view.visibleSeats]);
    return new Set();
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
    const score = missionSuspicion(view, new Set([view.seat]));
    score[view.seat] = -100;
    if (view.role === Role.Merlin) for (const seat of view.visibleSeats) score[seat] += merlinWeight;
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
    if (view.role === Role.Merlin && team.some((seat) => evil.has(seat))) return random() < 0.3;
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
