const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { AuthService } = require("../dist/auth.service.js");
const { RoomError } = require("../dist/avalon.types.js");

const envKeys = ["NODE_ENV", "AVALON_TOKEN_SECRET", "AVALON_ALLOW_LEGACY_LOGIN", "AVALON_TOKEN_TTL_DAYS", "WECHAT_APPID", "WECHAT_SECRET", "WECHAT_API_BASE"];

/** Builds an AuthService under a temporary environment. */
function withEnv(env, build = () => new AuthService()) {
    const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    for (const key of envKeys) delete process.env[key];
    Object.assign(process.env, env);
    try {
        return build();
    } finally {
        for (const key of envKeys) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    }
}

async function rejectsWith(promise, code) {
    await assert.rejects(promise, (error) => error instanceof RoomError && error.code === code);
}

const secret = "x".repeat(32);

test("production refuses to start without a token secret and disables legacy login", async () => {
    assert.throws(() => withEnv({ NODE_ENV: "production" }), /AVALON_TOKEN_SECRET/);
    assert.throws(() => withEnv({ AVALON_TOKEN_SECRET: "short" }), /at least 32/);
    const auth = withEnv({ NODE_ENV: "production", AVALON_TOKEN_SECRET: secret });
    assert.equal(auth.allowLegacy, false);
    await rejectsWith(auth.authenticate({ userId: "alice" }), 401);
    const opted = withEnv({ NODE_ENV: "production", AVALON_TOKEN_SECRET: secret, AVALON_ALLOW_LEGACY_LOGIN: "1" });
    assert.equal(opted.allowLegacy, true);
});

test("guest login creates a new unguessable account; legacy ids cannot claim reserved prefixes", async () => {
    const auth = withEnv({ AVALON_TOKEN_SECRET: secret });
    const first = await auth.authenticate({});
    const second = await auth.authenticate({ guest: true, userId: "ignored" });
    assert.equal(first.provider, "guest");
    assert.match(first.userId, /^g_[0-9a-f]{24}$/);
    assert.notEqual(first.userId, second.userId);
    assert.deepEqual(await auth.authenticate({ userId: "123456" }), { userId: "123456", provider: "legacy" });
    for (const userId of ["g_abc", "wx_abc", "ai-888-1"]) await rejectsWith(auth.authenticate({ userId }), 400);
    await rejectsWith(auth.authenticate({ userId: "has space" }), 400);
});

test("tokens round-trip, and tampered, foreign or expired tokens are rejected", async () => {
    const auth = withEnv({ AVALON_TOKEN_SECRET: secret, AVALON_TOKEN_TTL_DAYS: "1" });
    const { token, expiresAt } = auth.issueToken("g_owner", 1000);
    assert.equal(expiresAt, 1000 + 24 * 3600 * 1000);
    assert.equal(auth.verifyToken(token, 2000), "g_owner");
    assert.equal(auth.verifyToken(token, expiresAt), null, "expired");

    const [version, body, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ u: "g_victim", e: expiresAt }), "utf8").toString("base64url");
    assert.equal(auth.verifyToken(`${version}.${forged}.${signature}`, 2000), null, "body swapped");
    assert.equal(auth.verifyToken(`${version}.${body}.${signature.slice(1)}x`, 2000), null, "bad signature");
    assert.equal(auth.verifyToken("garbage", 2000), null);

    const other = withEnv({ AVALON_TOKEN_SECRET: "y".repeat(32) });
    assert.equal(other.verifyToken(token, 2000), null, "signed with another secret");

    const fresh = auth.issueToken("g_owner");
    assert.deepEqual(await auth.authenticate({ token: fresh.token, userId: "someone-else" }), { userId: "g_owner", provider: "token" });
    await rejectsWith(auth.authenticate({ token: "v1.bad.token" }), 401);
});

test("WeChat login exchanges the code and hides the openid behind a stable hash", async (t) => {
    const requests = [];
    const wechat = http.createServer((request, response) => {
        const url = new URL(request.url, "http://localhost");
        requests.push(url);
        const code = url.searchParams.get("js_code");
        response.setHeader("Content-Type", "text/plain");
        response.end(JSON.stringify(code === "good" ? { openid: "openid-123", session_key: "secret-key" } : { errcode: 40029, errmsg: "invalid code" }));
    });
    await new Promise((resolve) => wechat.listen(0, "127.0.0.1", resolve));
    t.after(() => wechat.close());
    const base = `http://127.0.0.1:${wechat.address().port}`;

    const disabled = withEnv({ AVALON_TOKEN_SECRET: secret });
    await rejectsWith(disabled.authenticate({ wxCode: "good" }), 503);

    const auth = withEnv({ AVALON_TOKEN_SECRET: secret, WECHAT_APPID: "wxapp", WECHAT_SECRET: "wxsecret", WECHAT_API_BASE: base });
    const first = await auth.authenticate({ wxCode: "good" });
    const again = await auth.authenticate({ code: "good" });
    assert.equal(first.provider, "wechat");
    assert.match(first.userId, /^wx_[0-9a-f]{32}$/);
    assert.equal(first.userId, again.userId, "same openid maps to the same account");
    assert.ok(!first.userId.includes("openid-123"));
    assert.equal(requests[0].pathname, "/sns/jscode2session");
    assert.equal(requests[0].searchParams.get("appid"), "wxapp");
    assert.equal(requests[0].searchParams.get("grant_type"), "authorization_code");
    await rejectsWith(auth.authenticate({ wxCode: "bad" }), 401);

    const unreachable = withEnv({ AVALON_TOKEN_SECRET: secret, WECHAT_APPID: "a", WECHAT_SECRET: "b", WECHAT_API_BASE: "http://127.0.0.1:1" });
    await rejectsWith(unreachable.authenticate({ wxCode: "good" }), 503);
});
