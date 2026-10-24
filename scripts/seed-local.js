#!/usr/bin/env node
/* ============================================================
   本地冒烟测试 seed（v0.55）
   给 scripts/dev-server.js 的**内存** Blobs 灌一批可控数据，让
   scripts/dom-smoke-test.js 的断言有东西可验（dev server 重启即清空）。

   用法：
     npm run dev                              # 默认 8787 端口
     node scripts/seed-local.js               # 默认踩 http://localhost:8788
     node scripts/seed-local.js --url=http://localhost:8787
     node scripts/seed-local.js --keep        # 保留已有照片，只重灌标签配置

   灌入内容：
     - 18 张照片：其中 2 张内容完全相同 + 1 张相似变体（查重断言用）
     - 2 张「待整理」（无主分类、无库内标签，整理视图断言用）
     - 1 张 rating=r18、1 张 rating=r16（safe=1 断言用；分级是照片字段，不进标签库）
     - 标签库：2 个组（「冒烟测试作品」24 个标签 = 大组折叠断言用 +「冒烟测试来源」6 个）
     - 主分类沿用内置默认六类（按图分配「插画」/「次元女」，部分留空）

   注意：默认会先清空图库（`--keep` 可跳过），避免反复 seed 累积照片。
   ============================================================ */
"use strict";

const sharp = require("sharp");

const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
const argVal = (prefix, def) => {
  const a = args.find((x) => x.startsWith(prefix));
  return a ? a.slice(prefix.length) : def;
};

const BASE = argVal("--url=", process.env.GALLERY_URL || "http://localhost:8788").replace(/\/+$/, "");
const TOKEN = process.env.GALLERY_TOKEN || "";
const KEEP_PHOTOS = hasFlag("--keep");

const GROUP_MAIN = { id: "g-smoke-main", name: "冒烟测试作品", color: "#4ea8de", sort: 0 };
const GROUP_ALT = { id: "g-smoke-alt", name: "冒烟测试来源", color: "#b58cff", sort: 1 };
const MAIN_TAGS = Array.from({ length: 24 }, (_, i) => `冒烟角色${String(i + 1).padStart(2, "0")}`);
const ALT_TAGS = Array.from({ length: 6 }, (_, i) => `冒烟来源${i + 1}`);

async function api(path, method = "GET", body) {
  const res = await fetch(BASE + path, {
    method,
    headers: Object.assign(
      { "Content-Type": "application/json" },
      TOKEN ? { "X-Auth-Token": TOKEN } : {}
    ),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status} ${text.slice(0, 200)}`);
  return data;
}

const png = (bg, w = 96, h = 64) =>
  sharp({ create: { width: w, height: h, channels: 3, background: bg } }).png().toBuffer();

const toDataUrl = (buf) => `data:image/png;base64,${buf.toString("base64")}`;

/* ---------- 1. 清空 + 灌标签配置 ---------- */
async function seedTags() {
  const tags = [];
  MAIN_TAGS.forEach((name, i) => {
    tags.push({ id: `t-sm-main-${i}`, name, aliases: [], group: GROUP_MAIN.id, color: null, sort: i });
  });
  ALT_TAGS.forEach((name, i) => {
    tags.push({ id: `t-sm-alt-${i}`, name, aliases: [], group: GROUP_ALT.id, color: null, sort: i });
  });
  // 一个未分组标签，用于验证「库内未分组」在分组视图里的可见性
  tags.push({ id: "t-sm-loose", name: "冒烟未分组", aliases: [], group: "", color: null, sort: 0 });

  await api("/api/tags", "PUT", {
    categories: [],          // 空 → 后端补内置默认六类
    groups: [GROUP_MAIN, GROUP_ALT],
    tags,
  });
  return tags.length;
}

/* ---------- 2. 上传照片 ---------- */
async function seedPhotos() {
  const colors = [
    { r: 40, g: 90, b: 180 }, { r: 180, g: 60, b: 90 }, { r: 60, g: 160, b: 90 },
    { r: 200, g: 150, b: 50 }, { r: 90, g: 70, b: 170 }, { r: 50, g: 170, b: 170 },
  ];
  // 内容完全相同的两张（查重「完全相同」分支）
  const dupPng = await png({ r: 30, g: 120, b: 200 });
  // 相似变体：同一张图缩到 62/96 ≈ 64% 后再编码（dhash 应当接近）
  const similarPng = await sharp(dupPng).resize({ width: 62 }).png().toBuffer();

  let uploaded = 0;
  for (let i = 1; i <= 18; i++) {
    let buf;
    if (i === 5 || i === 6) buf = dupPng;             // 两张完全一样
    else if (i === 7) buf = similarPng;               // 相似
    else buf = await png(colors[i % colors.length]);

    const tags = [];
    if (i <= 14) tags.push(MAIN_TAGS[(i - 1) % MAIN_TAGS.length]);
    else if (i <= 16) tags.push(ALT_TAGS[(i - 15) % ALT_TAGS.length]);
    if (i === 1) tags.push(MAIN_TAGS[1]); // 第 1 张同时带角色 01/02 → 两个标签有交集，便于验证「且 / 或」差异
    // i = 15..18 不带库内标签（待整理候选）
    // v0.57：成人向走照片自己的分级字段，不再写成 r18 / r16 标签
    const rating = i === 17 ? "r18" : (i === 18 ? "r16" : "general");

    const categories = i >= 15 ? [] : (i % 3 === 0 ? [] : (i % 2 ? ["插画"] : ["次元女"]));
    const title = i === 17 ? "冒烟成人向 R18" : (i === 18 ? "冒烟成人向 R16" : `冒烟样张 ${String(i).padStart(2, "0")}`);

    await api("/api/photos", "POST", {
      dataBase64: toDataUrl(buf),
      title,
      categories,
      tags,
      rating,
    });
    uploaded++;
  }
  return uploaded;
}

(async () => {
  console.log(`\n› seed → ${BASE}${TOKEN ? "（带 Token）" : ""}`);
  const health = await api("/api/photos?limit=1").catch((e) => {
    console.error(`✗ 连不上服务：${e.message}`);
    console.error("  先启动本地服务：npm run dev（或用 PORT=8788 node scripts/dev-server.js）\n");
    process.exit(1);
  });

  if (!KEEP_PHOTOS) {
    await api("/api/photos", "DELETE");
    console.log("✓ 已清空图库（--keep 可保留）");
  } else {
    console.log(`› 保留已有照片（当前 ${(health.photos || []).length ? "有数据" : "空库"}）`);
  }

  const tagCount = await seedTags();
  console.log(`✓ 标签配置：2 组 / ${tagCount} 个标签（其中「${GROUP_MAIN.name}」${MAIN_TAGS.length} 个 = 大组折叠断言用）`);

  const n = await seedPhotos();
  console.log(`✓ 上传 ${n} 张照片（1 组完全重复 + 1 张相似 + 2 张待整理 + R18/R16 各 1 张）`);

  const all = await api("/api/photos?limit=100");
  const safe = await api("/api/photos?limit=100&safe=1");
  console.log(`✓ 校验：列表共 ${(all.photos || []).length} 张，safe=1 返回 ${(safe.photos || []).length} 张\n`);
})().catch((e) => {
  console.error(`\n✗ seed 失败：${e.message}\n`);
  process.exit(1);
});
