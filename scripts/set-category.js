/* 批量给照片追加主分类（categories 是整体覆盖，所以先读现有再合并）
   用法:
     node scripts/set-category.js --category=二次元-女 --report=.local-data/upload-report-xxx.json [--report=...]
     node scripts/set-category.js --category=二次元-女 --ids=id1,id2,id3
   选项:
     --site= / --token=（或环境变量 RN_SITE / RN_TOKEN）
     --dry        只打印，不写
     --concurrency=4
   说明:
     · --report 可重复多次，读取 upload-folder.js 产出的报告里的 ok[].id
     · 已含该分类的照片自动跳过；PATCH 会保留已有的其它分类与标签
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const many = (name) => argv.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));
const one = (name, def) => {
  const v = many(name);
  return v.length ? v[v.length - 1] : def;
};
const SITE = String(one("site", process.env.RN_SITE || "https://r-gallery.netlify.app")).replace(/\/+$/, "");
const TOKEN = String(one("token", process.env.RN_TOKEN || ""));
const CATEGORY = String(one("category", "")).trim();
const DRY = argv.includes("--dry");
const CONCURRENCY = Math.max(1, Number(one("concurrency", 4)) || 4);

function idList() {
  const ids = new Set();
  for (const p of String(one("ids", "")).split(",").map((s) => s.trim()).filter(Boolean)) ids.add(p);
  for (const r of many("report")) {
    const j = JSON.parse(fs.readFileSync(r, "utf8"));
    for (const o of j.ok || []) if (o.id) ids.add(o.id);
  }
  return [...ids];
}

async function main() {
  if (!CATEGORY) throw new Error("需要 --category=分类名");
  const ids = idList();
  if (!ids.length) throw new Error("没有目标照片（用 --report= 或 --ids= 指定）");
  console.log(`目标 ${ids.length} 张 → 追加主分类「${CATEGORY}」${DRY ? "（干跑）" : ""}`);

  let ok = 0, already = 0, failed = 0, cursor = 0;
  async function worker() {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      try {
        const cur = await fetch(`${SITE}/api/photos/${id}`, { headers: TOKEN ? { "X-Auth-Token": TOKEN } : {} });
        if (cur.status === 404) { failed++; console.log(`  ✗ ${id}: 不存在`); continue; }
        const { photo } = await cur.json();
        const cats = Array.isArray(photo && photo.categories) ? photo.categories : [];
        if (cats.includes(CATEGORY)) { already++; continue; }
        const next = [...cats, CATEGORY];
        if (DRY) { ok++; console.log(`  · ${id} ${JSON.stringify(cats)} → ${JSON.stringify(next)}`); continue; }
        const res = await fetch(`${SITE}/api/photos/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...(TOKEN ? { "X-Auth-Token": TOKEN } : {}) },
          body: JSON.stringify({ categories: next }),
        });
        const out = await res.json().catch(() => ({}));
        if (res.ok) { ok++; if (ok % 20 === 0) console.log(`  … 已处理 ${ok}`); }
        else { failed++; console.log(`  ✗ ${id}: ${out.error || "HTTP " + res.status}`); }
      } catch (e) {
        failed++;
        console.log(`  ✗ ${id}: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`完成：已加 ${ok}，本来就有 ${already}，失败 ${failed}`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
