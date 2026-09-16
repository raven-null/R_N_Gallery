#!/usr/bin/env node
/* ============================================================
   照片数据迁移（v0.19）
   1) 主分类迁移：把照片标签里出现的主分类名（次元女 / 插画 / 风景 …）
      写进 meta.categories 数组（多选），默认同时把这些名字从标签里移除，
      避免「同一个信息既当分类又当标签」
   2) 旧作品名合并：把照片标签里的旧名替换成新名（默认
      星穹铁道 / 崩坏·星穹铁道 → 崩坏：星穹铁道）

   用法：
     node scripts/migrate-photos.js --url=https://xxx.netlify.app --token=访问密码 --dry-run
     node scripts/migrate-photos.js --url=... --token=...                 # 实际执行
     node scripts/migrate-photos.js --keep-tags                           # 分类名保留在标签里
     node scripts/migrate-photos.js --no-merge                            # 只做分类迁移
     node scripts/migrate-photos.js --merge "旧名=新名,旧名2=新名2"        # 自定义合并表
     node scripts/migrate-photos.js --r18key=xxx                          # 有 R18 密钥时才处理 R18 照片
   也支持环境变量：GALLERY_URL / GALLERY_TOKEN / GALLERY_R18KEY
   ============================================================ */
"use strict";

const DEFAULT_MERGE = {
  "星穹铁道": "崩坏：星穹铁道",
  "崩坏·星穹铁道": "崩坏：星穹铁道",
  "崩坏:星穹铁道": "崩坏：星穹铁道",
};

function parseArgs(argv) {
  const a = {
    url: (process.env.GALLERY_URL || "http://localhost:8787").replace(/\/+$/, ""),
    token: process.env.GALLERY_TOKEN || "",
    r18key: process.env.GALLERY_R18KEY || "",
    dryRun: false, keepTags: false, noMerge: false, merge: null, help: false,
  };
  for (const s of argv.slice(2)) {
    if (s === "--dry-run") a.dryRun = true;
    else if (s === "--keep-tags") a.keepTags = true;
    else if (s === "--no-merge") a.noMerge = true;
    else if (s === "--help" || s === "-h") a.help = true;
    else if (s.startsWith("--url=")) a.url = s.slice(6).replace(/\/+$/, "");
    else if (s.startsWith("--token=")) a.token = s.slice(8);
    else if (s.startsWith("--r18key=")) a.r18key = s.slice(9);
    else if (s.startsWith("--merge=")) {
      a.merge = {};
      s.slice(8).split(",").map((x) => x.trim()).filter(Boolean).forEach((pair) => {
        const i = pair.indexOf("=");
        if (i > 0) a.merge[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
      });
    } else console.warn(`忽略未知参数：${s}`);
  }
  return a;
}

function usage() {
  console.log(`
照片数据迁移 · 用法
  node scripts/migrate-photos.js [--url=...] [--token=...] [--dry-run]
                                 [--keep-tags] [--no-merge] [--merge "旧=新,旧=新"] [--r18key=...]

  --dry-run    只打印将要改动的照片，不写入
  --keep-tags  主分类名同时保留在标签里（默认会从标签移除）
  --no-merge   不做旧作品名合并
  --merge      自定义合并表（默认：星穹铁道 / 崩坏·星穹铁道 → 崩坏：星穹铁道）
  --r18key     R18 密钥（提供后连 R18 照片一起处理）
`);
}

async function fetchAllPhotos(args, headers) {
  const out = [];
  let cursor = null;
  for (;;) {
    const qs = new URLSearchParams({ limit: "200" });
    if (cursor) qs.set("cursor", cursor);
    if (args.token) qs.set("token", args.token);
    if (args.r18key) qs.set("r18Key", args.r18key);
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

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return usage();

  const headers = { "Content-Type": "application/json" };
  if (args.token) headers["X-Auth-Token"] = args.token;

  const tagsRes = await fetch(`${args.url}/api/tags${args.token ? `?token=${encodeURIComponent(args.token)}` : ""}`, { headers });
  if (tagsRes.status === 401) throw new Error("认证失败：请加 --token=访问密码");
  if (!tagsRes.ok) throw new Error(`GET /api/tags HTTP ${tagsRes.status}`);
  const cfg = await tagsRes.json();
  const catNames = new Set((cfg.categories || []).map((c) => c.name));
  const libNames = new Set((cfg.tags || []).map((t) => t.name));
  const merge = args.noMerge ? {} : (args.merge || DEFAULT_MERGE);
  const mergeTargets = new Set(Object.values(merge));

  const photos = await fetchAllPhotos(args, headers);
  console.log(`\n目标：${args.url}`);
  console.log(`主分类字典（${catNames.size}）：${[...catNames].join("、") || "（空）"}`);
  console.log(`照片 ${photos.length} 张${args.r18key ? "（含 R18）" : "（未提供 R18 密钥，R18 照片可能不在列表里）"}`);
  console.log(`作品名合并：${Object.keys(merge).length ? Object.entries(merge).map(([a, b]) => `${a}→${b}`).join("、") : "关闭"}`);
  console.log(`分类名${args.keepTags ? "保留" : "从标签移除"}：${[...catNames].join("、")}`);

  const plans = [];
  const stat = { catOnly: 0, mergeOnly: 0, both: 0, untouched: 0, missingMergeTarget: new Set() };

  for (const p of photos) {
    const tags = Array.isArray(p.tags) ? p.tags.slice() : [];
    const cats = Array.isArray(p.categories) ? p.categories.slice() : (p.category ? [p.category] : []);
    const catFromTags = tags.filter((t) => catNames.has(t));
    const nextCats = [...new Set([...cats, ...catFromTags])].slice(0, 6);
    let nextTags = tags.slice();
    if (!args.keepTags && catFromTags.length) nextTags = nextTags.filter((t) => !catNames.has(t));
    let merged = false;
    nextTags = nextTags.map((t) => {
      if (merge[t]) { merged = true; return merge[t]; }
      return t;
    });
    nextTags = [...new Set(nextTags)].slice(0, 10);

    // 合并目标不在标签库时提示（结果会变成「未分组」游离标签）
    Object.keys(merge).forEach((from) => {
      if (tags.includes(from) && !libNames.has(merge[from])) stat.missingMergeTarget.add(merge[from]);
    });

    const catsChanged = nextCats.length !== cats.length || nextCats.some((c, i) => c !== cats[i]);
    const tagsChanged = nextTags.length !== tags.length || nextTags.some((t, i) => t !== tags[i]);
    if (!catsChanged && !tagsChanged) { stat.untouched++; continue; }

    if (catsChanged && tagsChanged) stat.both++;
    else if (catsChanged) stat.catOnly++;
    else stat.mergeOnly++;
    plans.push({ id: p.id, title: p.title, catsChanged, tagsChanged, nextCats, nextTags, from: { tags, cats } });
  }

  console.log(`\n── 迁移预览 ──`);
  console.log(`需要改动：${plans.length} 张（分类+标签都变 ${stat.both} / 仅分类 ${stat.catOnly} / 仅标签 ${stat.mergeOnly}）｜无需改动 ${stat.untouched} 张`);
  if (stat.missingMergeTarget.size) {
    console.log(`⚠️ 合并目标不在标签库，合并后会成为「未分组」标签：${[...stat.missingMergeTarget].join("、")}`);
  }
  plans.slice(0, 12).forEach((x) => {
    const bits = [];
    if (x.catsChanged) bits.push(`分类 [${x.from.cats.join(",")}] → [${x.nextCats.join(",")}]`);
    if (x.tagsChanged) bits.push(`标签 [${x.from.tags.join(",")}] → [${x.nextTags.join(",")}]`);
    console.log(`  ${x.title || x.id}: ${bits.join("  ｜  ")}`);
  });
  if (plans.length > 12) console.log(`  …其余 ${plans.length - 12} 张同理`);

  if (!plans.length) { console.log("\n没有需要迁移的数据。\n"); return; }
  if (args.dryRun) { console.log("\n（dry-run：未写入任何数据）\n"); return; }

  let ok = 0;
  const errors = [];
  for (const x of plans) {
    try {
      const res = await fetch(`${args.url}/api/photos/${x.id}${args.token ? `?token=${encodeURIComponent(args.token)}` : ""}`, {
        method: "PATCH", headers, body: JSON.stringify({ categories: x.nextCats, tags: x.nextTags }),
      });
      if (!res.ok) { const d = await res.json().catch(() => null); throw new Error(`HTTP ${res.status} ${(d && d.error) || ""}`); }
      ok++;
    } catch (e) { errors.push(`${x.title || x.id}: ${e.message}`); }
  }
  console.log(`\n✓ 迁移完成：成功 ${ok} 张${errors.length ? `，失败 ${errors.length} 张` : ""}`);
  errors.slice(0, 10).forEach((e) => console.log(`  ✗ ${e}`));
  console.log("");
}

main().catch((e) => { console.error(`\n✗ 失败：${e.message}`); process.exit(1); });
