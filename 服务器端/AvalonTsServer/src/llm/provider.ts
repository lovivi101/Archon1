import { readFileSync } from "node:fs";

export interface Tokens { prompt: number; completion: number }
export interface ProviderConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
    timeoutMs?: number;
    maxRetries?: number;
}
export interface Completion { content: string; tokens: Tokens }
export interface Provider {
    complete(prompt: string): Promise<Completion>;
    readonly usage: Tokens;
    redact(text: string): string;
}

export const presets = { deepseek: { baseUrl: "https://api.deepseek.com", model: "deepseek-chat" } };

class RequestError extends Error {
    public constructor(message: string, public readonly retryable = false) { super(message); }
}

/** Never expose transport errors, response bodies or credentials in diagnostics. */
export class JsonProvider {
    readonly #key: string;
    readonly #fetch: typeof fetch;
    readonly #url: string;
    readonly #model: string;
    readonly #timeoutMs: number;
    readonly #maxRetries: number;
    readonly #usage: Tokens = { prompt: 0, completion: 0 };
    #calls = 0;

    public constructor(config: ProviderConfig, fetchImpl: typeof fetch = fetch, endpoint = "/chat/completions") {
        this.#key = config.apiKey.trim();
        if (!this.#key) throw new Error("未配置 LLM key");
        this.#fetch = fetchImpl;
        this.#url = `${config.baseUrl.replace(/\/+$/, "")}${endpoint}`;
        this.#model = config.model;
        this.#timeoutMs = config.timeoutMs ?? 20000;
        this.#maxRetries = config.maxRetries ?? 2;
        if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0
            || !Number.isInteger(this.#maxRetries) || this.#maxRetries < 0) throw new Error("LLM 超时或重试配置无效");
    }

    public get usage(): Tokens { return { ...this.#usage }; }
    public get calls(): number { return this.#calls; }

    public redact(text: string): string {
        return text.replace(/Bearer\s+[^\s"'<>]+/gi, "[已隐藏凭据]").split(this.#key).join("[已隐藏凭据]");
    }

    protected async request(body: Record<string, unknown>, inputTokenField: string, outputTokenField: string): Promise<{ data: any; tokens: Tokens }> {
        this.#calls += 1;
        for (let attempt = 0; ; attempt += 1) {
            const controller = new AbortController();
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const timeout = new Promise<never>((_, reject) => {
                    timer = setTimeout(() => {
                        controller.abort();
                        reject(new RequestError("LLM 请求超时"));
                    }, this.#timeoutMs);
                });
                const request = async (): Promise<{ data: any; tokens: Tokens }> => {
                    const response = await this.#fetch(this.#url, {
                        method: "POST",
                        redirect: "error",
                        headers: { Authorization: `Bearer ${this.#key}`, "Content-Type": "application/json" },
                        body: JSON.stringify({ ...body, model: this.#model }),
                        signal: controller.signal,
                    });
                    if (!response.ok) {
                        void response.body?.cancel().catch(() => {});
                        throw new RequestError(`LLM HTTP ${response.status}`, response.status === 429 || response.status >= 500 && response.status <= 599);
                    }
                    let data;
                    try { data = await response.json(); } catch { throw new RequestError("LLM 响应不是 JSON"); }
                    const count = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
                    const tokens = { prompt: count(data?.usage?.[inputTokenField]), completion: count(data?.usage?.[outputTokenField]) };
                    if (controller.signal.aborted) throw new RequestError("LLM 请求超时");
                    this.#usage.prompt += tokens.prompt;
                    this.#usage.completion += tokens.completion;
                    return { data, tokens };
                };
                return await Promise.race([request(), timeout]);
            } catch (error) {
                const safe = controller.signal.aborted ? new RequestError("LLM 请求超时")
                    : error instanceof RequestError ? error
                    : error instanceof TypeError ? new RequestError("LLM 网络错误", true)
                    : new RequestError("LLM 请求失败");
                if (!safe.retryable || attempt >= this.#maxRetries) throw safe;
            } finally {
                if (timer !== undefined) clearTimeout(timer);
            }
            await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
        }
    }
}

export class ChatCompletionProvider extends JsonProvider implements Provider {
    public async complete(prompt: string): Promise<Completion> {
        const { data, tokens } = await this.request({ messages: [{ role: "user", content: prompt }], response_format: { type: "json_object" } }, "prompt_tokens", "completion_tokens");
        if (typeof data?.choices?.[0]?.message?.content !== "string") throw new RequestError("LLM 响应缺少文本");
        return { content: this.redact(data.choices[0].message.content), tokens };
    }
}

export function keyFromEnv(env: NodeJS.ProcessEnv, prefix: string): string {
    let apiKey = env[`${prefix}_API_KEY`]?.trim() ?? "";
    if (!apiKey && env[`${prefix}_KEY_FILE`]) {
        let file;
        try { file = readFileSync(env[`${prefix}_KEY_FILE`]!, "utf8").trim(); }
        catch { throw new Error("无法读取 LLM key 文件"); }
        apiKey = file.replace(/^key\s*=\s*/i, "").trim();
    }
    return apiKey;
}

export function providerFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): ChatCompletionProvider {
    const name = env.AVALON_LLM_PROVIDER ?? "deepseek";
    const preset = name === "deepseek" ? presets.deepseek : undefined;
    const baseUrl = env.AVALON_LLM_BASE_URL || preset?.baseUrl;
    const model = env.AVALON_LLM_MODEL || preset?.model;
    if (!baseUrl || !model) throw new Error("未知 LLM provider，请配置 BASE_URL 和 MODEL");
    const apiKey = keyFromEnv(env, "AVALON_LLM");
    return new ChatCompletionProvider({ baseUrl, model, apiKey }, fetchImpl);
}
