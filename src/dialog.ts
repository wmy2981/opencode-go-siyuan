import {Dialog, showMessage} from "siyuan";
import {copyText} from "./clipboard";
import type {Translate} from "./i18n";
import {bindBottomSheet} from "./sheet";
import {USAGE_WINDOW_KEYS, displayedPercent} from "./usage";
import type {LogFn, UsageFailure, UsageSnapshot, UsageTarget, UsageWindowKey} from "./types";

const WINDOW_TITLE_KEY: Record<UsageWindowKey, string> = {
    rolling: "dialog.rolling",
    weekly: "dialog.weekly",
    monthly: "dialog.monthly",
};

/**
 * 打开弹窗的入口。会话 ID 是「这段对话」的身份，只有从智能体面板那一行进来时才有意义；
 * 顶栏按钮与设置页按钮打开的窗口不展示它。
 */
export type UsageOpenSource = "agent" | "topbar" | "settings";

export interface UsageDialogHost {
    t: Translate;
    target: () => UsageTarget | undefined;
    sessionValue: () => string;
    /** 最近一次成功取到的用量；查询失败时仍是上一份。 */
    snapshot: () => UsageSnapshot | null;
    /** 最近一次失败；与「最后更新」同时展示，互不冲突。 */
    failure: () => UsageFailure | null;
    /** 百分比按「已用量」还是「剩余量」显示。 */
    remaining: () => boolean;
    refresh: () => Promise<unknown>;
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

/**
 * 把毫秒差格式化成「2 天 10 小时 30 分」/「2d 10h 30m」，供周/月这类长跨度窗口使用。
 * 为 0 的单位整个不出现（「30 分后重置」而不是「0 天 0 小时 30 分后重置」），
 * 不足一分钟时仍按秒给出，免得只剩一句「0 分」。各单位的写法与顺序交给 i18n。
 */
export const formatSpanDuration = (milliseconds: number, t: Translate): string => {
    const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const parts: string[] = [];
    if (days > 0) {
        parts.push(t("duration.day", {d: days}));
    }
    if (hours > 0) {
        parts.push(t("duration.hour", {h: hours}));
    }
    if (minutes > 0) {
        parts.push(t("duration.minute", {m: minutes}));
    }
    if (parts.length === 0) {
        return t("duration.second", {s: totalSeconds % 60});
    }
    return parts.join(" ");
};

/**
 * 把「距上次成功取数过了多久」格式化成 `现在` / `30 秒前` / `5 分钟前` / `2 小时前`。
 *
 * 用量刷新失败时会继续展示上一份数据，绝对时间（`21:09:08`）看不出它有多旧，
 * 相对时间才说明「这行数字是刚才的，还是十分钟前的」。
 */
export const formatRelativeTime = (timestamp: number, now: number, t: Translate): string => {
    const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
    if (seconds < 5) {
        return t("time.justNow");
    }
    if (seconds < 60) {
        return t("time.secondsAgo", {n: seconds});
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return t("time.minutesAgo", {n: minutes});
    }
    return t("time.hoursAgo", {n: Math.floor(minutes / 60)});
};

/**
 * 用量详情窗口；用思源原生 Dialog，动作区自建。
 *
 * 移动端是思源原生的底部面板（从底部滑出、下拉关闭，见 `sheet.ts`），桌面端仍是居中的详情窗口。
 */
export class UsageDialog {
    private dialog: Dialog | null = null;
    /** 底部面板的绑定解绑函数；只有移动端会有。 */
    private sheet: (() => void) | null = null;
    private refreshing = false;
    /** 这次窗口是从哪里打开的；决定会话 ID 那一行显不显示。 */
    private source: UsageOpenSource = "topbar";

    constructor(private readonly host: UsageDialogHost) {
    }

    open(source: UsageOpenSource): void {
        this.source = source;
        if (this.dialog && !this.dialog.element.isConnected) {
            // 弹窗被别处销毁过（元素已脱离文档）时，缓存的实例只会把内容画进一个看不见的
            // 节点里；这时当作没开过，重建一个。销毁回调没机会跑，面板绑定得在这里摘掉。
            this.disposeSheet();
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
            // 底部面板撑满整行（容器自身的 max-width 会避开刘海安全区），桌面端仍是固定宽度的窗口。
            width: this.host.isMobile() ? "100vw" : "620px",
            // 底部面板靠下拉或点遮罩关闭，右上角不再画关闭按钮（内核自己的移动端底部面板同样如此）。
            // 内核的 Dialog 本来也只在移动端画这个按钮（桌面端一直是 `fn__none`），这里等于整个去掉。
            hideCloseIcon: this.host.isMobile(),
            content: this.html(),
            destroyCallback: () => {
                this.disposeSheet();
                this.dialog = null;
            },
        });
        if (this.host.isMobile()) {
            this.sheet = bindBottomSheet(this.dialog, () => this.close());
        }
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

    /** 摘掉底部面板的视口与触摸监听；销毁回调与「已被别处销毁」的重建路径都会走这里，重复调用无副作用。 */
    private disposeSheet(): void {
        this.sheet?.();
        this.sheet = null;
    }

    private html(): string {
        const t = this.host.t;
        return `<div class="b3-dialog__content">
    <div class="opencode-go-dialog">
        <div class="opencode-go-dialog__meta">
            <div class="opencode-go-dialog__row"><span class="opencode-go-dialog__label">${t("dialog.provider")}</span><span data-role="provider"></span></div>
            <div class="opencode-go-dialog__row"><span class="opencode-go-dialog__label">${t("dialog.baseURL")}</span><span class="ft__breakword" data-role="endpoint"></span></div>
            <div class="opencode-go-dialog__row" data-row="model"><span class="opencode-go-dialog__label">${t("dialog.model")}</span><span data-role="model"></span></div>
            <div class="opencode-go-dialog__row" data-row="session"><span class="opencode-go-dialog__label">${t("dialog.session")}</span><code class="opencode-go-dialog__session" data-role="session"></code><button class="block__icon block__icon--show ariaLabel" data-position="north" aria-label="${t("dialog.copy")}" data-action="copy" type="button"><svg><use xlink:href="#iconCopy"></use></svg></button></div>
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
        const snapshot = this.host.snapshot();
        const setText = (role: string, value: string): void => {
            const element = root.querySelector<HTMLElement>('[data-role="' + role + '"]');
            if (element) {
                element.textContent = value;
            }
        };
        setText("provider", target?.displayName || t("check.none"));
        setText("endpoint", target?.baseURL || t("check.none"));
        // 显示真正发给上游的模型 name；思源自己分配的 id 对用户没有意义。
        // 当前模型不属于任何官方端点供应商（或还没有模型）时整行不显示：那是别的供应商的模型，
        // 摆在 OpenCode Go 的用量窗口里只会误导人。
        setText("model", target?.modelName || t("check.none"));
        this.toggleRow("model", !!target?.modelName);
        setText("session", this.host.sessionValue() || t("check.none"));
        // 会话 ID 只在从智能体面板那一行打开时展示：顶栏 / 设置页打开的窗口没有对应的对话。
        this.toggleRow("session", this.source === "agent");
        setText("updated", snapshot
            ? t("dialog.updatedAt", {time: formatRelativeTime(snapshot.fetchedAt, Date.now(), t)})
            : t("dialog.never"));
        const windows = root.querySelector<HTMLElement>('[data-role="windows"]');
        if (windows) {
            windows.innerHTML = this.windowsHtml(snapshot);
        }
        // 错误块在「最后更新 + 刷新按钮」下面那一格：数据也许是上一次的，原因照样写清楚。
        const failure = this.host.failure();
        const error = root.querySelector<HTMLElement>('[data-role="error"]');
        if (error) {
            if (failure) {
                const detail = failure.detail ? " · " + failure.detail : "";
                error.textContent = t("dialog.error") + ": " + failure.message + detail;
                error.classList.remove("fn__none");
            } else {
                error.textContent = "";
                error.classList.add("fn__none");
            }
        }
    }

    /** 按需隐藏元信息里的整行（用思源自己的 `fn__none`，不做行内样式）。 */
    private toggleRow(row: "model" | "session", visible: boolean): void {
        const element = this.dialog?.element.querySelector<HTMLElement>('[data-row="' + row + '"]');
        element?.classList.toggle("fn__none", !visible);
    }

    private windowsHtml(snapshot: UsageSnapshot | null): string {
        const t = this.host.t;
        const windows = snapshot?.windows ?? {};
        const remaining = this.host.remaining();
        return USAGE_WINDOW_KEYS.map((key) => {
            const window = windows[key];
            const percent = typeof window?.percent === "number"
                ? displayedPercent(window.percent, remaining)
                : undefined;
            const percentText = typeof percent === "number"
                ? t(remaining ? "dialog.percentRemaining" : "dialog.percent", {percent})
                : t("dialog.percentUnknown");
            const limited = window?.status === "rate-limited"
                ? `<span class="opencode-go-dialog__limited">${t("dialog.rateLimited")}</span>`
                : "";
            // 进度条用的就是上面那个「要展示的」百分比：剩余样式下条画的也是剩余量，
            // 否则会出现「剩余 40%」却把条填到 60% 的自相矛盾。
            return `<div class="opencode-go-dialog__window">
    <div class="opencode-go-dialog__window-head">
        <span>${t(WINDOW_TITLE_KEY[key])}</span>
        <span class="opencode-go-dialog__window-value">${limited}${percentText}</span>
    </div>
    <div class="opencode-go-bar"><span style="width:${typeof percent === "number" ? percent : 0}%"></span></div>
    <div class="opencode-go-dialog__window-foot">${this.footText(key, window?.resetsAt)}</div>
</div>`;
        }).join("");
    }

    private footText(key: UsageWindowKey, resetsAt: string | undefined): string {
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
        // 5 小时窗口最多也就几小时，保持「小时 + 分」；周/月跨度到天，按「天 小时 分」显示。
        const time = key === "rolling" ? formatDuration(delta, t) : formatSpanDuration(delta, t);
        return t("dialog.reset", {time});
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
