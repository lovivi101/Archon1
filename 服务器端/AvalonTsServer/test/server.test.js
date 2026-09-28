const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const WebSocket = require("ws");
const { decodePacket, encodePacket } = require("../dist/protocol.js");

let server;
let port;

async function freePort() {
    const probe = http.createServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port: value } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    return value;
}

async function health() {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    return response.json();
}

/** Minimal protocol client that records every packet and lets tests wait for a matching one. */
class Client {
    constructor() {
        this.packets = [];
        this.waiters = [];
        this.seq = 0;
    }

    async open() {
        this.socket = new WebSocket(`ws://127.0.0.1:${port}`);
        this.socket.on("message", (raw) => {
            const packet = decodePacket(raw);
            this.packets.push(packet);
            this.waiters = this.waiters.filter((waiter) => !waiter(packet));
        });
        await new Promise((resolve, reject) => {
            this.socket.once("open", resolve);
            this.socket.once("error", reject);
        });
        return this;
    }

    send(route, payload = {}) {
        this.seq += 1;
        this.socket.send(encodePacket(this.seq, route, payload));
        return this.seq;
    }

    /** Resolves with the first packet (already received after `from`, or arriving later) that matches. */
    wait(route, match = () => true, from = 0, timeoutMs = 15000) {
        const test = (packet) => packet.route === route && match(packet.payload);
        const existing = this.packets.slice(from).find(test);
        if (existing) return Promise.resolve(existing.payload);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`timed out waiting for route ${route}`)), timeoutMs);
            this.waiters.push((packet) => {
                if (!test(packet)) return false;
                clearTimeout(timer);
                resolve(packet.payload);
                return true;
            });
        });
    }

    async login(userId) {
        const mark = this.packets.length;
        this.send(101, { userId, nickname: userId });
        return this.wait(101, () => true, mark);
    }

    async join(roomId) {
        const mark = this.packets.length;
        this.send(102, { roomId });
        return this.wait(102, () => true, mark);
    }

    close() {
        this.socket.close();
    }
}

test.before(async () => {
    port = await freePort();
    server = spawn(process.execPath, [path.join(__dirname, "../dist/server.js")], {
        cwd: path.join(__dirname, ".."),
        env: {
            ...process.env, PORT: String(port), PGHOST: "", NODE_ENV: "test",
            AVALON_NIGHT_SECONDS: "0.1", AVALON_PROPOSE_SECONDS: "0.3", AVALON_VOTE_SECONDS: "0.3",
            AVALON_MISSION_SECONDS: "0.3", AVALON_ASSASSIN_SECONDS: "0.3", AVALON_AI_TICK_MS: "20", AVALON_AI_DELAY_MS: "20",
            AVALON_SPEAK_SECONDS: "0.3", AVALON_LADY_SECONDS: "0.3", AVALON_EXCALIBUR_SECONDS: "0.3", AVALON_AI_SPEECH_MS: "20",
        },
        stdio: "ignore",
        windowsHide: true,
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            if ((await health()).ok) return;
        } catch (_) {
            // Still starting.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("server did not become healthy");
});

test.after(() => server?.kill());

test("requests before login and invalid actions get error codes on the request route", async () => {
    const client = await new Client().open();
    const seq = client.send(102, { roomId: "err" });
    const unauthorized = await client.wait(102);
    assert.equal(unauthorized.code, 401);
    assert.equal(unauthorized.seq, seq);

    await client.login("err-user");
    assert.equal((await client.join("bad room!")).code, 400);
    assert.equal((await client.join("err")).code, 0);
    const mark = client.packets.length;
    client.send(501, { approve: true });
    assert.equal((await client.wait(501, () => true, mark)).code, 409);
    client.send(999, {});
    assert.equal((await client.wait(999)).code, 404);

    client.send(104, {});
    assert.equal((await client.wait(104)).code, 0);
    client.send(401, { selectedSeats: [0, 1] });
    assert.equal((await client.wait(401, () => true, mark)).code, 404);
    client.close();
});

test("rooms are isolated, games finish on timeouts, and a finished room starts again", async () => {
    const alice = await new Client().open();
    const bob = await new Client().open();
    await alice.login("alice");
    await bob.login("bob");
    assert.equal((await alice.join("room-a")).code, 0);
    assert.equal((await bob.join("room-b")).code, 0);

    alice.send(103, {});
    const end = await alice.wait(702);
    assert.equal(typeof end.isGoodWin, "boolean");
    assert.equal(end.allRoles.length, 5);
    assert.ok(end.allRoles.every((player) => player.role > 0));
    assert.ok(!bob.packets.some((packet) => packet.route === 301), "room-b must not see room-a's game");
    assert.equal((await health()).rooms, 2);

    const mark = alice.packets.length;
    alice.send(103, {});
    const reset = await alice.wait(302, (payload) => payload.stage === 0, mark);
    assert.equal(reset.round, 1);
    await alice.wait(301, () => true, mark);
    alice.close();
    bob.close();
});

test("a player who drops mid-game can reconnect to the same seat and role", async () => {
    const first = await new Client().open();
    await first.login("carol");
    await first.join("room-c");
    first.send(103, {});
    const identity = await first.wait(303);
    first.close();

    const second = await new Client().open();
    await second.login("carol");
    const joined = await second.join("room-c");
    assert.equal(joined.code, 0);
    assert.ok(joined.room.stage > 0, "game is still in progress or finished");
    if (joined.room.stage < 6) {
        const again = await second.wait(303);
        assert.equal(again.role, identity.role);
        assert.deepEqual(again.visibleSeats, identity.visibleSeats);
    } else {
        await second.wait(702);
    }
    second.close();
});

test("a player cannot hop to another room while their game is running", async () => {
    const client = await new Client().open();
    await client.login("dave");
    await client.join("room-d");
    const mark = client.packets.length;
    client.send(103, {});
    await client.wait(301, () => true, mark);
    const hop = await client.join("room-e");
    if (client.packets.slice(mark).some((packet) => packet.route === 702)) return; // game already over
    assert.equal(hop.code, 409);
    client.close();
});

test("empty lobbies are closed when the last player leaves", async () => {
    const client = await new Client().open();
    await client.login("erin");
    await client.join("room-f");
    const before = (await health()).rooms;
    client.send(104, {});
    await client.wait(104);
    assert.equal((await health()).rooms, before - 1);
    client.close();
});

test("guest login issues a token that resumes the same account and replaces the old connection", async () => {
    const first = await new Client().open();
    const mark = first.packets.length;
    first.send(101, { nickname: "Guest A" });
    const guest = await first.wait(101, () => true, mark);
    assert.equal(guest.code, 0);
    assert.equal(guest.provider, "guest");
    assert.match(guest.userId, /^g_/);
    assert.ok(guest.token && guest.expiresAt > Date.now());
    const closed = new Promise((resolve) => first.socket.once("close", resolve));

    const second = await new Client().open();
    second.send(101, { token: guest.token, userId: "someone-else" });
    const resumed = await second.wait(101);
    assert.equal(resumed.code, 0);
    assert.equal(resumed.provider, "token");
    assert.equal(resumed.userId, guest.userId);
    assert.equal(await closed, 4001, "the older connection is closed");

    const forged = await new Client().open();
    forged.send(101, { token: `${guest.token.slice(0, -2)}xx` });
    assert.equal((await forged.wait(101)).code, 401);
    second.close();
    forged.close();
});

test("login attempts are rate limited per connection", async () => {
    const client = await new Client().open();
    for (let attempt = 0; attempt < 10; attempt += 1) client.send(101, { token: "v1.bad.token" });
    client.send(101, {});
    await client.wait(101, (payload) => payload.code === 429);
    client.close();
});

test("private rooms get a 6-digit code; quick match groups players by table size", async () => {
    const host = await new Client().open();
    const friend = await new Client().open();
    const stranger = await new Client().open();
    await host.login("host");
    await friend.login("friend");
    await stranger.login("stranger");

    host.send(105, { playerCount: 11 });
    assert.equal((await host.wait(105)).code, 400);
    host.send(105, { playerCount: 7 });
    const created = await host.wait(102);
    assert.equal(created.code, 0);
    assert.match(created.room.roomId, /^\d{6}$/);
    assert.equal(created.room.targetPlayers, 7);
    assert.deepEqual(created.room.rules, { lady: true, excalibur: false });

    let mark = friend.packets.length;
    friend.send(102, { roomId: "000000", mustExist: true });
    assert.equal((await friend.wait(102, () => true, mark)).code, 404);
    mark = friend.packets.length;
    friend.send(102, { roomId: created.room.roomId, mustExist: true });
    const joined = await friend.wait(102, () => true, mark);
    assert.equal(joined.code, 0);
    assert.equal(joined.room.players.length, 2);

    // Quick match for 10 players: both land in the same public room, separate from the private one.
    mark = friend.packets.length;
    friend.send(106, { playerCount: 10 });
    const first = await friend.wait(102, () => true, mark);
    stranger.send(106, { playerCount: 10 });
    const second = await stranger.wait(102);
    assert.equal(first.room.roomId, second.room.roomId);
    assert.notEqual(first.room.roomId, created.room.roomId);
    assert.equal(second.room.isPublic, true);
    assert.deepEqual(second.room.rules, { lady: false, excalibur: true });
    for (const client of [host, friend, stranger]) client.close();
});

test("humans take their speech turn and everyone at the table hears it", async () => {
    const first = await new Client().open();
    const second = await new Client().open();
    const one = await first.login("talker-1");
    const two = await second.login("talker-2");
    first.send(105, { playerCount: 5 });
    const { room } = await first.wait(102);
    second.send(102, { roomId: room.roomId, mustExist: true });
    await second.wait(102);

    const mark = first.packets.length;
    first.send(801, { text: "还没开始" });
    assert.equal((await first.wait(801, () => true, mark)).code, 409);
    first.send(103, {});
    second.send(103, {});
    // Whoever is first to get the floor says one line; the other player must receive it.
    const seats = { [one.userId]: first, [two.userId]: second };
    const players = (await first.wait(301)) && (await first.wait(201, (payload) => payload.room.stage === 1)).room.players;
    const seatOwner = new Map(players.map((player) => [player.seatIndex, seats[player.userId]]));
    const turn = await first.wait(804, (payload) => seatOwner.get(payload.speakerSeat) !== undefined, 0, 20000);
    const speaker = seatOwner.get(turn.speakerSeat);
    const listener = speaker === first ? second : first;
    speaker.send(801, { text: "我是好人，这轮我先听听" });
    const heard = await listener.wait(802, (payload) => payload.text === "我是好人，这轮我先听听");
    assert.equal(heard.seat, turn.speakerSeat);
    assert.equal(heard.channel, "all");
    first.close();
    second.close();
});

test("a finished game is recorded: rating pushed, history, replay for participants, leaderboard", async () => {
    const player = await new Client().open();
    const login = await player.login("record-keeper");
    player.send(105, { playerCount: 5 });
    await player.wait(102);
    player.send(103, {});
    const end = await player.wait(702, () => true, 0, 20000);
    const rating = await player.wait(1005, () => true, 0, 5000);
    assert.equal(typeof rating.matchId, "number");
    assert.equal(rating.games, 1);
    assert.equal(rating.delta !== 0, true);
    assert.match(rating.tier, /骑士/);

    let mark = player.packets.length;
    player.send(1001, {});
    const history = await player.wait(1001, () => true, mark);
    assert.equal(history.code, 0);
    assert.equal(history.matches[0].matchId, rating.matchId);
    assert.equal(history.matches[0].reason, end.winReason);

    mark = player.packets.length;
    player.send(1002, { matchId: rating.matchId });
    const detail = await player.wait(1002, () => true, mark);
    assert.equal(detail.code, 0);
    assert.equal(detail.match.players.length, 5);
    assert.ok(detail.match.players.every((seat) => seat.role > 0), "the replay shows every role");
    assert.ok(Array.isArray(detail.match.proposals) && detail.match.proposals.length > 0);

    const outsider = await new Client().open();
    await outsider.login("outsider");
    outsider.send(1002, { matchId: rating.matchId });
    assert.equal((await outsider.wait(1002)).code, 404);

    mark = player.packets.length;
    player.send(1003, {});
    const board = await player.wait(1003, () => true, mark);
    assert.ok(board.top.some((row) => row.userId === login.userId));
    assert.equal(board.me.games, 1);
    mark = player.packets.length;
    player.send(1004, {});
    const stats = await player.wait(1004, () => true, mark);
    assert.equal(stats.rating, rating.rating);
    player.close();
    outsider.close();
});
