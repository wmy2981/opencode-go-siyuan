declare module "*.scss";

/** 由 webpack `DefinePlugin` 在构建时从 `plugin.json` 注入的插件版本号。 */
declare const __PLUGIN_VERSION__: string;

/** 顶栏品牌图标的 viewBox 与内层图形，由 webpack 在构建时从 `assets/provider-icon.svg` 抽出。 */
declare const __PROVIDER_ICON_VIEWBOX__: string;
declare const __PROVIDER_ICON_BODY__: string;
