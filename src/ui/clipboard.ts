/**
 * 思源 App 的 WebView 里 `navigator.clipboard` 不可靠：Android / iOS / 鸿蒙各自用原生桥接实现复制
 * （内核前端的 `writeText` 同样先走桥接），而用手机浏览器打开局域网 http 地址时连这个 API 都不存在
 * （非安全上下文不提供它）。
 *
 * 只调 `navigator.clipboard.writeText` 时上面两类环境都会抛错，用户看到的就是「点了复制没反应」，
 * 所以这里按「原生桥接 → 网页剪贴板 → execCommand」依次降级，并把是否真的复制成功返回给调用方。
 */

interface NativeClipboardBridge {
    writeClipboard?: (text: string) => unknown;
}

interface ClipboardHostWindow {
    JSAndroid?: NativeClipboardBridge;
    JSHarmony?: NativeClipboardBridge;
    webkit?: {
        messageHandlers?: {
            setClipboard?: {postMessage: (text: string) => void};
        };
    };
}

/**
 * 网页剪贴板 API 都不通时的老式兜底：选中一个临时 textarea 再执行 copy 命令。
 * 只读属性用来避免移动端弹出软键盘，位置移出视口避免把弹窗顶偏。
 */
const copyByExecCommand = (text: string): boolean => {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    // iOS 上 select() 只认首个字符，必须再显式圈一遍范围。
    textarea.setSelectionRange(0, text.length);
    let copied = false;
    try {
        copied = document.execCommand("copy");
    } catch {
        copied = false;
    }
    textarea.remove();
    return copied;
};

/** 复制纯文本；返回是否真的写进了剪贴板。 */
export const copyText = async (text: string): Promise<boolean> => {
    const host = window as unknown as ClipboardHostWindow;
    try {
        if (host.JSAndroid?.writeClipboard) {
            host.JSAndroid.writeClipboard(text);
            return true;
        }
        if (host.JSHarmony?.writeClipboard) {
            return host.JSHarmony.writeClipboard(text) !== false;
        }
        if (host.webkit?.messageHandlers?.setClipboard) {
            host.webkit.messageHandlers.setClipboard.postMessage(text);
            return true;
        }
    } catch {
        // 桥接调用异常只说明这条路走不通，继续往下试网页剪贴板。
    }
    try {
        if (navigator.clipboard?.writeText) {
            // 必须同步发起：await 之前不能有其它异步等待，否则移动端会认为已经脱离用户手势而拒绝写入。
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // 非安全上下文、页面失焦、权限被拒都会抛到这里，交给 execCommand 兜底。
    }
    return copyByExecCommand(text);
};
