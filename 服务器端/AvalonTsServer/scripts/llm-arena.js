const fs = require("node:fs");
const path = require("node:path");
const { AvalonRoom } = require("../dist/avalon.room.js");
const { Stage, Role, isBadRole } = require("../dist/avalon.types.js");
const { LlmAgent } = require("../dist/llm/agent.js");
const { providerFromEnv } = require("../dist/llm/provider.js");
const { jevProviderFromEnv } = require("../dist/llm/jev.js");
const { roleNames } = require("../dist/llm/prompt.js");

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

function parseArgs(args) {
    const values = { games: "1", players: "5", "llm-seats": "all", "seat-providers": "", seed: "1", out: "logs/arena", speech: "1" };
    for (let index = 0; index < args.length; index += 2) {
        const name = args[index].slice(2);
        if (!args[index].startsWith("--") || !Object.hasOwn(values, name) || args[index + 1] === undefined) throw new Error("竞技场参数无效");
        values[name] = args[index + 1];
    }
    const integer = (key, min, max) => {
        const value = Number(values[key]);
        if (!/^\d+$/.test(values[key]) || !Number.isSafeInteger(value) || value < min || value > max) throw new Error("竞技场数字参数无效");
        return value;
    };
    const players = integer("players", 5, 10);
    const requestedSeats = values["llm-seats"] === "all" ? Array.from({ length: players }, (_, seat) => seat)
        : /^\d+(,\d+)*$/.test(values["llm-seats"]) ? values["llm-seats"].split(",").map(Number) : [];
    if (!requestedSeats.length || new Set(requestedSeats).size !== requestedSeats.length || requestedSeats.some((seat) => seat >= players)) throw new Error("LLM 座位参数无效，至少指定一个座位");
    const defaultProvider = process.env.AVALON_LLM_PROVIDER || "deepseek";
    if (defaultProvider === "heuristic" || defaultProvider === "jev") throw new Error("请用 --seat-providers 配置 Jev 或 heuristic");
    const providers = Array.from({ length: players }, (_, seat) => requestedSeats.includes(seat) ? defaultProvider : "heuristic");
    const explicit = new Set();
    if (values["seat-providers"]) for (const entry of values["seat-providers"].split(",")) {
        const match = entry.match(/^(\d+):(deepseek|jev|heuristic)$/);
        const seat = Number(match?.[1]) - 1;
        if (!match || seat < 0 || seat >= players || explicit.has(seat)) throw new Error("provider 座位参数无效，座位号从 1 开始且不可重复");
        explicit.add(seat);
        providers[seat] = match[2];
    }
    const order = [...requestedSeats, ...Array.from({ length: players }, (_, seat) => seat).filter((seat) => !requestedSeats.includes(seat))];
    const external = order.filter((seat) => providers[seat] !== "heuristic");
    const actualOrder = [...external, ...providers.map((_, seat) => seat).filter((seat) => providers[seat] === "heuristic")];
    const providerSeatMapping = actualOrder.map((requested, actual) => ({ requested: requested + 1, actual: actual + 1, provider: providers[requested] }));
    return { games: integer("games", 1, 100000), players, seed: integer("seed", 0, 0xffffffff), speech: integer("speech", 0, 1), out: values.out,
        seatMapping: external.map((requested, actual) => ({ requested, actual })), providerSeatMapping };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const providers = new Map();
    for (const { provider: name } of options.providerSeatMapping) {
        if (name === "heuristic" || providers.has(name)) continue;
        providers.set(name, name === "jev" ? jevProviderFromEnv() : providerFromEnv({ ...process.env, AVALON_LLM_PROVIDER: name }));
    }
    const redact = (text) => [...providers.values()].reduce((value, provider) => provider.redact(value), text);
    const stringify = (value) => JSON.stringify(value, (_key, item) => typeof item === "string" ? redact(item) : item);
    fs.mkdirSync(options.out, { recursive: true });
    const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
    const summary = { goodWins: 0, evilWins: 0, assassinations: 0, assassinationHits: 0, assassinationHitRate: 0,
        llmCalls: 0, fallbacks: 0, tokens: { prompt: 0, completion: 0 }, steps: 0, averageStepMs: 0, seatMapping: options.seatMapping,
        providerSeatMapping: options.providerSeatMapping, providerSeatBase: 1, byProvider: Object.fromEntries(
            [...new Set(options.providerSeatMapping.map((item) => item.provider))].map((name) => [name, {
                games: 0, goodGames: 0, goodWins: 0, goodWinRate: 0, evilGames: 0, evilWins: 0, evilWinRate: 0,
                assassinations: 0, assassinationHits: 0, assassinationHitRate: 0, calls: 0, fallbacks: 0, tokens: { prompt: 0, completion: 0 },
            }])) };
    let totalMs = 0;
    for (let game = 1; game <= options.games; game += 1) {
        const file = path.join(options.out, `${stamp}-g${game}.jsonl`);
        // Exclusive create: never overwrite an earlier game log.
        const fd = fs.openSync(file, "wx");
        const write = (entry) => fs.writeSync(fd, `${stringify(entry)}\n`);
        try {
            let now = 0;
            const config = { minPlayers: 5, maxPlayers: 10, nightMs: 1, aiDelayMs: 1, aiSpeechMs: 1,
                speakMs: 1e9, proposeMs: 1e9, voteMs: 1e9, missionMs: 1e9, ladyMs: 1e9, excaliburMs: 1e9, assassinMs: 1e9 };
            const room = new AvalonRoom(`arena-${game}`, { config, send: () => {}, clock: () => now, random: seeded(options.seed + game - 1), targetPlayers: options.players });
            const agents = new Map([...providers].map(([name, provider]) => [name, new LlmAgent(provider, { random: seeded(options.seed + game - 1) })]));
            const llmSeats = new Set(options.seatMapping.map((item) => item.actual));
            for (const { actual } of options.seatMapping) room.join(`llm-${actual}`, `旅人${actual}`);
            // A room needs one ready human to start; hand this bootstrap seat to the built-in AI afterwards.
            if (!llmSeats.size) room.join("bootstrap", "旅人0");
            for (const player of [...room.players]) room.ready(player.userId, true);
            if (!llmSeats.size) room.players[0].isAi = true;
            write({ type: "game", game, seed: options.seed + game - 1, players: options.players, speech: options.speech, seatMapping: options.seatMapping,
                providerSeatMapping: options.providerSeatMapping, providerSeatBase: 1,
                seatNumbering: { seatIndexBase: 0, speechSeatBase: 1, modelSeatBase: 1 },
                actualLlmSeats: [...llmSeats], heuristicSeats: room.players.filter((player) => player.isAi).map((player) => player.seatIndex) });

            const record = (seat, action, decision) => {
                summary.steps += 1;
                totalMs += decision.ms;
                const seatProvider = options.providerSeatMapping[seat].provider;
                const group = summary.byProvider[seatProvider];
                const calls = decision.calls ?? 0;
                summary.llmCalls += calls;
                group.calls += calls;
                if (decision.fallback) summary.fallbacks += 1;
                if (decision.fallback) group.fallbacks += 1;
                group.tokens.prompt += decision.tokens.prompt;
                group.tokens.completion += decision.tokens.completion;
                if (action === "assassinate") summary.assassinations += 1;
                if (action === "assassinate") group.assassinations += 1;
                write({ type: "action", step: summary.steps, round: room.round, seat, seatNumber: seat + 1, seatProvider,
                    role: roleNames[room.viewOf(seat).role], action, ...decision, ...(action === "speak" ? { speech: decision.value } : {}) });
            };

            // Observe AI actions without replacing their decisions or changing the room implementation.
            const methods = { chat: "speak", propose: "propose", vote: "vote", mission: "mission", assassinate: "assassinate", useExcalibur: "excaliburTarget", ladyCheck: "ladyTarget" };
            for (const [method, action] of Object.entries(methods)) {
                const original = room[method].bind(room);
                room[method] = (userId, value, ...rest) => {
                    const player = room.players.find((item) => item.userId === userId);
                    if (!player?.isAi) return original(userId, value, ...rest);
                    const decision = { value,
                        reason: "内置 AI 自动行动", provider: "heuristic", fallback: false, tokens: { prompt: 0, completion: 0 }, ms: 0 };
                    record(player.seatIndex, action, decision);
                    if (method === "propose" && room.rules.excalibur) record(player.seatIndex, "excaliburHolder", { ...decision, value: rest[0] });
                    return original(userId, value, ...rest);
                };
            }

            let steps = 0;
            while (!room.outcome && steps < 10000) {
                steps += 1;
                const seat = room.pendingSeats().find((candidate) => llmSeats.has(candidate));
                if (seat === undefined) { now += 2; room.tick(); continue; }
                const userId = room.players[seat].userId;
                const agent = agents.get(options.providerSeatMapping[seat].provider);
                const run = async (action) => {
                    const decision = await agent[action](room, seat);
                    record(seat, action, decision);
                    return decision.value;
                };
                switch (room.stage) {
                    case Stage.Speaking:
                        if (options.speech || options.providerSeatMapping[seat].provider === "jev") {
                            const speech = await run("speak");
                            if (speech !== null) room.chat(userId, speech);
                        }
                        else record(seat, "skipSpeech", { value: null, reason: "--speech 0", provider: "none", fallback: false, tokens: { prompt: 0, completion: 0 }, ms: 0 });
                        room.endSpeech(userId);
                        break;
                    case Stage.Proposing: {
                        const team = await run("propose");
                        let holder = -1;
                        if (room.rules.excalibur) {
                            const decision = agent.excaliburHolder(room, seat, team);
                            record(seat, "excaliburHolder", decision);
                            holder = decision.value;
                        }
                        room.propose(userId, team, holder);
                        break;
                    }
                    case Stage.Voting: room.vote(userId, await run("vote")); break;
                    case Stage.Mission: room.mission(userId, await run("mission")); break;
                    case Stage.Assassinating: room.assassinate(userId, await run("assassinate")); break;
                    case Stage.Excalibur: {
                        const decision = agent.excaliburTarget(room, seat);
                        record(seat, "excaliburTarget", decision);
                        room.useExcalibur(userId, decision.value);
                        break;
                    }
                    case Stage.LadyOfLake: {
                        const decision = agent.ladyTarget(room, seat);
                        record(seat, "ladyTarget", decision);
                        room.ladyCheck(userId, decision.value);
                        break;
                    }
                    default: throw new Error("竞技场阶段异常");
                }
            }
            if (!room.outcome) throw new Error("竞技场超过总步数上限");
            if (room.outcome.isGoodWin) summary.goodWins += 1;
            else summary.evilWins += 1;
            const hit = room.outcome.winReason.startsWith("刺客选择了") && !room.outcome.isGoodWin;
            if (hit) summary.assassinationHits += 1;
            for (const [name, group] of Object.entries(summary.byProvider)) {
                const seats = room.players.filter((player) => options.providerSeatMapping[player.seatIndex].provider === name);
                group.games += 1;
                if (seats.some((player) => !isBadRole(player.role))) {
                    group.goodGames += 1;
                    if (room.outcome.isGoodWin) group.goodWins += 1;
                }
                if (seats.some((player) => isBadRole(player.role))) {
                    group.evilGames += 1;
                    if (!room.outcome.isGoodWin) group.evilWins += 1;
                }
                if (hit && seats.some((player) => player.role === Role.Assassin)) group.assassinationHits += 1;
            }
            write({ type: "outcome", ...room.outcome });
        } finally { fs.closeSync(fd); }
    }
    for (const provider of providers.values()) {
        summary.tokens.prompt += provider.usage.prompt;
        summary.tokens.completion += provider.usage.completion;
    }
    for (const group of Object.values(summary.byProvider)) {
        group.goodWinRate = group.goodGames ? group.goodWins / group.goodGames : 0;
        group.evilWinRate = group.evilGames ? group.evilWins / group.evilGames : 0;
        group.assassinationHitRate = group.assassinations ? group.assassinationHits / group.assassinations : 0;
    }
    summary.assassinationHitRate = summary.assassinations ? summary.assassinationHits / summary.assassinations : 0;
    summary.averageStepMs = summary.steps ? totalMs / summary.steps : 0;
    console.log(stringify({ type: "summary", ...summary }));
}

main().catch(() => {
    // Paths, environment values, and underlying errors may contain credentials.
    console.error("竞技场运行失败：请检查参数、LLM 配置和日志目录权限。");
    process.exitCode = 1;
});
