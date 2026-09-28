const test = require("node:test");
const assert = require("node:assert/strict");
const { AvalonRoom } = require("../dist/avalon.room.js");
const { Role, Route, Stage, RoomError, isBadRole, teamSizeFor } = require("../dist/avalon.types.js");

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

const config = {
    minPlayers: 5, maxPlayers: 10, nightMs: 1000, speakMs: 30000, proposeMs: 60000, voteMs: 30000, missionMs: 30000,
    ladyMs: 30000, excaliburMs: 20000, assassinMs: 60000, aiDelayMs: 100, aiSpeechMs: 300,
};

/** A room with `humans` human seats (h0..) and `players` seats in total; the rest are AI. */
function setup({ humans, players = humans, seed = 1 }) {
    const ctx = { now: 1000, sent: [] };
    ctx.room = new AvalonRoom("m", {
        config, targetPlayers: players, random: seeded(seed),
        send: (to, route, payload) => ctx.sent.push({ to, route, payload }),
        clock: () => ctx.now,
    });
    for (let index = 0; index < humans; index += 1) ctx.room.join(`h${index}`, `H${index}`);
    for (let index = 0; index < humans; index += 1) ctx.room.ready(`h${index}`, true);
    ctx.advance = (ms) => {
        ctx.now += ms;
        ctx.room.tick();
    };
    ctx.player = (seat) => ctx.room.players[seat];
    ctx.skipSpeeches = () => {
        while (ctx.room.stage === Stage.Speaking) ctx.room.endSpeech(ctx.player(ctx.room.currentSpeaker()).userId);
    };
    ctx.toProposing = () => {
        if (ctx.room.stage === Stage.Night) ctx.advance(config.nightMs);
        ctx.skipSpeeches();
        assert.equal(ctx.room.stage, Stage.Proposing);
    };
    ctx.messages = (route) => ctx.sent.filter((item) => item.route === route);
    ctx.goodSeats = () => ctx.room.players.filter((player) => !isBadRole(player.role)).map((player) => player.seatIndex);
    /** Plays one round where the team is all good (so it succeeds). Excalibur, if required, goes to a non-captain member. */
    ctx.cleanRound = () => {
        ctx.toProposing();
        const { room } = ctx;
        const size = room.teamSize();
        const goods = ctx.goodSeats().filter((seat) => seat !== room.captainIdx);
        const team = [...goods.slice(0, size)];
        room.propose(ctx.player(room.captainIdx).userId, team, room.rules.excalibur ? team[0] : undefined);
        for (const player of room.players) room.vote(player.userId, true);
        for (const seat of team) room.mission(ctx.player(seat).userId, true);
        if (room.stage === Stage.Excalibur) room.useExcalibur(ctx.player(room.excaliburSeat).userId, -1);
    };
    return ctx;
}

function expectError(fn, code) {
    assert.throws(fn, (error) => error instanceof RoomError && error.code === code);
}

test("speeches go captain first then clockwise; only the current speaker may talk", () => {
    const ctx = setup({ humans: 5, seed: 3 });
    const { room } = ctx;
    ctx.advance(config.nightMs);
    assert.equal(room.stage, Stage.Speaking);
    const order = room.speechOrder;
    assert.equal(order[0], room.captainIdx);
    order.forEach((seat, index) => assert.equal(seat, (room.captainIdx + index) % 5));

    const speaker = ctx.player(room.currentSpeaker());
    const other = ctx.player((room.currentSpeaker() + 1) % 5);
    expectError(() => room.chat(other.userId, "我也想说"), 403);
    expectError(() => room.endSpeech(other.userId), 403);
    expectError(() => room.chat(speaker.userId, "   "), 400);
    expectError(() => room.chat(speaker.userId, "长".repeat(81)), 400);
    for (let index = 0; index < 5; index += 1) room.chat(speaker.userId, `第${index + 1}句`);
    expectError(() => room.chat(speaker.userId, "第六句"), 409);
    const chats = ctx.messages(Route.ChatMessage);
    assert.equal(chats.length, 5);
    assert.ok(chats.every((item) => item.to === null && item.payload.seat === speaker.seatIndex && item.payload.channel === "all"));

    // A human who stays silent loses the turn when time runs out; nobody speaks for them.
    ctx.advance(config.speakMs);
    assert.equal(room.currentSpeaker(), order[1]);
    assert.equal(ctx.messages(Route.ChatMessage).length, 5);
    const change = ctx.messages(Route.SpeakerChange).at(-1).payload;
    assert.equal(change.speakerSeat, order[1]);
    assert.equal(change.timeout, 30);

    ctx.skipSpeeches();
    assert.equal(room.stage, Stage.Proposing);
    expectError(() => room.chat(speaker.userId, "组队时说话"), 409);
});

test("AI speakers say something and an AI captain proposes the team it announced", () => {
    let checked = 0;
    for (let seed = 1; seed <= 20 && checked < 5; seed += 1) {
        const ctx = setup({ humans: 1, players: 7, seed });
        ctx.room.leave("h0");
        for (let guard = 0; guard < 3000 && ctx.room.stage !== Stage.End; guard += 1) ctx.advance(150);
        assert.equal(ctx.room.stage, Stage.End);
        const events = ctx.sent;
        for (let index = 0; index < events.length; index += 1) {
            const event = events[index];
            if (event.route !== Route.TeamProposed) continue;
            const captain = ctx.player(event.payload.captainSeat);
            if (!captain.isAi) continue;
            const plan = events.slice(0, index).reverse()
                .find((item) => item.route === Route.ChatMessage && item.payload.seat === captain.seatIndex && item.payload.text.includes("打算带"));
            assert.ok(plan, "AI captain announces a plan before proposing");
            const announced = [...plan.payload.text.matchAll(/(\d+)号/g)].map((match) => Number(match[1]) - 1);
            const proposed = event.payload.selectedSeats.slice().sort((a, b) => a - b);
            assert.deepEqual(announced.slice(-proposed.length).sort((a, b) => a - b), proposed);
            checked += 1;
        }
        assert.ok(ctx.messages(Route.ChatMessage).length > 0, "AI players talk");
    }
    assert.ok(checked >= 5);
});

test("before the assassination all evil players are revealed and get a private channel", () => {
    const ctx = setup({ humans: 7, seed: 5 });
    const { room } = ctx;
    for (let round = 0; round < 3; round += 1) {
        ctx.cleanRound();
        if (room.stage === Stage.LadyOfLake) room.ladyCheck(ctx.player(room.ladyHolder).userId, room.ladyEligible()[0]);
    }
    assert.equal(room.stage, Stage.Assassinating);
    const evil = room.players.filter((player) => isBadRole(player.role)).map((player) => player.seatIndex);
    const reveal = ctx.messages(Route.EvilRevealed).at(-1).payload;
    assert.deepEqual(reveal.evilSeats, evil);
    assert.ok(evil.some((seat) => ctx.player(seat).role === Role.Oberon), "7-player board includes Oberon");
    assert.deepEqual(room.snapshot().revealedEvil, evil);

    const good = ctx.player(ctx.goodSeats()[0]);
    expectError(() => room.chat(good.userId, "别杀我"), 403);
    const assassin = room.players.find((player) => player.role === Role.Assassin);
    const before = ctx.sent.length;
    room.chat(assassin.userId, "我们商量一下");
    const delivered = ctx.sent.slice(before).filter((item) => item.route === Route.ChatMessage);
    assert.deepEqual(delivered.map((item) => item.to).sort(), evil.map((seat) => ctx.player(seat).userId).sort());
    assert.ok(delivered.every((item) => item.payload.channel === "evil"));
    assert.equal(room.chatFor(good.userId).filter((entry) => entry.channel === "evil").length, 0);
});

test("Lady of the Lake: 7 players only, used after missions 2-4, result private, no re-checks", () => {
    assert.equal(setup({ humans: 5 }).room.rules.lady, false);
    assert.equal(setup({ humans: 10 }).room.rules.lady, false);

    const ctx = setup({ humans: 7, seed: 9 });
    const { room } = ctx;
    assert.deepEqual(room.rules, { lady: true, excalibur: false });
    assert.equal(room.ladyHolder, (room.captainIdx + 6) % 7, "starts to the right of the first captain");
    const firstHolder = room.ladyHolder;

    ctx.cleanRound();
    assert.equal(room.round, 2, "no Lady after round 1");
    assert.equal(room.stage, Stage.Speaking);
    ctx.cleanRound();
    assert.equal(room.stage, Stage.LadyOfLake);

    const holder = ctx.player(room.ladyHolder);
    const other = room.players.find((player) => player.seatIndex !== holder.seatIndex);
    expectError(() => room.ladyCheck(other.userId, holder.seatIndex), 403);
    expectError(() => room.ladyCheck(holder.userId, holder.seatIndex), 400);
    const target = room.ladyEligible().find((seat) => isBadRole(ctx.player(seat).role)) ?? room.ladyEligible()[0];
    const before = ctx.sent.length;
    room.ladyCheck(holder.userId, target);
    const sent = ctx.sent.slice(before);
    const result = sent.find((item) => item.route === Route.LadyResult);
    assert.equal(result.to, holder.userId, "only the holder learns the result");
    assert.equal(result.payload.isGood, !isBadRole(ctx.player(target).role));
    const used = sent.find((item) => item.route === Route.LadyUsed);
    assert.equal(used.to, null);
    assert.deepEqual([used.payload.holderSeat, used.payload.targetSeat], [holder.seatIndex, target]);
    assert.equal(room.ladyHolder, target, "the token passes to the checked player");
    assert.deepEqual(room.identity(holder.userId).facts, [{ seat: target, isGood: result.payload.isGood }]);
    assert.equal(room.round, 3);
    assert.equal(room.stage, Stage.Speaking);

    // The first holder and the previous holder can never be checked again.
    ctx.cleanRound();
    if (room.stage === Stage.LadyOfLake) {
        assert.ok(!room.ladyEligible().includes(firstHolder));
        assert.ok(!room.ladyEligible().includes(target));
        expectError(() => room.ladyCheck(ctx.player(room.ladyHolder).userId, firstHolder), 400);
    }
});

test("Excalibur: 10 players only, given at proposal, can flip another member's card", () => {
    assert.equal(setup({ humans: 7 }).room.rules.excalibur, false);
    const ctx = setup({ humans: 10, seed: 11 });
    const { room } = ctx;
    assert.deepEqual(room.rules, { lady: false, excalibur: true });
    ctx.toProposing();
    const captain = ctx.player(room.captainIdx);
    const size = room.teamSize();
    assert.equal(size, teamSizeFor(10, 1));
    const evil = room.players.find((player) => isBadRole(player.role) && player.seatIndex !== room.captainIdx);
    const goods = ctx.goodSeats().filter((seat) => seat !== room.captainIdx);
    const team = [evil.seatIndex, ...goods.slice(0, size - 1)];
    const holderSeat = team[1];
    expectError(() => room.propose(captain.userId, team), 400);
    expectError(() => room.propose(captain.userId, team, room.captainIdx), 400);
    expectError(() => room.propose(captain.userId, team, team.includes(9) ? 8 : 9), 400);
    room.propose(captain.userId, team, holderSeat);
    assert.equal(ctx.messages(Route.TeamProposed).at(-1).payload.excaliburSeat, holderSeat);
    for (const player of room.players) room.vote(player.userId, true);
    room.mission(evil.userId, false);
    for (const seat of team.slice(1)) room.mission(ctx.player(seat).userId, true);
    assert.equal(room.stage, Stage.Excalibur, "cards are in; the holder decides before the result");
    assert.equal(ctx.messages(Route.MissionResult).length, 0);

    const holder = ctx.player(holderSeat);
    expectError(() => room.useExcalibur(evil.userId, holderSeat), 403);
    expectError(() => room.useExcalibur(holder.userId, holderSeat), 400);
    const outsider = room.players.find((player) => !team.includes(player.seatIndex));
    expectError(() => room.useExcalibur(holder.userId, outsider.seatIndex), 400);
    const before = ctx.sent.length;
    room.useExcalibur(holder.userId, evil.seatIndex);
    const sent = ctx.sent.slice(before);
    const peek = sent.find((item) => item.route === Route.ExcaliburResult);
    assert.equal(peek.to, holder.userId);
    assert.deepEqual(peek.payload, { targetSeat: evil.seatIndex, originalSuccess: false });
    assert.deepEqual(sent.find((item) => item.route === Route.ExcaliburUsed).payload, { holderSeat, targetSeat: evil.seatIndex });
    const result = sent.find((item) => item.route === Route.MissionResult).payload;
    assert.equal(result.isSuccess, true, "the only failure card was flipped");
    assert.equal(result.failCount, 0);
    assert.deepEqual(room.identity(holder.userId).facts, [{ seat: evil.seatIndex, isGood: false }]);
    assert.equal(room.excaliburSeat, -1, "Excalibur is handed out again next proposal");
});

test("rooms fill empty seats with AI up to their size and publish the board", () => {
    for (const players of [5, 7, 10]) {
        const ctx = setup({ humans: 1, players });
        const snapshot = ctx.room.snapshot();
        assert.equal(ctx.room.players.length, players);
        assert.equal(ctx.room.players.filter((player) => player.isAi).length, players - 1);
        assert.equal(snapshot.targetPlayers, players);
        assert.equal(snapshot.roleSet.length, players);
        assert.deepEqual(snapshot.rules, { lady: players === 7, excalibur: players === 10 });
    }
    const lobby = new AvalonRoom("x", { config, targetPlayers: 6, send() {} });
    for (let index = 0; index < 6; index += 1) lobby.join(`p${index}`, "P");
    assert.equal(lobby.hasFreeSeat(), false);
    expectError(() => lobby.join("late", "L"), 409);
});

test("all-AI games at every size finish without a single invalid AI move", () => {
    for (let players = 5; players <= 10; players += 1) {
        let fallbacks = 0;
        let ladyUses = 0;
        let excaliburUses = 0;
        for (let seed = 1; seed <= 60; seed += 1) {
            const ctx = setup({ humans: 1, players, seed: seed * 31 + players });
            const original = ctx.room.fallbackAct.bind(ctx.room);
            ctx.room.fallbackAct = (player) => {
                fallbacks += 1;
                original(player);
            };
            ctx.room.leave("h0");
            for (let guard = 0; guard < 5000 && ctx.room.stage !== Stage.End; guard += 1) ctx.advance(150);
            assert.equal(ctx.room.stage, Stage.End, `${players}p seed ${seed} did not finish`);
            ladyUses += ctx.messages(Route.LadyUsed).length;
            excaliburUses += ctx.messages(Route.ExcaliburUsed).filter((item) => item.payload.targetSeat >= 0).length;
            assert.ok(ctx.messages(Route.LadyUsed).length <= 3);
        }
        assert.equal(fallbacks, 0, `${players}p: AI made invalid moves`);
        if (players === 7) assert.ok(ladyUses > 0, "Lady of the Lake gets used");
        else assert.equal(ladyUses, 0);
        if (players === 10) assert.ok(excaliburUses > 0, "Excalibur gets used");
        else assert.equal(excaliburUses, 0);
    }
});
