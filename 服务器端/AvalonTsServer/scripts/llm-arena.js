const fs = require("node:fs");
const path = require("node:path");
const { AvalonRoom } = require("../dist/avalon.room.js");
const { Stage } = require("../dist/avalon.types.js");
const { LlmAgent } = require("../dist/llm/agent.js");
const { providerFromEnv } = require("../dist/llm/provider.js");
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
    const values = { games: "1", players: "5", "llm-seats": "all", seed: "1", out: "logs/arena", speech: "1" };
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
    return { games: integer("games", 1, 100000), players, seed: integer("seed", 0, 0xffffffff), speech: integer("speech", 0, 1), out: values.out,
        seatMapping: requestedSeats.map((requested, actual) => ({ requested, actual })) };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const provider = providerFromEnv();
    const stringify = (value) => JSON.stringify(value, (_key, item) => typeof item === "string" ? provider.redact(item) : item);
    fs.mkdirSync(options.out, { recursive: true });
    const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
    const summary = { goodWins: 0, evilWins: 0, assassinations: 0, assassinationHits: 0, assassinationHitRate: 0,
        llmCalls: 0, fallbacks: 0, tokens: { prompt: 0, completion: 0 }, steps: 0, averageStepMs: 0, seatMapping: options.seatMapping };
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
            const agent = new LlmAgent(provider, { random: seeded(options.seed + game - 1) });
            const llmSeats = new Set(options.seatMapping.map((item) => item.actual));
            for (const { actual } of options.seatMapping) room.join(`llm-${actual}`, `旅人${actual}`);
            for (const player of [...room.players]) room.ready(player.userId, true);
            write({ type: "game", game, seed: options.seed + game - 1, players: options.players, speech: options.speech, seatMapping: options.seatMapping,
                seatNumbering: { seatIndexBase: 0, speechSeatBase: 1, modelSeatBase: 1 },
                actualLlmSeats: [...llmSeats], heuristicSeats: room.players.filter((player) => player.isAi).map((player) => player.seatIndex) });

            const record = (seat, action, decision) => {
                summary.steps += 1;
                totalMs += decision.ms;
                if (decision.provider === "llm") summary.llmCalls += 1;
                if (decision.fallback) summary.fallbacks += 1;
                if (action === "assassinate") summary.assassinations += 1;
                write({ type: "action", step: summary.steps, round: room.round, seat, role: roleNames[room.viewOf(seat).role], action, ...decision });
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
                const run = async (action) => {
                    const decision = await agent[action](room, seat);
                    record(seat, action, decision);
                    return decision.value;
                };
                switch (room.stage) {
                    case Stage.Speaking:
                        if (options.speech) room.chat(userId, await run("speak"));
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
            if (room.outcome.winReason.startsWith("刺客选择了") && !room.outcome.isGoodWin) summary.assassinationHits += 1;
            write({ type: "outcome", ...room.outcome });
        } finally { fs.closeSync(fd); }
    }
    summary.tokens = provider.usage;
    summary.assassinationHitRate = summary.assassinations ? summary.assassinationHits / summary.assassinations : 0;
    summary.averageStepMs = summary.steps ? totalMs / summary.steps : 0;
    console.log(stringify({ type: "summary", ...summary }));
}

main().catch(() => {
    // Paths, environment values, and underlying errors may contain credentials.
    console.error("竞技场运行失败：请检查参数、LLM 配置和日志目录权限。");
    process.exitCode = 1;
});
