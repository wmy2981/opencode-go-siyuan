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
    /** 打开用量详情弹窗（与点击输入框下方那行用量是同一个窗口）。 */
    openUsage: () => void;
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

/** 自检结果的严重度：绿=正常、黄=警告、红=错误。 */
type CheckLevel = "ok" | "warn" | "error";

/** 只读自检区的一行。`level` 有值时按严重度着色，`tip` 的说明文案整行加粗。 */
interface CheckRow {
    label: string;
    value: string;
    level?: CheckLevel;
    tip?: boolean;
}

/**
 * 打开插件设置面板，并挡掉思源写死的「自动聚焦输入框」。
 *
 * 思源 `app/src/plugin/Setting.ts` 的 `open()` 会给面板里**每一个**输入控件调一次
 * `bindInput()`（它第一行就是 `inputElement.focus()`，而且此时控件还没插进弹窗），最后再把
 * 焦点塞进 `contentElement.querySelector("input, textarea")`。
 *
 * 桌面端这只是焦点被抢走；移动端更糟：`app/src/mobile/index.ts` 改写过
 * `HTMLElement.prototype.focus`，每次 focus() 之后都会对「可输入元素」直接调原生桥的
 * `showKeyboard()`。它判断的是**调用 focus 的那个元素**，跟 focusin 回调之后焦点又被移到
 * 哪里无关 —— 所以事后把焦点改回弹窗容器来不及，键盘照样弹出来（面板还会顺带滚到最后一个
 * 输入框那里）。这里改成在 `open()` 期间临时接管 `HTMLElement.prototype.focus`，把这两次
 * 聚焦请求都丢掉：元素还不在文档里时 focus 本来就是空操作、但原生桥照样会被叫起来，所以
 * 未连接的输入控件也要挡。不产生 focus，也就不会有原生键盘；`open()` 结束立即还原，
 * 之后再点输入框照常聚焦。
 */
export const openWithoutAutofocus = (setting: Setting, name: string): void => {
    const nativeFocus = HTMLElement.prototype.focus;
    const guarded = function (this: HTMLElement, options?: FocusOptions): void {
        if (this.matches("input, textarea") && (!this.isConnected || this.closest(".b3-dialog__content"))) {
            return;
        }
        nativeFocus.call(this, options);
    };
    HTMLElement.prototype.focus = guarded;
    try {
        setting.open(name);
    } finally {
        HTMLElement.prototype.focus = nativeFocus;
    }
};

/**
 * 思源的 `Setting` 在 `open()` 里自己 new 一个 `Dialog`，插件没有机会传 `containerClassName`；
 * 而移动端样式（`src/index.scss` 里的 `.opencode-go-panel--mobile`）必须只作用在本插件的
 * 弹窗上 —— `.config-item` 这类类名是所有插件的设置页共用的，不能全局改。所以在 `open()`
 * 之后补一个只属于本插件的作用域类名。
 */
class PanelSetting extends Setting {
    constructor(private readonly mobile: boolean, options: ConstructorParameters<typeof Setting>[0]) {
        super(options);
    }

    open(name: string): void {
        super.open(name);
        // npm 包的 `Setting` 类型没声明运行时确实存在的 `dialog` 字段。
        const dialog = (this as unknown as {dialog?: {element: HTMLElement}}).dialog;
        dialog?.element.classList.add("opencode-go-panel");
        dialog?.element.classList.toggle("opencode-go-panel--mobile", this.mobile);
    }
}

/**
 * `Setting` 把 title/description 用 innerHTML 插进弹窗，所以拼 HTML 之前先转义文案，
 * 免得译文里的尖括号被当成标签。
 */
const escapeHtml = (value: string): string => value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

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
     *
     * 按钮是否可点由各自的 `sync` 说了算：第 1、2 步有前置条件，第 3 步的检查可以随便点。
     *
     * 宽度用 `fn__size200`，与下面「修复」等设置项的按钮同宽，三个步骤看起来才是一组。
     */
    const actionButton = (onClick: () => Promise<void>,
                          sync: (button: HTMLButtonElement) => void): HTMLButtonElement => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "b3-button b3-button--outline fn__flex-center fn__size200";
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

    /**
     * 各检查项的严重度。标准统一为「现在到底通不通」：
     * - 缺失：必需请求头不全 → 红（这是本插件与端点之间的约定，缺了就不是预期配置）；
     * - 取值不同：插件从不覆盖用户自己改过的取值 → 黄（需要人来确认是不是故意的）；
     * - API Key：未填或含非 ASCII → 红（必须重新粘贴）；只是混了空白/零宽字符 → 黄
     *   （用量请求会先净化再用，只有对话会被上游拒，点一次「立即修复」即可）；
     * - 用量：取到数据 → 绿；还没取过 → 黄；取失败 → 红。
     */
    const missingLevel = (values: string[]): CheckLevel => values.length > 0 ? "error" : "ok";
    const conflictLevel = (values: string[]): CheckLevel => values.length > 0 ? "warn" : "ok";
    const apiKeyLevel = (check: ProviderCheck): CheckLevel => {
        if (check.apiKeyIssue === "missing" || check.apiKeyIssue === "nonAscii") {
            return "error";
        }
        return check.apiKeyDirty ? "warn" : "ok";
    };
    const usageLevel = (usage: UsageResult | null): CheckLevel =>
        !usage ? "warn" : isUsageFailure(usage) ? "error" : "ok";

    const fillCheck = (container: HTMLElement): void => {
        const check = host.inspect();
        const usage = host.usage();
        const rows: CheckRow[] = [];
        const join = (values: string[]): string => values.length > 0 ? values.join(", ") : t("check.none");
        rows.push({label: t("check.provider"), value: check.exists
            ? check.displayName + " · " + check.baseURL
            : check.dismissed ? t("check.dismissed") : t("check.none")});
        if (check.exists) {
            rows.push({label: t("check.missing"), value: join(check.missing), level: missingLevel(check.missing)});
            rows.push({
                label: t("check.conflict"),
                value: join(check.conflicts),
                level: conflictLevel(check.conflicts),
            });
            rows.push({label: "API Key", value: apiKeyLabel(check), level: apiKeyLevel(check)});
            rows.push({label: t("check.models"), value: check.modelCount > 0
                ? String(check.modelCount)
                : t("check.modelsEmpty")});
        }
        check.foreign.forEach((item) => {
            const parts: string[] = [];
            if (item.missing.length > 0) {
                parts.push(t("check.missing") + ": " + item.missing.join(", "));
            }
            if (item.conflicts.length > 0) {
                parts.push(t("check.conflict") + ": " + item.conflicts.join(", "));
            }
            rows.push({
                label: t("check.provider") + " · " + item.displayName,
                value: parts.length > 0 ? parts.join("; ") : t("check.ok"),
            });
        });
        rows.push({label: t("check.sessionVariable"), value: host.sessionValue() || t("check.none")});
        rows.push({
            label: t("check.usage"),
            value: !usage
                ? t("dialog.never")
                : isUsageFailure(usage)
                    ? t("dialog.error") + ": " + usage.failure.message
                    : t("dialog.updatedAt", {time: new Date(usage.snapshot.fetchedAt).toLocaleTimeString()}),
            level: usageLevel(usage),
        });
        rows.push({label: "", value: t("message.variableTip"), tip: true});
        container.replaceChildren(...rows.map(({label, value, level, tip}) => {
            const row = document.createElement("div");
            row.className = "opencode-go-check__row";
            const labelElement = document.createElement("span");
            labelElement.className = "opencode-go-check__label";
            labelElement.textContent = label;
            const valueElement = document.createElement("span");
            valueElement.className = "opencode-go-check__value ft__breakword" +
                (level ? " opencode-go-check__value--" + level : "") +
                (tip ? " opencode-go-check__tip" : "");
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
            // 检查随时可以重来：一次检查进行期间按钮会被禁用，结束后在这里放回可点状态。
            button.textContent = t("guide.step3.action");
            button.disabled = false;
        },
    );
    checkElement = document.createElement("div");
    checkElement.className = "opencode-go-check";
    const step3 = stepElement(true, step3Button, checkElement);

    // ---- 设置 -------------------------------------------------------------

    const setting = new PanelSetting(host.isMobile(), {
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
        // 风险提示另起一行、用红字。description 是 innerHTML，可以直接带标签。
        description: escapeHtml(t("guide.tip")) +
            '<div class="opencode-go-guide__warn">' + escapeHtml(t("guide.warn")) + "</div>",
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
        title: t("settings.usageDialog"),
        description: t("settings.usageDialogTip"),
        createActionElement: () => buttonElement(t("settings.usageDialogAction"), async () => {
            host.openUsage();
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
