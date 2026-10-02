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

/** 跳到供应商详情页时等待宿主渲染的上限与轮询间隔。 */
const JUMP_TIMEOUT_MS = 3000;
const JUMP_INTERVAL_MS = 100;

/**
 * 「设置 - 人工智能」这一页的入口形态，以及该页挂载完成的标志。
 *
 * 入口只在新宿主上才用得到（见 `openAiProvidersPage()`）：桌面端是设置弹窗侧栏的页签项
 * （`config/index.ts` 渲染的 `.b3-list-item`，带 `b3-list-item--focus` 的那个就是当前页，
 * 不再重复点），移动端是主菜单里的同类设置项（`mobile/menu/mainMenu.ts` 按设置页定义渲染成
 * `data-type="setting-tab"` 的条目）。`#aiProviderCards` 是这页里由 `genProviderCardsHtml()`
 * 生成的卡片容器，它出现就说明页已挂载。
 */
const AI_TAB_SELECTOR = ".config__side .b3-list-item[data-name='ai']:not(.b3-list-item--focus), " +
    "#menu .b3-menu__item[data-type='setting-tab'][data-name='ai']";
const AI_PROVIDERS_SELECTOR = "#aiProviderCards";

/** 顶栏用量按钮在插件内的唯一 id：宿主按它去重、排序，并按它持久化显隐状态。 */
const TOP_BAR_USAGE_ID = "usage";
/** 顶栏按钮引用的品牌图标 id；它由下面的 sprite 注册，改这里就要同时改 sprite 里的 id。 */
const TOP_BAR_USAGE_ICON_ID = "iconOpenCodeGo";
/**
 * 顶栏按钮的品牌图标。
 *
 * 图形与 `assets/provider-icon.svg`（供应商卡片加载的同一份官方 OpenCode 图标）同源：webpack
 * 在构建时从该文件抽出内层图形与 viewBox 注入（`__PROVIDER_ICON_*`），源码里不再抄一份路径
 * 数据，官方图标换版本时不会漏改。经 `addIcons` 注册成 sprite 后由 `addTopBar` 以图标 id 引用，
 * 与思源内置图标走同一条渲染路径（尺寸交给宿主样式），图形自带背景与描边，不依赖主题的
 * `currentColor`。
 */
const TOP_BAR_USAGE_ICON = '<symbol id="' + TOP_BAR_USAGE_ICON_ID + '" viewBox="' +
    __PROVIDER_ICON_VIEWBOX__ + '">' + __PROVIDER_ICON_BODY__ + "</symbol>";

const isMobileFrontend = (): boolean => {
    const frontend = getFrontend();
    return frontend === "mobile" || frontend === "browser-mobile";
};

/**
 * 打开思源原生的设置，并请求切到指定页签。
 *
 * 这就是官方插件 API 里的 `openSetting`（`app/src/plugin/API.ts` 的 `createAPI()` 暴露了它）。
 * 页签参数在两代宿主上待遇不同，插件因此同时留着新旧两条路径（见 `openProviderSetting()`）：
 * 3.8.7-alpha.1 及以前它等价于原生 `openSetting(app, tab?)`，页签生效；3.8.7-alpha.2 起换成了
 * 不收页签的 `openPluginSetting(app)`，第二个参数被忽略。npm 包的类型声明一直是
 * `openSetting(app)`，所以这里显式放宽一次。
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
    /** 品牌图标 sprite 是否已经注册（`addIcons` 每次加载只应调用一次）。 */
    private topBarIconReady = false;

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
        this.syncTopBarButton();

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
            openUsage: () => this.dialog?.open(),
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
     * 新旧两代宿主都支持，所以两条路径都留着，按宿主行为自动选择：
     *
     * - 旧路径（3.8.7-alpha.1 及以前）：插件 API 的 `openSetting` 就是原生
     *   `openSetting(app, tab?)`（`app/src/plugin/API.ts` 里直接就是 `openSetting,`），页签生效，
     *   设置弹窗直接落在「人工智能」页，`#aiProviderCards` 立刻就在当前文档里，只要再点一次卡片。
     *   下面那行带 `"ai"` 的调用就是给这代宿主用的 —— 新宿主会忽略它，但别当无效参数删掉。
     * - 新路径（3.8.7-alpha.2 起，含 dev 上的 alpha.3）：同一个 API 换成了不收页签的
     *   `openPluginSetting(app)`（`app/src/plugin/API.ts` 里 `openSetting: openPluginSetting`），
     *   桌面端停在「设置 - 编辑器」、移动端只把主菜单推出来，页签得自己补点一次。
     *
     * 走哪条用行为判断、不比版本号：先看「人工智能」页是否已经挂载，没挂载才去点页签 ——
     * alpha/beta 版本串不好比，远程内核与以后的版本也不该写死。
     */
    private async openProviderSetting(): Promise<void> {
        const providerId = this.provider?.inspect().providerId ?? "";
        openNativeSetting(this.app, "ai");
        await this.openAiProvidersPage();
        if (!providerId) {
            return;
        }
        await this.clickProviderCard(providerId);
    }

    /**
     * 确保「设置 - 人工智能」已经挂载：旧宿主上它已经在了，直接返回；新宿主上补点一次页签入口。
     *
     * 页签项与供应商卡片一样是普通 click：桌面端设置弹窗的侧栏项由 `config/index.ts` 直接挂监听
     * （那里写明「兼容社区 JS 代码片段模拟点击，不做事件委托」），移动端主菜单里的设置项由
     * `mobile/menu/index.ts` 冒泡到 `#menu` 上的委托处理。只点一次：页签项与它的监听同时创建
     * （移动端的委托更是启动时就挂在 `#menu` 上），点中即生效，重点只会把同一页重新挂载一遍、
     * 移动端还会再叠一层面板。超时就安静放弃，不打断用户手头的操作。
     */
    private openAiProvidersPage(): Promise<void> {
        return new Promise((resolve) => {
            const deadline = Date.now() + JUMP_TIMEOUT_MS;
            let clicked = false;
            const tick = (): void => {
                if (document.querySelector(AI_PROVIDERS_SELECTOR)) {
                    this.log("settings", clicked
                        ? "the ai settings page showed up after clicking its tab"
                        : "this host opened the ai settings page on its own");
                    resolve();
                    return;
                }
                if (!clicked) {
                    const tab = document.querySelector<HTMLElement>(AI_TAB_SELECTOR);
                    if (tab) {
                        clicked = true;
                        tab.click();
                    }
                }
                if (Date.now() > deadline) {
                    this.log("settings", "the ai settings page did not show up in time");
                    resolve();
                    return;
                }
                window.setTimeout(tick, JUMP_INTERVAL_MS);
            };
            window.setTimeout(tick, JUMP_INTERVAL_MS);
        });
    }

    /** 等供应商卡片渲染出来再点它；超时就安静放弃，不打断用户手头的操作。 */
    private clickProviderCard(providerId: string): Promise<void> {
        return new Promise((resolve) => {
            const deadline = Date.now() + JUMP_TIMEOUT_MS;
            const tick = (): void => {
                const card = document.querySelector<HTMLElement>(
                    AI_PROVIDERS_SELECTOR + ' .b3-card[data-provider-id="' + CSS.escape(providerId) + '"]');
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

    /**
     * 按设置注册或摘掉顶栏的用量按钮（默认关闭）。
     *
     * `id` 固定，宿主按它去重：开启时重复调用只是原地更新，不会多出第二个按钮；关闭时摘掉。
     * 插件被禁用或卸载时，顶栏条目与图标 sprite 都由宿主统一清理，这里不重复处理。
     */
    private syncTopBarButton(): void {
        if (!this.settings.topBarButton) {
            this.removeTopBar(TOP_BAR_USAGE_ID);
            return;
        }
        if (!this.topBarIconReady) {
            // 只注册一次：`addIcons` 会往宿主的 <svg data-name="<插件名>"><defs> 里追加，
            // 重复调用会插出第二个同名 symbol。
            this.addIcons(TOP_BAR_USAGE_ICON);
            this.topBarIconReady = true;
        }
        this.addTopBar({
            id: TOP_BAR_USAGE_ID,
            icon: TOP_BAR_USAGE_ICON_ID,
            // 标题同时是按钮的 aria-label/提示文案，与弹窗标题一致。
            title: this.t("dialog.title"),
            callback: () => this.dialog?.open(),
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
        this.syncTopBarButton();
        this.startTimer();
        await this.session?.sync();
        this.inline?.schedule();
        await this.refreshUsage();
    }
}
