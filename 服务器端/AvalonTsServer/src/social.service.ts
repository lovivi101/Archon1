import { Injectable } from "@nestjs/common";
import { ErrorCode, RoomError } from "./avalon.types";
import { DatabaseService } from "./database.service";

export interface PlayerCard {
    userId: string;
    nickname: string;
    avatar: string;
}

export interface DirectMessage {
    senderId: string;
    targetId: string;
    text: string;
    /** ISO time. */
    time: string;
}

export interface FriendLists {
    friends: PlayerCard[];
    /** Requests waiting for my answer. */
    incoming: PlayerCard[];
    /** Requests I sent that are still open. */
    outgoing: PlayerCard[];
}

export const MAX_FRIENDS = 100;
export const MAX_MESSAGE_LENGTH = 200;
/** Messages returned by `messages` and kept per pair in memory. */
const HISTORY_LIMIT = 50;
const SEARCH_LIMIT = 10;

/**
 * Friends, friend requests and private messages. Stored in PostgreSQL, or in memory when the
 * database is disabled (development and tests), with the same behaviour either way.
 * Presence (online, current room) belongs to the game service, which adds it to these results.
 */
@Injectable()
export class SocialService {
    /** Names and avatars seen on login or room join; the database fills in anyone missing. */
    private readonly cards = new Map<string, PlayerCard>();
    private readonly memory = {
        friends: new Map<string, Set<string>>(),
        /** `requester\0target` */
        requests: new Set<string>(),
        messages: new Map<string, DirectMessage[]>(),
    };

    public constructor(private readonly database: DatabaseService) {}

    /** Records the latest nickname (and avatar, when known) of a player who logged in or joined a room. */
    public remember(userId: string, nickname: string, avatar?: string): void {
        const previous = this.cards.get(userId);
        this.cards.set(userId, { userId, nickname, avatar: avatar ?? previous?.avatar ?? "" });
    }

    public async lists(userId: string): Promise<FriendLists> {
        const pool = this.database.pool;
        let friendIds: string[];
        let incoming: string[];
        let outgoing: string[];
        if (!pool) {
            friendIds = [...(this.memory.friends.get(userId) ?? [])];
            const requests = [...this.memory.requests].map(splitKey);
            incoming = requests.filter(([, target]) => target === userId).map(([requester]) => requester);
            outgoing = requests.filter(([requester]) => requester === userId).map(([, target]) => target);
        } else {
            const friends = await pool.query(
                `SELECT CASE WHEN user_a = $1 THEN user_b ELSE user_a END AS id FROM friendships WHERE user_a = $1 OR user_b = $1`,
                [userId],
            );
            const requests = await pool.query("SELECT requester_id, target_id FROM friend_requests WHERE requester_id = $1 OR target_id = $1", [userId]);
            friendIds = friends.rows.map((row) => row.id);
            incoming = requests.rows.filter((row) => row.target_id === userId).map((row) => row.requester_id);
            outgoing = requests.rows.filter((row) => row.requester_id === userId).map((row) => row.target_id);
        }
        const cards = await this.lookup([...friendIds, ...incoming, ...outgoing]);
        const pick = (ids: string[]): PlayerCard[] => ids.map((id) => cards.get(id)).filter((card): card is PlayerCard => card !== undefined);
        return { friends: pick(friendIds), incoming: pick(incoming), outgoing: pick(outgoing) };
    }

    public async friendIds(userId: string): Promise<string[]> {
        return (await this.lists(userId)).friends.map((card) => card.userId);
    }

    /** Players whose nickname contains the query, or whose id equals it; never myself. */
    public async search(userId: string, rawQuery: unknown): Promise<(PlayerCard & { isFriend: boolean; pending: boolean })[]> {
        const query = String(rawQuery ?? "").trim();
        if (!query || query.length > 64) throw new RoomError(ErrorCode.BadRequest, "请输入玩家昵称或 ID");
        const pool = this.database.pool;
        let found: PlayerCard[];
        if (!pool) {
            const needle = query.toLocaleLowerCase();
            found = [...this.cards.values()]
                .filter((card) => card.userId !== userId && (card.userId === query || card.nickname.toLocaleLowerCase().includes(needle)))
                .slice(0, SEARCH_LIMIT);
        } else {
            const pattern = `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
            const result = await pool.query(
                `SELECT user_id, nickname, avatar FROM player_profiles
                 WHERE user_id <> $1 AND (user_id = $2 OR nickname ILIKE $3)
                 ORDER BY (user_id = $2) DESC, updated_at DESC LIMIT $4`,
                [userId, query, pattern, SEARCH_LIMIT],
            );
            found = result.rows.map((row) => this.cards.get(row.user_id) ?? { userId: row.user_id, nickname: row.nickname, avatar: row.avatar });
        }
        const lists = await this.lists(userId);
        const friends = new Set(lists.friends.map((card) => card.userId));
        const pending = new Set(lists.outgoing.map((card) => card.userId));
        return found.map((card) => ({ ...card, isFriend: friends.has(card.userId), pending: pending.has(card.userId) }));
    }

    /** Sends a request, or becomes friends at once when the target had already asked. */
    public async request(userId: string, rawTargetId: unknown): Promise<{ accepted: boolean }> {
        const targetId = String(rawTargetId ?? "");
        if (targetId === userId) throw new RoomError(ErrorCode.BadRequest, "不能添加自己为好友");
        if ((await this.lookup([targetId])).size === 0) throw new RoomError(ErrorCode.NotFound, "玩家不存在");
        const lists = await this.lists(userId);
        if (lists.friends.some((card) => card.userId === targetId)) throw new RoomError(ErrorCode.Conflict, "你们已经是好友");
        if (lists.incoming.some((card) => card.userId === targetId)) {
            await this.reply(userId, targetId, true);
            return { accepted: true };
        }
        if (lists.outgoing.some((card) => card.userId === targetId)) throw new RoomError(ErrorCode.Conflict, "好友申请已发送，等待对方同意");
        await this.checkLimit(userId, targetId);
        const pool = this.database.pool;
        if (!pool) this.memory.requests.add(requestKey(userId, targetId));
        else await pool.query("INSERT INTO friend_requests (requester_id, target_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [userId, targetId]);
        return { accepted: false };
    }

    public async reply(userId: string, rawRequesterId: unknown, accept: boolean): Promise<void> {
        const requesterId = String(rawRequesterId ?? "");
        const pool = this.database.pool;
        if (!pool) {
            if (!this.memory.requests.has(requestKey(requesterId, userId))) throw new RoomError(ErrorCode.NotFound, "好友申请不存在或已处理");
            if (accept) await this.checkLimit(userId, requesterId);
            this.memory.requests.delete(requestKey(requesterId, userId));
            this.memory.requests.delete(requestKey(userId, requesterId));
            if (accept) this.link(userId, requesterId);
            return;
        }
        const exists = await pool.query("SELECT 1 FROM friend_requests WHERE requester_id = $1 AND target_id = $2", [requesterId, userId]);
        if (!exists.rowCount) throw new RoomError(ErrorCode.NotFound, "好友申请不存在或已处理");
        if (accept) await this.checkLimit(userId, requesterId);
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(
                "DELETE FROM friend_requests WHERE (requester_id = $1 AND target_id = $2) OR (requester_id = $2 AND target_id = $1)",
                [requesterId, userId],
            );
            if (accept) {
                const [a, b] = sortedPair(userId, requesterId);
                await client.query("INSERT INTO friendships (user_a, user_b) VALUES ($1, $2) ON CONFLICT DO NOTHING", [a, b]);
            }
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    public async remove(userId: string, rawTargetId: unknown): Promise<void> {
        const targetId = String(rawTargetId ?? "");
        if (!(await this.areFriends(userId, targetId))) throw new RoomError(ErrorCode.NotFound, "对方不是你的好友");
        const pool = this.database.pool;
        if (!pool) {
            this.memory.friends.get(userId)?.delete(targetId);
            this.memory.friends.get(targetId)?.delete(userId);
            return;
        }
        const [a, b] = sortedPair(userId, targetId);
        await pool.query("DELETE FROM friendships WHERE user_a = $1 AND user_b = $2", [a, b]);
    }

    public async areFriends(a: string, b: string): Promise<boolean> {
        const pool = this.database.pool;
        if (!pool) return this.memory.friends.get(a)?.has(b) ?? false;
        const [x, y] = sortedPair(a, b);
        const result = await pool.query("SELECT 1 FROM friendships WHERE user_a = $1 AND user_b = $2", [x, y]);
        return Boolean(result.rowCount);
    }

    public async send(userId: string, rawTargetId: unknown, rawText: unknown): Promise<DirectMessage> {
        const targetId = String(rawTargetId ?? "");
        const text = String(rawText ?? "").trim();
        if (!text || [...text].length > MAX_MESSAGE_LENGTH) throw new RoomError(ErrorCode.BadRequest, `消息需要 1 到 ${MAX_MESSAGE_LENGTH} 个字`);
        if (!(await this.areFriends(userId, targetId))) throw new RoomError(ErrorCode.Forbidden, "只能给好友发私信");
        const message: DirectMessage = { senderId: userId, targetId, text, time: new Date().toISOString() };
        const pool = this.database.pool;
        if (!pool) {
            const key = pairKey(userId, targetId);
            const thread = this.memory.messages.get(key) ?? [];
            thread.push(message);
            if (thread.length > HISTORY_LIMIT) thread.shift();
            this.memory.messages.set(key, thread);
        } else {
            await pool.query("INSERT INTO direct_messages (sender_id, target_id, body) VALUES ($1, $2, $3)", [userId, targetId, text]);
        }
        return message;
    }

    /** The latest private messages between two friends, oldest first. */
    public async messages(userId: string, rawTargetId: unknown): Promise<DirectMessage[]> {
        const targetId = String(rawTargetId ?? "");
        if (!(await this.areFriends(userId, targetId))) throw new RoomError(ErrorCode.Forbidden, "只能查看好友的私信");
        const pool = this.database.pool;
        if (!pool) return [...(this.memory.messages.get(pairKey(userId, targetId)) ?? [])];
        const [a, b] = sortedPair(userId, targetId);
        const result = await pool.query(
            `SELECT sender_id, target_id, body, created_at FROM direct_messages
             WHERE LEAST(sender_id, target_id) = $1 AND GREATEST(sender_id, target_id) = $2
             ORDER BY id DESC LIMIT $3`,
            [a, b, HISTORY_LIMIT],
        );
        return result.rows.reverse().map((row) => ({ senderId: row.sender_id, targetId: row.target_id, text: row.body, time: new Date(row.created_at).toISOString() }));
    }

    /** Name cards for the given ids: cached ones first, the rest from player_profiles. Unknown ids are left out. */
    public async lookup(ids: string[]): Promise<Map<string, PlayerCard>> {
        const found = new Map<string, PlayerCard>();
        const missing: string[] = [];
        for (const id of new Set(ids)) {
            const card = this.cards.get(id);
            if (card) found.set(id, card);
            else missing.push(id);
        }
        const pool = this.database.pool;
        if (pool && missing.length > 0) {
            const result = await pool.query("SELECT user_id, nickname, avatar FROM player_profiles WHERE user_id = ANY($1)", [missing]);
            for (const row of result.rows) found.set(row.user_id, { userId: row.user_id, nickname: row.nickname, avatar: row.avatar });
        }
        return found;
    }

    private async checkLimit(userId: string, otherId: string): Promise<void> {
        const [mine, theirs] = await Promise.all([this.friendIds(userId), this.friendIds(otherId)]);
        if (mine.length >= MAX_FRIENDS) throw new RoomError(ErrorCode.Conflict, `好友数量已达上限（${MAX_FRIENDS}）`);
        if (theirs.length >= MAX_FRIENDS) throw new RoomError(ErrorCode.Conflict, "对方的好友数量已达上限");
    }

    private link(a: string, b: string): void {
        for (const [from, to] of [[a, b], [b, a]]) {
            const set = this.memory.friends.get(from) ?? new Set<string>();
            set.add(to);
            this.memory.friends.set(from, set);
        }
    }
}

function requestKey(requesterId: string, targetId: string): string {
    return `${requesterId}\u0000${targetId}`;
}

function splitKey(key: string): [string, string] {
    const [requester, target] = key.split("\u0000");
    return [requester, target];
}

function sortedPair(a: string, b: string): [string, string] {
    return a < b ? [a, b] : [b, a];
}

function pairKey(a: string, b: string): string {
    return sortedPair(a, b).join("\u0000");
}
