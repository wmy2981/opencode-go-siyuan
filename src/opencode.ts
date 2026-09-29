/**
 * OpenCode Go 的官方端点常量与判定helpers。
 *
 * 事实来源（2026-09-29 核对）：
 * - 官方文档 https://opencode.ai/docs/go/ 给出 Chat Completions 端点为
 *   `https://opencode.ai/zen/go/v1`，并要求客户端在 `x-opencode-session` 里发送
 *   每段对话稳定的会话 ID、同时使用自己的 User-Agent。
 * - 缺少 `x-opencode-session` 时网关直接返回 `400 MissingSessionID`，且该检查发生在
 *   鉴权之前，所以这个头不是可选优化。
 * - `/v1/models` 免鉴权；`/v1/usage` 需要 `Authorization: Bearer <key>`。
 */

export const OPENCODE_GO_HOST = "opencode.ai";
export const OPENCODE_GO_PATH_PREFIX = "/zen/go";
export const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";

export const SESSION_HEADER = "x-opencode-session";
export const USER_AGENT_HEADER = "User-Agent";
/** 变量库里的名字：供应商请求头通过 `{{vars.OPENCODE_GO_SESSION}}` 引用它。 */
export const SESSION_VARIABLE = "OPENCODE_GO_SESSION";

export const PROVIDER_DISPLAY_NAME = "OpenCode Go";
export const PLUGIN_PACKAGE_NAME = "opencode-go-siyuan";
/** 思源把插件目录托管在 /plugins/<name>/ 下，供应商卡片用这个地址加载官方图标。 */
export const PROVIDER_ICON_URL = "/plugins/" + PLUGIN_PACKAGE_NAME + "/provider-icon.svg";

export const DEFAULT_PLUGIN_UA = "siyuan-opencode-go/0.2.0";
export const USAGE_TIMEOUT_MS = 15000;

/**
 * 净化要放进 HTTP 头的取值。
 *
 * 粘贴 API Key 时很容易夹带空白、换行、零宽字符或 BOM（复制自网页/聊天工具时尤其常见）。
 * 这些字符永远不可能是密钥的一部分，但它们会让 `fetch` 直接抛
 * `String contains non ISO-8859-1 code point`，或者被内核原样发给上游、变成
 * `Invalid API key.`。所以读取与写回时都先做这一步。
 */
export const sanitizeHeaderValue = (raw: string): string =>
    typeof raw === "string" ? raw.replace(/[\s\u200b-\u200d\u2060\ufeff]/g, "") : "";

/** 头部取值里第一个超出 ISO-8859-1 的字符；没有则返回 undefined。 */
export const findNonASCII = (value: string): {index: number; codePoint: number} | undefined => {
    for (let index = 0; index < value.length; index++) {
        const codePoint = value.codePointAt(index) ?? 0;
        if (codePoint > 0xff) {
            return {index, codePoint};
        }
    }
    return undefined;
};

/**
 * 原始取值里第一个「净化也去不掉」的非 ASCII 字符。
 *
 * 下标按用户实际看到的原始字符串算，同时跳过空白/零宽这类点一下修复就能清理的杂质——
 * 否则提示的位置会指在杂质上，用户照着改还是错的。
 */
export const findBlockingNonASCII = (raw: string): {index: number; codePoint: number} | undefined => {
    if (typeof raw !== "string") {
        return undefined;
    }
    for (let index = 0; index < raw.length; index++) {
        const char = raw[index];
        if (sanitizeHeaderValue(char) !== char) {
            continue;
        }
        const codePoint = raw.codePointAt(index) ?? 0;
        if (codePoint > 0xff) {
            return {index, codePoint};
        }
    }
    return undefined;
};

/** baseURL 是否指向 OpenCode Go 官方端点。只看 host 与路径前缀，忽略大小写和结尾斜杠。 */
export const isOpenCodeGoBaseURL = (baseURL: string): boolean => {
    if (typeof baseURL !== "string" || !baseURL.trim()) {
        return false;
    }
    try {
        const url = new URL(baseURL.trim());
        return url.hostname.toLowerCase() === OPENCODE_GO_HOST &&
            url.pathname.toLowerCase().startsWith(OPENCODE_GO_PATH_PREFIX);
    } catch {
        return false;
    }
};

/**
 * 拼用量接口地址。
 * 上游同时存在带 `/v1` 与不带 `/v1` 的 baseURL（第三方实现里都有），这里统一补到 `/v1`。
 */
export const usageURLFrom = (baseURL: string): string | undefined => {
    if (!isOpenCodeGoBaseURL(baseURL)) {
        return undefined;
    }
    const url = new URL(baseURL.trim());
    const path = url.pathname.replace(/\/+$/, "");
    const normalized = path.toLowerCase().endsWith("/v1") ? path : path + "/v1";
    return url.origin + normalized + "/usage";
};

/** 生成合法形态的思源节点 ID（14 位时间戳 + `-` + 7 位随机），避免被 `AI.Normalize()` 重新分配。 */
export const newNodeID = (): string => {
    const pad = (value: number): string => String(value).padStart(2, "0");
    const now = new Date();
    const stamp = String(now.getFullYear()) + pad(now.getMonth() + 1) + pad(now.getDate()) +
        pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    let suffix = "";
    for (let i = 0; i < 7; i++) {
        suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return stamp + "-" + suffix;
};

/** 稳定的安装级/会话级 ID：优先用平台 UUID，不可用时退回手工拼接的 v4 形态。 */
export const newSessionID = (): string => {
    const cryptoObj = window.crypto as Crypto | undefined;
    if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
        try {
            return cryptoObj.randomUUID();
        } catch {
            // 非安全上下文等情况退回手工生成
        }
    }
    const hex = "0123456789abcdef";
    let out = "";
    for (let i = 0; i < 36; i++) {
        if (i === 8 || i === 13 || i === 18 || i === 23) {
            out += "-";
        } else if (i === 14) {
            out += "4";
        } else if (i === 19) {
            out += hex[(Math.floor(Math.random() * 4) + 8)];
        } else {
            out += hex[Math.floor(Math.random() * 16)];
        }
    }
    return out;
};
