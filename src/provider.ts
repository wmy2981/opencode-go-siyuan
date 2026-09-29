import {fetchSyncPost} from "siyuan";
import type {SetAIRequestInput, SettingAI, SettingModel, SettingProvider, SettingProviderInput} from "siyuan";
import {
    DEFAULT_PLUGIN_UA,
    isOpenCodeGoBaseURL,
    newNodeID,
    OPENCODE_GO_BASE_URL,
    PROVIDER_DISPLAY_NAME,
    SESSION_HEADER,
    SESSION_VARIABLE,
    USER_AGENT_HEADER,
} from "./opencode";
import type {LogFn, PluginSettings, UsageTarget} from "./types";

const AGENT_MODEL_PICKER_SELECTOR = ".sy__agentChat .agent-chat__model-picker";
const DEFAULT_REQUEST_TIMEOUT = 120;

/** 供应商自检结果：设置页只读自检区与一键修复共用。 */
export interface ProviderCheck {
    /** 插件自己维护的供应商是否存在。 */
    exists: boolean;
    providerId: string;
    displayName: string;
    baseURL: string;
    apiKeySet: boolean;
    modelCount: number;
    /** 缺失的必需请求头（会自动补齐）。 */
    missing: string[];
    /** 取值与插件期望不同的请求头（不会自动覆盖）。 */
    conflicts: string[];
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
 * 供应商管理器：负责在思源原生 AI 设置页里创建与维护 OpenCode Go 供应商。
 *
 * 原则（与需求约定一致）：
 * - 只补缺失字段，不覆盖用户自己改过的取值；要覆盖必须由用户显式点「一键修复」。
 * - 写入走内核原生的 `/api/setting/setAI`，因此该供应商在原生页面里是一个普通条目，
 *   可以被原生地改名、改 key、删模型、删除。
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
        const ai = readAI();
        const providers = ai ? listProviders(ai) : [];
        const matches = providers.filter((provider) => isOpenCodeGoBaseURL(provider.baseURL));
        const owned = this.findOwned(matches, settings);
        const expected = this.expectedHeaders();
        const foreign = matches
            .filter((provider) => provider !== owned)
            .map((provider) => ({
                providerId: provider.id,
                displayName: provider.displayName || provider.id,
                ...this.diffHeaders(provider, expected),
            }));
        return {
            exists: !!owned,
            providerId: owned?.id ?? "",
            displayName: owned?.displayName || (owned ? PROVIDER_DISPLAY_NAME : ""),
            baseURL: owned?.baseURL ?? "",
            apiKeySet: !!owned?.apiKey?.trim(),
            modelCount: (owned?.models ?? []).filter(Boolean).length,
            ...this.diffHeaders(owned, expected),
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
            apiKey: typeof provider.apiKey === "string" ? provider.apiKey.trim() : "",
            modelId,
        });
        const withKey = matches.filter((provider) => provider.enabled && !!provider.apiKey?.trim());
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

    /** 确保供应商存在并补齐缺失字段（不覆盖已有取值）。 */
    async ensure(): Promise<ProviderCheck> {
        return this.apply(false);
    }

    /** 用户显式点击「一键修复」：缺失补齐 + 冲突覆盖。 */
    async repair(): Promise<ProviderCheck> {
        return this.apply(true);
    }

    /** 通过思源原生的模型列表接口刷新模型；返回模型数量。 */
    async refreshModels(): Promise<number> {
        const ai = readAI();
        if (!ai) {
            return 0;
        }
        const providers = listProviders(ai);
        const provider = this.findOwned(providers, this.getSettings()) ||
            providers.find((item) => isOpenCodeGoBaseURL(item.baseURL));
        if (!provider) {
            return 0;
        }
        const models = await this.fetchModels(provider);
        if (!models || models.length === 0) {
            return 0;
        }
        provider.models = models;
        await this.writeAI(ai);
        return models.length;
    }

    private async apply(force: boolean): Promise<ProviderCheck> {
        const settings = this.getSettings();
        const ai = readAI();
        if (!ai) {
            this.log("provider", "AI config is unavailable; skip injection");
            return this.inspect();
        }
        const providers = listProviders(ai);
        const expected = this.expectedHeaders();
        let provider = this.findOwned(providers, settings);
        let changed = false;
        if (!provider && (settings.injectProvider || force)) {
            provider = {
                id: newNodeID(),
                displayName: PROVIDER_DISPLAY_NAME,
                enabled: true,
                apiKey: "",
                baseURL: OPENCODE_GO_BASE_URL,
                protocol: "",
                requestTimeout: DEFAULT_REQUEST_TIMEOUT,
                headers: {},
                models: [],
            };
            providers.push(provider);
            ai.providers = providers;
            changed = true;
            this.log("provider", "created the OpenCode Go provider");
        }
        if (!provider) {
            return this.inspect();
        }
        if (force) {
            provider.baseURL = OPENCODE_GO_BASE_URL;
            provider.enabled = true;
            if (!provider.displayName) {
                provider.displayName = PROVIDER_DISPLAY_NAME;
            }
            if (!provider.requestTimeout || provider.requestTimeout <= 0) {
                provider.requestTimeout = DEFAULT_REQUEST_TIMEOUT;
            }
        }
        if (!provider.headers || typeof provider.headers !== "object") {
            provider.headers = {};
            changed = true;
        }
        for (const [name, value] of Object.entries(expected)) {
            const actual = readHeader(provider.headers, name);
            if (typeof actual === "undefined") {
                writeHeader(provider.headers, name, value);
                changed = true;
            } else if (actual !== value && force) {
                writeHeader(provider.headers, name, value);
                changed = true;
            }
        }
        const modelCount = (provider.models ?? []).filter(Boolean).length;
        if (modelCount === 0) {
            const models = await this.fetchModels(provider);
            if (models && models.length > 0) {
                provider.models = models;
                changed = true;
            }
        }
        if (changed) {
            await this.writeAI(ai);
        }
        if (provider.id && provider.id !== settings.injectedProviderId) {
            await this.patchSettings({injectedProviderId: provider.id});
        }
        return this.inspect();
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
            return undefined;
        }
        return matches.find((provider) => provider.displayName === PROVIDER_DISPLAY_NAME);
    }

    /**
     * 调内核原生的 `/api/ai/listModels`。
     * 注意返回结构是「模型名字符串数组 + contextLengths 映射」，与思源自带的
     * 「获取模型列表」按钮完全一致（`aiProviderUi.ts` 里也是这么解析的）。
     */
    private async fetchModels(provider: SettingProvider): Promise<SettingModel[] | undefined> {
        try {
            const response = await fetchSyncPost("/api/ai/listModels", {
                providerConfig: provider as unknown as SettingProviderInput,
            });
            if (response.code !== 0) {
                this.log("provider", "list models failed: " + response.msg);
                return undefined;
            }
            const data = response.data as {
                models?: Array<string | null> | null;
                contextLengths?: Record<string, number> | null;
                msg?: string;
            };
            const names = (Array.isArray(data.models) ? data.models : [])
                .filter((name): name is string => typeof name === "string" && name.trim() !== "")
                .map((name) => name.trim());
            if (names.length === 0) {
                this.log("provider", "list models returned nothing: " + (data.msg || ""));
                return undefined;
            }
            const lengths = data.contextLengths && typeof data.contextLengths === "object" ? data.contextLengths : {};
            return names.map((name) => {
                const model: SettingModel = {id: "", enabled: true, name, displayName: ""};
                const byName = lengths[name];
                const byLower = lengths[name.toLowerCase()];
                const contextLength = typeof byName === "number" ? byName : byLower;
                if (typeof contextLength === "number" && Number.isSafeInteger(contextLength) && contextLength > 0) {
                    model.contextLength = contextLength;
                }
                return model;
            });
        } catch (error) {
            this.log("provider", "list models threw: " + String(error));
            return undefined;
        }
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
