import type {Plugin} from "siyuan";
import type {InlineWindowPreset, PluginSettings, UsageStyle, UserAgentMode} from "./types";

const STORAGE_NAME = "settings";

export const MIN_REFRESH_SECONDS = 30;
export const MAX_REFRESH_SECONDS = 3600;
export const DEFAULT_REFRESH_SECONDS = 300;

export const DEFAULT_SETTINGS: PluginSettings = {
    dynamicSession: true,
    staticSessionId: "",
    userAgentMode: "kernel",
    customUserAgent: "",
    inlineUsage: true,
    inlineWindows: "h5Week",
    usageStyle: "used",
    topBarButton: false,
    refreshIntervalSeconds: DEFAULT_REFRESH_SECONDS,
    debugLog: false,
    injectedProviderId: "",
};

const isUserAgentMode = (value: unknown): value is UserAgentMode =>
    value === "kernel" || value === "plugin" || value === "custom";

const isUsageStyle = (value: unknown): value is UsageStyle =>
    value === "used" || value === "remaining";

const isInlineWindowPreset = (value: unknown): value is InlineWindowPreset =>
    value === "h5Week" || value === "h5WeekMonth" || value === "h5Month" ||
    value === "weekMonth" || value === "h5";

/** 把磁盘上的内容（可能是旧版本、被手改或不存在）收敛成一份合法配置。 */
export const normalizeSettings = (raw: unknown): PluginSettings => {
    const source = (raw && typeof raw === "object" ? raw : {}) as Partial<PluginSettings>;
    const interval = Number(source.refreshIntervalSeconds);
    return {
        dynamicSession: source.dynamicSession !== false,
        staticSessionId: typeof source.staticSessionId === "string" ? source.staticSessionId.trim() : "",
        userAgentMode: isUserAgentMode(source.userAgentMode) ? source.userAgentMode : DEFAULT_SETTINGS.userAgentMode,
        customUserAgent: typeof source.customUserAgent === "string" ? source.customUserAgent.trim() : "",
        inlineUsage: source.inlineUsage !== false,
        // 旧的配置里没有这一项，缺失或取值不在枚举内都回落到默认的「5 小时和周」。
        inlineWindows: isInlineWindowPreset(source.inlineWindows)
            ? source.inlineWindows
            : DEFAULT_SETTINGS.inlineWindows,
        // 只有显式存成 remaining 才反过来显示，旧配置与非法值一律回落到「已用量」。
        usageStyle: isUsageStyle(source.usageStyle) ? source.usageStyle : DEFAULT_SETTINGS.usageStyle,
        // 顶栏按钮是可选入口，只有显式存成 true 才注册。
        topBarButton: source.topBarButton === true,
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
