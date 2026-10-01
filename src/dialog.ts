import {Dialog, showMessage} from "siyuan";
import {copyText} from "./clipboard";
import type {Translate} from "./i18n";
import {USAGE_WINDOW_KEYS} from "./usage";
import {isUsageFailure} from "./types";
import type {LogFn, UsageResult, UsageTarget, UsageWindowKey} from "./types";

const WINDOW_TITLE_KEY: Record<UsageWindowKey, string> = {
    rolling: "dialog.rolling",
    weekly: "dialog.weekly",
    monthly: "dialog.monthly",
};

export interface UsageDialogHost {
    t: Translate;
    target: () => UsageTarget | undefined;
    sessionValue: () => string;
    result: () => UsageResult | null;
    refresh: () => Promise<UsageResult | null>;
    isMobile: () => boolean;
    log: LogFn;
}

/** 把毫秒差格式化成「3 小时 29 分」/「3h 29m」，单位走 i18n。 */
export const formatDuration = (milliseconds: number, t: Translate): string => {
    const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
        return t("duration.hourMinute", {h: hours, m: minutes});
    }
    if (minutes > 0) {
        return t("duration.minute", {m: minutes});
    }
    return t("duration.second", {s: seconds});
};

/** 用量详情窗口；用思源原生 Dialog，动作区自建。 */
export class UsageDialog {
    private dialog: Dialog | null = null;
    private refreshing = false;

    constructor(private readonly host: UsageDialogHost) {
    }

    open(): void {
        if (this.dialog && !this.dialog.element.isConnected) {
            // 弹窗被别处销毁过（元素已脱离文档）时，缓存的实例只会把内容画进一个看不见的
            // 节点里；这时当作没开过，重建一个。
            this.dialog = null;
        }
        if (this.dialog) {
            this.dialog.element.style.zIndex = (++window.siyuan.zIndex).toString();
            this.render();
            void this.refreshAndRender();
            return;
        }
        this.dialog = new Dialog({
            title: this.host.t("dialog.title"),
            width: this.host.isMobile() ? "92vw" : "620px",
            content: this.html(),
            destroyCallback: () => {
                this.dialog = null;
            },
        });
        this.bind(this.dialog);
        this.render();
        void this.refreshAndRender();
    }

    close(): void {
        this.dialog?.destroy();
        this.dialog = null;
    }

    /** 数据更新后如果窗口开着就重绘。 */
    refreshView(): void {
        if (this.dialog) {
            this.render();
        }
    }

    private html(): string {
        const t = this.host.t;
        return `<div class="b3-dialog__content">
    <div class="opencode-go-dialog">
        <div class="opencode-go-dialog__meta">
            <div class="opencode-go-dialog__row"><span class="opencode-go-dialog__label">${t("dialog.provider")}</span><span data-role="provider"></span></div>
            <div class="opencode-go-dialog__row"><span class="opencode-go-dialog__label">${t("dialog.baseURL")}</span><span class="ft__breakword" data-role="endpoint"></span></div>
            <div class="opencode-go-dialog__row"><span class="opencode-go-dialog__label">${t("dialog.model")}</span><span data-role="model"></span></div>
            <div class="opencode-go-dialog__row"><span class="opencode-go-dialog__label">${t("dialog.session")}</span><code class="opencode-go-dialog__session" data-role="session"></code><button class="block__icon block__icon--show ariaLabel" data-position="north" aria-label="${t("dialog.copy")}" data-action="copy" type="button"><svg><use xlink:href="#iconCopy"></use></svg></button></div>
        </div>
        <div class="opencode-go-dialog__windows" data-role="windows"></div>
        <div class="opencode-go-dialog__foot">
            <span class="opencode-go-dialog__updated" data-role="updated"></span>
            <button class="block__icon block__icon--show ariaLabel" data-position="north" aria-label="${t("dialog.refresh")}" data-action="refresh" type="button"><svg><use xlink:href="#iconRefresh"></use></svg></button>
        </div>
        <div class="opencode-go-dialog__error fn__none" data-role="error"></div>
    </div>
</div>`;
    }

    private bind(dialog: Dialog): void {
        dialog.element.addEventListener("click", (event) => {
            const target = event.target as HTMLElement | null;
            const action = target?.closest<HTMLElement>("[data-action]")?.dataset.action;
            if (action === "refresh") {
                void this.refreshAndRender();
            } else if (action === "copy") {
                void this.copySession();
            }
        });
    }

    private render(): void {
        const root = this.dialog?.element;
        if (!root) {
            return;
        }
        const t = this.host.t;
        const target = this.host.target();
        const result = this.host.result();
        const setText = (role: string, value: string): void => {
            const element = root.querySelector<HTMLElement>('[data-role="' + role + '"]');
            if (element) {
                element.textContent = value;
            }
        };
        setText("provider", target?.displayName || t("check.none"));
        setText("endpoint", target?.baseURL || t("check.none"));
        // 显示真正发给上游的模型 name；思源自己分配的 id 对用户没有意义。
        setText("model", target?.modelName || target?.modelId || t("check.none"));
        setText("session", this.host.sessionValue() || t("check.none"));
        setText("updated", result?.ok
            ? t("dialog.updatedAt", {time: new Date(result.snapshot.fetchedAt).toLocaleTimeString()})
            : t("dialog.never"));
        const windows = root.querySelector<HTMLElement>('[data-role="windows"]');
        if (windows) {
            windows.innerHTML = this.windowsHtml();
        }
        const error = root.querySelector<HTMLElement>('[data-role="error"]');
        if (error) {
            if (result && isUsageFailure(result)) {
                const detail = result.failure.detail ? " · " + result.failure.detail : "";
                error.textContent = t("dialog.error") + ": " + result.failure.message + detail;
                error.classList.remove("fn__none");
            } else {
                error.textContent = "";
                error.classList.add("fn__none");
            }
        }
    }

    private windowsHtml(): string {
        const t = this.host.t;
        const result = this.host.result();
        const windows = result && result.ok ? result.snapshot.windows : {};
        return USAGE_WINDOW_KEYS.map((key) => {
            const window = windows[key];
            const percent = typeof window?.percent === "number" ? window.percent : undefined;
            const percentText = typeof percent === "number"
                ? t("dialog.percent", {percent})
                : t("dialog.percentUnknown");
            const limited = window?.status === "rate-limited"
                ? `<span class="opencode-go-dialog__limited">${t("dialog.rateLimited")}</span>`
                : "";
            return `<div class="opencode-go-dialog__window">
    <div class="opencode-go-dialog__window-head">
        <span>${t(WINDOW_TITLE_KEY[key])}</span>
        <span class="opencode-go-dialog__window-value">${limited}${percentText}</span>
    </div>
    <div class="opencode-go-bar"><span style="width:${typeof percent === "number" ? percent : 0}%"></span></div>
    <div class="opencode-go-dialog__window-foot">${this.footText(window?.resetsAt)}</div>
</div>`;
        }).join("");
    }

    private footText(resetsAt: string | undefined): string {
        const t = this.host.t;
        if (!resetsAt) {
            return t("dialog.resetUnknown");
        }
        const resetAt = Date.parse(resetsAt);
        if (!Number.isFinite(resetAt)) {
            return t("dialog.resetUnknown");
        }
        const delta = resetAt - Date.now();
        if (delta <= 0) {
            return t("dialog.resetUnknown");
        }
        return t("dialog.reset", {time: formatDuration(delta, t)});
    }

    private async refreshAndRender(): Promise<void> {
        if (this.refreshing) {
            return;
        }
        this.refreshing = true;
        const button = this.dialog?.element.querySelector<HTMLButtonElement>('[data-action="refresh"]');
        const icon = button?.querySelector("svg");
        if (button) {
            button.disabled = true;
            button.setAttribute("aria-label", this.host.t("dialog.refreshing"));
            // 转动用思源自带的 `fn__rotate`（`animation: rotate 2s infinite linear`），
            // 与内核自己的刷新按钮同一套动效，插件不再自造关键帧。
            icon?.classList.add("fn__rotate");
        }
        try {
            await this.host.refresh();
            this.render();
        } finally {
            this.refreshing = false;
            if (button?.isConnected) {
                button.disabled = false;
                button.setAttribute("aria-label", this.host.t("dialog.refresh"));
                icon?.classList.remove("fn__rotate");
            }
        }
    }

    private async copySession(): Promise<void> {
        const value = this.host.sessionValue();
        if (!value) {
            return;
        }
        if (await copyText(value)) {
            showMessage(this.host.t("dialog.copied"));
            return;
        }
        this.host.log("dialog", "clipboard write failed");
        showMessage(this.host.t("dialog.copyFailed"));
    }
}
