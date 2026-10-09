import { aiAssassinTarget, aiExcaliburHolder, aiExcaliburTarget, aiLadyTarget, aiMissionCard, aiProposeTeam, aiSpeech, aiVote, Random } from "../avalon.ai";
import { AvalonRoom } from "../avalon.room";
import { isBadRole } from "../avalon.types";
import { Action, assassinationCandidates, buildPrompt } from "./prompt";
import { Provider, Tokens } from "./provider";

export interface Decision<T> {
    /** Seat-valued decisions use internal, zero-based seatIndex values. */
    value: T;
    reason: string;
    fallback: boolean;
    fallbackReason?: string;
    tokens: Tokens;
    ms: number;
    provider: "llm" | "heuristic";
}
export interface AgentOptions { random?: Random }

export class LlmAgent {
    private readonly random: Random;
    public constructor(private readonly provider: Provider, options: AgentOptions = {}) {
        this.random = options.random ?? (() => 0.5);
    }

    public async speak(room: AvalonRoom, seat: number): Promise<Decision<string>> { return this.decide<string>(room, seat, "speak"); }
    public async propose(room: AvalonRoom, seat: number): Promise<Decision<number[]>> { return this.decide<number[]>(room, seat, "propose"); }
    public async vote(room: AvalonRoom, seat: number): Promise<Decision<boolean>> { return this.decide<boolean>(room, seat, "vote"); }
    public async mission(room: AvalonRoom, seat: number): Promise<Decision<boolean>> { return this.decide<boolean>(room, seat, "mission"); }
    public async assassinate(room: AvalonRoom, seat: number): Promise<Decision<number>> { return this.decide<number>(room, seat, "assassinate"); }

    public excaliburHolder(room: AvalonRoom, seat: number, team: number[]): Decision<number> {
        return this.heuristic(() => aiExcaliburHolder(room.viewOf(seat), team, this.random));
    }
    public excaliburTarget(room: AvalonRoom, seat: number): Decision<number> {
        return this.heuristic(() => aiExcaliburTarget(room.viewOf(seat), room.selectedSeats, room.missionCards.get(seat) === true, this.random));
    }
    public ladyTarget(room: AvalonRoom, seat: number): Decision<number> {
        return this.heuristic(() => aiLadyTarget(room.viewOf(seat), room.ladyEligible(), this.random));
    }
    private heuristic<T>(action: () => T): Decision<T> {
        const start = performance.now();
        return { value: action(), reason: "内置启发式策略", fallback: false, tokens: { prompt: 0, completion: 0 }, ms: performance.now() - start, provider: "heuristic" };
    }

    private async decide<T>(room: AvalonRoom, seat: number, action: Action): Promise<Decision<T>> {
        const view = room.viewOf(seat);
        const start = performance.now();
        const before = this.provider.usage;
        let value: unknown;
        let reason = "";
        let fallbackReason: string | undefined;
        try {
            const response = await this.provider.complete(buildPrompt(room, seat, action));
            let data;
            try { data = JSON.parse(response.content); } catch { throw new Error("模型输出不是合法 JSON"); }
            if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("模型输出必须是 JSON 对象");
            if (action !== "speak" && typeof data.reason !== "string") throw new Error("模型输出缺少 reason 字符串");
            reason = typeof data.reason === "string" ? this.provider.redact(data.reason) : "";
            const validSeat = (target: unknown): target is number => Number.isInteger(target) && Number(target) >= 1 && Number(target) <= view.playerCount;
            switch (action) {
                case "speak":
                    if (typeof data.speech !== "string" || !data.speech.trim()) throw new Error("发言必须是非空字符串");
                    value = this.provider.redact(data.speech).replace(/\s+/g, " ").trim().slice(0, 80);
                    break;
                case "propose":
                    if (!Array.isArray(data.team) || data.team.length !== room.teamSize() || !data.team.every(validSeat) || new Set(data.team).size !== data.team.length) throw new Error("队伍人数或座位非法");
                    value = data.team.map((target: number) => target - 1);
                    break;
                case "vote":
                    if (typeof data.approve !== "boolean") throw new Error("投票必须是布尔值");
                    value = data.approve;
                    break;
                case "mission":
                    if (typeof data.success !== "boolean" || !data.success && !isBadRole(view.role)) throw new Error("任务牌非法：好人不能出失败");
                    value = data.success;
                    break;
                case "assassinate":
                    if (!validSeat(data.target) || !assassinationCandidates(view).includes(data.target - 1)) throw new Error("刺杀目标非法");
                    value = data.target - 1;
                    break;
            }
        } catch (error) {
            // All validation messages are fixed; provider errors are sanitized at their source.
            fallbackReason = this.provider.redact(error instanceof Error ? error.message : "LLM 调用失败");
            reason = "内置 AI 回退";
            switch (action) {
                case "speak": value = aiSpeech(view, { isCaptain: seat === room.captainIdx }, this.random).replace(/\s+/g, " ").trim().slice(0, 80); break;
                case "propose": value = aiProposeTeam(view, room.teamSize(), this.random); break;
                case "vote": value = aiVote(view, room.selectedSeats, this.random); break;
                case "mission": value = aiMissionCard(view, room.selectedSeats, this.random); break;
                case "assassinate": value = aiAssassinTarget(view, this.random); break;
            }
        }
        const after = this.provider.usage;
        return { value: value as T, reason, fallback: fallbackReason !== undefined, ...(fallbackReason === undefined ? {} : { fallbackReason }),
            tokens: { prompt: after.prompt - before.prompt, completion: after.completion - before.completion }, ms: performance.now() - start, provider: "llm" };
    }
}
