// 用 Playwright CLI 给 assets/preview.html 截图，生成集市要求的插件预览图。
//
// 尺寸与体积上限取自 plugin-sample/README.md 的 preview 字段说明（建议尺寸 1024*768，
// 支持 PNG/JPEG/WebP/AVIF，上限 512KiB）。截图按 1024x768 视口、1 倍像素密度拍摄，
// preview.html 的 body 也是同样的尺寸且 overflow: hidden，所以不出现滚动条，
// 也不需要整页截图。
//
// 这张图是扁平配色的特性宣传图，调色板量化几乎无损，能把体积压到 1/5。
//
// 首次使用前需要下载 Chromium：npx playwright install chromium。
import {execFileSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    fileURLToPath,
    pathToFileURL,
} from "node:url";
import sharp from "sharp";

const EXPECTED_WIDTH = 1024;
const EXPECTED_HEIGHT = 768;
const MAX_BYTES = 512 * 1024;

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = path.join(root, "assets", "preview.html");
const pngPath = path.join(root, "assets", "preview.png");
const playwrightCli = path.join(root, "node_modules", "playwright", "cli.js");

if (!fs.existsSync(playwrightCli)) {
    console.error(`Playwright not found at ${path.relative(root, playwrightCli)}; run npm install first.`);
    process.exit(1);
}

const html = fs.readFileSync(htmlPath, "utf8");
const width = /body\s*\{[^}]*?width:\s*(\d+)px/s.exec(html)?.[1];
const height = /body\s*\{[^}]*?height:\s*(\d+)px/s.exec(html)?.[1];

if (width !== String(EXPECTED_WIDTH) || height !== String(EXPECTED_HEIGHT)) {
    console.error(
        `assets/preview.html declares ${width}x${height}; the marketplace expects ${EXPECTED_WIDTH}x${EXPECTED_HEIGHT}`,
    );
    process.exit(1);
}

// 先截到临时目录：任何一步失败都不会破坏仓库里已有的 preview.png
const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), "siyuan-preview-"));
let failure = "";

try {
    const shotPath = path.join(shotDir, "preview.png");
    try {
        execFileSync(process.execPath, [
            playwrightCli,
            "screenshot",
            "--browser=chromium",
            `--viewport-size=${EXPECTED_WIDTH},${EXPECTED_HEIGHT}`,
            "--wait-for-timeout=500",
            pathToFileURL(htmlPath).href,
            shotPath,
        ], {stdio: ["ignore", "ignore", "inherit"]});
    } catch {
        throw new Error("Screenshot failed; if Chromium is missing, run: npx playwright install chromium");
    }

    const metadata = await sharp(shotPath).metadata();
    const actual = `${metadata.width}x${metadata.height}`;
    if (actual !== `${EXPECTED_WIDTH}x${EXPECTED_HEIGHT}`) {
        throw new Error(`The screenshot is ${actual}, expected ${EXPECTED_WIDTH}x${EXPECTED_HEIGHT}`);
    }

    const before = fs.statSync(shotPath).size;
    const optimized = await sharp(shotPath)
        .png({compressionLevel: 9, palette: true, quality: 92, effort: 10})
        .toBuffer();
    if (optimized.length > MAX_BYTES) {
        throw new Error(
            `The compressed preview is ${optimized.length} bytes, over the marketplace limit of ${MAX_BYTES}`,
        );
    }

    fs.writeFileSync(pngPath, optimized);
    console.log(`assets/preview.png: ${before} -> ${optimized.length} bytes (${actual}, limit ${MAX_BYTES})`);
} catch (error) {
    failure = error.message;
} finally {
    fs.rmSync(shotDir, {recursive: true, force: true});
}

if (failure) {
    console.error(failure);
    process.exit(1);
}
