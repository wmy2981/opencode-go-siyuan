import {Plugin} from "siyuan";
import "./index.scss";

/**
 * 插件入口。
 *
 * 当前只有骨架：供应商原生注入、逐会话请求头与用量展示分别由后续提交接入。
 */
export default class OpenCodeGoPlugin extends Plugin {
    async onload(): Promise<void> {
        console.log("opencode-go-siyuan: loaded");
    }

    async onunload(): Promise<void> {
        console.log("opencode-go-siyuan: unloaded");
    }
}
