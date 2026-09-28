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
