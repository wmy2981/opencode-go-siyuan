import {fetchSyncPost} from "siyuan";
import type {SettingVariable, SettingVariables} from "siyuan";
import {newSessionID, SESSION_VARIABLE} from "./opencode";
import type {LogFn, PluginSettings} from "./types";

const AGENT_CHAT_PATH = "/api/ai/agent/chat";
const EDITOR_CHAT_PATH = "/api/ai/editor/chat";

type FetchLike = typeof window.fetch;

/**
 * 从一次对话请求里取出这段对话的稳定 ID。
 *
 * 内核只支持静态请求头，唯一能做到「每请求不同」的通道是 `{{vars.NAME}}`：
 * 供应商请求头写 `{{vars.OPENCODE_GO_SESSION}}`，内核在**每个请求**上解析它
 * （`kernel/api/agent.go` 每次调用 `ResolveAIProviderHeaders`）。
 * 因此这里在请求离开前端之前先把变量写成该请求自己的会话 ID。
 */
export const sessionIDOfChatRequest = (pathname: string, body: unknown): string => {
    if (pathname !== AGENT_CHAT_PATH && pathname !== EDITOR_CHAT_PATH) {
        return "";
    }
    if (!body || typeof body !== "object") {
        return "";
    }
    const payload = body as {sessionID?: unknown; taskID?: unknown};
    const candidate = pathname === AGENT_CHAT_PATH ? payload.sessionID : payload.taskID;
    return typeof candidate === "string" && candidate.trim() ? candidate.trim() : "";
};

const pathnameOf = (input: RequestInfo | URL): string => {
    try {
        if (typeof input === "string") {
            return new URL(input, location.href).pathname;
        }
        if (input instanceof URL) {
            return input.pathname;
        }
        if (typeof Request !== "undefined" && input instanceof Request) {
            return new URL(input.url, location.href).pathname;
        }
    } catch {
        // 取不到就当作不是对话请求
    }
    return "";
};

const parseBody = (body: BodyInit | null | undefined): unknown => {
    if (typeof body !== "string" || !body) {
        return undefined;
    }
    try {
        return JSON.parse(body);
    } catch {
        return undefined;
    }
};

const readVariables = (): SettingVariables | undefined =>
    (window.siyuan?.config as unknown as {variables?: SettingVariables} | undefined)?.variables;

/**
 * 会话头控制器。
 *
 * - 动态模式：包装 `window.fetch`，在 `/api/ai/agent/chat`（读 `sessionID`）与
 *   `/api/ai/editor/chat`（读 `taskID`）发出之前，把变量写成该请求的会话 ID，然后放行。
 *   同一会话内不重复写盘。
 * - 静态模式：不包装，只把变量写成一个安装级 ID。
 * - 变量缺失时内核会把 `{{vars.OPENCODE_GO_SESSION}}` 原样发出，仍然是非空值，
 *   所以失败模式是「所有会话共用一个字面量、缓存变差」，不会 400。
 */
export class SessionHeaderController {
    private originalFetch: FetchLike | null = null;
    private wrapper: FetchLike | null = null;
    private currentValue = "";
    private writing: Promise<void> | null = null;

    constructor(
        private readonly getSettings: () => PluginSettings,
        private readonly patchSettings: (patch: Partial<PluginSettings>) => Promise<void>,
        private readonly log: LogFn,
    ) {
    }

    /** 当前变量里的会话 ID（尚未写入时为空串）。 */
    value(): string {
        return this.currentValue;
    }

    /** 按当前设置安装或卸下拦截，并保证变量已经有非空值。 */
    async sync(): Promise<void> {
        const settings = this.getSettings();
        if (!settings.dynamicSession) {
            this.uninstall();
            await this.writeVariable(await this.staticID());
            return;
        }
        this.install();
        const existing = this.readVariable();
        if (existing) {
            this.currentValue = existing;
            return;
        }
        await this.writeVariable(await this.staticID());
    }

    /** `onunload`：还原 fetch。变量保留，因为供应商请求头还在引用它。 */
    stop(): void {
        this.uninstall();
    }

    /** `uninstall`：插件被移除时删掉自己维护的变量。 */
    async removeVariable(): Promise<void> {
        const variables = readVariables();
        const items = (variables?.items ?? []).filter((item): item is SettingVariable => !!item);
        if (!items.some((item) => item.name === SESSION_VARIABLE)) {
            return;
        }
        const remaining = items.filter((item) => item.name !== SESSION_VARIABLE);
        try {
            await this.writeItems(remaining);
            this.currentValue = "";
            this.log("session", "session variable removed");
        } catch (error) {
            this.log("session", "remove variable failed: " + String(error));
        }
    }

    private install(): void {
        if (this.wrapper) {
            return;
        }
        const original = window.fetch;
        const controller = this;
        const wrapper = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
            const pathname = pathnameOf(input);
            const sessionID = pathname ? sessionIDOfChatRequest(pathname, parseBody(init?.body)) : "";
            if (!sessionID) {
                return original.call(window, input, init);
            }
            // 必须等变量写成功再放行，否则内核可能用上一个会话的 ID 发出去。
            return controller.ensureValue(sessionID).then(
                () => original.call(window, input, init),
                (error) => {
                    // 写变量失败绝不能挡住用户发消息。
                    controller.log("session", "write session variable failed: " + String(error));
                    return original.call(window, input, init);
                },
            );
        };
        this.originalFetch = original;
        this.wrapper = wrapper as FetchLike;
        window.fetch = this.wrapper;
        this.log("session", "fetch interception installed");
    }

    private uninstall(): void {
        if (!this.wrapper) {
            return;
        }
        if (window.fetch === this.wrapper && this.originalFetch) {
            window.fetch = this.originalFetch;
        }
        this.wrapper = null;
        this.originalFetch = null;
        this.log("session", "fetch interception removed");
    }

    private async ensureValue(value: string): Promise<void> {
        if (value === this.currentValue) {
            return;
        }
        if (this.writing) {
            await this.writing;
            if (value === this.currentValue) {
                return;
            }
        }
        const task = this.writeVariable(value);
        this.writing = task;
        try {
            await task;
        } finally {
            if (this.writing === task) {
                this.writing = null;
            }
        }
    }

    private readVariable(): string {
        const items = readVariables()?.items ?? [];
        const found = items.find((item) => item?.name === SESSION_VARIABLE);
        return found && typeof found.value === "string" ? found.value.trim() : "";
    }

    /** 写入变量。`setVariables` 是整体替换语义，所以要把现有变量一起回传。 */
    private async writeVariable(value: string): Promise<void> {
        if (!value || value === this.currentValue) {
            return;
        }
        const variables = readVariables();
        const items = (variables?.items ?? []).filter((item): item is SettingVariable => !!item);
        const index = items.findIndex((item) => item.name === SESSION_VARIABLE);
        if (index >= 0) {
            if (items[index].value === value) {
                this.currentValue = value;
                return;
            }
            items[index] = {name: SESSION_VARIABLE, value};
        } else {
            items.push({name: SESSION_VARIABLE, value});
        }
        await this.writeItems(items);
        this.currentValue = value;
        this.log("session", "session variable updated");
    }

    private async writeItems(items: SettingVariable[]): Promise<void> {
        const response = await fetchSyncPost("/api/setting/setVariables", {items});
        if (response.code !== 0) {
            throw new Error(response.msg || "setVariables failed");
        }
        (window.siyuan.config as unknown as {variables: SettingVariables}).variables =
            response.data as SettingVariables;
    }

    private async staticID(): Promise<string> {
        const existing = this.getSettings().staticSessionId.trim();
        if (existing) {
            return existing;
        }
        const generated = newSessionID();
        await this.patchSettings({staticSessionId: generated});
        return generated;
    }
}
