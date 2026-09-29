import type {SettingAI, SettingModel, SettingProvider, SettingVariable} from "siyuan";

export type {SettingAI, SettingModel, SettingProvider, SettingVariable};

/** 用量窗口，与 OpenCode Go `/v1/usage` 响应里的三个字段一一对应。 */
export type UsageWindowKey = "rolling" | "weekly" | "monthly";

/**
 * 单个用量窗口。
 * 该接口是上游第一方实现但未文档化、且改过一次响应形态，因此所有字段都按可选处理，
 * 缺字段一律视为「未知」而不是 0。
 */
export interface UsageWindow {
    status?: string;
    percent?: number;
    resetsAt?: string;
}

export interface UsageSnapshot {
    fetchedAt: number;
    windows: Partial<Record<UsageWindowKey, UsageWindow>>;
}

export type UsageFailureKind =
    | "noProvider"
    | "noKey"
    /** Key 里含非 ASCII 字符：JS 的 fetch 会直接拒绝构造请求，必须说清是哪一位。 */
    | "badKey"
    | "auth"
    | "entitlement"
    | "http"
    | "network"
    | "parse";

/** API Key 的可用性：正常 / 未填写 / 含非 ASCII 字符。 */
export type ApiKeyIssue = "ok" | "missing" | "nonAscii";

export interface UsageFailure {
    kind: UsageFailureKind;
    /** 已按当前界面语言本地化的简短描述。 */
    message: string;
    status?: number;
    /** 上游返回的原始错误摘要，用于设置页与详情窗口里的「错误详情」。 */
    detail?: string;
}

export type UsageResult =
    | {ok: true; snapshot: UsageSnapshot}
    | {ok: false; failure: UsageFailure};

/** 显式判别，避免依赖布尔判别式的收窄行为。 */
export const isUsageFailure = (result: UsageResult): result is {ok: false; failure: UsageFailure} =>
    result.ok === false;

/** 用量请求的目标：由 baseURL 命中 OpenCode Go 官方端点的供应商决定。 */
export interface UsageTarget {
    providerId: string;
    displayName: string;
    baseURL: string;
    apiKey: string;
    /** 当前选中的模型 id，仅用于展示与自检。 */
    modelId: string;
}

export type UserAgentMode = "kernel" | "plugin" | "custom";

export interface PluginSettings {
    /** 自动在思源原生 AI 设置页创建并维护 OpenCode Go 供应商。 */
    injectProvider: boolean;
    /** 按会话写入变量，让 `x-opencode-session` 每段对话各不相同。 */
    dynamicSession: boolean;
    /** 关闭按会话发送时使用的固定 ID；留空则自动生成。 */
    staticSessionId: string;
    userAgentMode: UserAgentMode;
    customUserAgent: string;
    /** 在智能体输入框下方显示用量文本。 */
    inlineUsage: boolean;
    refreshIntervalSeconds: number;
    debugLog: boolean;
    /** 插件自己维护的供应商 id；用于在用户改名后仍能稳定识别。 */
    injectedProviderId: string;
}

export type LogFn = (topic: string, message: string) => void;
