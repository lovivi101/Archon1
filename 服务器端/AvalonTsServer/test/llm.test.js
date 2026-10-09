const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { AvalonRoom } = require("../dist/avalon.room.js");
const { Role, Stage, isBadRole } = require("../dist/avalon.types.js");
const { ChatCompletionProvider, providerFromEnv } = require("../dist/llm/provider.js");
const { buildPrompt, normalizeSpeech } = require("../dist/llm/prompt.js");
const { LlmAgent } = require("../dist/llm/agent.js");
const ai = require("../dist/avalon.ai.js");

const fakeKey = "synthetic-llm-test-credential";
const config = { minPlayers: 5, maxPlayers: 10, nightMs: 1, aiDelayMs: 1, aiSpeechMs: 1,
    speakMs: 1e9, proposeMs: 1e9, voteMs: 1e9, missionMs: 1e9, ladyMs: 1e9, excaliburMs: 1e9, assassinMs: 1e9 };
function roomFor(players = 5) {
    const room = new AvalonRoom("llm-test", { config, targetPlayers: players, send: () => {}, clock: () => 0, random: () => 0.999 });
    for (let seat = 0; seat < players; seat += 1) room.join(`h${seat}`, ["灰袍贤者", "北境女王", "林中旅人", "山岭铁卫", "湖畔游侠"][seat] ?? `旅人${seat}`);
    for (const player of room.players) room.ready(player.userId, true);
    return room;
}
function completion(content, usage = { prompt_tokens: 11, completion_tokens: 7 }) {
    return new Response(JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }], usage }), { status: 200 });
}
function providerWith(fetchImpl, overrides = {}) {
    return new ChatCompletionProvider({ baseUrl: "http://127.0.0.1/fake", model: "fake-model", apiKey: fakeKey, ...overrides }, fetchImpl);
}
function agentWith(content) { return new LlmAgent(providerWith(async () => completion(content)), { random: () => 0.5 }); }

test("provider sends compatible JSON requests and totals usage without exposing credentials", async () => {
    const provider = providerWith(async (url, options) => {
        assert.equal(url, "http://127.0.0.1/fake/chat/completions");
        assert.equal(options.method, "POST");
        assert.ok(options.headers.Authorization === `Bearer ${fakeKey}`, "synthetic authorization matches");
        assert.deepEqual(JSON.parse(options.body), { model: "fake-model", messages: [{ role: "user", content: "测试 JSON" }], response_format: { type: "json_object" } });
        return completion({ approve: true, reason: "通过" });
    });
    await provider.complete("测试 JSON");
    await provider.complete("测试 JSON");
    assert.deepEqual(provider.usage, { prompt: 22, completion: 14 });
    const copy = provider.usage;
    copy.prompt = 0;
    assert.equal(provider.usage.prompt, 22);
    assert.equal(JSON.stringify(provider).includes(fakeKey), false);
});

test("all five legal decisions are adopted; speech is single-line and at most 80 characters", async () => {
    const room = roomFor();
    room.selectedSeats = [0, 2];
    const cases = [["speak", 2, { speech: "第一句\n" + "好".repeat(100) }, "第一句 " + "好".repeat(76)],
        ["propose", 2, { team: [1, 3], reason: "组队" }, [0, 2]],
        ["propose", 2, { team: [1, 5], reason: "首尾座位" }, [0, 4]], ["vote", 2, { approve: true, reason: "投票" }, true],
        ["mission", 2, { success: true, reason: "成功" }, true], ["mission", 3, { success: false, reason: "失败" }, false]];
    for (const [action, seat, output, expected] of cases) {
        const decision = await agentWith(output)[action](room, seat);
        assert.equal(decision.fallback, false);
        assert.deepEqual(decision.value, expected);
        assert.deepEqual(decision.tokens, { prompt: 11, completion: 7 });
        assert.ok(decision.ms >= 0);
    }
    room.stage = Stage.Assassinating;
    room.revealedEvil = [3, 4];
    const decision = await agentWith({ target: 1, reason: "公开表现" }).assassinate(room, 3);
    assert.equal(decision.value, 0);
    assert.equal(decision.fallback, false);
});

test("invalid teams, mission cards, targets, booleans and JSON use the corresponding deterministic AI", async () => {
    const room = roomFor();
    room.selectedSeats = [0, 2];
    const cases = [
        ["propose", 2, { team: [1], reason: "人数不足" }, () => ai.aiProposeTeam(room.viewOf(2), 2, () => 0.5)],
        ["propose", 2, { team: [1, 1], reason: "重复" }, () => ai.aiProposeTeam(room.viewOf(2), 2, () => 0.5)],
        ["propose", 2, { team: [1, 6], reason: "越界" }, () => ai.aiProposeTeam(room.viewOf(2), 2, () => 0.5)],
        ["propose", 2, { team: [0, 3], reason: "零号" }, () => ai.aiProposeTeam(room.viewOf(2), 2, () => 0.5)],
        ["propose", 2, { team: [-1, 2], reason: "负数" }, () => ai.aiProposeTeam(room.viewOf(2), 2, () => 0.5)],
        ["propose", 2, { team: [1, "3"], reason: "字符串" }, () => ai.aiProposeTeam(room.viewOf(2), 2, () => 0.5)],
        ["mission", 2, { success: false, reason: "好人失败" }, () => true],
        ["vote", 2, { approve: "true", reason: "类型错误" }, () => ai.aiVote(room.viewOf(2), room.selectedSeats, () => 0.5)],
        ["vote", 2, "{broken", () => ai.aiVote(room.viewOf(2), room.selectedSeats, () => 0.5)],
        ["vote", 2, "null", () => ai.aiVote(room.viewOf(2), room.selectedSeats, () => 0.5)],
        ["speak", 2, { speech: "\n " }, () => ai.aiSpeech(room.viewOf(2), { isCaptain: false }, () => 0.5).replace(/\s+/g, " ").trim().slice(0, 80)],
    ];
    for (const [action, seat, output, expected] of cases) {
        const decision = await agentWith(output)[action](room, seat);
        assert.equal(decision.fallback, true, action);
        assert.ok(decision.fallbackReason);
        assert.deepEqual(decision.value, expected());
    }
    room.stage = Stage.Assassinating;
    room.revealedEvil = [3, 4];
    for (const target of [4, 5, -1, 1.5, "1"]) {
        const decision = await agentWith({ target, reason: "非法刺杀" }).assassinate(room, 3);
        assert.equal(decision.fallback, true);
        assert.equal(decision.value, ai.aiAssassinTarget(room.viewOf(3), () => 0.5));
    }
});

test("one-based assassination targets 0 and playerCount + 1 are rejected before AI fallback", async () => {
    const room = roomFor();
    room.stage = Stage.Assassinating;
    room.revealedEvil = [3, 4];
    for (const target of [0, room.players.length + 1]) {
        const decision = await agentWith({ target, reason: "越界" }).assassinate(room, 3);
        assert.equal(decision.fallback, true);
        assert.equal(decision.fallbackReason, "刺杀目标非法");
        assert.equal(decision.value, ai.aiAssassinTarget(room.viewOf(3), () => 0.5));
    }
});

test("timeout aborts the fetch and falls back even when injected fetch ignores cancellation", async () => {
    let signal;
    const provider = providerWith(async (_url, options) => { signal = options.signal; return new Promise(() => {}); }, { timeoutMs: 10 });
    const decision = await new LlmAgent(provider).vote(roomFor(), 2);
    assert.equal(decision.fallback, true);
    assert.match(decision.fallbackReason, /超时/);
    assert.equal(signal.aborted, true);
    assert.deepEqual(decision.tokens, { prompt: 0, completion: 0 });
});

test("429, 5xx and fetch TypeError retry; other errors fail directly and never echo credentials", async () => {
    for (const kind of [429, 503, "network"]) {
        let calls = 0;
        const provider = providerWith(async () => {
            calls += 1;
            if (calls === 1) {
                if (kind === "network") throw new TypeError(`connection reset Bearer ${fakeKey}`);
                return new Response(fakeKey, { status: kind });
            }
            return completion({ approve: true, reason: "重试成功" });
        });
        const decision = await new LlmAgent(provider).vote(roomFor(), 2);
        assert.equal(calls, 2);
        assert.equal(decision.fallback, false);
    }
    for (const kind of [401, "error", "network"]) {
        let calls = 0;
        const provider = providerWith(async () => {
            calls += 1;
            if (kind === "error") throw new Error(fakeKey);
            if (kind === "network") throw new TypeError(fakeKey);
            return new Response(`Bearer ${fakeKey}`, { status: kind });
        });
        const decision = await new LlmAgent(provider).vote(roomFor(), 2);
        assert.equal(calls, kind === "network" ? 3 : 1);
        assert.equal(decision.fallback, true);
        assert.equal(JSON.stringify(decision).includes(fakeKey), false);
        assert.equal(JSON.stringify(decision).includes("Bearer"), false);
    }
});

test("empty credentials fail locally and key-file / preset overrides work using synthetic files only", async (t) => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return completion({ approve: true, reason: "ok" }); };
    assert.throws(() => providerWith(fetchImpl, { apiKey: " " }), (error) => error.message === "未配置 LLM key" && !error.message.includes("Bearer"));
    assert.throws(() => providerFromEnv({}, fetchImpl), /未配置 LLM key/);
    assert.equal(calls, 0);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "avalon-llm-key-test-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "synthetic.txt");
    for (const content of [fakeKey, `key = ${fakeKey}\n`]) {
        fs.writeFileSync(file, content);
        const provider = providerFromEnv({ AVALON_LLM_KEY_FILE: file }, async (url, options) => {
            assert.equal(url, "https://api.deepseek.com/chat/completions");
            assert.equal(JSON.parse(options.body).model, "deepseek-chat");
            assert.ok(options.headers.Authorization === `Bearer ${fakeKey}`);
            return completion({ approve: true, reason: "ok" });
        });
        await provider.complete("test");
    }
    const override = providerFromEnv({ AVALON_LLM_API_KEY: fakeKey, AVALON_LLM_KEY_FILE: "nonexistent-synthetic-file",
        AVALON_LLM_PROVIDER: "custom", AVALON_LLM_BASE_URL: "http://127.0.0.1/v1/", AVALON_LLM_MODEL: "local" }, async (url, options) => {
        assert.equal(url, "http://127.0.0.1/v1/chat/completions");
        assert.equal(JSON.parse(options.body).model, "local");
        return completion({ approve: true, reason: "ok" });
    });
    await override.complete("test");
    assert.throws(() => providerFromEnv({ AVALON_LLM_KEY_FILE: "nonexistent-synthetic-file" }, fetchImpl), /无法读取 LLM key 文件/);
});

test("model text and malformed responses cannot echo a synthetic credential into decision diagnostics", async () => {
    const decision = await agentWith({ approve: true, reason: `echo ${fakeKey} Bearer another-secret` }).vote(roomFor(), 2);
    assert.equal(decision.fallback, false);
    assert.equal(JSON.stringify(decision).includes(fakeKey), false);
    assert.equal(JSON.stringify(decision).includes("Bearer"), false);
    const provider = providerWith(async () => completion(null));
    const invalid = await new LlmAgent(provider).vote(roomFor(), 2);
    assert.equal(invalid.fallback, true);
    const missing = providerWith(async () => new Response(JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 3 } })));
    const result = await new LlmAgent(missing).vote(roomFor(), 2);
    assert.equal(result.fallback, true);
    assert.deepEqual(result.tokens, { prompt: 5, completion: 3 });
});

test("prompts include rules, full team, votes, mission threshold, private facts and only last 30 public speeches", () => {
    const room = roomFor(7);
    room.round = 4;
    room.selectedSeats = [0, 2, 4, 6];
    room.failedVotes = 2;
    room.missionResults = [true, false, true];
    room.proposals = [{ round: 1, captainSeat: 2, team: [0, 2], votes: [true, false, true, false, true, true, true], passed: true }];
    room.missions = [{ round: 1, team: [0, 2], failCount: 0, success: true }];
    room.facts.set(2, [{ seat: 6, isGood: false }]);
    for (let i = 0; i < 35; i += 1) room.chatLog.push({ seat: 0, nickname: "灰袍贤者", text: `PUBLIC-${i}-END`, channel: "all", round: 1, time: i });
    room.chatLog.push({ seat: 4, nickname: "湖畔游侠", text: "PRIVATE-EVIL", channel: "evil", round: 1, time: 40 });
    const vote = buildPrompt(room, 2, "vote");
    assert.match(vote, /座位号从 1 开始，与游戏界面一致；JSON 里的座位数字也从 1 开始/);
    assert.match(vote, /五轮队伍人数依次为：2、3、3、4、4/);
    assert.match(vote, /当前提案队伍：1号\(灰袍贤者\)、3号\(林中旅人\)、5号\(湖畔游侠\)、7号\(旅人6\)/);
    assert.match(vote, /已连续否决 2 次；好人 2 胜，坏人 1 胜/);
    assert.match(vote, /2号\(北境女王\)反对/);
    assert.match(vote, /队长 3号\(林中旅人\)，队伍 1号\(灰袍贤者\)、3号\(林中旅人\)/);
    assert.match(vote, /失败牌 0 张，任务成功/);
    assert.match(vote, /7号\(旅人6\)为坏人阵营/);
    assert.equal(vote.includes("PUBLIC-4-END"), false);
    assert.equal(vote.includes("PUBLIC-5-END"), true);
    assert.equal((vote.match(/PUBLIC-\d+-END/g) ?? []).length, 30);
    assert.equal(buildPrompt(room, 4, "vote").includes("PRIVATE-EVIL"), false);
    assert.match(buildPrompt(room, 2, "mission"), /本轮需要 2 张失败牌任务才失败/);
});

test("role-specific night explanations match rules and loyal prompts never read other roles", () => {
    const room = roomFor(7);
    assert.match(buildPrompt(room, 0, "vote"), /这些座位是坏人：.*莫德雷德除外，你看不到他/);
    assert.match(buildPrompt(room, 1, "vote"), /这两个座位一个是梅林、一个是莫甘娜，你不知道哪个是哪个/);
    assert.match(buildPrompt(room, 4, "vote"), /这些座位是你的坏人同伴：.*奥伯伦除外，你们互不相识/);
    assert.match(buildPrompt(room, 6, "vote"), /你看不到任何人，其他坏人也不知道你/);
    assert.match(buildPrompt(room, 2, "vote"), /你没有夜晚信息/);
    const original = room.viewOf(2);
    room.viewOf = () => structuredClone(original);
    for (const player of room.players.filter((item) => item.seatIndex !== 2)) Object.defineProperty(player, "role", { get() { throw new Error("hidden role read"); } });
    const prompt = buildPrompt(room, 2, "vote");
    assert.equal(prompt.includes("派西维尔"), false);
    assert.equal(prompt.includes("莫甘娜"), false);
    assert.equal(prompt.includes("奥伯伦"), false);
    assert.equal(prompt.includes("莫德雷德"), false);
    assert.equal(prompt.includes("爪牙"), false);
    // Merlin/Assassin occur in the universal win condition, never assigned to another seat.
    assert.equal((prompt.match(/你的身份：/g) ?? []).length, 1);
    assert.match(prompt, /你的身份：忠臣/);
});

test("assassination prompt includes one-based revealed evil and candidates; AI speech numbers are preserved", () => {
    const room = roomFor(7);
    room.stage = Stage.Assassinating;
    room.revealedEvil = [4, 5, 6];
    const prompt = buildPrompt(room, 4, "assassinate");
    assert.match(prompt, /已亮明的全部其他坏人：6号\(旅人5\)、7号\(旅人6\)/);
    assert.match(prompt, /刺杀候选（排除自己和已知同伴）：1号\(灰袍贤者\)、2号\(北境女王\)、3号\(林中旅人\)、4号\(山岭铁卫\)/);
    assert.ok(prompt.includes('{"target":4,"reason":"..."}'));
    room.players[0].isAi = true;
    room.chatLog.push({ seat: 0, nickname: "灰袍贤者", text: "我带1号、3号", channel: "all", round: 1, time: 0 });
    assert.match(buildPrompt(room, 4, "vote"), /我带1号\(灰袍贤者\)、3号\(林中旅人\)/);
});

test("human speech keeps 3号 pointing to seatIndex 2 and nickname enrichment is idempotent", () => {
    const room = roomFor();
    assert.equal(room.players[0].isAi, false);
    room.chatLog.push({ seat: 0, nickname: "灰袍贤者", text: "我支持3号", channel: "all", round: 1, time: 0 });
    assert.match(buildPrompt(room, 2, "vote"), /第 1 轮 1号\(灰袍贤者\)："我支持3号\(林中旅人\)"/);
    const speech = "1号、3号(林中旅人)、5号，0号、6号";
    const enriched = "1号(灰袍贤者)、3号(林中旅人)、5号(湖畔游侠)，0号、6号";
    assert.equal(normalizeSpeech(room, speech), enriched);
    assert.equal(normalizeSpeech(room, enriched), enriched);
    assert.ok(buildPrompt(room, 2, "propose").includes('{"team":[1,3],"reason":"..."}'));
});

test("pendingSeats and detached viewOf equal internal AI inputs for every seat across all stages", () => {
    for (const count of [5, 7, 10]) {
        const room = roomFor(count);
        room.facts.set(2, [{ seat: 3, isGood: true }]);
        for (const stage of Object.values(Stage).filter((value) => typeof value === "number")) {
            room.stage = stage;
            room.speechOrder = [2, 1, 0];
            room.speakerIndex = 0;
            room.selectedSeats = [1, 2];
            room.votes.set(0, true);
            room.missionCards.set(1, true);
            room.excaliburSeat = 2;
            room.ladyHolder = 1;
            room.revealedEvil = room.players.filter((player) => isBadRole(player.role)).map((player) => player.seatIndex);
            assert.deepEqual(room.pendingSeats(), room.pendingActors().map((player) => player.seatIndex));
            for (const player of room.players) assert.deepEqual(room.viewOf(player.seatIndex), room.viewFor(player));
            const copy = room.viewOf(2);
            copy.visibleSeats.push(99);
            copy.facts[0].isGood = false;
            copy.proposals.push({ round: 1 });
            assert.equal(room.viewOf(2).visibleSeats.includes(99), false);
            assert.equal(room.viewOf(2).facts[0].isGood, true);
            assert.equal(room.proposals.length, 0);
        }
        room.stage = Stage.Night;
        assert.deepEqual(room.viewOf(2).visibleSeats, []);
        assert.equal(room.viewOf(2).role, Role.Servant);
        assert.equal("players" in room.viewOf(2), false);
        assert.throws(() => room.viewOf(-1), /座位不存在/);
        assert.throws(() => room.viewOf(1.5), /座位不存在/);
        assert.throws(() => room.viewOf(count), /座位不存在/);
    }
});

test("Excalibur and Lady decisions use heuristics without calling the provider", () => {
    const room = roomFor(10);
    const agent = new LlmAgent(providerWith(async () => { assert.fail("must not call model"); }), { random: () => 0.5 });
    room.selectedSeats = [0, 2, 3];
    room.missionCards.set(2, true);
    room.ladyHolder = 2;
    for (const decision of [agent.excaliburHolder(room, 0, room.selectedSeats), agent.excaliburTarget(room, 2), agent.ladyTarget(room, 2)]) {
        assert.equal(decision.provider, "heuristic");
        assert.equal(decision.fallback, false);
        assert.deepEqual(decision.tokens, { prompt: 0, completion: 0 });
        assert.ok(Number.isInteger(decision.value));
    }
});

async function runArena(baseUrl, out, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["scripts/llm-arena.js", "--games", "1", "--out", out, ...args], {
            cwd: path.resolve(__dirname, ".."),
            env: { ...process.env, AVALON_LLM_PROVIDER: "deepseek", AVALON_LLM_BASE_URL: baseUrl,
                AVALON_LLM_MODEL: "synthetic-model", AVALON_LLM_API_KEY: fakeKey, AVALON_LLM_KEY_FILE: "" },
            windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        const timer = setTimeout(() => { child.kill(); reject(new Error("arena child timeout")); }, 20000);
        child.stdout.on("data", (chunk) => { output += chunk; });
        child.stderr.on("data", (chunk) => { output += chunk; });
        child.on("error", (error) => { clearTimeout(timer); reject(error); });
        child.on("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
    });
}

test("offline arena subprocesses finish full, mixed, silent, Lady and Excalibur games without key leakage", { timeout: 60000 }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "avalon-llm-arena-"));
    const requests = [];
    const server = http.createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        const prompt = JSON.parse(body).messages[0].content;
        requests.push(prompt);
        const action = prompt.match(/当前动作：(\w+)/)[1];
        const size = Number(prompt.match(/本轮队伍人数：(\d+)/)[1]);
        const candidate = prompt.match(/刺杀候选（排除自己和已知同伴）：(\d+)号/);
        const decisions = { speak: { speech: "我支持3号，会根据公开记录判断。" }, propose: { team: Array.from({ length: size }, (_, i) => i + 1), reason: "公开组队" },
            vote: { approve: true, reason: `echo ${fakeKey}` }, mission: { success: true, reason: "成功" }, assassinate: { target: Number(candidate?.[1] ?? 1), reason: "公开判断" } };
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decisions[action]) } }], usage: { prompt_tokens: 11, completion_tokens: 7 } }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => { await new Promise((resolve) => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    for (const [name, args] of [["all", ["--players", "5"]], ["mixed", ["--players", "5", "--llm-seats", "0,2,4", "--speech", "0"]],
        ["mixed-speaking", ["--players", "5", "--llm-seats", "0,2,4"]],
        ["lady", ["--players", "7", "--speech", "0"]], ["sword", ["--players", "10", "--speech", "0"]]]) {
        const before = requests.length;
        const out = path.join(dir, name);
        const result = await runArena(baseUrl, out, args);
        assert.equal(result.code, 0, "arena exits successfully");
        assert.equal(result.output.includes(fakeKey), false);
        assert.equal(result.output.includes("Bearer"), false);
        const files = fs.readdirSync(out).filter((file) => file.endsWith(".jsonl"));
        assert.equal(files.length, 1);
        const raw = fs.readFileSync(path.join(out, files[0]), "utf8");
        assert.equal(raw.includes(fakeKey), false);
        assert.equal(raw.includes("Bearer"), false);
        const rows = raw.trim().split("\n").map((line) => JSON.parse(line));
        assert.deepEqual(rows[0].seatNumbering, { seatIndexBase: 0, speechSeatBase: 1, modelSeatBase: 1 });
        assert.equal(rows.at(-1).type, "outcome");
        const actions = rows.filter((row) => row.type === "action");
        const summary = JSON.parse(result.output.trim());
        assert.equal(summary.goodWins + summary.evilWins, 1);
        assert.equal(summary.llmCalls, requests.length - before);
        assert.equal(summary.fallbacks, 0);
        assert.deepEqual(summary.tokens, { prompt: summary.llmCalls * 11, completion: summary.llmCalls * 7 });
        assert.equal(summary.steps, actions.length);
        if (name !== "all" && name !== "mixed-speaking") assert.equal(requests.slice(before).some((prompt) => prompt.includes("当前动作：speak")), false);
        if (name === "all" || name === "mixed-speaking") {
            assert.ok(actions.some((row) => row.action === "speak" && row.provider === "llm" && row.value === "我支持3号，会根据公开记录判断。"));
            assert.ok(requests.slice(before).some((prompt) => prompt.includes("我支持3号(旅人2)")));
        }
        for (const row of actions.filter((item) => item.action === "propose" && item.provider === "llm")) {
            assert.deepEqual(row.value, Array.from({ length: row.value.length }, (_, index) => index));
        }
        if (name === "mixed" || name === "mixed-speaking") {
            assert.deepEqual(rows[0].seatMapping, [{ requested: 0, actual: 0 }, { requested: 2, actual: 1 }, { requested: 4, actual: 2 }]);
            assert.deepEqual(rows[0].heuristicSeats, [3, 4]);
            assert.ok(actions.some((row) => row.provider === "heuristic" && row.seat >= 3));
            assert.ok(actions.filter((row) => row.provider === "llm").every((row) => row.seat < 3));
        }
        if (name === "lady") assert.ok(actions.some((row) => row.action === "ladyTarget" && row.provider === "heuristic"));
        if (name === "sword") {
            assert.ok(actions.some((row) => row.action === "excaliburHolder" && row.provider === "heuristic"));
            assert.ok(actions.some((row) => row.action === "excaliburTarget" && row.provider === "heuristic"));
        }
    }
});
