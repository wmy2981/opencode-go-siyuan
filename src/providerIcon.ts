import {PROVIDER_DISPLAY_NAME, PROVIDER_ICON_URL} from "./opencode";
import {officialProviderCards} from "./provider";
import type {LogFn} from "./types";

const CARDS_ID = "aiProviderCards";

/**
 * 给原生供应商卡片贴上官方图标。
 *
 * 事实（核对过思源 3.8.6 的 `aiProviderUi.ts` / `aiProviderPresets.ts`）：
 * 卡片头像只由 `findProviderPreset(provider.baseURL)` 决定 —— 命中内置预设才拿得到
 * `preset.icon`，否则退化成首字母方块；预设数组是应用内部模块，没有任何插件 API 可以追加，
 * provider 配置里也没有图标字段。所以唯一可行的做法就是在渲染之后把头像换成一张 `<img>`，
 * 与预设供应商的卡片标记逐字同构（尺寸由思源自己的 `.b3-card__img img` 规则接管）。
 *
 * 目标是「按 baseURL 命中的全部卡片」，而不是「插件记录过的那个 id」：
 * 用户在原生页面改过 id、从别的设备同步过来、或者干脆自己手建了一个同端点供应商时，
 * 记录的 id 都可能对不上 —— 那正是「图标有时不显示」的来源。图标属于品牌本身，
 * 只要端点是我们认识的那一个就贴上去。
 */
export class ProviderIconPatcher {
    private bodyObserver: MutationObserver | null = null;
    private cardsObserver: MutationObserver | null = null;
    private frame = 0;
    private destroyed = false;

    constructor(private readonly log: LogFn) {
    }

    start(): void {
        this.observeBody();
        this.schedule();
    }

    destroy(): void {
        this.destroyed = true;
        this.bodyObserver?.disconnect();
        this.bodyObserver = null;
        this.cardsObserver?.disconnect();
        this.cardsObserver = null;
        if (this.frame) {
            window.cancelAnimationFrame(this.frame);
            this.frame = 0;
        }
    }

    private schedule(): void {
        if (this.destroyed || this.frame) {
            return;
        }
        this.frame = window.requestAnimationFrame(() => {
            this.frame = 0;
            this.patch();
        });
    }

    /**
     * 兜底观察整个 body，专管「设置页被打开 / 被关掉」。
     * 每次都要重新 observe：`patch()` 里会为了写 DOM 先把它断开，只判断对象在不在
     * 就会变成「只建不挂」，第一次之后这个兜底就彻底失效了。
     */
    private observeBody(): void {
        this.bodyObserver = this.bodyObserver ?? new MutationObserver(() => this.schedule());
        this.bodyObserver.disconnect();
        if (!this.destroyed) {
            this.bodyObserver.observe(document.body, {childList: true, subtree: true});
        }
    }

    /**
     * 设置页开着时改盯 `#aiProviderCards`：`renderProviderCards` 会整体替换它的
     * innerHTML（挂载、保存、删除、切回列表页都会走一次），盯它就够了，
     * 不必陪着智能体面板的流式输出每帧重跑。
     */
    private observeCards(cards: HTMLElement | null): void {
        this.cardsObserver = this.cardsObserver ?? new MutationObserver(() => this.schedule());
        this.cardsObserver.disconnect();
        if (cards && !this.destroyed) {
            this.cardsObserver.observe(cards, {childList: true, subtree: true});
        }
    }

    private patch(): void {
        if (this.destroyed) {
            return;
        }
        const cards = document.getElementById(CARDS_ID);
        if (!cards) {
            this.observeCards(null);
            this.observeBody();
            return;
        }
        this.cardsObserver?.disconnect();
        const targets = officialProviderCards();
        targets.forEach((target) => {
            const card = cards.querySelector<HTMLElement>(
                '.b3-card[data-provider-id="' + CSS.escape(target.providerId) + '"]');
            const avatar = card?.querySelector<HTMLElement>(".b3-card__img");
            if (!avatar) {
                return;
            }
            const image = avatar.querySelector("img");
            if (image?.getAttribute("src") === PROVIDER_ICON_URL) {
                return;
            }
            const next = document.createElement("img");
            next.src = PROVIDER_ICON_URL;
            next.alt = target.displayName || PROVIDER_DISPLAY_NAME;
            next.addEventListener("error", () => {
                this.log("provider", "official icon failed to load: " + PROVIDER_ICON_URL);
            });
            avatar.replaceChildren(next);
            this.log("provider", "official icon applied to the native provider card");
        });
        this.observeCards(cards);
        this.observeBody();
    }
}
