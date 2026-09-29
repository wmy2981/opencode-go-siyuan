import type {LogFn} from "./types";

const PREFIX = "opencode-go-siyuan";

/**
 * 控制台日志：只在调试开关打开时输出，并按「主题 + 内容」去重，避免轮询把控制台刷满。
 * 调用方负责不要把 API Key 写进 message。
 */
export const createLogger = (enabled: () => boolean): LogFn => {
    let lastTopic = "";
    let lastMessage = "";
    return (topic: string, message: string): void => {
        if (!enabled()) {
            return;
        }
        if (topic === lastTopic && message === lastMessage) {
            return;
        }
        lastTopic = topic;
        lastMessage = message;
        console.log(PREFIX + " [" + topic + "] " + message);
    };
};
