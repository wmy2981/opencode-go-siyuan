import {Setting, showMessage} from "siyuan";
import type {Translate} from "./i18n";
import type {ProviderCheck} from "./provider";
import {MAX_REFRESH_SECONDS, MIN_REFRESH_SECONDS} from "./settings";
import {isUsageFailure} from "./types";
import type {PluginSettings, UsageResult, UserAgentMode} from "./types";

export interface SettingsPanelHost {
    t: Translate;
    settings: () => PluginSettings;
    save: (draft: PluginSettings) => Promise<void>;
    inspect: () => ProviderCheck;
    repair: () => Promise<ProviderCheck>;
    refreshModels: () => Promise<number>;
    refreshUsage: () => Promise<UsageResult | null>;
    sessionValue: () => string;
    usage: () => UsageResult | null;
    isMobile: () => boolean;
    log: (topic: string, message: string) => void;
}

export interface SettingsPanel {
    setting: Setting;
    /** 重新渲染只读自检区（例如用量刷新之后）。 */
    refreshInfo: () => void;
}

/**
 * 插件的设置面板：用思源官方的 `Setting` 类渲染，控件全部走 `b3-*` 原生类名，
 * 因此外观与原生设置页一致；开关与参数走「草稿 + 保存」，动作类按钮立即生效。
 */
export const openSettingsPanel = (host: SettingsPanelHost): SettingsPanel => {
    const t = host.t;
    const draft: PluginSettings = {...host.settings()};
    let infoElement: HTMLElement | null = null;
    let renderInfo: () => void = () => undefined;

    const switchElement = (checked: boolean, onChange: (checked: boolean) => void): HTMLElement => {
        const input = document.createElement("input");
        input.type = "checkbox";
        input.className = "b3-switch fn__flex-center";
        input.checked = checked;
        input.addEventListener("change", () => onChange(input.checked));
        return input;
    };

    const buttonElement = (label: string, onClick: () => Promise<void>): HTMLElement => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "b3-button b3-button--outline fn__flex-center fn__size200";
        button.textContent = label;
        button.addEventListener("click", () => {
            button.disabled = true;
            void onClick()
                .catch((error) => {
                    host.log("settings", "action failed: " + String(error));
                    showMessage(t("message.saveFailed"), 4000, "error");
                })
                .finally(() => {
                    if (button.isConnected) {
                        button.disabled = false;
                    }
                });
        });
        return button;
    };

    const textareaElement = (value: string, onChange: (value: string) => void): HTMLElement => {
        const textarea = document.createElement("textarea");
        textarea.className = "b3-text-field fn__block";
        textarea.rows = 2;
        textarea.value = value;
        textarea.addEventListener("change", () => onChange(textarea.value.trim()));
        return textarea;
    };

    const numberElement = (value: number, onChange: (value: number) => void): HTMLElement => {
        const input = document.createElement("input");
        input.type = "number";
        input.className = "b3-text-field fn__flex-center fn__size200";
        input.min = String(MIN_REFRESH_SECONDS);
        input.max = String(MAX_REFRESH_SECONDS);
        input.step = "1";
        input.value = String(value);
        input.addEventListener("change", () => {
            const parsed = Number(input.value);
            const clamped = Number.isFinite(parsed)
                ? Math.min(MAX_REFRESH_SECONDS, Math.max(MIN_REFRESH_SECONDS, Math.round(parsed)))
                : value;
            input.value = String(clamped);
            onChange(clamped);
        });
        return input;
    };

    const selectElement = (options: Array<[string, string]>, value: string,
                           onChange: (value: string) => void): HTMLElement => {
        const select = document.createElement("select");
        select.className = "b3-select fn__flex-center fn__size200";
        options.forEach(([optionValue, label]) => {
            const option = document.createElement("option");
            option.value = optionValue;
            option.textContent = label;
            if (optionValue === value) {
                option.selected = true;
            }
            select.append(option);
        });
        select.addEventListener("change", () => onChange(select.value));
        return select;
    };

    const fillInfo = (container: HTMLElement): void => {
        const check = host.inspect();
        const usage = host.usage();
        const rows: Array<[string, string]> = [];
        const join = (values: string[]): string => values.length > 0 ? values.join(", ") : t("check.none");
        rows.push([t("check.provider"), check.exists ? check.displayName + " · " + check.baseURL : t("check.none")]);
        if (check.exists) {
            rows.push([t("check.missing"), join(check.missing)]);
            rows.push([t("check.conflict"), join(check.conflicts)]);
            rows.push(["API Key", check.apiKeySet ? t("check.ok") : t("check.missing")]);
            rows.push(["Models", String(check.modelCount)]);
        }
        check.foreign.forEach((item) => {
            const parts: string[] = [];
            if (item.missing.length > 0) {
                parts.push(t("check.missing") + ": " + item.missing.join(", "));
            }
            if (item.conflicts.length > 0) {
                parts.push(t("check.conflict") + ": " + item.conflicts.join(", "));
            }
            rows.push([t("check.provider") + " · " + item.displayName, parts.length > 0 ? parts.join("; ") : t("check.ok")]);
        });
        rows.push([t("check.sessionVariable"), host.sessionValue() || t("check.none")]);
        rows.push([t("check.usage"), !usage
            ? t("dialog.never")
            : isUsageFailure(usage)
                ? t("dialog.error") + ": " + usage.failure.message
                : t("dialog.updatedAt", {time: new Date(usage.snapshot.fetchedAt).toLocaleTimeString()})]);
        rows.push(["", t("message.variableTip")]);
        container.replaceChildren(...rows.map(([label, value]) => {
            const row = document.createElement("div");
            row.className = "opencode-go-check__row";
            const labelElement = document.createElement("span");
            labelElement.className = "opencode-go-check__label";
            labelElement.textContent = label;
            const valueElement = document.createElement("span");
            valueElement.className = "opencode-go-check__value ft__breakword";
            valueElement.textContent = value;
            row.append(labelElement, valueElement);
            return row;
        }));
    };

    renderInfo = (): void => {
        if (infoElement) {
            fillInfo(infoElement);
        }
    };

    const setting = new Setting({
        width: host.isMobile() ? "92vw" : "760px",
        height: "80vh",
        confirmCallback: () => {
            void host.save({...draft}).then(
                () => showMessage(t("message.saved")),
                (error) => {
                    host.log("settings", "save failed: " + String(error));
                    showMessage(t("message.saveFailed"), 4000, "error");
                },
            );
        },
    });

    setting.addItem({
        title: t("settings.injectProvider"),
        description: t("settings.injectProviderTip"),
        createActionElement: () => switchElement(draft.injectProvider, (checked) => {
            draft.injectProvider = checked;
        }),
    });
    setting.addItem({
        title: t("settings.repair"),
        description: t("settings.repairTip"),
        createActionElement: () => buttonElement(t("settings.repairAction"), async () => {
            await host.repair();
            renderInfo();
            showMessage(t("settings.repairDone"));
        }),
    });
    setting.addItem({
        title: t("settings.refreshModels"),
        description: t("settings.refreshModelsTip"),
        createActionElement: () => buttonElement(t("settings.refreshModelsAction"), async () => {
            const count = await host.refreshModels();
            renderInfo();
            showMessage(count > 0 ? t("settings.refreshModelsDone", {count}) : t("settings.refreshModelsEmpty"),
                4000, count > 0 ? "info" : "error");
        }),
    });
    setting.addItem({
        title: t("settings.dynamicSession"),
        description: t("settings.dynamicSessionTip"),
        createActionElement: () => switchElement(draft.dynamicSession, (checked) => {
            draft.dynamicSession = checked;
        }),
    });
    setting.addItem({
        title: t("settings.staticSessionId"),
        description: t("settings.staticSessionIdTip"),
        createActionElement: () => textareaElement(draft.staticSessionId, (value) => {
            draft.staticSessionId = value;
        }),
    });
    setting.addItem({
        title: t("settings.userAgentMode"),
        description: t("settings.userAgentModeTip"),
        createActionElement: () => selectElement([
            ["kernel", t("settings.ua.kernel")],
            ["plugin", t("settings.ua.plugin")],
            ["custom", t("settings.ua.custom")],
        ], draft.userAgentMode, (value) => {
            draft.userAgentMode = value as UserAgentMode;
        }),
    });
    setting.addItem({
        title: t("settings.customUserAgent"),
        description: t("settings.customUserAgentTip"),
        createActionElement: () => textareaElement(draft.customUserAgent, (value) => {
            draft.customUserAgent = value;
        }),
    });
    setting.addItem({
        title: t("settings.inlineUsage"),
        description: t("settings.inlineUsageTip"),
        createActionElement: () => switchElement(draft.inlineUsage, (checked) => {
            draft.inlineUsage = checked;
        }),
    });
    setting.addItem({
        title: t("settings.interval"),
        description: t("settings.intervalTip"),
        createActionElement: () => numberElement(draft.refreshIntervalSeconds, (value) => {
            draft.refreshIntervalSeconds = value;
        }),
    });
    setting.addItem({
        title: t("settings.refreshNow"),
        description: t("settings.refreshNowTip"),
        createActionElement: () => buttonElement(t("settings.refreshNowAction"), async () => {
            await host.refreshUsage();
            renderInfo();
        }),
    });
    setting.addItem({
        title: t("settings.debugLog"),
        description: t("settings.debugLogTip"),
        createActionElement: () => switchElement(draft.debugLog, (checked) => {
            draft.debugLog = checked;
        }),
    });
    setting.addItem({
        title: t("settings.check"),
        description: t("settings.checkTip"),
        direction: "row",
        createActionElement: () => {
            const container = document.createElement("div");
            container.className = "opencode-go-check";
            infoElement = container;
            fillInfo(container);
            return container;
        },
    });

    return {setting, refreshInfo: renderInfo};
};
