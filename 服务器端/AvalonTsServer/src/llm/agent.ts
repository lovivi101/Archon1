import { aiAssassinTarget, aiExcaliburHolder, aiExcaliburTarget, aiLadyTarget, aiMissionCard, aiProposeTeam, aiSpeech, aiVote, Random } from "../avalon.ai";
import { AvalonRoom } from "../avalon.room";
import { Action } from "./prompt";
import { BackendResult, ChatDecisionBackend, DecisionBackend } from "./backend";
import { Provider, Tokens } from "./provider";

export interface Decision<T> {
    /** Seat-valued decisions use internal, zero-based seatIndex values. */
    value: T;
    reason: string;
    fallback: boolean;
    fallbackReason?: string;
    tokens: Tokens;
    ms: number;
    provider: "llm" | "jev" | "heuristic";
    calls?: number;
    confidence?: number;
    probabilities?: Record<string, number>;
}
export interface AgentOptions { random?: Random }

export class LlmAgent {
    private readonly random: Random;
    private readonly provider: DecisionBackend;
    public constructor(provider: Provider | DecisionBackend, options: AgentOptions = {}) {
        this.provider = "decide" in provider ? provider : new ChatDecisionBackend(provider);
        this.random = options.random ?? (() => 0.5);
    }

    public async speak(room: AvalonRoom, seat: number): Promise<Decision<string | null>> { return this.decide<string | null>(room, seat, "speak"); }
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
        const callsBefore = this.provider.calls;
        let metadata: Pick<BackendResult, "confidence" | "probabilities"> = {};
        let value: unknown;
        let reason = "";
        let fallbackReason: string | undefined;
        try {
            const result = await this.provider.decide(room, seat, action);
            value = result.value;
            reason = result.reason;
            if (result.confidence !== undefined) metadata.confidence = result.confidence;
            if (result.probabilities !== undefined) metadata.probabilities = result.probabilities;
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
            tokens: { prompt: after.prompt - before.prompt, completion: after.completion - before.completion }, ms: performance.now() - start,
            provider: this.provider.kind, calls: this.provider.calls - callsBefore, ...metadata };
    }
}
