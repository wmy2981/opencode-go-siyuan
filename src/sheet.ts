import type {Dialog} from "siyuan";

/** 面板根节点与面板本体（`.b3-dialog__container`）的样式类，全部由思源移动端样式表定义。 */
const SHEET_ROOT_CLASS = "mobile-bottom-sheet-dialog";
const SHEET_CLASS = "mobile-bottom-sheet";
/** 下拉关闭的判定：位移超过 min(120px, 面板高度的 1/4)，或位移超过 20px 且速度够快。 */
const CLOSE_DISTANCE = 120;
const CLOSE_VELOCITY = 0.6;
/** 拖动松手后吞掉紧随其后的那次 click，免得一次拖动被当成点了面板里的图标。 */
const SUPPRESS_CLICK_MS = 300;

/**
 * 等视口稳定后再展开面板。
 *
 * 打开弹窗会把输入框的软键盘收掉，此时视口高度还在变；面板得等布局落定再滑上来，否则会先按
 * 旧高度出现、再被挪一次。判定照抄思源 `app/src/menus/sheetOpen.ts` 的 `waitForSheetViewport`
 * （核对于 3.8.7-alpha.3），只去掉它为单元测试注入的时钟与帧回调：无键盘时下一帧就展开；有
 * 键盘时等视口恢复到满高并稳定 32ms，最多等 1 秒以兼容浮动键盘和窗口尺寸变化。
 */
const waitForViewport = (height: () => number, fullHeight: number, open: () => void): (() => void) => {
    const start = performance.now();
    const waitForKeyboard = fullHeight - height() > 100;
    let frame = 0;
    let cancelled = false;
    let restoredAt: number | undefined;
    const check = (): void => {
        if (cancelled) {
            return;
        }
        const now = performance.now();
        if (height() >= fullHeight - 2) {
            restoredAt = restoredAt ?? now;
        } else {
            restoredAt = undefined;
        }
        if (!waitForKeyboard || (restoredAt !== undefined && now - restoredAt >= 32) || now - start >= 1000) {
            open();
            return;
        }
        frame = window.requestAnimationFrame(check);
    };
    frame = window.requestAnimationFrame(check);
    return () => {
        cancelled = true;
        window.cancelAnimationFrame(frame);
    };
};

/**
 * 把思源原生弹窗改造成移动端底部面板（bottom sheet）。
 *
 * 外观全部来自思源移动端样式表，插件只补上内核自己会加的类名与那套交互：
 * `app/src/assets/scss/main/_mobile.scss` 的 `.mobile-bottom-sheet-dialog`（核对于 3.8.7-alpha.3）
 * 把弹窗贴到屏幕底部、圆角朝上，并让 `.b3-dialog--open` 时面板从 `translateY(100%)` 过渡到
 * `0` —— 「从底部滑出」本身就是内核的样式，插件不自造关键帧，也不用单独的窗口。
 * 交互照抄同一版本的 `app/src/mobile/util/bindBottomSheetDialog.ts` 与 `bindBottomSheetDrag.ts`
 * （含它们依赖的 `app/src/menus/sheetOpen.ts`）：菜单抽屉同款的抓手、只支持下拉关闭、不参与普通
 * 弹窗的移动与缩放。那两个内核模块没有对外暴露，插件只能照着重写一遍。
 *
 * 返回解绑函数，调用方在弹窗销毁时必须调一次，否则视口监听与触摸监听会跟着泄漏。
 */
export const bindBottomSheet = (dialog: Dialog, close: () => void): (() => void) => {
    const root = dialog.element;
    const frame = root.querySelector<HTMLElement>(".b3-dialog");
    const sheet = root.querySelector<HTMLElement>(".b3-dialog__container");
    const scrim = root.querySelector<HTMLElement>(".b3-dialog__scrim");
    if (!frame || !sheet || !scrim) {
        return () => undefined;
    }

    root.classList.add(SHEET_ROOT_CLASS);
    sheet.classList.add(SHEET_CLASS);
    // 底部面板只支持下拉关闭，不参与通用弹窗的移动与缩放：标题栏带 `resize__move`、容器带一圈
    // `resize__*` 把手，触摸设备上它们会被思源的拖拽桥接转成 mousedown，进而整块面板被拖走或
    // 缩放（`app/src/util/touchDragBridge.ts` 对手指落在弹窗内 `resize__*` 上的情况照旧派发
    // mousedown）。内核的底部面板同样把这两处摘掉。
    sheet.querySelector(".b3-dialog__header")?.classList.remove("resize__move");
    sheet.querySelectorAll(".resize__rd, .resize__ld, .resize__lt, .resize__rt, " +
        ".resize__r, .resize__d, .resize__t, .resize__l").forEach((element) => element.remove());
    // 抓手交给 `b3-menu__title--root` 的伪元素绘制，与内核菜单抽屉同一个观感。
    const handle = document.createElement("div");
    handle.className = "b3-menu__title b3-menu__title--root";
    handle.setAttribute("aria-hidden", "true");
    sheet.prepend(handle);

    // 初始定位不参与过渡：面板先藏到屏幕外，等视口落定后再滑上来。
    sheet.style.transition = "none";
    sheet.style.transform = "translateY(100%)";
    sheet.style.visibility = "hidden";

    /**
     * 把面板对齐到可视视口：软键盘弹起/收起、地址栏收放都会改 `visualViewport` 却不一定改
     * `window.innerHeight`，不对齐的话面板会有一部分落在键盘或地址栏后面。
     */
    const syncViewport = (): void => {
        const viewport = window.visualViewport;
        if (!viewport) {
            return;
        }
        frame.style.top = viewport.offsetTop + "px";
        frame.style.height = viewport.height + "px";
    };
    window.visualViewport?.addEventListener("resize", syncViewport);
    window.visualViewport?.addEventListener("scroll", syncViewport);
    syncViewport();

    let cancelOpen: (() => void) | undefined;
    let opening = false;
    const updateOpen = (): void => {
        // `b3-dialog--open` 由内核的 Dialog 自己加，构造之后一个事件循环才加；这里盯住它，
        // 也盯住销毁时把它摘掉的那一刻。
        if (!root.classList.contains("b3-dialog--open")) {
            cancelOpen?.();
            cancelOpen = undefined;
            return;
        }
        if (opening) {
            return;
        }
        opening = true;
        // `height1` 是无键盘时的布局高度：Android 上 innerHeight 会被键盘永久压掉一截，
        // 只和 innerHeight 比就永远等不到「键盘已收起」。
        const size = window.siyuan.mobile?.size;
        const orientation = size?.isLandscape ? size.landscape : size?.portrait;
        cancelOpen = waitForViewport(
            () => Math.min(window.innerHeight, window.visualViewport?.height ?? window.innerHeight),
            Math.max(window.innerHeight, orientation?.height1 || 0),
            () => {
                if (!root.isConnected || !root.classList.contains("b3-dialog--open")) {
                    return;
                }
                syncViewport();
                sheet.style.visibility = "";
                // 先还原样式表里的过渡、再清掉行内位移，面板才会从屏幕外动画滑上来。
                void sheet.offsetHeight;
                sheet.style.transition = "";
                void sheet.offsetHeight;
                sheet.style.transform = "";
            },
        );
    };
    const openObserver = new MutationObserver(() => updateOpen());
    openObserver.observe(root, {attributes: true, attributeFilter: ["class"]});
    updateOpen();

    let start: {x: number, y: number, time: number} | undefined;
    let dragging = false;
    let closing = false;
    let suppressClickUntil = 0;
    /** 回到「初始态」：行内的过渡、位移与遮罩透明度都清掉，样式表里的值重新生效。 */
    const resetDrag = (): void => {
        sheet.style.transition = "";
        sheet.style.transform = "";
        scrim.style.opacity = "";
        start = undefined;
        dragging = false;
    };

    const onTouchStart = (event: TouchEvent): void => {
        if (closing) {
            return;
        }
        resetDrag();
        const target = event.target as HTMLElement;
        // 可编辑区、面板里的图标按钮、关闭按钮都交还给自己处理。
        if (event.touches.length !== 1 ||
            target.closest('input, textarea, select, [contenteditable="true"], .protyle, .block__icon, .b3-dialog__close')) {
            return;
        }
        // 面板内部已经滚下去的内容不接管：这时下拉是滚动，不是关面板。
        let parent: HTMLElement | null = target;
        while (parent && parent !== sheet) {
            if (parent.scrollHeight > parent.clientHeight + 1 && parent.scrollTop > 0 &&
                ["auto", "scroll", "overlay"].includes(getComputedStyle(parent).overflowY)) {
                return;
            }
            parent = parent.parentElement;
        }
        const touch = event.touches[0];
        start = {x: touch.clientX, y: touch.clientY, time: performance.now()};
    };

    const onTouchMove = (event: TouchEvent): void => {
        if (!start || closing) {
            return;
        }
        if (event.touches.length !== 1) {
            resetDrag();
            return;
        }
        const touch = event.touches[0];
        const offset = touch.clientY - start.y;
        // 判定成下拉之前先看方向：先横向移动、先向上滑都不接管，免得把横滑和滚动一起吃掉。
        if (!dragging && (offset <= 0 || Math.abs(touch.clientX - start.x) > offset)) {
            start = undefined;
            return;
        }
        dragging = true;
        sheet.style.transition = "none";
        sheet.style.transform = "translateY(" + Math.max(0, offset) + "px)";
        scrim.style.opacity = Math.max(0, 1 - Math.max(0, offset) / Math.max(sheet.clientHeight, 1)).toString();
        if (event.cancelable) {
            event.preventDefault();
        }
    };

    const onTouchEnd = (event: TouchEvent): void => {
        if (closing) {
            return;
        }
        if (!dragging || !start || !event.changedTouches.length) {
            resetDrag();
            return;
        }
        const offset = Math.max(0, event.changedTouches[0].clientY - start.y);
        const duration = Math.max(performance.now() - start.time, 1);
        const shouldClose = offset > Math.min(CLOSE_DISTANCE, sheet.clientHeight * .25) ||
            (offset > 20 && offset / duration > CLOSE_VELOCITY);
        suppressClickUntil = performance.now() + SUPPRESS_CLICK_MS;
        // 把最后一次拖动位置提交成行内样式，关闭或回弹的过渡都从当前位移接着走。
        void sheet.offsetHeight;
        sheet.style.transition = "";
        start = undefined;
        dragging = false;
        if (shouldClose) {
            closing = true;
            // 次序不能反：先摘掉 `b3-dialog--open`，样式表的基础规则（`translateY(100%)`）随即
            // 接管，再清掉行内位移，面板就从手指离开的位置继续滑出屏幕。
            close();
            resetDrag();
            return;
        }
        resetDrag();
    };

    const onTouchCancel = (): void => {
        if (!closing) {
            resetDrag();
        }
    };

    const onClickCapture = (event: MouseEvent): void => {
        if (performance.now() < suppressClickUntil) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    };

    sheet.addEventListener("touchstart", onTouchStart, {passive: true});
    sheet.addEventListener("touchmove", onTouchMove, {passive: false});
    sheet.addEventListener("touchend", onTouchEnd);
    sheet.addEventListener("touchcancel", onTouchCancel);
    sheet.addEventListener("click", onClickCapture, true);

    return () => {
        cancelOpen?.();
        cancelOpen = undefined;
        openObserver.disconnect();
        sheet.removeEventListener("touchstart", onTouchStart);
        sheet.removeEventListener("touchmove", onTouchMove);
        sheet.removeEventListener("touchend", onTouchEnd);
        sheet.removeEventListener("touchcancel", onTouchCancel);
        sheet.removeEventListener("click", onClickCapture, true);
        handle.remove();
        window.visualViewport?.removeEventListener("resize", syncViewport);
        window.visualViewport?.removeEventListener("scroll", syncViewport);
    };
};
