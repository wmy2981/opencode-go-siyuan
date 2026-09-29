import type {Translate} from "./i18n";
import {
    DEFAULT_PLUGIN_UA,
    findBlockingNonASCII,
    findNonASCII,
    sanitizeHeaderValue,
    SESSION_HEADER,
    USAGE_TIMEOUT_MS,
    usageURLFrom,
} from "./opencode";
import type {
    LogFn,
    UsageFailure,
    UsageFailureKind,
    UsageResult,
    UsageSnapshot,
    UsageTarget,
    UsageWindow,
    UsageWindowKey,
} from "./types";

export const USAGE_WINDOW_KEYS: UsageWindowKey[] = ["rolling", "weekly", "monthly"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object";

/**
 * 解析 `GET https://opencode.ai/zen/go/v1/usage` 的响应。
 *
 * 该接口是 OpenCode Go 的第一方实现，但没有写进官方文档、上线当天还改过一次响应形态，
 * 所以这里全部按可选处理：
 * - 缺字段一律当作「未知」，绝不当成 0；
 * - `percent === 0` 时上游给的 `resetsAt` 是「当前时间 + 窗口长度」的占位值，直接丢弃。
 */
export const parseUsage = (payload: unknown): Partial<Record<UsageWindowKey, UsageWindow>> | undefined => {
    if (!isRecord(payload) || !isRecord(payload.usage)) {
        return undefined;
    }
    const usage = payload.usage;
    const windows: Partial<Record<UsageWindowKey, UsageWindow>> = {};
    let hasPercent = false;
    for (const key of USAGE_WINDOW_KEYS) {
        const raw = usage[key];
        if (!isRecord(raw)) {
            continue;
        }
        const window: UsageWindow = {};
        if (typeof raw.percent === "number" && Number.isFinite(raw.percent)) {
            window.percent = Math.max(0, Math.min(100, raw.percent));
            hasPercent = true;
        }
        if (typeof raw.status === "string" && raw.status) {
            window.status = raw.status;
        }
        if (typeof raw.resetsAt === "string" && raw.resetsAt && window.percent !== 0) {
            window.resetsAt = raw.resetsAt;
        }
        windows[key] = window;
    }
    return hasPercent ? windows : undefined;
};

/** 从上游错误体里取一段可读的错误详情，用于「错误详情」区域。 */
export const errorDetailOf = (payload: unknown): string => {
    if (!isRecord(payload)) {
        return "";
    }
    const error = payload.error;
    if (isRecord(error)) {
        const parts = [error.type, error.message].filter((item): item is string =>
            typeof item === "string" && item !== "");
        if (parts.length > 0) {
            return parts.join(": ");
        }
    }
    return typeof payload.msg === "string" ? payload.msg : "";
};

/** 用量查询客户端；key 只在本进程内存里使用，绝不写日志。 */
export class UsageClient {
    constructor(
        private readonly resolveTarget: () => UsageTarget | undefined,
        private readonly sessionValue: () => string,
        private readonly t: Translate,
        private readonly log: LogFn,
    ) {
    }

    async fetch(): Promise<UsageResult> {
        const target = this.resolveTarget();
        if (!target) {
            return this.fail("noProvider");
        }
        // 粘贴来的 Key 常带空白/零宽字符，先净化；净化后仍非 ASCII 就必须明确报出来，
        // 否则 fetch 只会抛一句看不懂的 "String contains non ISO-8859-1 code point"。
        const apiKey = sanitizeHeaderValue(target.apiKey);
        if (!apiKey) {
            return this.fail("noKey");
        }
        const invalid = findBlockingNonASCII(target.apiKey);
        if (invalid) {
            this.log("usage", "API key holds a non ASCII code point at index " + invalid.index);
            return this.fail("badKey", undefined, "U+" + invalid.codePoint.toString(16).toUpperCase(),
                this.t("usage.error.badKey", {index: String(invalid.index + 1)}));
        }
        const url = usageURLFrom(target.baseURL);
        if (!url) {
            return this.fail("noProvider");
        }
        // 会话 ID 只用于上游归因，任何情况下都不能因为它让请求构造失败。
        const session = sanitizeHeaderValue(this.sessionValue());
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), USAGE_TIMEOUT_MS);
        try {
            const response = await fetch(url, {
                method: "GET",
                headers: {
                    Authorization: "Bearer " + apiKey,
                    Accept: "application/json",
                    // 与其它实现一致：用量请求也带上会话标识，便于上游归因。
                    [SESSION_HEADER]: session && !findNonASCII(session) ? session : DEFAULT_PLUGIN_UA,
                },
                signal: controller.signal,
            });
            let payload: unknown;
            try {
                payload = await response.json();
            } catch {
                payload = undefined;
            }
            if (!response.ok) {
                const kind: UsageFailureKind = response.status === 401
                    ? "auth"
                    : response.status === 403
                        ? "entitlement"
                        : "http";
                this.log("usage", "request failed with HTTP " + response.status);
                return this.fail(kind, response.status, errorDetailOf(payload));
            }
            const windows = parseUsage(payload);
            if (!windows) {
                this.log("usage", "response shape is not usable");
                return this.fail("parse", response.status, errorDetailOf(payload));
            }
            return {ok: true, snapshot: {fetchedAt: Date.now(), windows}};
        } catch (error) {
            this.log("usage", "network failure: " + String(error));
            return this.fail("network", undefined, String(error));
        } finally {
            window.clearTimeout(timer);
        }
    }

    private fail(kind: UsageFailureKind, status?: number, detail?: string, message?: string): UsageResult {
        const failure: UsageFailure = {
            kind,
            status,
            detail,
            message: message ?? (kind === "http"
                ? this.t("usage.error.http", {status: typeof status === "number" ? status : 0})
                : this.t("usage.error." + kind)),
        };
        return {ok: false, failure};
    }
}

export type {UsageResult, UsageSnapshot};
