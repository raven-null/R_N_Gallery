#!/usr/bin/env node
/* ============================================================
   角色标签导入（v0.17）
   把 scripts/data/chars-*.json 里的角色名单合并进图库的标签配置：
   - 每个游戏建一个「标签组」（原神 / 崩坏：星穹铁道 / 绝区零）
   - 每个角色建一个组内标签（名称 + 别名，别名用于搜索 / 拼音匹配）
   - 额外给每个组补一个「作品级」同名标签（如「原神」），方便只打作品兜底
   - 已存在的标签不重复创建，只补别名 / 归组；可反复运行（幂等）

   用法：
     node scripts/import-chars.js                                   # 本地 dev（http://localhost:8787）
     node scripts/import-chars.js --url=https://xxx.netlify.app --token=访问密码
     node scripts/import-chars.js --dry-run                         # 只预览，不写入
     node scripts/import-chars.js --pending                         # 连「待核对候选角色」一起导入
     node scripts/import-chars.js --only=genshin,zzz                # 只导部分游戏
     node scripts/import-chars.js --no-work-tag                     # 不补作品级同名标签
     node scripts/import-chars.js --reset                           # 先清空现有组与标签，再导入（保留主分类）
   也支持环境变量：GALLERY_URL / GALLERY_TOKEN（避免密码进命令历史）
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const SLUGS = ["genshin", "starrail", "zzz"];
const GROUP_COLORS = { "原神": "#4ea8de", "崩坏：星穹铁道": "#b58cff", "绝区零": "#ffd60a" };
const WORK_TAG_ALIASES = {
  "原神": ["genshin", "Genshin", "原"],
  "崩坏：星穹铁道": ["星铁", "崩铁", "星穹铁道", "star rail", "Honkai: Star Rail", "hsr"],
  "绝区零": ["zzz", "ZZZ", "絕區零", "绝"],
};

function parseArgs(argv) {
  const a = {
    url: process.env.GALLERY_URL || "http://localhost:8787",
    token: process.env.GALLERY_TOKEN || "",
    pending: false, dryRun: false, reset: false,
    only: null, workTag: true, help: false,
  };
  for (const s of argv.slice(2)) {
    if (s === "--pending") a.pending = true;
    else if (s === "--dry-run") a.dryRun = true;
    else if (s === "--reset") a.reset = true;
    else if (s === "--no-work-tag") a.workTag = false;
    else if (s === "--help" || s === "-h") a.help = true;
    else if (s.startsWith("--url=")) a.url = s.slice(6).replace(/\/+$/, "");
    else if (s.startsWith("--token=")) a.token = s.slice(8);
    else if (s.startsWith("--only=")) a.only = s.slice(7).split(",").map((x) => x.trim()).filter(Boolean);
    else console.warn(`忽略未知参数：${s}`);
  }
  a.url = a.url.replace(/\/+$/, "");
  return a;
}

function usage() {
  console.log(`
角色标签导入 · 用法
  node scripts/import-chars.js [--url=...] [--token=...] [--dry-run] [--pending]
                              [--only=genshin,starrail,zzz] [--no-work-tag] [--reset]

  --url    图库地址（默认 http://localhost:8787，可用环境变量 GALLERY_URL）
  --token  访问密码（启用门禁后必填，可用环境变量 GALLERY_TOKEN）
  --dry-run  只预览将要新增的内容，不写入
  --pending  一并导入 chars-pending.json 里「待核对」的候选角色
  --only     只导入指定游戏
  --no-work-tag  不补「作品级」同名标签（如「原神」）
`);
}

function loadGroups(args) {
  const groups = [];
  for (const slug of SLUGS) {
    if (args.only && !args.only.includes(slug)) continue;
    const file = path.join(DATA_DIR, `chars-${slug}.json`);
    if (!fs.existsSync(file)) { console.warn(`跳过：找不到 ${file}`); continue; }
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    groups.push({
      game: j.game,
      slug,
      chars: (j.chars || []).map((c) => ({ name: String(c.name || "").trim(), aliases: c.aliases || [] })).filter((c) => c.name),
    });
  }
  if (args.pending) {
    const file = path.join(DATA_DIR, "chars-pending.json");
    if (!fs.existsSync(file)) console.warn(`跳过候选名单：找不到 ${file}`);
    else {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const g of j.groups || []) {
        let target = groups.find((x) => x.game === g.game);
        if (!target) {
          target = { game: g.game, slug: `pending-${groups.length}`, chars: [] };
          groups.push(target);
        }
        for (const c of g.chars || []) {
          const name = String(c.name || "").trim();
          if (name) target.chars.push({ name, aliases: c.aliases || [], pending: true, confidence: c.confidence });
        }
      }
    }
  }
  return groups;
}

/* 已存在则合并别名 / 归组；不存在则新增 */
function upsertTag(cfg, tag, report) {
  const name = tag.name;
  const cleanAliases = [...new Set((tag.aliases || []).map((s) => String(s).trim()).filter((a) => a && a !== name))];
  const exists = cfg.tags.find((t) => t.name === name);
  if (exists) {
    if (!Array.isArray(exists.aliases)) exists.aliases = [];
    let aliasChanged = false;
    for (const a of cleanAliases) {
      if (!exists.aliases.includes(a)) { exists.aliases.push(a); aliasChanged = true; }
    }
    if (aliasChanged) report.aliasMerged.push(name);
    if (!exists.group && tag.group) { exists.group = tag.group; report.regrouped.push(name); }
    return false;
  }
  cfg.tags.push({ id: "", name, aliases: cleanAliases, group: tag.group, color: tag.color || null, sort: cfg.tags.length });
  report.newTags.push(name);
  return true;
}

function merge(cfg, groups, opts) {
  const report = { newGroups: [], newTags: [], aliasMerged: [], regrouped: [], workTags: [], perGame: [] };
  for (const gd of groups) {
    let g = cfg.groups.find((x) => x.name === gd.game);
    if (!g) {
      g = { id: `g-imp-${gd.slug}`, name: gd.game, color: GROUP_COLORS[gd.game] || null, sort: cfg.groups.length };
      cfg.groups.push(g);
      report.newGroups.push(gd.game);
    }
    const gid = g.id;
    let workTagAdded = false;
    if (opts.workTag) {
      workTagAdded = upsertTag(cfg, { name: gd.game, aliases: WORK_TAG_ALIASES[gd.game] || [], group: gid }, report);
      if (workTagAdded) report.workTags.push(gd.game);
    }
    const added = [];
    for (const c of gd.chars) {
      if (upsertTag(cfg, { name: c.name, aliases: c.aliases, group: gid }, report)) added.push(c.name);
    }
    report.perGame.push({ game: gd.game, total: gd.chars.length, added, workTagAdded });
  }
  return report;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return usage();

  const groups = loadGroups(args);
  if (!groups.length) { console.error("没有可导入的数据（检查 scripts/data/chars-*.json）"); process.exit(1); }
  const totalChars = groups.reduce((n, g) => n + g.chars.length, 0);
  console.log(`\n准备导入：${groups.map((g) => `${g.game}(${g.chars.length})`).join("  ")}  合计 ${totalChars} 个角色`);
  if (args.pending) console.log("已包含「待核对候选角色」（--pending）");
  console.log(`目标：${args.url}${args.dryRun ? "   [dry-run 只预览]" : ""}`);

  const headers = { "Content-Type": "application/json" };
  if (args.token) headers["X-Auth-Token"] = args.token;

  let cfg;
  try {
    const res = await fetch(`${args.url}/api/tags${args.token ? `?token=${encodeURIComponent(args.token)}` : ""}`, { headers });
    if (res.status === 401) throw new Error("认证失败：请加 --token=访问密码");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cfg = await res.json();
  } catch (e) {
    console.error(`\n✗ 读取现有标签配置失败：${e.message}`);
    console.error("  本地请先启动 `npm run dev`；线上请带上 --url 与 --token。");
    process.exit(1);
  }
  if (!Array.isArray(cfg.groups) || !Array.isArray(cfg.tags)) {
    console.error("✗ 返回的配置格式异常（缺少 groups / tags）");
    process.exit(1);
  }
  const before = { groups: cfg.groups.length, tags: cfg.tags.length };
  console.log(`现有配置：${before.groups} 组 / ${before.tags} 标签`);
  const original = JSON.parse(JSON.stringify(cfg)); // 导入前快照（备份用）

  if (args.reset) {
    console.log(`--reset：清空原有 ${before.groups} 组 / ${before.tags} 标签（照片数据与主分类保留）`);
    cfg.groups = [];
    cfg.tags = [];
  }

  const report = merge(cfg, groups, args);
  console.log("\n── 导入预览 ──");
  console.log(`新建组：${report.newGroups.join("、") || "无"}`);
  for (const p of report.perGame) {
    const sample = p.added.slice(0, 8).join("、");
    console.log(`  ${p.game}：角色 ${p.total} 个 → 新增 ${p.added.length} 个${p.workTagAdded ? " + 作品级标签" : ""}${sample ? `（例：${sample}${p.added.length > 8 ? "…" : ""}）` : ""}`);
  }
  console.log(`新增标签合计：${report.newTags.length}`);
  console.log(`为已有标签补充别名：${report.aliasMerged.length}${report.aliasMerged.length ? `（${report.aliasMerged.slice(0, 8).join("、")}${report.aliasMerged.length > 8 ? "…" : ""}）` : ""}`);
  console.log(`把游离标签归入组：${report.regrouped.length}`);
  console.log(`导入后：${cfg.groups.length} 组 / ${cfg.tags.length} 标签`);

  if (args.dryRun) { console.log("\n（dry-run：未写入任何数据）\n"); return; }

  // 备份「导入前」的配置
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = path.join(DATA_DIR, `backup-tags-config-${stamp}.json`);
    fs.writeFileSync(backup, JSON.stringify(original, null, 2), "utf8");
    console.log(`\n已备份导入前的配置 → ${path.relative(process.cwd(), backup)}`);
  } catch (e) { console.warn(`备份失败（不影响导入）：${e.message}`); }

  // 注意：必须原样回传 categories，否则自定义主分类会被默认值覆盖
  const res = await fetch(`${args.url}/api/tags`, { method: "PUT", headers, body: JSON.stringify(cfg) });
  const out = await res.json().catch(() => null);
  if (!res.ok) {
    console.error(`\n✗ 写入失败：HTTP ${res.status} ${(out && out.error) || ""}`);
    process.exit(1);
  }
  const saved = (out && out.config) || {};
  console.log(`\n✓ 导入完成：${(saved.groups || []).length} 组 / ${(saved.tags || []).length} 标签 / ${(saved.categories || []).length} 主分类`);
  console.log("  去「标签」页即可看到新的组与角色；上传页点组头展开即可点选。\n");
}

main().catch((e) => { console.error(`\n✗ 失败：${e.message}`); process.exit(1); });
