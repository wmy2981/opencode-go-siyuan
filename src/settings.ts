import type {Plugin} from "siyuan";
import type {PluginSettings, UserAgentMode} from "./types";

const STORAGE_NAME = "settings";

export const MIN_REFRESH_SECONDS = 30;
export const MAX_REFRESH_SECONDS = 3600;
export const DEFAULT_REFRESH_SECONDS = 300;

export const DEFAULT_SETTINGS: PluginSettings = {
    injectProvider: true,
    dynamicSession: true,
    staticSessionId: "",
    userAgentMode: "kernel",
    customUserAgent: "",
    inlineUsage: true,
    refreshIntervalSeconds: DEFAULT_REFRESH_SECONDS,
    debugLog: false,
    injectedProviderId: "",
};

const isUserAgentMode = (value: unknown): value is UserAgentMode =>
    value === "kernel" || value === "plugin" || value === "custom";

/** 把磁盘上的内容（可能是旧版本、被手改或不存在）收敛成一份合法配置。 */
export const normalizeSettings = (raw: unknown): PluginSettings => {
    const source = (raw && typeof raw === "object" ? raw : {}) as Partial<PluginSettings>;
    const interval = Number(source.refreshIntervalSeconds);
    return {
        injectProvider: source.injectProvider !== false,
        dynamicSession: source.dynamicSession !== false,
        staticSessionId: typeof source.staticSessionId === "string" ? source.staticSessionId.trim() : "",
        userAgentMode: isUserAgentMode(source.userAgentMode) ? source.userAgentMode : DEFAULT_SETTINGS.userAgentMode,
        customUserAgent: typeof source.customUserAgent === "string" ? source.customUserAgent.trim() : "",
        inlineUsage: source.inlineUsage !== false,
        refreshIntervalSeconds: Number.isFinite(interval) && interval > 0
            ? Math.min(MAX_REFRESH_SECONDS, Math.max(MIN_REFRESH_SECONDS, Math.round(interval)))
            : DEFAULT_REFRESH_SECONDS,
        debugLog: source.debugLog === true,
        injectedProviderId: typeof source.injectedProviderId === "string" ? source.injectedProviderId : "",
    };
};

/** 只走宿主的存储接口（`data/storage/petal/<插件名>/`），不使用 fs / electron API。 */
export const loadSettings = async (plugin: Plugin): Promise<PluginSettings> => {
    try {
        return normalizeSettings(await plugin.loadData(STORAGE_NAME));
    } catch (error) {
        console.error("opencode-go-siyuan: load settings failed", error);
        return {...DEFAULT_SETTINGS};
    }
};

export const saveSettings = async (plugin: Plugin, settings: PluginSettings): Promise<void> => {
    await plugin.saveData(STORAGE_NAME, settings);
};
