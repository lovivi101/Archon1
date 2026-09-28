const test = require("node:test");
const assert = require("node:assert/strict");
const { RecordsService, rateMatch, tierFor, START_RATING } = require("../dist/records.service.js");
const { Role } = require("../dist/avalon.types.js");

/** A finished 5-player game: seats 0-1 human (good / evil), the rest AI. */
function log({ goodWin = true, humans = [["alice", Role.Merlin], ["bob", Role.Assassin]], roomId = "r1" } = {}) {
    const roles = [...humans.map(([, role]) => role), Role.Servant, Role.Percival, Role.Morgana];
    const players = roles.map((role, seat) => ({
        userId: humans[seat]?.[0] ?? `ai-${roomId}-${seat}`, nickname: humans[seat]?.[0] ?? `AI_${seat}`, avatar: "", seat, role, isAi: seat >= humans.length,
    }));
    return {
        roomId, playerCount: 5, goodWin, reason: goodWin ? "梅林存活，好人胜利" : "三次任务失败，坏人胜利", startedAt: 1000, endedAt: 2000, players,
        record: { players, proposals: [{ round: 1, captainSeat: 0, team: [0, 1], votes: [true, true, false, false, true], passed: true }], missions: [], chat: [] },
    };
}

test("team Elo: winners gain, losers lose, new players move faster, tiers follow rating", () => {
    const fresh = rateMatch(log(), new Map());
    const alice = fresh.find((change) => change.userId === "alice");
    const bob = fresh.find((change) => change.userId === "bob");
    assert.equal(alice.before, START_RATING);
    assert.ok(alice.after > START_RATING, "good won");
    assert.ok(bob.after < START_RATING, "evil lost");
    assert.equal(alice.games, 1);
    assert.equal(alice.wins, 1);
    assert.equal(bob.wins, 0);
    assert.equal(fresh.length, 2, "AI seats are never rated");

    const veteran = rateMatch(log(), new Map([["alice", { rating: 1000, games: 50, wins: 25 }]]));
    assert.ok(veteran.find((change) => change.userId === "alice").after - 1000 < alice.after - 1000, "K shrinks after 10 games");
    const favourite = rateMatch(log(), new Map([["alice", { rating: 1600, games: 50, wins: 40 }]]));
    const underdog = rateMatch(log(), new Map([["alice", { rating: 700, games: 50, wins: 10 }]]));
    assert.ok(favourite.find((c) => c.userId === "alice").after - 1600 < underdog.find((c) => c.userId === "alice").after - 700, "beating weaker opposition gains less");

    assert.equal(tierFor(999), "青铜·见习骑士");
    assert.equal(tierFor(1100), "白银·侍从骑士");
    assert.equal(tierFor(1250), "黄金·誓约骑士");
    assert.equal(tierFor(1600), "王者·圆桌圣骑士");
});

test("in-memory records: history, replay only for participants, leaderboard and stats", async () => {
    const records = new RecordsService({ pool: undefined });
    const first = await records.saveMatch(log({ goodWin: true }));
    const second = await records.saveMatch(log({ goodWin: false, roomId: "r2" }));
    assert.equal(second.matchId, first.matchId + 1);

    const history = await records.history("alice");
    assert.deepEqual(history.map((entry) => entry.matchId), [second.matchId, first.matchId], "newest first");
    assert.equal(history[0].won, false);
    assert.equal(history[1].won, true);
    assert.equal(typeof history[0].ratingDelta, "number");

    const replay = await records.match(first.matchId, "bob");
    assert.equal(replay.matchId, first.matchId);
    assert.equal(replay.players[0].role, Role.Merlin);
    assert.equal(await records.match(first.matchId, "stranger"), null);

    const board = await records.leaderboard();
    assert.deepEqual(board.map((row) => row.rank), [1, 2]);
    assert.ok(board[0].rating >= board[1].rating);
    const stats = await records.stats("alice");
    assert.equal(stats.games, 2);
    assert.equal(stats.wins, 1);
    assert.ok(stats.rank >= 1);
    assert.deepEqual(await records.stats("nobody"), { rating: START_RATING, tier: tierFor(START_RATING), games: 0, wins: 0, rank: 0 });
});
