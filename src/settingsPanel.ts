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
    /** 只读自检，不改动任何配置。 */
    inspect: () => ProviderCheck;
    /** 显式创建供应商：已存在同端点条目时直接沿用，绝不重复创建。 */
    create: () => Promise<ProviderCheck>;
    /** 显式修复：可以重建被删掉的供应商，并覆盖冲突字段、清理 Key 里的杂质。 */
    repair: () => Promise<ProviderCheck>;
    /** 打开思源原生的「设置 - 人工智能」并定位到这个供应商。 */
    openProviderSetting: () => Promise<void>;
    refreshUsage: () => Promise<UsageResult | null>;
    sessionValue: () => string;
    usage: () => UsageResult | null;
    isMobile: () => boolean;
    log: (topic: string, message: string) => void;
}

export interface SettingsPanel {
    setting: Setting;
    /** 重新渲染各步骤状态与只读自检区（例如用量刷新之后）。 */
    refreshInfo: () => void;
}

/**
 * 插件的设置面板：用思源官方的 `Setting` 类渲染，控件全部走 `b3-*` 原生类名，
 * 因此外观与原生设置页一致。
 *
 * 面板分两段：上面是「创建 → 填凭据 → 检查」的顺序指引，所有会改动思源配置的动作
 * 都必须由用户点按钮触发；下面是纯设置项。开关与参数走「草稿 + 保存」，动作类按钮立即生效。
 */
export const openSettingsPanel = (host: SettingsPanelHost): SettingsPanel => {
    const t = host.t;
    const draft: PluginSettings = {...host.settings()};
    /** 每次刷新都要重算的界面状态（步骤状态、按钮标签与可用性）。 */
    const refreshers: Array<() => void> = [];
    let checkElement: HTMLElement | null = null;

    /** 登记一个「刷新时要重算」的回调；面板构建完与每次动作后都会跑一遍。 */
    const refreshLater = (sync: () => void): void => {
        refreshers.push(sync);
    };

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

    /**
     * 指引里的步骤按钮：点击期间禁用，结束后整体重算一遍界面状态 —— 不只是这个按钮的
     * 标签与可用性，还包括其它步骤的状态文案与下面的自检结果（例如刚创建完供应商，
     * 第 2 步就该从「请先完成第 1 步」变成 API Key 的状态）。
     */
    const actionButton = (onClick: () => Promise<void>,
                          sync: (button: HTMLButtonElement) => void): HTMLButtonElement => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "b3-button b3-button--outline";
        button.addEventListener("click", () => {
            button.disabled = true;
            void onClick()
                .catch((error) => {
                    host.log("settings", "action failed: " + String(error));
                    showMessage(t("message.saveFailed"), 4000, "error");
                })
                .finally(() => {
                    if (button.isConnected) {
                        renderInfo();
                    }
                });
        });
        refreshLater(() => sync(button));
        return button;
    };

    const statusElement = (text: () => string): HTMLElement => {
        const span = document.createElement("span");
        span.className = "opencode-go-step__status";
        refreshLater(() => {
            span.textContent = text();
        });
        return span;
    };

    const stepElement = (block: boolean, ...children: HTMLElement[]): HTMLElement => {
        const container = document.createElement("div");
        container.className = "opencode-go-step" + (block ? " opencode-go-step--block" : "");
        container.append(...children);
        return container;
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

    /** API Key 的可用性文案，指引第 2 步与自检区共用。 */
    const apiKeyLabel = (check: ProviderCheck): string => {
        if (check.apiKeyIssue === "nonAscii") {
            return t("check.apiKeyNonAscii", {index: String(check.apiKeyIndex + 1)});
        }
        if (check.apiKeyDirty) {
            return t("check.apiKeyDirty");
        }
        if (check.apiKeyIssue === "ok") {
            return t("check.apiKeyOk");
        }
        return t("check.apiKeyMissing");
    };

    const fillCheck = (container: HTMLElement): void => {
        const check = host.inspect();
        const usage = host.usage();
        const rows: Array<[string, string]> = [];
        const join = (values: string[]): string => values.length > 0 ? values.join(", ") : t("check.none");
        rows.push([t("check.provider"), check.exists
            ? check.displayName + " · " + check.baseURL
            : check.dismissed ? t("check.dismissed") : t("check.none")]);
        if (check.exists) {
            rows.push([t("check.missing"), join(check.missing)]);
            rows.push([t("check.conflict"), join(check.conflicts)]);
            rows.push(["API Key", apiKeyLabel(check)]);
            rows.push([t("check.models"), check.modelCount > 0
                ? String(check.modelCount)
                : t("check.modelsEmpty")]);
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

    function renderInfo(): void {
        refreshers.forEach((sync) => sync());
        if (checkElement) {
            fillCheck(checkElement);
        }
    }

    // ---- 顺序指引 ---------------------------------------------------------

    const step1Button = actionButton(
        async () => {
            const check = await host.create();
            host.log("settings", "create requested; exists=" + check.exists);
            showMessage(check.exists ? t("guide.step1.done") : t("guide.step1.failed"),
                4000, check.exists ? "info" : "error");
        },
        (button) => {
            const exists = host.inspect().exists;
            button.textContent = exists ? t("guide.step1.existed") : t("guide.step1.action");
            button.disabled = exists;
        },
    );
    const step1 = stepElement(false, step1Button, statusElement(() => {
        const check = host.inspect();
        if (check.exists) {
            return t("guide.step1.statusReady") + " · " + check.baseURL;
        }
        return check.dismissed ? t("guide.step1.statusDeleted") : t("guide.step1.statusMissing");
    }));

    const step2Button = actionButton(
        async () => {
            await host.openProviderSetting();
        },
        (button) => {
            button.textContent = t("guide.step2.action");
            button.disabled = !host.inspect().exists;
        },
    );
    const step2 = stepElement(false, step2Button, statusElement(() => {
        const check = host.inspect();
        return check.exists ? apiKeyLabel(check) : t("guide.step2.statusMissing");
    }));

    const step3Button = actionButton(
        async () => {
            await host.refreshUsage();
            showMessage(t("guide.step3.done"));
        },
        (button) => {
            button.textContent = t("guide.step3.action");
        },
    );
    checkElement = document.createElement("div");
    checkElement.className = "opencode-go-check";
    const step3 = stepElement(true, step3Button, checkElement);

    // ---- 设置 -------------------------------------------------------------

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
        title: t("guide.title"),
        description: t("guide.tip"),
    });
    setting.addItem({
        title: t("guide.step1.title"),
        description: t("guide.step1.desc"),
        direction: "row",
        createActionElement: () => step1,
    });
    setting.addItem({
        title: t("guide.step2.title"),
        description: t("guide.step2.desc"),
        direction: "row",
        createActionElement: () => step2,
    });
    setting.addItem({
        title: t("guide.step3.title"),
        description: t("guide.step3.desc"),
        direction: "row",
        createActionElement: () => step3,
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
        title: t("settings.headerStrategy"),
        description: t("settings.headerStrategyTip"),
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
        title: t("settings.debugLog"),
        description: t("settings.debugLogTip"),
        createActionElement: () => switchElement(draft.debugLog, (checked) => {
            draft.debugLog = checked;
        }),
    });

    // 元素在面板打开前就建好了，这里先把状态算一遍，避免打开瞬间闪一下默认文案。
    renderInfo();

    return {setting, refreshInfo: renderInfo};
};
