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
const { JevProvider, jevProviderFromEnv } = require("../dist/llm/jev.js");
const { buildState } = require("../dist/llm/prompt.js");
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

async function runArena(baseUrl, out, args, extraEnv = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["scripts/llm-arena.js", "--games", "1", "--out", out, ...args], {
            cwd: path.resolve(__dirname, ".."),
            env: { ...process.env, AVALON_LLM_PROVIDER: "deepseek", AVALON_LLM_BASE_URL: baseUrl,
                AVALON_LLM_MODEL: "synthetic-model", AVALON_LLM_API_KEY: fakeKey, AVALON_LLM_KEY_FILE: "",
                AVALON_JEV_BASE_URL: baseUrl, AVALON_JEV_MODEL: "synthetic-jev", AVALON_JEV_API_KEY: "synthetic-jev-credential", AVALON_JEV_KEY_FILE: "", ...extraEnv },
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

function jevAnswer(action, criteria, choice = Object.keys(criteria)[0]) {
    const keys = Object.keys(criteria);
    return { answers: { [action]: { type: "choice", choice, confidence: 0.56,
        probabilities: Object.fromEntries(keys.map((key) => [key, 1 / keys.length])) } }, usage: { input_tokens: 13, output_tokens: 3 } };
}
function jevWith(fetchImpl, overrides = {}) {
    return new JevProvider({ baseUrl: "http://127.0.0.1/fake", apiKey: fakeKey, model: "synthetic-jev", ...overrides }, fetchImpl);
}
async function fakeService(t, handler) {
    const server = http.createServer(async (req, res) => {
        try {
            let body = "";
            for await (const chunk of req) body += chunk;
            const reply = handler(req.url, JSON.parse(body));
            res.statusCode = reply.status ?? 200;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(reply.body ?? reply));
        } catch {
            res.statusCode = 500;
            res.end("fake service failed");
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return `http://127.0.0.1:${server.address().port}`;
}

test("Jev local systemone service maps four decisions, one-based candidates and all valid teams", async (t) => {
    const requests = [];
    const baseUrl = await fakeService(t, (url, body) => {
        requests.push({ url, body });
        const action = Object.keys(body.questions)[0];
        const choice = { vote: "reject", mission: "fail", propose: "team_1_3", assassinate: "seat_1" }[action];
        return jevAnswer(action, body.questions[action].criteria, choice);
    });
    const provider = jevProviderFromEnv({ AVALON_JEV_API_KEY: fakeKey, AVALON_JEV_BASE_URL: `${baseUrl}/` });
    const agent = new LlmAgent(provider);
    const room = roomFor();
    room.selectedSeats = [0, 2];
    for (const [action, seat, expected] of [["vote", 2, false], ["mission", 3, false], ["propose", 2, [0, 2]], ["assassinate", 3, 0]]) {
        if (action === "assassinate") { room.stage = Stage.Assassinating; room.revealedEvil = [3, 4]; }
        const decision = await agent[action](room, seat);
        assert.equal(decision.fallback, false);
        assert.deepEqual(decision.value, expected);
        assert.equal(decision.confidence, 0.56);
        assert.deepEqual(decision.tokens, { prompt: 13, completion: 3 });
        assert.equal(decision.calls, 1);
        const request = requests.at(-1);
        assert.equal(request.url, "/v1/systemone");
        assert.equal(request.body.model, "jev-latest");
        assert.equal(request.body.state, buildState(room, seat, action));
        assert.equal(request.body.state.includes("只返回 JSON"), false);
        assert.equal(request.body.state.includes("JSON 里的座位"), false);
        assert.equal(request.body.questions[action].type, "choice");
        assert.deepEqual(Object.keys(decision.probabilities), Object.keys(request.body.questions[action].criteria));
    }
    assert.deepEqual(requests[0].body.questions.vote.criteria, { approve: "赞成", reject: "反对" });
    assert.deepEqual(requests[1].body.questions.mission.criteria, { success: "成功", fail: "失败" });
    assert.equal(Object.keys(requests[2].body.questions.propose.criteria).length, 10);
    assert.equal(requests[2].body.questions.propose.criteria.team_1_3, "1号(灰袍贤者)、3号(林中旅人)");
    assert.deepEqual(requests[3].body.questions.assassinate.criteria, { seat_1: "1号(灰袍贤者)", seat_2: "2号(北境女王)", seat_3: "3号(林中旅人)" });
    assert.deepEqual(provider.usage, { prompt: 52, completion: 12 });
    for (const [action, expected] of [["mission", true], ["speak", null]]) {
        const decision = await agent[action](room, 2);
        assert.equal(decision.value, expected);
        assert.equal(decision.fallback, false);
        assert.equal(decision.calls, 0);
        assert.deepEqual(decision.tokens, { prompt: 0, completion: 0 });
        if (action === "speak") assert.equal(decision.reason, "provider has no text output");
    }
    assert.equal(requests.length, 4);
});

test("Jev team choices allow 252 and stop over 255 before requesting; fallback matches AI", async () => {
    let requests = 0;
    const provider = jevWith(async (_url, options) => {
        requests += 1;
        const body = JSON.parse(options.body);
        assert.equal(Object.keys(body.questions.propose.criteria).length, 252);
        return new Response(JSON.stringify(jevAnswer("propose", body.questions.propose.criteria)));
    });
    const room = roomFor(10);
    room.round = 5;
    const agent = new LlmAgent(provider, { random: () => 0.5 });
    assert.equal((await agent.propose(room, 2)).fallback, false);
    // Current rules never exceed 252. Inject 11 players only into the backend's candidate enumeration;
    // retain the legal 10-player view captured by Agent so the real fallback AI can still run.
    const view = room.viewOf(2);
    let reads = 0;
    room.viewOf = () => ++reads === 2 ? { ...view, playerCount: 11 } : view;
    const decision = await agent.propose(room, 2);
    assert.equal(decision.fallbackReason, "组合过多");
    assert.equal(decision.fallback, true);
    assert.equal(decision.calls, 0);
    assert.deepEqual(decision.value, ai.aiProposeTeam(room.viewOf(2), 5, () => 0.5));
    assert.equal(requests, 1);
});

test("Jev missing fields and illegal choices fall back to the corresponding AI without response text leakage", async () => {
    const room = roomFor();
    room.selectedSeats = [0, 2];
    room.stage = Stage.Assassinating;
    room.revealedEvil = [3, 4];
    const cases = [["vote", 2, () => ai.aiVote(room.viewOf(2), room.selectedSeats, () => 0.5)],
        ["mission", 3, () => ai.aiMissionCard(room.viewOf(3), room.selectedSeats, () => 0.5)],
        ["propose", 2, () => ai.aiProposeTeam(room.viewOf(2), 2, () => 0.5)],
        ["assassinate", 3, () => ai.aiAssassinTarget(room.viewOf(3), () => 0.5)]];
    for (const [action, seat, expected] of cases) {
        const provider = jevWith(async (_url, options) => {
            const body = JSON.parse(options.body);
            return new Response(JSON.stringify(jevAnswer(action, body.questions[action].criteria, `Bearer ${fakeKey}`)));
        });
        const decision = await new LlmAgent(provider, { random: () => 0.5 })[action](room, seat);
        assert.equal(decision.fallback, true);
        assert.deepEqual(decision.value, expected());
        assert.equal(JSON.stringify(decision).includes(fakeKey), false);
        assert.equal(JSON.stringify(decision).includes("Bearer"), false);
        assert.deepEqual(decision.tokens, { prompt: 13, completion: 3 });
    }
    for (const field of ["answers", "type", "choice", "confidence", "probabilities", "extraProbability", "badProbability"]) {
        const data = jevAnswer("vote", { approve: "赞成", reject: "反对" });
        if (field === "answers") delete data.answers;
        else if (field === "extraProbability") data.answers.vote.probabilities[fakeKey] = 0.2;
        else if (field === "badProbability") data.answers.vote.probabilities.approve = fakeKey;
        else delete data.answers.vote[field];
        const decision = await new LlmAgent(jevWith(async () => new Response(JSON.stringify(data)))).vote(room, 2);
        assert.equal(decision.fallback, true, field);
        assert.equal(JSON.stringify(decision).includes(fakeKey), false);
    }
});

test("Jev 400/422 do not retry; 429/5xx/network retry; timeout and all errors redact credentials", async (t) => {
    for (const status of [400, 422]) {
        let calls = 0;
        const baseUrl = await fakeService(t, () => { calls += 1; return { status, body: { detail: { error_type: "api_usage_error", message: `Bearer ${fakeKey}` } } }; });
        const decision = await new LlmAgent(jevProviderFromEnv({ AVALON_JEV_API_KEY: fakeKey, AVALON_JEV_BASE_URL: baseUrl })).vote(roomFor(), 2);
        assert.equal(calls, 1);
        assert.equal(decision.fallback, true);
        assert.match(decision.fallbackReason, new RegExp(`HTTP ${status}`));
        assert.equal(JSON.stringify(decision).includes(fakeKey), false);
    }
    for (const kind of [429, 503, "network", "exhausted", "error"]) {
        let calls = 0;
        const provider = jevWith(async () => {
            calls += 1;
            if (kind === "error") throw new Error(fakeKey);
            if (kind === "exhausted" || calls === 1 && kind === "network") throw new TypeError(fakeKey);
            if (calls === 1) return new Response(fakeKey, { status: kind });
            return new Response(JSON.stringify(jevAnswer("vote", { approve: "赞成", reject: "反对" })));
        });
        const decision = await new LlmAgent(provider).vote(roomFor(), 2);
        assert.equal(calls, kind === "exhausted" ? 3 : kind === "error" ? 1 : 2);
        assert.equal(decision.calls, 1);
        assert.equal(decision.fallback, kind === "error" || kind === "exhausted");
        assert.equal(JSON.stringify(decision).includes(fakeKey), false);
    }
    let signal;
    const slow = jevWith(async (_url, options) => { signal = options.signal; return new Promise(() => {}); }, { timeoutMs: 15 });
    const decision = await new LlmAgent(slow).vote(roomFor(), 2);
    assert.equal(decision.fallback, true);
    assert.match(decision.fallbackReason, /超时/);
    assert.equal(signal.aborted, true);
});

test("Jev env defaults, overrides and synthetic key files reject empty keys locally", async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "avalon-jev-key-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "synthetic.txt");
    let calls = 0;
    const fetchImpl = async (url, options) => {
        calls += 1;
        assert.equal(url, "https://api.typesafe.ai/v1/systemone");
        assert.equal(JSON.parse(options.body).model, "jev-latest");
        assert.ok(options.headers.Authorization === `Bearer ${fakeKey}`);
        return new Response(JSON.stringify(jevAnswer("vote", { approve: "赞成", reject: "反对" })));
    };
    assert.throws(() => jevProviderFromEnv({}, fetchImpl), /未配置 LLM key/);
    assert.throws(() => jevProviderFromEnv({ AVALON_JEV_API_KEY: " " }, fetchImpl), /未配置 LLM key/);
    assert.throws(() => jevProviderFromEnv({ AVALON_JEV_KEY_FILE: "nonexistent-synthetic-file" }, fetchImpl), /无法读取 LLM key 文件/);
    assert.equal(calls, 0);
    for (const content of [fakeKey, `key = ${fakeKey}\n`]) {
        fs.writeFileSync(file, content);
        const provider = jevProviderFromEnv({ AVALON_JEV_KEY_FILE: file }, fetchImpl);
        await provider.decide(roomFor(), 2, "vote");
        assert.equal(JSON.stringify(provider).includes(fakeKey), false);
        assert.equal(provider.redact(`Bearer ${fakeKey}`).includes(fakeKey), false);
    }
    const override = jevProviderFromEnv({ AVALON_JEV_API_KEY: fakeKey, AVALON_JEV_KEY_FILE: "nonexistent-synthetic-file",
        AVALON_JEV_BASE_URL: "http://127.0.0.1/custom/", AVALON_JEV_MODEL: "override" }, async (url, options) => {
        assert.equal(url, "http://127.0.0.1/custom/v1/systemone");
        assert.equal(JSON.parse(options.body).model, "override");
        return new Response(JSON.stringify(jevAnswer("vote", { approve: "赞成", reject: "反对" })));
    });
    await override.decide(roomFor(), 2, "vote");
});

test("Jev state shares legal information without reading hidden roles or including private chat", () => {
    const room = roomFor(7);
    room.chatLog.push({ seat: 4, nickname: "湖畔游侠", text: "PRIVATE-EVIL", channel: "evil", round: 1, time: 0 });
    const view = room.viewOf(2);
    room.viewOf = () => structuredClone(view);
    for (const player of room.players.filter((item) => item.seatIndex !== 2)) Object.defineProperty(player, "role", { get() { throw new Error("hidden role read"); } });
    const state = buildState(room, 2, "vote");
    assert.match(state, /你的身份：忠臣/);
    assert.equal(state.includes("PRIVATE-EVIL"), false);
    assert.equal(state.includes("只返回 JSON"), false);
    assert.equal(state.includes("派西维尔"), false);
});

test("five-player Chat + Jev + heuristic arena logs probabilities, null speech, actual seats and provider statistics", { timeout: 60000 }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "avalon-jev-arena-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const requests = [];
    const baseUrl = await fakeService(t, (url, body) => {
        requests.push({ url, body });
        if (url === "/v1/systemone") {
            const action = Object.keys(body.questions)[0];
            return jevAnswer(action, body.questions[action].criteria);
        }
        const prompt = body.messages[0].content;
        const action = prompt.match(/当前动作：(\w+)/)[1];
        const size = Number(prompt.match(/本轮队伍人数：(\d+)/)[1]);
        const target = Number(prompt.match(/刺杀候选（排除自己和已知同伴）：(\d+)号/)?.[1] ?? 1);
        const decisions = { speak: { speech: "我支持3号。" }, propose: { team: Array.from({ length: size }, (_, index) => index + 1), reason: "组队" },
            vote: { approve: true, reason: `Bearer ${fakeKey} synthetic-jev-credential` }, mission: { success: true, reason: "成功" }, assassinate: { target, reason: "刺杀" } };
        return { choices: [{ message: { content: JSON.stringify(decisions[action]) } }], usage: { prompt_tokens: 11, completion_tokens: 7 } };
    });
    for (const [name, args] of [
        ["mixed", ["--seat-providers", "1:deepseek,2:jev,3:heuristic,4:jev,5:deepseek"]],
        ["partial", ["--llm-seats", "0,2,4", "--seat-providers", "2:jev,3:heuristic"]],
        ["all-heuristic", ["--seat-providers", "1:heuristic,2:heuristic,3:heuristic,4:heuristic,5:heuristic"]],
        ["all-jev", ["--seat-providers", "1:jev,2:jev,3:jev,4:jev,5:jev", "--speech", "0"]],
    ]) {
        const before = requests.length;
        const out = path.join(dir, name);
        const result = await runArena(baseUrl, out, ["--players", "5", ...args], name === "all-heuristic"
            ? { AVALON_LLM_API_KEY: "", AVALON_JEV_API_KEY: "" } : name === "all-jev" ? { AVALON_LLM_API_KEY: "" } : {});
        assert.equal(result.code, 0, result.output);
        const summary = JSON.parse(result.output.trim());
        const raw = fs.readFileSync(path.join(out, fs.readdirSync(out).find((file) => file.endsWith(".jsonl"))), "utf8");
        for (const credential of [fakeKey, "synthetic-jev-credential", "Bearer"]) assert.equal((result.output + raw).includes(credential), false);
        const rows = raw.trim().split("\n").map(JSON.parse);
        assert.equal(rows.at(-1).type, "outcome");
        assert.deepEqual(rows[0].providerSeatMapping, summary.providerSeatMapping);
        assert.equal(summary.providerSeatBase, 1);
        assert.equal(summary.llmCalls, requests.length - before);
        assert.equal(summary.fallbacks, 0);
        const actions = rows.filter((row) => row.type === "action");
        const jev = actions.filter((row) => row.provider === "jev");
        if (name !== "all-heuristic") {
            assert.ok(jev.some((row) => row.action === "speak" && row.speech === null && row.reason === "provider has no text output" && row.calls === 0));
            assert.ok(jev.some((row) => row.action === "vote" && row.confidence === 0.56 && row.probabilities.approve === 0.5));
        }
        for (const [provider, group] of Object.entries(summary.byProvider)) {
            const own = actions.filter((row) => row.seatProvider === provider);
            assert.equal(group.games, 1);
            assert.equal(group.calls, own.reduce((count, row) => count + (row.calls ?? 0), 0));
            assert.deepEqual(group.tokens, own.reduce((tokens, row) => ({ prompt: tokens.prompt + row.tokens.prompt, completion: tokens.completion + row.tokens.completion }), { prompt: 0, completion: 0 }));
            assert.equal(group.assassinations, own.filter((row) => row.action === "assassinate").length);
            assert.equal(group.goodGames, Number(own.some((row) => ["梅林", "派西维尔", "忠臣"].includes(row.role))));
            assert.equal(group.evilGames, Number(own.some((row) => ["刺客", "莫甘娜"].includes(row.role))));
            assert.equal(group.goodWins, group.goodGames * summary.goodWins);
            assert.equal(group.evilWins, group.evilGames * summary.evilWins);
            assert.equal(group.goodWinRate, group.goodGames ? group.goodWins / group.goodGames : 0);
            assert.equal(group.evilWinRate, group.evilGames ? group.evilWins / group.evilGames : 0);
            assert.equal(group.assassinationHits, group.assassinations ? summary.assassinationHits : 0);
        }
        assert.deepEqual(summary.tokens, Object.values(summary.byProvider).reduce((tokens, group) => ({ prompt: tokens.prompt + group.tokens.prompt, completion: tokens.completion + group.tokens.completion }), { prompt: 0, completion: 0 }));
        if (name === "mixed") {
            assert.deepEqual(summary.providerSeatMapping, [
                { requested: 1, actual: 1, provider: "deepseek" }, { requested: 2, actual: 2, provider: "jev" },
                { requested: 4, actual: 3, provider: "jev" }, { requested: 5, actual: 4, provider: "deepseek" }, { requested: 3, actual: 5, provider: "heuristic" },
            ]);
            t.diagnostic(`synthetic mixed summary: ${JSON.stringify({ ...summary, averageStepMs: undefined })}`);
        }
        if (name === "partial") assert.deepEqual(summary.providerSeatMapping, [
            { requested: 1, actual: 1, provider: "deepseek" }, { requested: 5, actual: 2, provider: "deepseek" },
            { requested: 2, actual: 3, provider: "jev" }, { requested: 3, actual: 4, provider: "heuristic" }, { requested: 4, actual: 5, provider: "heuristic" },
        ]);
    }
    for (const bad of ["0:jev", "6:jev", "1:jev,1:deepseek", "1:unknown"]) {
        const before = requests.length;
        const result = await runArena(baseUrl, path.join(dir, "invalid"), ["--seat-providers", bad]);
        assert.equal(result.code, 1);
        assert.equal(requests.length, before);
    }
});
