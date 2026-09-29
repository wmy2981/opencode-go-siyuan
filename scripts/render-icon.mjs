// 把 assets/icon.svg 渲染成集市要求的插件图标：160x160，PNG，不超过 64KiB。
//
// 尺寸与体积上限取自 plugin-sample/README.md 的 icon 字段说明（建议尺寸 160*160，
// 支持 PNG/JPEG/WebP/AVIF，上限 64KiB）。生成后按这两个数复核，越界直接失败，
// 避免超标的图被塞进 package.zip 才发现。
//
// 先按 4 倍密度栅格化再缩放，边缘比直接栅格化到目标尺寸更锐利。
//
// 软件内显示的图标不走这里：它以 24x24 内联在 src/icons.ts 里，
// 由 addIcons 注入，不随插件包分发文件。
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import sharp from "sharp";

const SIZE = 160;
const MAX_BYTES = 64 * 1024;

const assets = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets");
const source = path.join(assets, "icon.svg");
const target = path.join(assets, "icon.png");

await sharp(fs.readFileSync(source), {density: 384})
    .resize(SIZE, SIZE)
    .png({compressionLevel: 9})
    .toFile(target);

const {width, height} = await sharp(target).metadata();
if (width !== SIZE || height !== SIZE) {
    console.error(`assets/icon.png is ${width}x${height}, expected ${SIZE}x${SIZE}`);
    process.exit(1);
}

const bytes = fs.statSync(target).size;
if (bytes > MAX_BYTES) {
    console.error(`assets/icon.png is ${bytes} bytes, over the marketplace limit of ${MAX_BYTES}`);
    process.exit(1);
}

console.log(`assets/icon.png done: ${bytes} bytes (${SIZE}x${SIZE}, limit ${MAX_BYTES})`);
