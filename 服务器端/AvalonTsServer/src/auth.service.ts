import { Injectable, Logger } from "@nestjs/common";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ErrorCode, RoomError } from "./avalon.types";

export type LoginProvider = "token" | "wechat" | "guest" | "legacy";

export interface Identity {
    userId: string;
    provider: LoginProvider;
}

export interface IssuedToken {
    token: string;
    expiresAt: number;
}

/** Prefixes owned by server-issued identities; a self-declared (legacy) userId may not use them. */
const reservedPrefixes = ["wx_", "g_", "ai-"];
const legacyUserIdPattern = /^[\w.@:-]{1,64}$/;

/**
 * Login and session tokens.
 *
 * - `token`: resumes a session issued earlier by this server (HMAC-signed, stateless).
 * - `wxCode`: WeChat mini-game `wx.login()` code, exchanged for the openid via jscode2session.
 * - no credentials / `guest: true`: a new random guest account.
 * - `userId`: legacy self-declared id, only for local development (disabled in production by default).
 *
 * Every successful login returns a fresh token that the client should store and send next time.
 */
@Injectable()
export class AuthService {
    private readonly logger = new Logger(AuthService.name);
    private readonly secret: Buffer;
    private readonly ttlMs: number;
    public readonly allowLegacy: boolean;
    private readonly wechatAppId = process.env.WECHAT_APPID ?? "";
    private readonly wechatSecret = process.env.WECHAT_SECRET ?? "";
    private readonly wechatApiBase = (process.env.WECHAT_API_BASE ?? "https://api.weixin.qq.com").replace(/\/+$/, "");

    public constructor() {
        const production = process.env.NODE_ENV === "production";
        const configured = process.env.AVALON_TOKEN_SECRET ?? "";
        if (configured.length > 0 && configured.length < 32) throw new Error("AVALON_TOKEN_SECRET must be at least 32 characters");
        if (!configured && production) throw new Error("AVALON_TOKEN_SECRET is required in production");
        if (!configured) this.logger.warn("AVALON_TOKEN_SECRET not set; using a random secret, so tokens stop working after a restart.");
        this.secret = configured ? Buffer.from(configured, "utf8") : randomBytes(32);
        this.ttlMs = Math.max(1, Number(process.env.AVALON_TOKEN_TTL_DAYS ?? 30) || 30) * 24 * 3600 * 1000;
        const legacy = process.env.AVALON_ALLOW_LEGACY_LOGIN;
        this.allowLegacy = legacy === undefined || legacy === "" ? !production : legacy === "1" || legacy === "true";
    }

    public get wechatEnabled(): boolean {
        return Boolean(this.wechatAppId && this.wechatSecret);
    }

    public async authenticate(payload: Record<string, any>): Promise<Identity> {
        if (typeof payload.token === "string" && payload.token.length > 0) {
            const userId = this.verifyToken(payload.token);
            if (!userId) throw new RoomError(ErrorCode.Unauthorized, "登录已过期，请重新登录");
            return { userId, provider: "token" };
        }
        const wxCode = payload.wxCode ?? payload.code;
        if (typeof wxCode === "string" && wxCode.length > 0) {
            return { userId: await this.wechatUserId(wxCode), provider: "wechat" };
        }
        const legacyId = String(payload.userId ?? payload.UID ?? payload.uid ?? "").trim();
        if (payload.guest === true || !legacyId) {
            return { userId: `g_${randomBytes(12).toString("hex")}`, provider: "guest" };
        }
        if (!this.allowLegacy) throw new RoomError(ErrorCode.Unauthorized, "请使用微信登录或游客登录");
        if (!legacyUserIdPattern.test(legacyId)) throw new RoomError(ErrorCode.BadRequest, "用户 ID 格式错误");
        if (reservedPrefixes.some((prefix) => legacyId.startsWith(prefix))) throw new RoomError(ErrorCode.BadRequest, "用户 ID 使用了保留前缀");
        return { userId: legacyId, provider: "legacy" };
    }

    public issueToken(userId: string, now = Date.now()): IssuedToken {
        const expiresAt = now + this.ttlMs;
        const body = Buffer.from(JSON.stringify({ u: userId, e: expiresAt }), "utf8").toString("base64url");
        return { token: `v1.${body}.${this.sign(body)}`, expiresAt };
    }

    /** Returns the userId for a valid, unexpired token, otherwise null. */
    public verifyToken(token: string, now = Date.now()): string | null {
        const [version, body, signature] = token.split(".");
        if (version !== "v1" || !body || !signature) return null;
        const expected = Buffer.from(this.sign(body), "utf8");
        const actual = Buffer.from(signature, "utf8");
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
        try {
            const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
            if (typeof data.u !== "string" || typeof data.e !== "number" || data.e <= now) return null;
            return data.u;
        } catch {
            return null;
        }
    }

    private sign(body: string): string {
        return createHmac("sha256", this.secret).update(body).digest("base64url");
    }

    /**
     * Exchanges a wx.login() code for the openid. The openid is hashed into the userId so other
     * players, who see userIds in room snapshots, never learn it. session_key is discarded.
     */
    private async wechatUserId(code: string): Promise<string> {
        if (!this.wechatEnabled) throw new RoomError(ErrorCode.Unavailable, "服务器未配置微信登录");
        if (code.length > 128) throw new RoomError(ErrorCode.BadRequest, "微信登录凭证格式错误");
        const query = new URLSearchParams({ appid: this.wechatAppId, secret: this.wechatSecret, js_code: code, grant_type: "authorization_code" });
        let data: Record<string, any>;
        try {
            const response = await fetch(`${this.wechatApiBase}/sns/jscode2session?${query}`, { signal: AbortSignal.timeout(5000) });
            data = JSON.parse(await response.text());
        } catch (error) {
            this.logger.error({ event: "auth.wechat_unreachable", error: String(error) });
            throw new RoomError(ErrorCode.Unavailable, "微信登录服务暂不可用");
        }
        if (typeof data.openid !== "string" || !data.openid) {
            this.logger.warn({ event: "auth.wechat_rejected", errcode: data.errcode });
            throw new RoomError(ErrorCode.Unauthorized, "微信登录失败，请重试");
        }
        const digest = createHash("sha256").update(`${this.wechatAppId}:${data.openid}`).digest("hex").slice(0, 32);
        return `wx_${digest}`;
    }
}
