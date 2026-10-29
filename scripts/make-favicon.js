#!/usr/bin/env node
/* ============================================================
   从一张源图生成网站图标（v1.09）

   node scripts/make-favicon.js                 # 默认读 scripts/data/favicon-src.png
   node scripts/make-favicon.js 某张图.png       # 也可以指定别的图

   源图放在 scripts/data/ 而不是 public/，避免被一起部署到线上。

   做法：找出图里「非白色」像素的包围盒（也就是那个圆角窗口图案），
   按正方形裁出来（留一点边距），再输出 favicon-32 / 192 / apple-touch-icon。
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "public");
const DEFAULT_SRC = path.join(__dirname, "data", "favicon-src.png");
const SRC = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_SRC;

const PAD = 0.04; // 图案四周留 4% 边距

(async () => {
  if (!fs.existsSync(SRC)) {
    console.error(`✗ 找不到源图：${SRC}`);
    console.error("  把图片存成 scripts/data/favicon-src.png 再跑一次，或用参数指定路径。");
    process.exit(1);
  }
  const img = sharp(SRC, { failOn: "none" });
  const meta = await img.metadata();
  const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  // 找「非白」像素的包围盒（容忍接近白的抗锯齿像素）
  let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      const r = data[i], g = data[i + 1], b = data[i + 2], a = info.channels === 4 ? data[i + 3] : 255;
      if (a < 8) continue;                       // 全透明不算
      if (r > 244 && g > 244 && b > 244) continue; // 接近白 = 背景
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) {
    console.error("✗ 没找到图案（整张图都是白的？）");
    process.exit(1);
  }

  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const side = Math.round(Math.max(w, h) * (1 + PAD * 2));
  const cx = Math.round((minX + maxX + 1) / 2);
  const cy = Math.round((minY + maxY + 1) / 2);
  // 裁切区域要落在图片内部
  const left = Math.max(0, Math.min(info.width - side, cx - Math.round(side / 2)));
  const top = Math.max(0, Math.min(info.height - side, cy - Math.round(side / 2)));
  const crop = {
    left,
    top,
    width: Math.min(side, info.width - left),
    height: Math.min(side, info.height - top),
  };

  console.log(`源图 ${meta.width}×${meta.height} · 图案包围盒 ${w}×${h} @(${minX},${minY})`);
  console.log(`裁切 ${crop.width}×${crop.height} @(${crop.left},${crop.top})`);

  const base = sharp(SRC).extract(crop).ensureAlpha();
  const targets = [
    ["favicon-32.png", 32],
    ["favicon-192.png", 192],
    ["apple-touch-icon.png", 180],
    ["favicon-512.png", 512],
  ];
  for (const [name, size] of targets) {
    const out = path.join(OUT, name);
    await base.clone().resize(size, size, { fit: "cover" }).png({ compressionLevel: 9 }).toFile(out);
    console.log(`✓ ${name}（${size}×${size}，${(fs.statSync(out).size / 1024).toFixed(1)} KB）`);
  }
  console.log("\n记得在 public/index.html 里把 <link rel=\"icon\"> 指向 favicon-32.png / favicon-192.png。");
})();
