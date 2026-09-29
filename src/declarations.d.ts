declare module "*.scss";

/** 由 webpack `DefinePlugin` 在构建时从 `plugin.json` 注入的插件版本号。 */
declare const __PLUGIN_VERSION__: string;
