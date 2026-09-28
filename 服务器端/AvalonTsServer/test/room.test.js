const test = require("node:test");
const assert = require("node:assert/strict");
const { AvalonRoom } = require("../dist/avalon.room.js");
const { Role, Route, Stage, RoomError, isBadRole } = require("../dist/avalon.types.js");

function seeded(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const baseConfig = {
    minPlayers: 5, maxPlayers: 10, nightMs: 1000, proposeMs: 60000, voteMs: 30000, missionMs: 30000, assassinMs: 60000, aiDelayMs: 100,
};

function setup({ humans = 1, seed = 1, config = {} } = {}) {
    const ctx = { now: 1000, sent: [] };
    ctx.room = new AvalonRoom("t", {
        config: { ...baseConfig, ...config },
        send: (to, route, payload) => ctx.sent.push({ to, route, payload }),
        clock: () => ctx.now,
        random: seeded(seed),
    });
    for (let index = 0; index < humans; index += 1) ctx.room.join(`h${index}`, `H${index}`);
    ctx.advance = (ms) => {
        ctx.now += ms;
        ctx.room.tick();
    };
    ctx.startAll = () => {
        for (let index = 0; index < humans; index += 1) ctx.room.ready(`h${index}`, true);
    };
    /** Runs the clock forward until the game ends; humans never act, so timeouts must carry the game. */
    ctx.runToEnd = (step = 5000) => {
        for (let guard = 0; guard < 2000 && ctx.room.stage !== Stage.End; guard += 1) ctx.advance(step);
        assert.equal(ctx.room.stage, Stage.End, "game should finish");
    };
    return ctx;
}

function expectError(fn, code) {
    assert.throws(fn, (error) => error instanceof RoomError && error.code === code);
}

function seatOf(room, role) {
    return room.players.find((player) => player.role === role);
}

test("start fills AI seats up to five and night advances to proposing", () => {
    const ctx = setup();
    ctx.startAll();
    assert.equal(ctx.room.players.length, 5);
    assert.equal(ctx.room.players.filter((player) => player.isAi).length, 4);
    assert.equal(ctx.room.stage, Stage.Night);
    const routes = ctx.sent.map((item) => item.route);
    assert.ok(routes.indexOf(Route.GameStart) < routes.indexOf(Route.IdentityPush));
    assert.ok(routes.indexOf(Route.IdentityPush) < routes.lastIndexOf(Route.StageChange));
    ctx.advance(999);
    assert.equal(ctx.room.stage, Stage.Night);
    ctx.advance(1);
    assert.equal(ctx.room.stage, Stage.Proposing);
});

test("identity is only pushed to its owner and hidden roles never leak before the end", () => {
    const ctx = setup({ humans: 3, seed: 7 });
    ctx.startAll();
    const identities = ctx.sent.filter((item) => item.route === Route.IdentityPush);
    assert.deepEqual(identities.map((item) => item.to).sort(), ["h0", "h1", "h2"]);
    ctx.runToEnd();
    for (const message of ctx.sent) {
        if (message.route === Route.GameEnd || message.route === Route.IdentityPush) continue;
        const players = message.payload?.room?.players ?? [];
        assert.ok(players.every((player) => player.role === Role.Unknown), `route ${message.route} leaked a role`);
    }
});

test("night visibility: Oberon sees nobody and is hidden from evil, Mordred is hidden from Merlin", () => {
    for (const count of [7, 10]) {
        const ctx = setup({ humans: count, seed: count });
        ctx.startAll();
        const { room } = ctx;
        const merlin = seatOf(room, Role.Merlin);
        const merlinSees = room.visibleSeats(merlin).map((seat) => room.players[seat].role);
        assert.ok(merlinSees.every((role) => isBadRole(role) && role !== Role.Mordred));
        const assassin = seatOf(room, Role.Assassin);
        assert.ok(room.visibleSeats(assassin).every((seat) => room.players[seat].role !== Role.Oberon));
        const oberon = seatOf(room, Role.Oberon);
        if (oberon) {
            assert.deepEqual(room.visibleSeats(oberon), []);
            assert.ok(merlinSees.includes(Role.Oberon), "Merlin still sees Oberon");
        }
        const percivalSees = room.visibleSeats(seatOf(room, Role.Percival)).map((seat) => room.players[seat].role).sort();
        assert.deepEqual(percivalSees, [Role.Merlin, Role.Morgana]);
    }
});

test("invalid actions are rejected with error codes instead of being ignored", () => {
    const ctx = setup({ humans: 5, seed: 3 });
    ctx.startAll();
    const { room } = ctx;
    expectError(() => room.vote("h0", true), 409);
    ctx.advance(1000);
    const captain = room.players[room.captainIdx];
    const other = room.players.find((player) => player !== captain);
    expectError(() => room.propose(other.userId, [0, 1]), 403);
    expectError(() => room.propose(captain.userId, [0]), 400);
    expectError(() => room.propose(captain.userId, [0, 0]), 400);
    expectError(() => room.propose(captain.userId, [0, 9]), 400);
    expectError(() => room.propose("stranger", [0, 1]), 404);
    room.propose(captain.userId, [0, 1]);
    expectError(() => room.vote("h0", "yes"), 400);
    room.vote("h0", true);
    expectError(() => room.vote("h0", false), 409);
    assert.equal(room.votes.get(0), true, "duplicate vote must not overwrite the first ballot");
});

test("good players cannot fail a mission and cards cannot be resubmitted", () => {
    const ctx = setup({ humans: 5, seed: 11 });
    ctx.startAll();
    const { room } = ctx;
    ctx.advance(1000);
    const good = room.players.find((player) => !isBadRole(player.role));
    const bad = room.players.find((player) => isBadRole(player.role));
    room.propose(room.players[room.captainIdx].userId, [good.seatIndex, bad.seatIndex]);
    for (const player of room.players) room.vote(player.userId, true);
    assert.equal(room.stage, Stage.Mission);
    expectError(() => room.mission(good.userId, false), 403);
    room.mission(good.userId, true);
    expectError(() => room.mission(good.userId, true), 409);
    const outsider = room.players.find((player) => player !== good && player !== bad);
    expectError(() => room.mission(outsider.userId, true), 403);
    room.mission(bad.userId, false);
    assert.deepEqual(room.missionResults, [false]);
});

test("round 4 with seven players needs two failure cards", () => {
    const ctx = setup({ humans: 7, seed: 5 });
    ctx.startAll();
    const { room } = ctx;
    room.round = 4;
    room.missionResults = [true, false, true];
    room.stage = Stage.Mission;
    const bad = room.players.find((player) => isBadRole(player.role));
    const goods = room.players.filter((player) => !isBadRole(player.role)).slice(0, 3);
    room.selectedSeats = [bad.seatIndex, ...goods.map((player) => player.seatIndex)];
    room.missionCards.clear();
    room.mission(bad.userId, false);
    for (const player of goods) room.mission(player.userId, true);
    assert.equal(room.missionResults[3], true);
    assert.equal(room.stage, Stage.Assassinating);
});

test("only the assassin can assassinate, and only good targets", () => {
    const ctx = setup({ humans: 5, seed: 13 });
    ctx.startAll();
    const { room } = ctx;
    room.stage = Stage.Assassinating;
    const assassin = seatOf(room, Role.Assassin);
    const morgana = seatOf(room, Role.Morgana);
    const merlin = seatOf(room, Role.Merlin);
    expectError(() => room.assassinate(morgana.userId, merlin.seatIndex), 403);
    expectError(() => room.assassinate(assassin.userId, morgana.seatIndex), 400);
    expectError(() => room.assassinate(assassin.userId, 42), 400);
    room.assassinate(assassin.userId, merlin.seatIndex);
    assert.equal(room.stage, Stage.End);
    assert.equal(room.outcome.isGoodWin, false);
    assert.ok(room.outcome.allRoles.every((player) => player.role !== Role.Unknown));
});

test("five rejected proposals end the game for evil", () => {
    const ctx = setup({ humans: 5, seed: 17 });
    ctx.startAll();
    const { room } = ctx;
    ctx.advance(1000);
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const size = room.teamSize();
        room.propose(room.players[room.captainIdx].userId, [...Array(size).keys()]);
        for (const player of room.players) room.vote(player.userId, false);
    }
    assert.equal(room.stage, Stage.End);
    assert.equal(room.outcome.isGoodWin, false);
});

test("stage change carries captain, round and vote progress", () => {
    const ctx = setup({ humans: 5, seed: 19 });
    ctx.startAll();
    ctx.advance(1000);
    const { room } = ctx;
    const firstCaptain = room.captainIdx;
    room.propose(room.players[firstCaptain].userId, [0, 1]);
    for (const player of room.players) room.vote(player.userId, false);
    const change = ctx.sent.filter((item) => item.route === Route.StageChange).at(-1).payload;
    assert.equal(change.stage, Stage.Proposing);
    assert.equal(change.captainIdx, (firstCaptain + 1) % 5);
    assert.equal(change.failedVotes, 1);
    assert.equal(change.round, 1);
    assert.equal(change.timeout, 60);
    assert.ok(change.deadline > ctx.now);
});

test("timeouts play for idle humans so a game always finishes", () => {
    const ctx = setup({ humans: 2, seed: 23 });
    ctx.startAll();
    ctx.runToEnd();
    assert.ok(ctx.room.outcome.winReason.length > 0);
});

test("AI seats act after the AI delay without waiting for the timeout", () => {
    const ctx = setup({ humans: 1, seed: 29 });
    ctx.startAll();
    ctx.room.leave("h0");
    ctx.runToEnd(150);
    assert.ok(ctx.now < 1000 + 60000, "all-AI game should not wait for any timeout");
});

test("a finished room resets for the next game instead of locking up", () => {
    const ctx = setup({ humans: 2, seed: 31 });
    ctx.startAll();
    ctx.runToEnd();
    const { room } = ctx;
    room.leave("h1");
    room.ready("h0", true);
    assert.deepEqual(room.players.map((player) => player.userId).filter((id) => !id.startsWith("ai-")), ["h0"]);
    assert.equal(room.stage, Stage.Night, "remaining player started a fresh game");
    assert.equal(room.missionResults.length, 0);
    ctx.runToEnd();
    room.join("newcomer", "N");
    assert.equal(room.stage, Stage.Preparing, "a newcomer reopens a finished room");
    assert.deepEqual(room.players.map((player) => player.userId), ["h0", "newcomer"]);
    assert.ok(room.players.every((player) => !player.isReady && player.role === Role.Unknown));
});

test("leaving or disconnecting before the game frees the seat", () => {
    const ctx = setup({ humans: 3, seed: 37 });
    const { room } = ctx;
    room.ready("h0", true);
    room.ready("h2", true);
    room.setOffline("h2");
    assert.deepEqual(room.players.map((player) => player.seatIndex), [0, 1]);
    assert.equal(room.stage, Stage.Preparing);
    room.leave("h1");
    assert.equal(room.stage, Stage.Night, "the last unready player leaving starts the game");
});

test("full room and started game reject new players; members can rejoin", () => {
    const ctx = setup({ humans: 10 });
    expectError(() => ctx.room.join("h10", "late"), 409);
    ctx.startAll();
    ctx.room.setOffline("h3");
    assert.equal(ctx.room.players[3].isOnline, false);
    expectError(() => ctx.room.join("other", "late"), 409);
    ctx.room.join("h3", "back");
    assert.equal(ctx.room.players[3].isOnline, true);
    assert.equal(ctx.room.identity("h3").role, ctx.room.players[3].role);
});

test("AI assassin guesses from public play instead of reading Merlin's role", () => {
    let assassinations = 0;
    let hits = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
        const ctx = setup({ humans: 1, seed });
        ctx.startAll();
        ctx.room.leave("h0");
        ctx.runToEnd(150);
        const reason = ctx.room.outcome.winReason;
        if (reason.startsWith("刺客选择了")) {
            assassinations += 1;
            if (!ctx.room.outcome.isGoodWin) hits += 1;
        }
    }
    assert.ok(assassinations >= 10, `expected assassinations to happen, got ${assassinations}`);
    assert.ok(hits < assassinations, `assassin hit Merlin ${hits}/${assassinations}`);
});
