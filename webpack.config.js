const path = require("path");
const fs = require("fs");
const webpack = require("webpack");
const {EsbuildPlugin} = require("esbuild-loader");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const CopyPlugin = require("copy-webpack-plugin");
const ZipPlugin = require("zip-webpack-plugin");
const pluginManifest = require("./plugin.json");

// icon / preview 的实际文件名由 plugin.json 决定（集市要求包根目录下与字段同名）。
// 源文件放在 assets/ 下，打包时复制到包根目录。
const packageImagePatterns = [
    ["icon", "icon.png"],
    ["preview", "preview.png"],
].flatMap(([field, legacyName]) => {
    const fileName = pluginManifest[field] || (fs.existsSync(path.join("assets", legacyName)) ? legacyName : "");
    if (!fileName) {
        return [];
    }
    const source = path.join("assets", fileName);
    if (!fs.existsSync(source)) {
        throw new Error(`plugin.json 的 ${field} 声明了 ${fileName}，但 ${source} 不存在`);
    }
    return [{from: source, to: "./dist/"}];
});

// 供 AI 设置页的 provider 卡片直接引用的图标：思源把插件目录托管在 /plugins/<name>/ 下，
// 所以这个文件必须出现在包根目录，前端才能用 <img src="/plugins/opencode-go-siyuan/..."> 加载。
const extraAssetPatterns = ["provider-icon.svg"]
    .filter((fileName) => fs.existsSync(path.join("assets", fileName)))
    .map((fileName) => ({from: path.join("assets", fileName), to: "./dist/"}));

module.exports = (env, argv) => {
    const production = argv.mode === "production";
    const plugins = [
        // 插件标识里的版本号在构建时从 plugin.json 注入，源码里不再写死版本字面量。
        // 开发与生产构建都注入，避免两条路径行为不一致。
        new webpack.DefinePlugin({
            __PLUGIN_VERSION__: JSON.stringify(pluginManifest.version),
        }),
        new MiniCssExtractPlugin({
            filename: production ? "dist/index.css" : "index.css",
        }),
    ];
    if (production) {
        plugins.push(
            new webpack.BannerPlugin({
                banner: () => fs.readFileSync("LICENSE").toString(),
            }),
        );
        plugins.push(
            new CopyPlugin({
                patterns: [
                    ...packageImagePatterns,
                    ...extraAssetPatterns,
                    {from: "README*.md", to: "./dist/"},
                    {from: "plugin.json", to: "./dist/"},
                    {from: "src/i18n/", to: "./dist/i18n/"},
                ],
            }),
        );
        // package.zip 里必须是扁平结构（不带 dist/ 前缀），集市按根目录取文件
        plugins.push(
            new ZipPlugin({
                filename: "package.zip",
                algorithm: "gzip",
                include: [/dist/],
                pathMapper: (assetPath) => assetPath.replace("dist/", ""),
            }),
        );
    } else {
        plugins.push(
            new CopyPlugin({
                patterns: [
                    {from: "src/i18n/", to: "./i18n/"},
                ],
            }),
        );
    }
    return {
        mode: argv.mode || "development",
        watch: !production,
        devtool: production ? false : "eval-source-map",
        output: {
            filename: "[name].js",
            path: path.resolve(__dirname),
            libraryTarget: "commonjs2",
            library: {
                type: "commonjs2",
            },
        },
        externals: {
            siyuan: "siyuan",
        },
        entry: {
            [production ? "dist/index" : "index"]: "./src/index.ts",
        },
        optimization: {
            minimize: production,
            minimizer: [
                // 保留全部 console 调用：插件出问题时可诊断性比几 KB 体积重要得多。
                new EsbuildPlugin({
                    drop: [],
                    pure: [],
                }),
            ],
        },
        resolve: {
            extensions: [".ts", ".scss", ".js", ".json"],
        },
        module: {
            rules: [
                {
                    test: /\.ts(x?)$/,
                    include: [path.resolve(__dirname, "src")],
                    use: [
                        {
                            loader: "esbuild-loader",
                            options: {
                                target: "es6",
                            },
                        },
                    ],
                },
                {
                    test: /\.scss$/,
                    include: [path.resolve(__dirname, "src")],
                    use: [
                        MiniCssExtractPlugin.loader,
                        {
                            loader: "css-loader",
                        },
                        {
                            loader: "sass-loader",
                        },
                    ],
                },
            ],
        },
        plugins,
    };
};
