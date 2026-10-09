import { AvalonRoom } from "../avalon.room";
import { isBadRole } from "../avalon.types";
import { Action, assassinationCandidates, buildPrompt } from "./prompt";
import { Provider, Tokens } from "./provider";

export interface BackendResult {
    /** Seat-valued results already use internal, zero-based indices. */
    value: unknown;
    reason: string;
    confidence?: number;
    probabilities?: Record<string, number>;
}

export interface DecisionBackend {
    readonly kind: "llm" | "jev";
    readonly usage: Tokens;
    /** Logical requests, excluding HTTP retries and decisions made without a request. */
    readonly calls: number;
    redact(text: string): string;
    decide(room: AvalonRoom, seat: number, action: Action): Promise<BackendResult>;
}

/** Keeps the original complete() provider API usable by existing callers. */
export class ChatDecisionBackend implements DecisionBackend {
    public readonly kind = "llm";
    public calls = 0;
    public constructor(private readonly provider: Provider) {}
    public get usage(): Tokens { return this.provider.usage; }
    public redact(text: string): string { return this.provider.redact(text); }

    public async decide(room: AvalonRoom, seat: number, action: Action): Promise<BackendResult> {
        const view = room.viewOf(seat);
        this.calls += 1;
        const response = await this.provider.complete(buildPrompt(room, seat, action));
        let data;
        try { data = JSON.parse(response.content); } catch { throw new Error("模型输出不是合法 JSON"); }
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("模型输出必须是 JSON 对象");
        if (action !== "speak" && typeof data.reason !== "string") throw new Error("模型输出缺少 reason 字符串");
        const reason = typeof data.reason === "string" ? this.redact(data.reason) : "";
        const validSeat = (target: unknown): target is number => Number.isInteger(target) && Number(target) >= 1 && Number(target) <= view.playerCount;
        let value: unknown;
        switch (action) {
            case "speak":
                if (typeof data.speech !== "string" || !data.speech.trim()) throw new Error("发言必须是非空字符串");
                value = this.redact(data.speech).replace(/\s+/g, " ").trim().slice(0, 80);
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
        return { value, reason };
    }
}
