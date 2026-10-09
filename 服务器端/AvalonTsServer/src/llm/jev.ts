import { AvalonRoom } from "../avalon.room";
import { isBadRole } from "../avalon.types";
import { BackendResult, DecisionBackend } from "./backend";
import { Action, assassinationCandidates, buildState, seatLabel } from "./prompt";
import { JsonProvider, keyFromEnv, ProviderConfig } from "./provider";

/** Stop after 256 entries: enough to reject oversize questions without unbounded enumeration. */
function teamChoices(count: number, size: number): number[][] {
    const teams: number[][] = [];
    const visit = (start: number, team: number[]): void => {
        if (teams.length > 255) return;
        if (team.length === size) { teams.push([...team]); return; }
        for (let seat = start; seat <= count - (size - team.length); seat += 1) {
            visit(seat + 1, [...team, seat]);
            if (teams.length > 255) return;
        }
    };
    visit(0, []);
    return teams;
}

export class JevProvider extends JsonProvider implements DecisionBackend {
    public readonly kind = "jev";
    public constructor(config: ProviderConfig, fetchImpl: typeof fetch = fetch) {
        super(config, fetchImpl, "/v1/systemone");
    }

    public async decide(room: AvalonRoom, seat: number, action: Action): Promise<BackendResult> {
        if (action === "speak") return { value: null, reason: "provider has no text output" };
        const view = room.viewOf(seat);
        if (action === "mission" && !isBadRole(view.role)) return { value: true, reason: "好人直接出成功" };
        const choices = new Map<string, { description: string; value: unknown }>();
        let instructions: string;
        switch (action) {
            case "vote":
                instructions = "你是否赞成这支队伍？";
                choices.set("approve", { description: "赞成", value: true });
                choices.set("reject", { description: "反对", value: false });
                break;
            case "mission":
                instructions = "你要提交哪种任务牌？";
                choices.set("success", { description: "成功", value: true });
                choices.set("fail", { description: "失败", value: false });
                break;
            case "assassinate":
                instructions = "你要刺杀哪个候选人？";
                for (const target of assassinationCandidates(view)) choices.set(`seat_${target + 1}`, { description: seatLabel(room, target), value: target });
                break;
            case "propose": {
                instructions = "你要提议哪支队伍？";
                const teams = teamChoices(view.playerCount, room.teamSize());
                if (teams.length > 255) throw new Error("组合过多");
                for (const team of teams) choices.set(`team_${team.map((target) => target + 1).join("_")}`, {
                    description: team.map((target) => seatLabel(room, target)).join("、"), value: team,
                });
                break;
            }
        }
        if (!choices.size) throw new Error("Jev 没有合法候选");
        const criteria = Object.fromEntries([...choices].map(([key, entry]) => [key, entry.description]));
        const { data } = await this.request({ state: buildState(room, seat, action), questions: {
            [action]: { type: "choice", instructions, criteria },
        } }, "input_tokens", "output_tokens");
        const answer = data?.answers?.[action];
        if (answer?.type !== "choice" || typeof answer.choice !== "string" || !choices.has(answer.choice)) throw new Error("Jev 响应缺少有效 choice");
        const probability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
        if (!probability(answer.confidence) || !answer.probabilities || typeof answer.probabilities !== "object" || Array.isArray(answer.probabilities)
            || Object.keys(answer.probabilities).length !== choices.size
            || ![...choices.keys()].every((key) => Object.hasOwn(answer.probabilities, key) && probability(answer.probabilities[key]))) {
            throw new Error("Jev 响应缺少有效 confidence 或 probabilities");
        }
        // Only copy allowlisted choice keys and numbers; arbitrary response text never reaches logs.
        const probabilities = Object.fromEntries([...choices.keys()].map((key) => [key, answer.probabilities[key] as number]));
        return { value: choices.get(answer.choice)!.value, reason: "Jev 类型化决策", confidence: answer.confidence, probabilities };
    }
}

export function jevProviderFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): JevProvider {
    return new JevProvider({ baseUrl: env.AVALON_JEV_BASE_URL || "https://api.typesafe.ai",
        model: env.AVALON_JEV_MODEL || "jev-latest", apiKey: keyFromEnv(env, "AVALON_JEV") }, fetchImpl);
}
