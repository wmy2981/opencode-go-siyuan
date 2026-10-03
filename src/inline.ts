import type {Translate} from "./i18n";
import type {LogFn, UsageResult} from "./types";

/** 输入区整块，用量行插在它后面（输入框外面、紧贴下沿）。 */
const INPUT_AREA_SELECTOR = ".sy__agentChat .agent-chat__input-area";
const NODE_ATTR = "data-opencode-go-usage";
const NODE_CLASS = "opencode-go-usage";
/** 按下到抬起之间位移超过这个像素数就算「滑动」，不算「点击」（与思源键盘工具栏同一取值）。 */
const TAP_SLOP = 10;

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
            // 已经插好就一个字节都不动：`insertAdjacentElement` 会先把节点摘下来再插回去，
            // 而浏览器在「按下与抬起之间 mousedown 目标被摘除」时根本不派发 click —— 桌面端
            // 按住那 100 毫秒里只要发生一次这种搬家，这次点击就白点了（表现正是「点了没弹窗」）。
            // 输入区后面那一格是公开位置，别的插件同样会往里插一行，一旦这里发现位置被占就挪
            // 回去，两边就会以每帧一次的频率互相搬家，按住期间必然出错。因此这里只认「还在
            // 文档里」，位置被挤到下一格也随它去；只有节点真的脱离了文档（面板被重建）才重建。
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
        // 用 click 而不是「按下就弹窗」：触屏上想从这一行往下滚动的第一下也落在节点上，
        // 按下即弹窗等于手指一碰就出弹窗（旧实现还在 touchstart 上 preventDefault，顺手把
        // 滚动也一起掐掉了）。滑动/滚动结束后浏览器根本不会补 click，所以判定交给浏览器。
        // 弹窗由这次 click 自己插进 DOM，这一下 click 已经派发完毕，不会再落到刚出现的
        // `.b3-dialog__scrim` 上（`app/src/dialog/index.ts` 给它绑了「点一下就 destroy」），
        // 因此这里不需要任何 preventDefault；面板整体重建换掉节点时也不用接管状态 ——
        // click 是在抬起的那一刻重新命中的（前提是这一行在按住期间没被摘下来，见上面 apply()
        // 里「绝不搬动已插入的节点」的说明）。内核自己的 token 浮层就是这么绑的
        // （`app/src/layout/dock/agent/AgentChat.ts` 里 tokenDisplayEl 的 click）。
        // 自己再记一次位移，只为兜住「鼠标按住划选」这类浏览器照样会派发 click 的情况
        // （思源自己的键盘工具栏也用 10px 判定位移，见 `app/src/mobile/util/keyboardToolbar.ts`）。
        let pointerId = -1;
        let startX = 0;
        let startY = 0;
        let moved = false;
        node.addEventListener("pointerdown", (event) => {
            if (event.button !== 0) {
                return;
            }
            pointerId = event.pointerId;
            startX = event.clientX;
            startY = event.clientY;
            moved = false;
        });
        node.addEventListener("pointermove", (event) => {
            if (event.pointerId !== pointerId) {
                return;
            }
            if (Math.abs(event.clientX - startX) > TAP_SLOP || Math.abs(event.clientY - startY) > TAP_SLOP) {
                moved = true;
            }
        });
        node.addEventListener("click", (event) => {
            const tapped = !moved;
            pointerId = -1;
            moved = false;
            // 不冒泡：面板自己的 click 处理（`AgentChat.ts:1007`）会给输入框抢焦点，
            // 移动端会连带把软键盘弹回来，盖住刚打开的弹窗。
            event.stopPropagation();
            if (tapped) {
                this.host.onClick();
            }
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
