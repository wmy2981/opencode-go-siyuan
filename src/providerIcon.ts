import {PROVIDER_ICON_URL} from "./opencode";
import type {LogFn} from "./types";

const CARDS_ID = "aiProviderCards";

/**
 * 给原生供应商卡片贴上官方图标。
 *
 * 思源对未知 baseURL 的供应商只渲染首字母头像（`aiProviderUi.ts` 的 `getProviderAvatarHTML`），
 * 而 `PROVIDER_PRESETS` 是应用内部模块、没有任何插件 API 可以追加预设。
 * 所以这里把卡片里的头像换成一张 `<img>`——与预设供应商的卡片标记逐字同构，
 * 尺寸（74px 圆角方块）完全由思源自己的 `.b3-card__img img` 规则接管。
 */
export class ProviderIconPatcher {
    private observer: MutationObserver | null = null;
    private frame = 0;
    private destroyed = false;

    constructor(
        private readonly providerId: () => string,
        private readonly displayName: () => string,
        private readonly log: LogFn,
    ) {
    }

    start(): void {
        this.observer = this.observer ?? new MutationObserver(() => this.schedule());
        this.observer.disconnect();
        this.observer.observe(document.body, {childList: true, subtree: true});
        this.schedule();
    }

    destroy(): void {
        this.destroyed = true;
        this.observer?.disconnect();
        this.observer = null;
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

    private patch(): void {
        const providerId = this.providerId();
        if (!providerId || !document.getElementById(CARDS_ID)) {
            return;
        }
        const card = document.querySelector<HTMLElement>(
            "#" + CARDS_ID + ' .b3-card[data-provider-id="' + CSS.escape(providerId) + '"]');
        if (!card) {
            return;
        }
        const avatar = card.querySelector<HTMLElement>(":scope > .b3-card__img");
        if (!avatar || avatar.querySelector("img")) {
            return;
        }
        const image = document.createElement("img");
        image.src = PROVIDER_ICON_URL;
        image.alt = this.displayName();
        avatar.replaceChildren(image);
        this.log("provider", "official icon applied to the native provider card");
    }
}
