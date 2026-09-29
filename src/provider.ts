import {fetchSyncPost} from "siyuan";
import type {SetAIRequestInput, SettingAI, SettingProvider} from "siyuan";
import {
    DEFAULT_PLUGIN_UA,
    findBlockingNonASCII,
    isOpenCodeGoBaseURL,
    newNodeID,
    OPENCODE_GO_BASE_URL,
    PROVIDER_DISPLAY_NAME,
    sanitizeHeaderValue,
    SESSION_HEADER,
    SESSION_VARIABLE,
    USER_AGENT_HEADER,
} from "./opencode";
import type {ApiKeyIssue, LogFn, PluginSettings, UsageTarget} from "./types";

const AGENT_MODEL_PICKER_SELECTOR = ".sy__agentChat .agent-chat__model-picker";
const DEFAULT_REQUEST_TIMEOUT = 120;

/** 供应商自检结果：设置页只读自检区与一键修复共用。 */
export interface ProviderCheck {
    /** 该端点上是否已经有可管理的供应商条目（插件建的，或已存在的同类条目）。 */
    exists: boolean;
    /** 该条目的 id；为空表示这个端点上还没有任何条目。跳转与图标补丁都用它。 */
    providerId: string;
    displayName: string;
    baseURL: string;
    apiKeySet: boolean;
    /** API Key 的可用性问题；`nonAscii` 时 `apiKeyIndex` 指向第一个非法字符。 */
    apiKeyIssue: ApiKeyIssue;
    apiKeyIndex: number;
    /**
     * 存储值里混着空白/零宽字符等杂质。用量请求会先净化再用，所以这里不算故障；
     * 但对话是由内核原样发出去的，带着杂质的 Key 会被上游拒，需要点「立即修复」清理。
     */
    apiKeyDirty: boolean;
    modelCount: number;
    /** 缺失的必需请求头（会自动补齐）。 */
    missing: string[];
    /** 取值与插件期望不同的请求头（不会自动覆盖）。 */
    conflicts: string[];
    /**
     * 记录过供应商 id、但这个端点上已经一条都没有了：说明用户自己删掉了。
     * 插件不会因此自动重建，只用于把提示写得更明白一点。
     */
    dismissed: boolean;
    /** 同样命中官方端点、但不是插件维护的供应商。 */
    foreign: Array<{providerId: string; displayName: string; missing: string[]; conflicts: string[]}>;
}

/** 读取宿主的 AI 配置；`window.siyuan.config` 在保存设置时会被整体替换，所以每次重新取。 */
const readAI = (): SettingAI | null => {
    const config = window.siyuan?.config as unknown as {ai?: SettingAI} | undefined;
    return config?.ai ?? null;
};

const listProviders = (ai: SettingAI): SettingProvider[] =>
    (Array.isArray(ai.providers) ? ai.providers : []).filter((item): item is SettingProvider => !!item);

/** 请求头名大小写不敏感（内核写出去时会做 CanonicalHeaderKey）。 */
const findHeaderKey = (headers: Record<string, string> | undefined, name: string): string | undefined => {
    if (!headers) {
        return undefined;
    }
    const expected = name.toLowerCase();
    return Object.keys(headers).find((key) => key.toLowerCase() === expected);
};

const readHeader = (headers: Record<string, string> | undefined, name: string): string | undefined => {
    const key = findHeaderKey(headers, name);
    return key ? headers[key] : undefined;
};

const writeHeader = (headers: Record<string, string>, name: string, value: string): void => {
    const key = findHeaderKey(headers, name);
    headers[key && key !== name ? key : name] = value;
};

/** 新建供应商条目的初始形态；`id` 直接用合法节点 ID，避免内核 `Normalize` 再分配一个。 */
const newProviderConfig = (headers: Record<string, string>): SettingProvider => ({
    id: newNodeID(),
    displayName: PROVIDER_DISPLAY_NAME,
    enabled: true,
    apiKey: "",
    baseURL: OPENCODE_GO_BASE_URL,
    protocol: "",
    requestTimeout: DEFAULT_REQUEST_TIMEOUT,
    headers: {...headers},
    models: [],
});

/** 当前实际生效的模型 id：面板里的选择器优先，回落到 AI 配置。 */
export const currentModelId = (): string => {
    const domId = document.querySelector<HTMLElement>(AGENT_MODEL_PICKER_SELECTOR)?.dataset.modelId;
    if (domId) {
        return domId;
    }
    return readAI()?.agent?.modelId ?? "";
};

/** 按设置算出要注入的 User-Agent；返回空字符串表示沿用思源内核自己的 UA。 */
export const userAgentOf = (settings: PluginSettings): string => {
    if (settings.userAgentMode === "plugin") {
        return DEFAULT_PLUGIN_UA;
    }
    if (settings.userAgentMode === "custom") {
        return settings.customUserAgent.trim();
    }
    return "";
};

/**
 * 当前选中的模型真正发给上游的 name（思源把上游模型名存在 `name`，`id` 只是本地标识）。
 * 找不到归属时返回空串，调用方自行决定退回什么。
 */
const upstreamModelName = (modelId: string): string => {
    if (!modelId) {
        return "";
    }
    const ai = readAI();
    for (const provider of ai ? listProviders(ai) : []) {
        const model = (provider.models ?? []).find((item) => item?.id === modelId);
        const name = typeof model?.name === "string" ? model.name.trim() : "";
        if (name) {
            return name;
        }
    }
    return "";
};

/**
 * 官方端点上的全部供应商卡片，供图标补丁使用。
 *
 * 刻意按 baseURL 而不是「插件记录过的 id」来解析：用户改名、从别的设备同步过来、
 * 或者干脆自己手建一个同端点供应商时，记录的 id 都可能对不上，而图标属于品牌本身，
 * 只要端点是我们认识的那一个就应当贴上去。这也是「图标有时不显示」的根因所在。
 */
export const officialProviderCards = (): Array<{providerId: string; displayName: string}> => {
    const ai = readAI();
    return (ai ? listProviders(ai) : [])
        .filter((provider) => isOpenCodeGoBaseURL(provider.baseURL))
        .map((provider) => ({
            providerId: provider.id,
            displayName: provider.displayName || PROVIDER_DISPLAY_NAME,
        }));
};

/**
 * 供应商管理器：负责在思源原生 AI 设置页里创建与维护 OpenCode Go 供应商。
 *
 * 原则（与需求约定一致）：
 * - 只在用户显式点「创建供应商」或「立即修复」时动手，运行时绝不自动注入。
 * - 只补缺失字段，不覆盖用户自己改过的取值；要覆盖必须由用户显式点「立即修复」。
 * - 绝不碰模型列表：模型由用户在原生供应商页自己添加，插件只统计数量用于自检。
 * - 写回前必须重新读取实时配置，绝不拿旧快照整体覆盖——那会抹掉用户刚粘贴的 API Key。
 * - 写入走内核原生的 `/api/setting/setAI`，因此该供应商在原生页面里是一个普通条目，
 *   可以被原生地改名、改 key、改模型、删除。
 */
export class ProviderManager {
    constructor(
        private readonly getSettings: () => PluginSettings,
        private readonly patchSettings: (patch: Partial<PluginSettings>) => Promise<void>,
        private readonly log: LogFn,
    ) {
    }

    /** 期望注入的请求头。会话头用变量占位符，由内核在每个请求上解析。 */
    expectedHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            [SESSION_HEADER]: "{{vars." + SESSION_VARIABLE + "}}",
        };
        const userAgent = userAgentOf(this.getSettings());
        if (userAgent) {
            headers[USER_AGENT_HEADER] = userAgent;
        }
        return headers;
    }

    /** 只读自检，不修改任何配置。 */
    inspect(): ProviderCheck {
        const settings = this.getSettings();
        const state = this.readState(settings);
        const owned = state.owned;
        // 本插件在这个端点上实际管理的条目：插件自己建的优先，否则沿用端点上已存在的那个。
        // 设置面板的指引与跳转都以它为准，因此「已存在」不等于「插件建过」。
        const card = owned ?? state.matches[0];
        const expected = this.expectedHeaders();
        const rawApiKey = card?.apiKey ?? "";
        const apiKey = sanitizeHeaderValue(rawApiKey);
        // 位置按用户实际看到的原始取值算，并跳过修复就能清掉的杂质。
        const invalid = findBlockingNonASCII(rawApiKey);
        const foreign = state.matches
            .filter((provider) => provider !== card)
            .map((provider) => ({
                providerId: provider.id,
                displayName: provider.displayName || provider.id,
                ...this.diffHeaders(provider, expected),
            }));
        return {
            exists: !!card,
            providerId: card?.id ?? "",
            displayName: card?.displayName || (card ? PROVIDER_DISPLAY_NAME : ""),
            baseURL: card?.baseURL ?? "",
            apiKeySet: apiKey !== "",
            apiKeyIssue: apiKey === "" ? "missing" : invalid ? "nonAscii" : "ok",
            apiKeyIndex: invalid ? invalid.index : -1,
            apiKeyDirty: rawApiKey !== apiKey,
            modelCount: (card?.models ?? []).filter(Boolean).length,
            ...this.diffHeaders(card, expected),
            dismissed: !card && !!settings.injectedProviderId,
            foreign,
        };
    }

    /** 用量请求目标：baseURL 命中官方端点的供应商，优先「启用 + 有 key + 包含当前模型」。 */
    target(): UsageTarget | undefined {
        const ai = readAI();
        const matches = (ai ? listProviders(ai) : []).filter((provider) => isOpenCodeGoBaseURL(provider.baseURL));
        if (matches.length === 0) {
            return undefined;
        }
        const modelId = currentModelId();
        const toTarget = (provider: SettingProvider): UsageTarget => ({
            providerId: provider.id,
            displayName: provider.displayName || PROVIDER_DISPLAY_NAME,
            baseURL: provider.baseURL,
            apiKey: sanitizeHeaderValue(provider.apiKey ?? ""),
            modelId,
            modelName: upstreamModelName(modelId) || modelId,
        });
        const withKey = matches.filter((provider) =>
            provider.enabled && sanitizeHeaderValue(provider.apiKey ?? "") !== "");
        const exact = withKey.find((provider) =>
            (provider.models ?? []).some((model) => model?.enabled && model.id === modelId));
        return toTarget(exact || withKey[0] || matches[0]);
    }

    /**
     * 当前是否在通过 OpenCode Go 端点对话。按约定只看 baseURL：先看当前模型归属哪个
     * 供应商，找不到归属时回落到「存在启用的官方端点供应商」。
     */
    isInUse(): boolean {
        const ai = readAI();
        const providers = (ai ? listProviders(ai) : [])
            .filter((provider) => provider.enabled && isOpenCodeGoBaseURL(provider.baseURL));
        if (providers.length === 0) {
            return false;
        }
        const modelId = currentModelId();
        if (!modelId) {
            return true;
        }
        const owner = (ai ? listProviders(ai) : [])
            .find((provider) => (provider.models ?? []).some((model) => model?.enabled && model.id === modelId));
        return owner ? isOpenCodeGoBaseURL(owner.baseURL) : true;
    }

    /**
     * 用户显式点「创建供应商」：不存在就创建（已有同端点条目则直接沿用，绝不出重复条目），
     * 只补缺失字段，不覆盖用户已经改过的取值。
     */
    async create(): Promise<ProviderCheck> {
        return this.apply(false);
    }

    /** 用户显式点「立即修复」：可以重建被删掉的供应商，并覆盖冲突字段、清理 Key 里的杂质。 */
    async repair(): Promise<ProviderCheck> {
        return this.apply(true);
    }

    /**
     * 注入流程分两段，避免「读旧快照 → 写回」之间夹进异步操作把用户的改动抹掉：
     * 1. 只读地判断该做什么；
     * 2. 重新读取实时配置，同步地改完，紧接着写回（读与写之间不再有 await）。
     */
    private async apply(force: boolean): Promise<ProviderCheck> {
        const state = this.readState(this.getSettings());
        let provider = state.owned;
        let creating = false;
        if (!provider) {
            // 官方端点上已经有条目（用户自己建的、或从别的设备同步过来的）就直接接管，
            // 绝不插重复条目。
            provider = state.matches[0];
            if (!provider) {
                creating = true;
            } else {
                this.log("provider", "adopted the existing OpenCode Go provider: " + provider.id);
            }
        }
        await this.commit({
            targetId: creating ? "" : (provider?.id ?? ""),
            creating,
            force,
            expected: this.expectedHeaders(),
        });
        return this.inspect();
    }

    /** 重新读取实时配置、同步改写、立即写回。读与写之间不允许出现 await。 */
    private async commit(options: {
        targetId: string;
        creating: boolean;
        force: boolean;
        expected: Record<string, string>;
    }): Promise<void> {
        const settings = this.getSettings();
        const ai = readAI();
        if (!ai) {
            this.log("provider", "AI config is unavailable; skip injection");
            return;
        }
        const providers = listProviders(ai);
        let provider = options.creating
            ? undefined
            : providers.find((item) => item.id === options.targetId);
        if (!provider && !options.creating) {
            // 等待模型列表期间用户把它删掉了：尊重删除，不要复活。
            this.log("provider", "the target provider disappeared; skip writing");
            return;
        }
        let changed = options.creating;
        if (!provider) {
            provider = newProviderConfig(options.expected);
            providers.push(provider);
            ai.providers = providers;
            this.log("provider", "created the OpenCode Go provider");
        }
        if (options.force) {
            provider.baseURL = OPENCODE_GO_BASE_URL;
            provider.enabled = true;
            if (!provider.displayName) {
                provider.displayName = PROVIDER_DISPLAY_NAME;
            }
            if (!provider.requestTimeout || provider.requestTimeout <= 0) {
                provider.requestTimeout = DEFAULT_REQUEST_TIMEOUT;
            }
            // 修 key 里的空白/零宽字符——这类杂质会让请求直接失败。
            const cleaned = sanitizeHeaderValue(provider.apiKey ?? "");
            if (cleaned !== provider.apiKey) {
                provider.apiKey = cleaned;
                changed = true;
            }
        }
        if (!provider.headers || typeof provider.headers !== "object") {
            provider.headers = {};
            changed = true;
        }
        for (const [name, value] of Object.entries(options.expected)) {
            const actual = readHeader(provider.headers, name);
            if (typeof actual === "undefined") {
                writeHeader(provider.headers, name, value);
                changed = true;
            } else if (actual !== value && options.force) {
                writeHeader(provider.headers, name, value);
                changed = true;
            }
        }
        const providerId = provider.id;
        if (changed) {
            await this.writeAI(ai);
        }
        if (providerId && providerId !== settings.injectedProviderId) {
            await this.patchSettings({injectedProviderId: providerId});
        }
    }

    /** 一次性读出后续判断所需的全部状态，避免在多处重复过滤。 */
    private readState(settings: PluginSettings): {
        ai: SettingAI | null;
        providers: SettingProvider[];
        matches: SettingProvider[];
        owned: SettingProvider | undefined;
    } {
        const ai = readAI();
        const providers = ai ? listProviders(ai) : [];
        const matches = providers.filter((provider) => isOpenCodeGoBaseURL(provider.baseURL));
        return {ai, providers, matches, owned: this.findOwned(matches, settings)};
    }

    private diffHeaders(provider: SettingProvider | undefined, expected: Record<string, string>): {
        missing: string[];
        conflicts: string[];
    } {
        const missing: string[] = [];
        const conflicts: string[] = [];
        if (!provider) {
            return {missing: Object.keys(expected), conflicts};
        }
        for (const [name, value] of Object.entries(expected)) {
            const actual = readHeader(provider.headers, name);
            if (typeof actual === "undefined" || actual === "") {
                missing.push(name);
            } else if (actual !== value) {
                conflicts.push(name);
            }
        }
        return {missing, conflicts};
    }

    private findOwned(matches: SettingProvider[], settings: PluginSettings): SettingProvider | undefined {
        const byID = matches.find((provider) => provider.id === settings.injectedProviderId);
        if (byID) {
            return byID;
        }
        if (settings.injectedProviderId) {
            // 记过 id 却找不到 → 用户删掉了；不要再按显示名猜一个「像是我们的」条目。
            return undefined;
        }
        return matches.find((provider) => provider.displayName === PROVIDER_DISPLAY_NAME);
    }

    private async writeAI(ai: SettingAI): Promise<void> {
        const response = await fetchSyncPost("/api/setting/setAI", ai as unknown as SetAIRequestInput);
        if (response.code !== 0) {
            throw new Error(response.msg || "setAI failed");
        }
        const saved = response.data as SettingAI;
        (window.siyuan.config as unknown as {ai: SettingAI}).ai = saved;
        // 与思源自身的 AI 配置保存路径一致，通知智能体面板重新读取模型可用性。
        window.dispatchEvent(new CustomEvent("siyuan-ai-config-changed"));
    }
}
