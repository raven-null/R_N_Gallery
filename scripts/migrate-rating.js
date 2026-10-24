#!/usr/bin/env node
/* ============================================================
   分级迁移（v0.57）：把「老布尔字段 / 标签名 / 主分类名」里的成人向标记
   收敛成照片自己的 meta.rating（general / r16 / r18）。

   背景：v0.56 及以前成人向靠三路任一命中判定 —— 独立字段 r18/r16、
   标签里带 r18/r16、主分类里带 r18/r16。标签名一撞车就能改可见性，
   还出过「整理角色删掉图上的 r18 标签把自己解锁」的越权。
   v0.57 起分级只认 meta.rating，本脚本负责把存量数据搬过去。

   做三件事：
     1) 按老规则推导每张图的分级，写成显式 rating；
     2) 从 tags / categories 里剔除 r18、r16（分级已折算，不留脏名字）；
     3) 从标签库（tags-config）里删掉名为 r18 / r16 的标签与主分类。

   用法（**默认只看不写**）：
     node scripts/migrate-rating.js                                  # 预览本地 8787
     node scripts/migrate-rating.js --url=http://localhost:8788
     node scripts/migrate-rating.js --url=https://xxx.netlify.app --token=访问密码
     node scripts/migrate-rating.js --url=... --token=... --write    # 真正写入（会先备份）

   ⚠️ 线上执行前务必先跑一次预览，确认「待处理」数量与预期一致；
      写入前会把全部照片元数据 + 标签配置备份到 scripts/data/（已 gitignore）。
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");

const RATINGS = ["general", "r16", "r18"];
const RANK = { general: 0, r16: 1, r18: 2 };
const RESERVED = new Set(["r18", "r16"]);
const isReserved = (n) => RESERVED.has(String(n == null ? "" : n).trim().toLowerCase());
const lowList = (v) => (Array.isArray(v) ? v : (v ? [v] : [])).map((x) => String(x).trim().toLowerCase());

/* 与后端 _lib.js 的 ratingOf() 完全一致：显式字段 → 老布尔 → 标签 → 主分类 */
function ratingOf(p) {
  const raw = String(p.rating || "").trim().toLowerCase();
  if (RATINGS.includes(raw)) return raw;
  if (p.r18 === true) return "r18";
  if (p.r16 === true) return "r16";
  const tags = lowList(p.tags);
  if (tags.includes("r18")) return "r18";
  if (tags.includes("r16")) return "r16";
  const cats = lowList(Array.isArray(p.categories) && p.categories.length ? p.categories : p.category);
  if (cats.includes("r18")) return "r18";
  if (cats.includes("r16")) return "r16";
  return "general";
}

function parseArgs(argv) {
  const a = { url: "http://localhost:8787", token: "", write: false, help: false };
  for (const s of argv.slice(2)) {
    if (s === "--write") a.write = true;
    else if (s === "--help" || s === "-h") a.help = true;
    else if (s.startsWith("--url=")) a.url = s.slice(6).replace(/\/+$/, "");
    else if (s.startsWith("--token=")) a.token = s.slice(8);
  }
  return a;
}
function usage() {
  console.log(`
分级迁移（v0.57）：把 r18 / r16 从标签、主分类、老布尔字段收敛成 meta.rating

  node scripts/migrate-rating.js [--url=...] [--token=...] [--write]

  --url     目标站点（默认 http://localhost:8787）
  --token   访问密码（线上必填；没有它列表里看不到 R18 / R16 图片，会漏迁移）
  --write   真正写入（默认只预览）。写入前自动备份到 scripts/data/
`);
}

async function fetchAllPhotos(args, headers) {
  const out = [];
  let cursor = null;
  for (;;) {
    const qs = new URLSearchParams({ limit: "200" });
    if (cursor) qs.set("cursor", cursor);
    if (args.token) qs.set("token", args.token);
    const res = await fetch(`${args.url}/api/photos?${qs.toString()}`, { headers });
    if (res.status === 401) throw new Error("认证失败：请加 --token=访问密码");
    if (!res.ok) throw new Error(`GET /api/photos HTTP ${res.status}`);
    const d = await res.json();
    out.push(...(d.photos || []));
    if (!d.hasMore || !d.cursor) break;
    cursor = d.cursor;
  }
  return out;
}

(async () => {
  const args = parseArgs(process.argv);
  if (args.help) return usage();

  const headers = { "Content-Type": "application/json" };
  if (args.token) headers["X-Auth-Token"] = args.token;

  /* ---------- 1. 拉数据 ---------- */
  const photos = await fetchAllPhotos(args, headers);
  const tagsQs = args.token ? `?token=${encodeURIComponent(args.token)}` : "";
  const tagsRes = await fetch(`${args.url}/api/tags${tagsQs}`, { headers });
  if (!tagsRes.ok) throw new Error(`GET /api/tags HTTP ${tagsRes.status}`);
  const cfg = await tagsRes.json();

  console.log(`\n目标：${args.url}${args.write ? "　【写入模式】" : "　（预览）"}`);
  console.log(`照片 ${photos.length} 张　标签 ${(cfg.tags || []).length} 个　主分类 ${(cfg.categories || []).length} 个`);

  /* ---------- 2. 逐张算计划 ---------- */
  const before = { general: 0, r16: 0, r18: 0 };
  const plans = [];
  let tagClean = 0;
  let catClean = 0;
  let boolClean = 0;

  for (const p of photos) {
    const cur = ratingOf(p);
    before[cur]++;

    const tagsArr = Array.isArray(p.tags) ? p.tags : [];
    const catsArr = Array.isArray(p.categories) && p.categories.length ? p.categories : (p.category ? [p.category] : []);
    const tags = tagsArr.filter((x) => !isReserved(x));
    const cats = catsArr.filter((x) => !isReserved(x));
    const tagsChanged = tags.length !== tagsArr.length;
    const catsChanged = cats.length !== catsArr.length;
    const hasBool = p.r18 !== undefined || p.r16 !== undefined;
    const ratingMissing = String(p.rating || "").trim().toLowerCase() !== cur;

    if (tagsChanged) tagClean++;
    if (catsChanged) catClean++;
    if (hasBool) boolClean++;

    if (tagsChanged || catsChanged || hasBool || ratingMissing) {
      plans.push({ id: p.id, title: p.title || p.id, rating: cur, tags, categories: cats, tagsChanged, catsChanged, hasBool });
    }
  }

  /* ---------- 3. 标签库里的保留名 ---------- */
  const junkTags = (cfg.tags || []).filter((t) => isReserved(t.name));
  const junkCats = (cfg.categories || []).filter((c) => isReserved(c.name));

  console.log(`\n分级分布：大众级 ${before.general}　R16 ${before.r16}　R18 ${before.r18}`);
  console.log(`待处理照片 ${plans.length} 张：`);
  console.log(`  · 标签含 r18/r16 → 折算进分级并剔除：${tagClean} 张`);
  console.log(`  · 主分类含 r18/r16 → 同上：${catClean} 张`);
  console.log(`  · 老布尔字段 r18/r16 → 删除（值已进分级）：${boolClean} 张`);
  if (junkTags.length) console.log(`标签库待删：${junkTags.map((t) => t.name).join("、")}`);
  if (junkCats.length) console.log(`主分类待删：${junkCats.map((c) => c.name).join("、")}`);

  if (plans.length) {
    console.log("\n前 10 张示例：");
    for (const plan of plans.slice(0, 10)) {
      const bits = [];
      if (plan.tagsChanged) bits.push("清标签");
      if (plan.catsChanged) bits.push("清主分类");
      if (plan.hasBool) bits.push("删老字段");
      console.log(`  ${plan.rating.padEnd(8)} ${plan.id}  ${plan.title}　${bits.join(" / ")}`);
    }
  }

  if (!plans.length && !junkTags.length && !junkCats.length) {
    console.log("\n✓ 没有需要迁移的数据（已经是 v0.57 的形态）\n");
    return;
  }
  if (!args.write) {
    console.log("\n（预览模式：确认无误后加 --write 才会真正写入）\n");
    return;
  }

  /* ---------- 4. 备份 ---------- */
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(__dirname, "data");
  fs.mkdirSync(dir, { recursive: true });
  const backup = path.join(dir, `backup-rating-${stamp}.json`);
  fs.writeFileSync(backup, JSON.stringify({ exportedAt: new Date().toISOString(), photos, config: cfg }, null, 2), "utf8");
  console.log(`\n已备份 → ${backup}`);

  /* ---------- 5. 写照片 ---------- */
  let ok = 0;
  const failed = [];
  for (const plan of plans) {
    try {
      const res = await fetch(`${args.url}/api/photos/${plan.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ rating: plan.rating, tags: plan.tags, categories: plan.categories }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
      ok++;
      process.stdout.write(`\r  已写 ${ok}/${plans.length}`);
    } catch (e) {
      failed.push(`${plan.id}: ${e.message}`);
    }
  }
  console.log("");

  /* ---------- 6. 清标签库 ---------- */
  if (junkTags.length || junkCats.length) {
    const nextCfg = {
      categories: (cfg.categories || []).filter((c) => !isReserved(c.name)),
      groups: cfg.groups || [],
      tags: (cfg.tags || []).filter((t) => !isReserved(t.name)),
    };
    const res = await fetch(`${args.url}/api/tags`, { method: "PUT", headers, body: JSON.stringify(nextCfg) });
    if (!res.ok) failed.push(`标签库 PUT: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
    else console.log(`✓ 标签库已清理（删标签 ${junkTags.length} 个 / 删主分类 ${junkCats.length} 个）`);
  }

  console.log(`\n✓ 照片迁移完成：成功 ${ok} 张${failed.length ? `，失败 ${failed.length} 张` : ""}`);
  if (failed.length) {
    console.log("失败明细：");
    failed.slice(0, 20).forEach((f) => console.log(`  ✗ ${f}`));
    process.exitCode = 1;
  }
  console.log("提示：分级只在管理员视图里完整可见；观光 / 整理模式仍只看得到「大众级」。\n");
})().catch((e) => {
  console.error(`\n✗ 迁移失败：${e.message}\n`);
  process.exit(1);
});
