import {getFrontend, openSetting, Plugin} from "siyuan";
import type {IWebSocketData} from "siyuan";
import "./index.scss";
import {UsageDialog} from "./dialog";
import type {Translate} from "./i18n";
import {createTranslator} from "./i18n";
import {InlineUsage} from "./inline";
import {createLogger} from "./log";
import {ProviderManager} from "./provider";
import type {ProviderCheck} from "./provider";
import {ProviderIconPatcher} from "./providerIcon";
import {SessionHeaderController} from "./session";
import {DEFAULT_SETTINGS, loadSettings, normalizeSettings, saveSettings} from "./settings";
import {openSettingsPanel, openWithoutAutofocus} from "./settingsPanel";
import type {LogFn, PluginSettings, UsageResult} from "./types";
import {UsageClient} from "./usage";

/** 跳到供应商详情页时等待卡片渲染的上限与轮询间隔。 */
const JUMP_TIMEOUT_MS = 3000;
const JUMP_INTERVAL_MS = 100;

const isMobileFrontend = (): boolean => {
    const frontend = getFrontend();
    return frontend === "mobile" || frontend === "browser-mobile";
};

/**
 * 打开思源原生的设置弹窗并切到指定页签。
 *
 * 这就是官方插件 API 里的 `openSetting`（`app/src/plugin/API.ts` 的 `createAPI()` 暴露了它），
 * 运行时签名是 `openSetting(app, tab?)`，桌面端与移动端各走各的原生实现；
 * 只是 npm 包的类型声明还停在 `openSetting(app)`，所以这里显式放宽一次。
 */
const openNativeSetting = openSetting as unknown as (app: unknown, tab: string) => void;

export default class OpenCodeGoPlugin extends Plugin {
    private settings: PluginSettings = {...DEFAULT_SETTINGS};
    private log: LogFn = () => undefined;
    private t: Translate = (key) => key;
    private provider: ProviderManager | null = null;
    private session: SessionHeaderController | null = null;
    private usage: UsageClient | null = null;
    private inline: InlineUsage | null = null;
    private dialog: UsageDialog | null = null;
    private iconPatcher: ProviderIconPatcher | null = null;
    private timer = 0;
    private lastUsage: UsageResult | null = null;

    private readonly handleAIConfigChanged = (): void => {
        void this.onConfigChanged();
    };

    private readonly handleFocus = (): void => {
        this.inline?.schedule();
    };

    private readonly handleWsMain = (event: CustomEvent<IWebSocketData>): void => {
        if ((event.detail as {cmd?: string} | undefined)?.cmd === "setConf") {
            void this.onConfigChanged();
        }
    };

    async onload(): Promise<void> {
        this.settings = await loadSettings(this);
        this.log = createLogger(() => this.settings.debugLog);
        this.t = createTranslator(this.i18n as Record<string, unknown>);

        this.provider = new ProviderManager(
            () => this.settings,
            (patch) => this.patchSettings(patch),
            this.log,
        );
        this.session = new SessionHeaderController(
            () => this.settings,
            (patch) => this.patchSettings(patch),
            this.log,
        );
        this.usage = new UsageClient(
            () => this.provider?.target(),
            () => this.session?.value() ?? "",
            this.t,
            this.log,
        );
        this.inline = new InlineUsage({
            t: this.t,
            active: () => !!this.provider?.isInUse(),
            onClick: () => this.dialog?.open(),
            log: this.log,
        });
        this.dialog = new UsageDialog({
            t: this.t,
            target: () => this.provider?.target(),
            sessionValue: () => this.session?.value() ?? "",
            result: () => this.lastUsage,
            refresh: () => this.refreshUsage(),
            isMobile: isMobileFrontend,
            log: this.log,
        });
        this.iconPatcher = new ProviderIconPatcher(this.log);

        this.inline.setEnabled(this.settings.inlineUsage);
        await this.session.sync();
        this.startTimer();

        window.addEventListener("siyuan-ai-config-changed", this.handleAIConfigChanged);
        window.addEventListener("focus", this.handleFocus);
        this.eventBus.on("ws-main", this.handleWsMain);
        this.iconPatcher.start();
        this.inline.schedule();

        // 插件不再自动创建或修复供应商：对宿主机配置的每一次改动都必须由用户在
        // 设置面板的指引里显式点按钮触发。启动时只读地查一次用量。
        void this.refreshUsage();
    }

    onLayoutReady(): void {
        this.inline?.schedule();
    }

    openSetting(): void {
        if (!this.provider || !this.session) {
            return;
        }
        const panel = openSettingsPanel({
            t: this.t,
            settings: () => this.settings,
            save: (draft) => this.applySettings(draft),
            inspect: () => this.provider!.inspect(),
            create: () => this.createProvider(),
            repair: () => this.repairProvider(),
            openProviderSetting: () => this.openProviderSetting(),
            refreshUsage: () => this.refreshUsage(),
            sessionValue: () => this.session!.value(),
            usage: () => this.lastUsage,
            isMobile: isMobileFrontend,
            log: this.log,
        });
        openWithoutAutofocus(panel.setting, this.displayName || this.name);
        // 打开设置页时强制刷新一次，结果回来后重绘只读自检区。
        void this.refreshUsage().then(() => panel.refreshInfo());
    }

    async onunload(): Promise<void> {
        window.clearInterval(this.timer);
        this.timer = 0;
        window.removeEventListener("siyuan-ai-config-changed", this.handleAIConfigChanged);
        window.removeEventListener("focus", this.handleFocus);
        this.eventBus.off("ws-main", this.handleWsMain);
        this.session?.stop();
        this.iconPatcher?.destroy();
        this.inline?.destroy();
        this.dialog?.close();
        this.inline = null;
        this.dialog = null;
        this.iconPatcher = null;
    }

    async uninstall(): Promise<void> {
        await this.session?.removeVariable();
    }

    private async onConfigChanged(): Promise<void> {
        this.inline?.schedule();
        await this.session?.sync();
        await this.refreshUsage();
    }

    /** 指引第 1 步：用户显式点「创建供应商」。 */
    private async createProvider(): Promise<ProviderCheck> {
        if (!this.provider) {
            throw new Error("provider manager is not ready");
        }
        const check = await this.provider.create();
        this.log("provider", check.exists
            ? "provider ready: " + check.providerId
            : "no OpenCode Go provider is present");
        return check;
    }

    /** 设置项「修复供应商配置」：显式覆盖冲突字段，并可重建被删掉的供应商。 */
    private async repairProvider(): Promise<ProviderCheck> {
        if (!this.provider) {
            throw new Error("provider manager is not ready");
        }
        const check = await this.provider.repair();
        this.log("provider", "provider repaired: " + check.providerId);
        return check;
    }

    /**
     * 指引第 2 步：打开思源原生的「设置 - 人工智能」，并点进这个供应商的设置页。
     *
     * 进入供应商详情页只能模拟一次点击：`aiProviderUi.ts` 的卡片是事件委托在
     * `#aiProviderCardsBlock` 上的普通 click，点它完全等价于用户自己点了一下；
     * `config/index.ts` 里也明确写了侧栏页签「兼容社区 JS 代码片段模拟点击」。
     */
    private async openProviderSetting(): Promise<void> {
        const providerId = this.provider?.inspect().providerId ?? "";
        openNativeSetting(this.app, "ai");
        if (!providerId) {
            return;
        }
        await this.clickProviderCard(providerId);
    }

    /** 等供应商卡片渲染出来再点它；超时就安静放弃，不打断用户手头的操作。 */
    private clickProviderCard(providerId: string): Promise<void> {
        return new Promise((resolve) => {
            const deadline = Date.now() + JUMP_TIMEOUT_MS;
            const tick = (): void => {
                const card = document.querySelector<HTMLElement>(
                    '#aiProviderCards .b3-card[data-provider-id="' + CSS.escape(providerId) + '"]');
                if (card) {
                    card.scrollIntoView({block: "nearest"});
                    card.click();
                    resolve();
                    return;
                }
                if (Date.now() > deadline) {
                    this.log("settings", "the provider card did not show up in time");
                    resolve();
                    return;
                }
                window.setTimeout(tick, JUMP_INTERVAL_MS);
            };
            window.setTimeout(tick, JUMP_INTERVAL_MS);
        });
    }

    private async refreshUsage(): Promise<UsageResult | null> {
        if (!this.usage) {
            return null;
        }
        const result = await this.usage.fetch();
        this.lastUsage = result;
        this.inline?.setResult(result);
        this.dialog?.refreshView();
        if (result.ok) {
            this.log("usage", "usage updated");
        }
        return result;
    }

    private startTimer(): void {
        window.clearInterval(this.timer);
        this.timer = window.setInterval(() => {
            if (document.hidden) {
                return;
            }
            void this.refreshUsage();
        }, this.settings.refreshIntervalSeconds * 1000);
    }

    private async patchSettings(patch: Partial<PluginSettings>): Promise<void> {
        this.settings = normalizeSettings({...this.settings, ...patch});
        await saveSettings(this, this.settings);
    }

    private async applySettings(draft: PluginSettings): Promise<void> {
        this.settings = normalizeSettings(draft);
        await saveSettings(this, this.settings);
        this.inline?.setEnabled(this.settings.inlineUsage);
        this.startTimer();
        await this.session?.sync();
        this.inline?.schedule();
        await this.refreshUsage();
    }
}
