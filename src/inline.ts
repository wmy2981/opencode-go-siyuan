import type {Translate} from "./i18n";
import type {LogFn, UsageResult} from "./types";

/** 输入区整块，用量行插在它后面（输入框外面、紧贴下沿）。 */
const INPUT_AREA_SELECTOR = ".sy__agentChat .agent-chat__input-area";
const NODE_ATTR = "data-opencode-go-usage";
const NODE_CLASS = "opencode-go-usage";

export interface InlineUsageHost {
    t: Translate;
    /** 当前是否通过 OpenCode Go 端点对话。 */
    active: () => boolean;
    onClick: () => void;
    log: LogFn;
}

/**
 * 智能体输入框下方的用量行。
 *
 * 只用思源原生 DOM 结构做锚点，不改写内核 DOM；面板会被整体重建，所以每次
 * 注入前都必须重新挂上 body 观察器（这是同类实现踩过的坑）。
 */
export class InlineUsage {
    private node: HTMLElement | null = null;
    private bodyObserver: MutationObserver | null = null;
    private panelObserver: MutationObserver | null = null;
    private frame = 0;
    private lastText = "";
    private result: UsageResult | null = null;
    private enabled = true;
    private destroyed = false;

    constructor(private readonly host: InlineUsageHost) {
    }

    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        this.schedule();
    }

    setResult(result: UsageResult | null): void {
        this.result = result;
        this.schedule();
    }

    /** 合并到下一帧，避免流式输出时每帧都动 DOM。 */
    schedule(): void {
        if (this.destroyed || this.frame) {
            return;
        }
        this.frame = window.requestAnimationFrame(() => {
            this.frame = 0;
            this.apply();
        });
    }

    destroy(): void {
        this.destroyed = true;
        this.bodyObserver?.disconnect();
        this.bodyObserver = null;
        this.panelObserver?.disconnect();
        this.panelObserver = null;
        if (this.frame) {
            window.cancelAnimationFrame(this.frame);
            this.frame = 0;
        }
        this.clearNode();
    }

    private apply(): void {
        if (this.destroyed) {
            return;
        }
        const anchor = document.querySelector<HTMLElement>(INPUT_AREA_SELECTOR);
        if (!anchor || !this.enabled || !this.host.active()) {
            this.clearNode();
            this.observeBody();
            return;
        }
        const panel = anchor.closest<HTMLElement>(".sy__agentChat");
        if (this.node?.isConnected) {
            // 只把它挪回锚点后面，绝不重建：重建会换掉节点与它上面的监听器，
            // 用户按下与抬起之间一旦发生这种替换，click 就永远不会产生。
            if (anchor.nextElementSibling !== this.node) {
                anchor.insertAdjacentElement("afterend", this.node);
            }
            this.observePanel(panel);
            this.render();
            return;
        }
        this.observeBody();
        this.panelObserver?.disconnect();
        this.node?.remove();
        const node = document.createElement("div");
        node.className = NODE_CLASS;
        node.setAttribute(NODE_ATTR, "true");
        node.setAttribute("tabindex", "0");
        node.setAttribute("role", "button");
        // 用 pointerdown 而不是 click：智能体面板里流式输出时每一帧都在改 DOM，
        // 节点只要在按下与抬起之间被挪动过，click 就永远等不到 —— 表现正是
        // 「点了但没有弹窗」。pointerdown 在按下的那一刻就触发，不受后续重绘影响。
        node.addEventListener("pointerdown", (event) => {
            if (event.button !== 0) {
                return;
            }
            event.preventDefault();
            this.host.onClick();
        });
        node.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                this.host.onClick();
            }
        });
        anchor.insertAdjacentElement("afterend", node);
        this.node = node;
        this.lastText = "";
        this.observePanel(panel);
        this.render();
    }

    private render(): void {
        if (!this.node) {
            return;
        }
        const text = this.textOf();
        if (text !== this.lastText) {
            this.lastText = text;
            this.node.textContent = text;
            this.node.classList.toggle("opencode-go-usage--error", !!this.result && !this.result.ok);
        }
        this.node.classList.toggle("fn__none", text === "");
    }

    private textOf(): string {
        const result = this.result;
        if (!result) {
            // 还没拿到数据时不显示，避免先闪一行再变成真数据。
            return "";
        }
        if (!result.ok) {
            return this.host.t("inline.unavailable");
        }
        const rolling = result.snapshot.windows.rolling?.percent;
        const weekly = result.snapshot.windows.weekly?.percent;
        if (typeof rolling !== "number" || typeof weekly !== "number") {
            return this.host.t("inline.unavailable");
        }
        return this.host.t("inline.value", {h5: rolling, week: weekly});
    }

    private observeBody(): void {
        this.bodyObserver = this.bodyObserver ?? new MutationObserver(() => this.schedule());
        // 注入前会 disconnect，因此这里必须无条件重新 observe，否则面板一旦被重建就再也回不来。
        this.bodyObserver.disconnect();
        if (!this.destroyed) {
            this.bodyObserver.observe(document.body, {childList: true, subtree: true});
        }
    }

    private observePanel(panel: HTMLElement | null): void {
        this.panelObserver = this.panelObserver ?? new MutationObserver(() => this.schedule());
        this.panelObserver.disconnect();
        if (!panel || this.destroyed) {
            return;
        }
        let element: HTMLElement | null = panel;
        while (element && element !== document.body) {
            this.panelObserver.observe(element, {
                childList: true,
                attributes: true,
                attributeFilter: ["class", "style"],
            });
            element = element.parentElement;
        }
    }

    private clearNode(): void {
        this.panelObserver?.disconnect();
        this.node?.remove();
        this.node = null;
        document.querySelectorAll("[" + NODE_ATTR + "]").forEach((element) => element.remove());
        this.lastText = "";
    }
}
