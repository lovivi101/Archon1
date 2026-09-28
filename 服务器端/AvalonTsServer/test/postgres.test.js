const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// Runs only against a real database: PGHOST (and PGUSER/PGPASSWORD/PGDATABASE) must point at a
// disposable PostgreSQL; the migrations are applied first.
const enabled = Boolean(process.env.PGHOST) && process.env.AVALON_PG_TEST === "1";

test("PostgreSQL records: migrations, save, history, replay, leaderboard", { skip: !enabled && "set PGHOST and AVALON_PG_TEST=1" }, async () => {
    execFileSync(process.execPath, [path.join(__dirname, "../scripts/migrate.js")], { stdio: "inherit" });
    const { DatabaseService } = require("../dist/database.service.js");
    const { RecordsService } = require("../dist/records.service.js");
    const database = new DatabaseService();
    await database.onModuleInit();
    const records = new RecordsService(database);
    const suffix = Date.now().toString(36);
    const alice = `pg-alice-${suffix}`;
    const bob = `pg-bob-${suffix}`;
    await database.saveProfile(alice, "Alice");
    await database.saveProfile(bob, "Bob");
    const players = [[alice, 1], [bob, 4], ["ai-1", 3], ["ai-2", 2], ["ai-3", 5]].map(([userId, role], seat) => ({
        userId, nickname: userId, avatar: "avatar-merlin", seat, role, isAi: seat >= 2,
    }));
    const log = {
        roomId: "pg", playerCount: 5, goodWin: true, reason: "梅林存活，好人胜利", startedAt: Date.now() - 60000, endedAt: Date.now(), players,
        record: { players, proposals: [], missions: [{ round: 1, team: [0, 1], failCount: 0, success: true }], chat: [] },
    };
    const saved = await records.saveMatch(log);
    const again = await records.saveMatch({ ...log, goodWin: false });
    assert.ok(again.matchId > saved.matchId);

    const history = await records.history(alice);
    assert.deepEqual(history.slice(0, 2).map((entry) => entry.matchId), [again.matchId, saved.matchId]);
    assert.deepEqual(history.slice(0, 2).map((entry) => entry.won), [false, true]);
    const replay = await records.match(saved.matchId, bob);
    assert.equal(replay.missions[0].success, true);
    assert.equal(await records.match(saved.matchId, "someone-else"), null);

    const stats = await records.stats(alice);
    assert.equal(stats.games, 2);
    assert.equal(stats.wins, 1);
    assert.ok(stats.rank >= 1);
    const board = await records.leaderboard(100);
    assert.ok(board.some((row) => row.userId === alice && row.avatar === "avatar-merlin"));
    await database.onModuleDestroy();
});
