import type {Translate} from "./i18n";
import {DEFAULT_PLUGIN_UA, SESSION_HEADER, USAGE_TIMEOUT_MS, usageURLFrom} from "./opencode";
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
        if (!target.apiKey) {
            return this.fail("noKey");
        }
        const url = usageURLFrom(target.baseURL);
        if (!url) {
            return this.fail("noProvider");
        }
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), USAGE_TIMEOUT_MS);
        try {
            const response = await fetch(url, {
                method: "GET",
                headers: {
                    Authorization: "Bearer " + target.apiKey,
                    Accept: "application/json",
                    // 与其它实现一致：用量请求也带上会话标识，便于上游归因。
                    [SESSION_HEADER]: this.sessionValue() || DEFAULT_PLUGIN_UA,
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

    private fail(kind: UsageFailureKind, status?: number, detail?: string): UsageResult {
        const failure: UsageFailure = {
            kind,
            status,
            detail,
            message: kind === "http"
                ? this.t("usage.error.http", {status: typeof status === "number" ? status : 0})
                : this.t("usage.error." + kind),
        };
        return {ok: false, failure};
    }
}

export type {UsageResult, UsageSnapshot};
