#!/usr/bin/env node
/* ============================================================
   近似重复图片检测（v0.20）
   下载每张照片的缩略图 → 计算 dHash（64 位感知哈希）→ 两两比较汉明距离，
   把视觉上几乎相同的照片聚成一组（同一张图的重复上传、轻微压缩差异、缩放版本等）。
   只读，不删除任何东西。

   用法：
     node scripts/find-duplicates.js --url=https://xxx.netlify.app --token=访问密码
     node scripts/find-duplicates.js --threshold=10      # 放宽阈值（默认 8，越小越严格）
     node scripts/find-duplicates.js --json > dups.json  # 输出 JSON
   也支持环境变量：GALLERY_URL / GALLERY_TOKEN / GALLERY_R18KEY
   ============================================================ */
"use strict";

const sharp = require("sharp");

const DEFAULT_THRESHOLD = 8;
const CONCURRENCY = 6;

function parseArgs(argv) {
  const a = {
    url: (process.env.GALLERY_URL || "http://localhost:8787").replace(/\/+$/, ""),
    token: process.env.GALLERY_TOKEN || "",
    r18key: process.env.GALLERY_R18KEY || "",
    threshold: DEFAULT_THRESHOLD, json: false,
  };
  for (const s of argv.slice(2)) {
    if (s === "--json") a.json = true;
    else if (s.startsWith("--url=")) a.url = s.slice(6).replace(/\/+$/, "");
    else if (s.startsWith("--token=")) a.token = s.slice(8);
    else if (s.startsWith("--r18key=")) a.r18key = s.slice(9);
    else if (s.startsWith("--threshold=")) a.threshold = parseInt(s.slice(12), 10) || DEFAULT_THRESHOLD;
  }
  return a;
}

async function fetchPhotos(a) {
  const out = [];
  let cursor = null;
  const headers = a.token ? { "X-Auth-Token": a.token } : {};
  for (;;) {
    const qs = new URLSearchParams({ limit: "200", _: String(Math.random()) });
    if (cursor) qs.set("cursor", cursor);
    if (a.token) qs.set("token", a.token);
    if (a.r18key) qs.set("r18Key", a.r18key);
    const res = await fetch(`${a.url}/api/photos?${qs}`, { headers });
    if (res.status === 401) throw new Error("认证失败：请加 --token=访问密码");
    if (!res.ok) throw new Error(`GET /api/photos HTTP ${res.status}`);
    const d = await res.json();
    out.push(...(d.photos || []));
    if (!d.hasMore || !d.cursor) break;
    cursor = d.cursor;
  }
  return out;
}

async function dHashOf(a, id) {
  const qs = new URLSearchParams();
  if (a.token) qs.set("token", a.token);
  if (a.r18key) qs.set("r18Key", a.r18key);
  const res = await fetch(`${a.url}/api/photos/${id}/thumb?${qs}`);
  if (!res.ok) throw new Error(`thumb HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const raw = await sharp(buf, { failOn: "none" }).resize(9, 8, { fit: "fill" }).grayscale().raw().toBuffer();
  let hash = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if (raw[y * 9 + x] < raw[y * 9 + x + 1]) hash |= 1n << BigInt(y * 8 + x);
    }
  }
  return hash;
}

const popcount = (v) => { let n = 0; while (v) { v &= v - 1n; n++; } return n; };

async function main() {
  const a = parseArgs(process.argv);
  const photos = await fetchPhotos(a);
  if (a.json === false) console.log(`\n目标：${a.url}\n照片 ${photos.length} 张｜相似阈值：dHash 距离 ≤ ${a.threshold}\n`);

  // 并发下载缩略图并算哈希
  const hashes = new Map();
  const failed = [];
  for (let i = 0; i < photos.length; i += CONCURRENCY) {
    const batch = photos.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (p) => {
      try { hashes.set(p.id, await dHashOf(a, p.id)); }
      catch (e) { failed.push({ id: p.id, title: p.title, error: e.message }); }
    }));
    if (!a.json) process.stdout.write(`\r已处理 ${Math.min(i + CONCURRENCY, photos.length)}/${photos.length} 张…`);
  }
  if (!a.json) process.stdout.write("\r" + " ".repeat(40) + "\r");

  // 两两比较（并查集聚类）
  const ids = [...hashes.keys()];
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (x, y) => { const a1 = find(x), b1 = find(y); if (a1 !== b1) parent.set(a1, b1); };
  const pairs = [];
  const allPairs = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const d = popcount(hashes.get(ids[i]) ^ hashes.get(ids[j]));
      allPairs.push({ a: ids[i], b: ids[j], distance: d });
      if (d <= a.threshold) { union(ids[i], ids[j]); pairs.push({ a: ids[i], b: ids[j], distance: d }); }
    }
  }
  allPairs.sort((x, y) => x.distance - y.distance);
  const groups = new Map();
  ids.forEach((id) => { const r = find(id); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(id); });
  const dupGroups = [...groups.values()].filter((g) => g.length > 1)
    .map((g) => {
      const members = g.map((id) => photos.find((p) => p.id === id)).filter(Boolean);
      members.sort((x, y) => String(x.uploadedAt || "").localeCompare(String(y.uploadedAt || "")));
      return {
        size: members.length,
        keep: members[0].id, // 建议保留最早上传的那张
        members: members.map((p) => ({
          id: p.id, title: p.title, dims: `${p.width}x${p.height}`, size: p.size,
          uploadedAt: p.uploadedAt, categories: p.categories || [], tags: p.tags || [],
        })),
      };
    })
    .sort((x, y) => y.size - x.size);

  if (a.json) {
    console.log(JSON.stringify({ scanned: photos.length, failed, threshold: a.threshold, groups: dupGroups }, null, 2));
    return;
  }

  console.log(`疑似重复组：${dupGroups.length} 组，涉及 ${dupGroups.reduce((n, g) => n + g.size, 0)} 张`);
  dupGroups.forEach((g, i) => {
    console.log(`\n[${i + 1}] ${g.size} 张（建议保留最早上传的 ${g.keep}）`);
    g.members.forEach((m) => {
      const mark = m.id === g.keep ? "保留" : "重复";
      console.log(`   ${mark}  ${m.id}  ${m.dims}  ${(m.size / 1024).toFixed(0)}KB  ${String(m.uploadedAt).slice(0, 10)}  「${m.title}」  分类[${(m.categories || []).join(",")}] 标签[${(m.tags || []).join(",")}]`);
    });
  });
  // 即使没有「重复」，也列出最相似的前几对，便于人工判断（dHash 距离越小越像，0 = 几乎一致）
  const top = allPairs.slice(0, 8);
  if (top.length) {
    console.log(`\n最相似的 ${top.length} 对（仅参考，距离 ≥ ${a.threshold + 1} 一般属于不同构图）：`);
    top.forEach((t, i) => {
      const A = photos.find((p) => p.id === t.a), B = photos.find((p) => p.id === t.b);
      console.log(`  ${i + 1}. 距离 ${t.distance}  「${A && A.title}」 (${A && A.width}x${A && A.height})  ↔  「${B && B.title}」 (${B && B.width}x${B && B.height})`);
    });
  }
  if (failed.length) console.log(`\n跳过 ${failed.length} 张（读取失败，可能是 R18 未提供密钥）：${failed.slice(0, 5).map((f) => f.title || f.id).join("、")}`);
  console.log("");
}

main().catch((e) => { console.error(`\n✗ 失败：${e.message}`); process.exit(1); });
