import { Injectable, Logger } from "@nestjs/common";
import { PoolClient } from "pg";
import { isBadRole } from "./avalon.types";
import { DatabaseService } from "./database.service";

/** Everything needed to store and replay one finished game (built by AvalonRoom.matchLog). */
export interface MatchLog {
    roomId: string;
    playerCount: number;
    goodWin: boolean;
    reason: string;
    startedAt: number;
    endedAt: number;
    players: { userId: string; nickname: string; avatar: string; seat: number; role: number; isAi: boolean }[];
    record: Record<string, unknown>;
}

export interface RatingChange {
    userId: string;
    before: number;
    after: number;
    games: number;
    wins: number;
}

export interface PlayerStats {
    rating: number;
    tier: string;
    games: number;
    wins: number;
    /** 1-based position among rated players, or 0 before the first game. */
    rank: number;
}

export interface HistoryEntry {
    matchId: number;
    endedAt: number;
    playerCount: number;
    role: number;
    won: boolean;
    reason: string;
    ratingDelta: number | null;
}

export interface LeaderboardEntry {
    rank: number;
    userId: string;
    nickname: string;
    avatar: string;
    rating: number;
    tier: string;
    games: number;
    wins: number;
}

export const START_RATING = 1000;
/** AI seats count at this rating in team averages but are never rated themselves. */
const AI_RATING = 1000;

/** Rank tiers from the design doc: 青铜（见习骑士）up to 王者（圆桌圣骑士）. */
const TIERS: [number, string][] = [
    [1600, "王者·圆桌圣骑士"],
    [1450, "钻石·圣殿骑士"],
    [1300, "铂金·王国骑士"],
    [1200, "黄金·誓约骑士"],
    [1100, "白银·侍从骑士"],
    [0, "青铜·见习骑士"],
];

export function tierFor(rating: number): string {
    return TIERS.find(([floor]) => rating >= floor)?.[1] ?? TIERS[TIERS.length - 1][1];
}

/**
 * Team Elo: each human moves by K * (result - expected), where expected compares the average rating
 * of the two sides (AI seats at a fixed rating). New players (fewer than 10 games) move faster.
 */
export function rateMatch(log: MatchLog, current: Map<string, { rating: number; games: number; wins: number }>): RatingChange[] {
    const ratingOf = (player: MatchLog["players"][number]): number => (player.isAi ? AI_RATING : current.get(player.userId)?.rating ?? START_RATING);
    const good = log.players.filter((player) => !isBadRole(player.role));
    const evil = log.players.filter((player) => isBadRole(player.role));
    const average = (side: MatchLog["players"]): number => side.reduce((sum, player) => sum + ratingOf(player), 0) / Math.max(1, side.length);
    const expectedGood = 1 / (1 + 10 ** ((average(evil) - average(good)) / 400));
    return log.players.filter((player) => !player.isAi).map((player) => {
        const state = current.get(player.userId) ?? { rating: START_RATING, games: 0, wins: 0 };
        const onGood = !isBadRole(player.role);
        const won = onGood === log.goodWin;
        const expected = onGood ? expectedGood : 1 - expectedGood;
        const k = state.games < 10 ? 40 : 24;
        const after = Math.round(state.rating + k * ((won ? 1 : 0) - expected));
        return { userId: player.userId, before: state.rating, after, games: state.games + 1, wins: state.wins + (won ? 1 : 0) };
    });
}

function won(log: MatchLog, role: number): boolean {
    return !isBadRole(role) === log.goodWin;
}

/**
 * Stores finished games and ratings in PostgreSQL, or in memory when the database is disabled
 * (development and tests), with the same behaviour either way.
 */
@Injectable()
export class RecordsService {
    private readonly logger = new Logger(RecordsService.name);
    private readonly memory = {
        matches: [] as (MatchLog & { id: number; ratings: RatingChange[] })[],
        profiles: new Map<string, { nickname: string; avatar: string; rating: number; games: number; wins: number }>(),
    };
    private static readonly MEMORY_MATCH_LIMIT = 5000;

    public constructor(private readonly database: DatabaseService) {}

    public async saveMatch(log: MatchLog): Promise<{ matchId: number; ratings: RatingChange[] }> {
        const pool = this.database.pool;
        if (!pool) return this.saveInMemory(log);
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const humans = log.players.filter((player) => !player.isAi);
            const current = await this.lockRatings(client, humans.map((player) => player.userId));
            const ratings = rateMatch(log, current);
            const inserted = await client.query(
                `INSERT INTO matches (room_id, player_count, good_win, reason, started_at, ended_at, record)
                 VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0), to_timestamp($6 / 1000.0), $7) RETURNING id`,
                [log.roomId, log.playerCount, log.goodWin, log.reason, log.startedAt, log.endedAt, JSON.stringify(log.record)],
            );
            const matchId = Number(inserted.rows[0].id);
            for (const player of log.players) {
                const change = ratings.find((item) => item.userId === player.userId && !player.isAi);
                await client.query(
                    `INSERT INTO match_players (match_id, seat, user_id, role, is_ai, won, rating_before, rating_after)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                    [matchId, player.seat, player.userId, player.role, player.isAi, won(log, player.role), change?.before ?? null, change?.after ?? null],
                );
            }
            for (const change of ratings) {
                const player = humans.find((item) => item.userId === change.userId);
                await client.query(
                    `INSERT INTO player_profiles (user_id, nickname, avatar, rating, games, wins) VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT (user_id) DO UPDATE SET avatar = EXCLUDED.avatar, rating = EXCLUDED.rating,
                     games = EXCLUDED.games, wins = EXCLUDED.wins, updated_at = NOW()`,
                    [change.userId, player?.nickname ?? "Guest", player?.avatar ?? "", change.after, change.games, change.wins],
                );
            }
            await client.query("COMMIT");
            return { matchId, ratings };
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    public async history(userId: string, limit = 20): Promise<HistoryEntry[]> {
        const pool = this.database.pool;
        if (!pool) {
            return this.memory.matches.filter((match) => match.players.some((player) => player.userId === userId && !player.isAi))
                .slice(-limit).reverse().map((match) => {
                    const player = match.players.find((item) => item.userId === userId)!;
                    const change = match.ratings.find((item) => item.userId === userId);
                    return {
                        matchId: match.id, endedAt: match.endedAt, playerCount: match.playerCount, role: player.role,
                        won: won(match, player.role), reason: match.reason, ratingDelta: change ? change.after - change.before : null,
                    };
                });
        }
        const result = await pool.query(
            `SELECT m.id, EXTRACT(EPOCH FROM m.ended_at) * 1000 AS ended_at, m.player_count, m.reason, p.role, p.won,
                    p.rating_after - p.rating_before AS delta
             FROM match_players p JOIN matches m ON m.id = p.match_id
             WHERE p.user_id = $1 AND NOT p.is_ai ORDER BY m.id DESC LIMIT $2`,
            [userId, limit],
        );
        return result.rows.map((row) => ({
            matchId: Number(row.id), endedAt: Math.round(Number(row.ended_at)), playerCount: row.player_count, role: row.role,
            won: row.won, reason: row.reason, ratingDelta: row.delta === null ? null : Number(row.delta),
        }));
    }

    /** The full replay of a match, only for players who took part in it. */
    public async match(matchId: number, userId: string): Promise<Record<string, unknown> | null> {
        const pool = this.database.pool;
        if (!pool) {
            const match = this.memory.matches.find((item) => item.id === matchId);
            if (!match || !match.players.some((player) => player.userId === userId)) return null;
            return { matchId, ...match.record };
        }
        const result = await pool.query(
            `SELECT m.record FROM matches m WHERE m.id = $1
             AND EXISTS (SELECT 1 FROM match_players p WHERE p.match_id = m.id AND p.user_id = $2)`,
            [matchId, userId],
        );
        return result.rowCount ? { matchId, ...result.rows[0].record } : null;
    }

    public async leaderboard(limit = 50): Promise<LeaderboardEntry[]> {
        const pool = this.database.pool;
        let rows: { userId: string; nickname: string; avatar: string; rating: number; games: number; wins: number }[];
        if (!pool) {
            rows = [...this.memory.profiles.entries()].filter(([, profile]) => profile.games > 0)
                .map(([userId, profile]) => ({ userId, ...profile }))
                .sort((a, b) => b.rating - a.rating || b.games - a.games).slice(0, limit);
        } else {
            const result = await pool.query(
                `SELECT user_id, nickname, avatar, rating, games, wins FROM player_profiles
                 WHERE games > 0 ORDER BY rating DESC, games DESC LIMIT $1`,
                [limit],
            );
            rows = result.rows.map((row) => ({ userId: row.user_id, nickname: row.nickname, avatar: row.avatar, rating: row.rating, games: row.games, wins: row.wins }));
        }
        return rows.map((row, index) => ({ rank: index + 1, ...row, tier: tierFor(row.rating) }));
    }

    public async stats(userId: string): Promise<PlayerStats> {
        const pool = this.database.pool;
        let state: { rating: number; games: number; wins: number } | undefined;
        let better = 0;
        if (!pool) {
            state = this.memory.profiles.get(userId);
            if (state && state.games > 0) better = [...this.memory.profiles.values()].filter((profile) => profile.games > 0 && profile.rating > state!.rating).length;
        } else {
            const result = await pool.query("SELECT rating, games, wins FROM player_profiles WHERE user_id = $1", [userId]);
            state = result.rowCount ? result.rows[0] : undefined;
            if (state && state.games > 0) {
                const rank = await pool.query("SELECT COUNT(*) AS better FROM player_profiles WHERE games > 0 AND rating > $1", [state.rating]);
                better = Number(rank.rows[0].better);
            }
        }
        const rating = state?.rating ?? START_RATING;
        const games = state?.games ?? 0;
        return { rating, tier: tierFor(rating), games, wins: state?.wins ?? 0, rank: games > 0 ? better + 1 : 0 };
    }

    private async lockRatings(client: PoolClient, userIds: string[]): Promise<Map<string, { rating: number; games: number; wins: number }>> {
        const result = await client.query("SELECT user_id, rating, games, wins FROM player_profiles WHERE user_id = ANY($1) FOR UPDATE", [userIds]);
        return new Map(result.rows.map((row) => [row.user_id, { rating: row.rating, games: row.games, wins: row.wins }]));
    }

    private saveInMemory(log: MatchLog): { matchId: number; ratings: RatingChange[] } {
        const profiles = this.memory.profiles;
        const ratings = rateMatch(log, profiles);
        const matchId = (this.memory.matches.at(-1)?.id ?? 0) + 1;
        this.memory.matches.push({ ...log, id: matchId, ratings });
        if (this.memory.matches.length > RecordsService.MEMORY_MATCH_LIMIT) this.memory.matches.shift();
        for (const change of ratings) {
            const player = log.players.find((item) => item.userId === change.userId)!;
            profiles.set(change.userId, { nickname: player.nickname, avatar: player.avatar, rating: change.after, games: change.games, wins: change.wins });
        }
        this.logger.debug({ event: "match.saved_in_memory", matchId });
        return { matchId, ratings };
    }
}
