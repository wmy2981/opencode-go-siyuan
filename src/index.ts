import {getFrontend, Plugin} from "siyuan";
import type {IWebSocketData} from "siyuan";
import "./index.scss";
import {UsageDialog} from "./dialog";
import type {Translate} from "./i18n";
import {createTranslator} from "./i18n";
import {InlineUsage} from "./inline";
import {createLogger} from "./log";
import {PROVIDER_DISPLAY_NAME} from "./opencode";
import {ProviderManager} from "./provider";
import {ProviderIconPatcher} from "./providerIcon";
import {SessionHeaderController} from "./session";
import {DEFAULT_SETTINGS, loadSettings, normalizeSettings, saveSettings} from "./settings";
import {openSettingsPanel} from "./settingsPanel";
import type {LogFn, PluginSettings, UsageResult} from "./types";
import {UsageClient} from "./usage";

const isMobileFrontend = (): boolean => {
    const frontend = getFrontend();
    return frontend === "mobile" || frontend === "browser-mobile";
};

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
            () => this.provider.target(),
            () => this.session.value(),
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
            target: () => this.provider.target(),
            sessionValue: () => this.session.value(),
            result: () => this.lastUsage,
            refresh: () => this.refreshUsage(),
            isMobile: isMobileFrontend,
            log: this.log,
        });
        this.iconPatcher = new ProviderIconPatcher(
            () => this.settings.injectedProviderId,
            () => PROVIDER_DISPLAY_NAME,
            this.log,
        );

        this.inline.setEnabled(this.settings.inlineUsage);
        await this.session.sync();
        this.startTimer();

        window.addEventListener("siyuan-ai-config-changed", this.handleAIConfigChanged);
        window.addEventListener("focus", this.handleFocus);
        this.eventBus.on("ws-main", this.handleWsMain);
        this.iconPatcher.start();
        this.inline.schedule();

        void this.ensureProvider();
        void this.refreshUsage();
    }

    onLayoutReady(): void {
        this.inline?.schedule();
        void this.ensureProvider();
    }

    openSetting(): void {
        if (!this.provider || !this.session) {
            return;
        }
        const panel = openSettingsPanel({
            t: this.t,
            settings: () => this.settings,
            save: (draft) => this.applySettings(draft),
            inspect: () => this.provider.inspect(),
            repair: () => this.provider.repair(),
            refreshModels: () => this.provider.refreshModels(),
            refreshUsage: () => this.refreshUsage(),
            sessionValue: () => this.session.value(),
            usage: () => this.lastUsage,
            isMobile: isMobileFrontend,
            log: this.log,
        });
        panel.setting.open(this.displayName || this.name);
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
        if (this.settings.injectProvider) {
            await this.ensureProvider();
        }
        await this.refreshUsage();
    }

    private async ensureProvider(): Promise<void> {
        if (!this.provider) {
            return;
        }
        try {
            const check = await this.provider.ensure();
            this.log("provider", check.exists
                ? "provider ready: " + check.providerId
                : "no OpenCode Go provider is present");
        } catch (error) {
            this.log("provider", "ensure failed: " + String(error));
        }
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
        await this.ensureProvider();
        await this.refreshUsage();
    }
}
