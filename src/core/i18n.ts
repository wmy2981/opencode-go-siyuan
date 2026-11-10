/** 极简 i18n：按 key 取文案并替换 `{name}` 占位符，缺失时回落 key 本身。 */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

export const createTranslator = (messages: Record<string, unknown> | undefined): Translate => {
    return (key: string, params?: Record<string, string | number>): string => {
        const raw = messages ? messages[key] : undefined;
        let text = typeof raw === "string" ? raw : key;
        if (params) {
            for (const [name, value] of Object.entries(params)) {
                text = text.split("{" + name + "}").join(String(value));
            }
        }
        return text;
    };
};
