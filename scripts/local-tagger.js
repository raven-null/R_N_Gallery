#!/usr/bin/env node
/* ============================================================
   本地打标（v0.22）：用 WD14 Tagger 在自己电脑上给图片识别标签
   —— 全程本地推理，图片不上传、不经任何内容审核，因此 **R18 图片也能处理**。

   它能识别：角色名（动漫/游戏角色，含大量绝区零 / 原神 / 星铁角色）、
   画风与画面元素（风景 / 彩色 / 线稿 / Q版 …）、以及分级倾向
   （general / sensitive / questionable / explicit → 可自动建议标 R18）。

   准备（一次性）：
     npm install onnxruntime-node            # 原生推理运行时（约 100MB）
     node scripts/local-tagger.js --download # 下载 WD14 模型到 scripts/data/wd-tagger/

   用法：
     node scripts/local-tagger.js --url=https://<站点> --token=<访问密码> --limit=5 --dry-run
     node scripts/local-tagger.js --url=... --token=... --only-untagged --write
     node scripts/local-tagger.js --url=... --token=... --only-untagged --write --write-r18 --r18key=<R18密钥>
     node scripts/local-tagger.js --image=本地图片.jpg --dry-run       # 先拿一张本地图试算
   也支持环境变量：GALLERY_URL / GALLERY_TOKEN / GALLERY_R18KEY

   默认 **不写入**（dry-run 行为），要真正写回图库必须显式加 --write。
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const MODEL_DIR = path.join(DATA_DIR, "wd-tagger");
const MAP_FILE = path.join(DATA_DIR, "tagger-map.json");
/* 模型仓库（默认走 hf-mirror 国内镜像；失败可换 --model-base=） */
const DEFAULT_MODEL_BASE = "https://hf-mirror.com/SmilingWolf/wd-swinv2-tagger-v3/resolve/main/";
const MODEL_FILES = ["model.onnx", "selected_tags.csv"];
const RATING_TAGS = ["general", "sensitive", "questionable", "explicit"];
const IMG_SIZE = 448;

function parseArgs(argv) {
  const a = {
    url: (process.env.GALLERY_URL || "http://localhost:8787").replace(/\/+$/, ""),
    token: process.env.GALLERY_TOKEN || "",
    r18key: process.env.GALLERY_R18KEY || "",
    modelBase: DEFAULT_MODEL_BASE,
    download: false, write: false, writeR18: false, dryRun: false,
    onlyUntagged: false, onlyNoCategory: false, limit: 0,
    threshold: 0.35, maxTags: 15, image: null, selftest: false, help: false,
  };
  for (const s of argv.slice(2)) {
    if (s === "--download") a.download = true;
    else if (s === "--write") a.write = true;
    else if (s === "--write-r18") a.writeR18 = true;
    else if (s === "--dry-run") a.dryRun = true;
    else if (s === "--only-untagged") a.onlyUntagged = true;
    else if (s === "--only-no-category") a.onlyNoCategory = true;
    else if (s === "--selftest") a.selftest = true;
    else if (s === "--help" || s === "-h") a.help = true;
    else if (s.startsWith("--url=")) a.url = s.slice(6).replace(/\/+$/, "");
    else if (s.startsWith("--token=")) a.token = s.slice(8);
    else if (s.startsWith("--r18key=")) a.r18key = s.slice(9);
    else if (s.startsWith("--model-base=")) a.modelBase = s.slice(13);
    else if (s.startsWith("--model-dir=")) a.modelDir = s.slice(12);
    else if (s.startsWith("--image=")) a.image = s.slice(8);
    else if (s.startsWith("--limit=")) a.limit = parseInt(s.slice(8), 10) || 0;
    else if (s.startsWith("--threshold=")) a.threshold = parseFloat(s.slice(12)) || 0.35;
    else if (s.startsWith("--max-tags=")) a.maxTags = parseInt(s.slice(11), 10) || 15;
    else console.warn(`忽略未知参数：${s}`);
  }
  return a;
}

function usage() {
  console.log(`
本地打标（WD14 Tagger）· 用法
  一次性准备：
    npm install onnxruntime-node
    node scripts/local-tagger.js --download

  试算一张本地图片（不连图库）：
    node scripts/local-tagger.js --image=某张图.jpg

  批量处理图库（默认只报告，不写入）：
    node scripts/local-tagger.js --url=https://<站点> --token=<密码> --only-untagged --dry-run
    node scripts/local-tagger.js --url=... --token=... --only-untagged --write
    node scripts/local-tagger.js --url=... --token=... --only-untagged --write --write-r18 --r18key=<R18密钥>

  参数
    --write        真正写回图库（不加则只报告）
    --write-r18    模型判定 questionable/explicit 时，一并把照片标为 R18
    --only-untagged  只处理「没有任何标签」的照片
    --only-no-category  只处理「没有主分类」的照片
    --limit=N      最多处理 N 张
    --threshold=0.35  标签概率阈值（越高越保守）
    --max-tags=15  每张最多采用多少个标签
    --model-dir=  模型目录（默认 scripts/data/wd-tagger）
    --model-base= 模型下载地址前缀（默认 hf-mirror 镜像）
`);
}

/* ---------- 模型下载 ---------- */
async function download(a) {
  fs.mkdirSync(a.modelDir || MODEL_DIR, { recursive: true });
  const dir = a.modelDir || MODEL_DIR;
  for (const f of MODEL_FILES) {
    const dest = path.join(dir, f);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1024) {
      console.log(`✓ 已存在：${f}（${(fs.statSync(dest).size / 1e6).toFixed(1)}MB）`);
      continue;
    }
    const url = a.modelBase + f;
    console.log(`↓ 下载 ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}（可换 --model-base=，或手动下载 ${f} 放到 ${dir}）`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    console.log(`✓ 已保存 ${dest}（${(buf.length / 1e6).toFixed(1)}MB）`);
  }
  console.log("\n模型就绪。先用一张本地图片试算：node scripts/local-tagger.js --image=xxx.jpg\n");
}

/* ---------- 标签表 / 映射 ---------- */
function loadTagTable(dir) {
  const csv = fs.readFileSync(path.join(dir, "selected_tags.csv"), "utf8").replace(/^\uFEFF/, "");
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const head = lines[0].split(",").map((s) => s.trim().toLowerCase());
  const iName = head.indexOf("name");
  const iCat = head.indexOf("category");
  const tags = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const name = (cols[iName] || "").trim();
    if (!name) continue;
    tags.push({ name, category: parseInt(cols[iCat], 10) || 0 });
  }
  return tags; // category: 0=general, 4=character, 9=rating
}

/* 英文标签 → 图库中文标签：1) tagger-map.json  2) chars-*.json 别名（角色） */
function loadNameMap() {
  const map = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(MAP_FILE, "utf8"));
    Object.entries(j.map || {}).forEach(([k, v]) => map.set(k.toLowerCase(), v));
  } catch (e) { /* 没有映射文件也能跑 */ }
  for (const slug of ["genshin", "starrail", "zzz"]) {
    const f = path.join(DATA_DIR, `chars-${slug}.json`);
    if (!fs.existsSync(f)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      for (const c of j.chars || []) {
        for (const al of c.aliases || []) {
          const key = String(al).trim().toLowerCase().replace(/\s+/g, "_");
          if (key && !map.has(key)) map.set(key, c.name);
        }
        // 中文名本身也可能被模型直接输出（少见）
        map.set(String(c.name).toLowerCase(), c.name);
      }
    } catch (e) { /* ignore */ }
  }
  return map;
}

/* ---------- 预处理 + 推理 ---------- */
async function loadImageTensor(sharp, ort, buf) {
  const raw = await sharp(buf, { failOn: "none", animated: false })
    .rotate()
    .resize(IMG_SIZE, IMG_SIZE, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .removeAlpha()
    .raw()
    .toBuffer();
  // WD14 训练用的是 BGR、0~255 的 float32
  const arr = new Float32Array(IMG_SIZE * IMG_SIZE * 3);
  for (let i = 0, p = 0; i < raw.length; i += 3, p += 3) {
    arr[p] = raw[i + 2];
    arr[p + 1] = raw[i + 1];
    arr[p + 2] = raw[i];
  }
  return new ort.Tensor("float32", arr, [1, IMG_SIZE, IMG_SIZE, 3]);
}

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

async function tagImage(session, ort, sharp, buf, table, args) {
  const tensor = await loadImageTensor(sharp, ort, buf);
  const feeds = {};
  feeds[session.inputNames[0]] = tensor;
  const out = await session.run(feeds);
  let scores = out[session.outputNames[0]].data; // Float32Array | Float64Array

  // 有些导出把 logits 直接输出：最大值 > 1 视为需要 sigmoid
  let maxV = 0;
  for (let i = 0; i < scores.length; i++) if (scores[i] > maxV) maxV = scores[i];
  if (maxV > 1.01) scores = Array.from(scores, sigmoid);

  const hits = [];
  for (let i = 0; i < table.length && i < scores.length; i++) {
    const p = scores[i];
    if (p >= args.threshold) hits.push({ name: table[i].name, category: table[i].category, p });
  }
  const ratings = hits.filter((h) => RATING_TAGS.includes(h.name.toLowerCase()));
  const general = hits.filter((h) => h.category === 0 && !RATING_TAGS.includes(h.name.toLowerCase()));
  const chars = hits.filter((h) => h.category === 4);
  const top = [...chars, ...general].sort((x, y) => y.p - x.p).slice(0, args.maxTags);
  const level = ratings.sort((x, y) => y.p - x.p)[0];
  return { top, ratings, level: level ? level.name.toLowerCase() : null };
}

/* ---------- 图库 ---------- */
async function fetchPhotos(a) {
  const headers = a.token ? { "X-Auth-Token": a.token } : {};
  const out = [];
  let cursor = null;
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

async function downloadImage(a, p) {
  const qs = new URLSearchParams();
  if (a.token) qs.set("token", a.token);
  if (a.r18key) qs.set("r18Key", a.r18key);
  const res = await fetch(`${a.url}/api/photos/${p.id}/raw?${qs}`);
  if (!res.ok) throw new Error(`raw HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return usage();
  const dir = args.modelDir || MODEL_DIR;
  const willWrite = args.write && !args.dryRun; // 默认只报告；--write 才写回，--dry-run 可强制只看

  if (args.download) return download(args);

  /* 依赖检查 */
  let sharp, ort;
  try { sharp = require("sharp"); } catch (e) { throw new Error("缺少 sharp：npm install"); }
  try { ort = require("onnxruntime-node"); }
  catch (e) {
    console.error("\n✗ 还没有安装推理运行时。先执行：\n    npm install onnxruntime-node\n");
    process.exit(1);
  }
  if (!fs.existsSync(path.join(dir, "model.onnx"))) {
    console.error(`\n✗ 找不到模型：${path.join(dir, "model.onnx")}\n  先执行：node scripts/local-tagger.js --download\n`);
    process.exit(1);
  }

  const table = loadTagTable(dir);
  const nameMap = loadNameMap();
  const libNames = new Set();
  if (!args.image) {
    const headers = args.token ? { "X-Auth-Token": args.token } : {};
    const cfg = await (await fetch(`${args.url}/api/tags?token=${encodeURIComponent(args.token)}&_=${Math.random()}`, { headers })).json();
    (cfg.tags || []).forEach((t) => libNames.add(t.name));
  }

  console.log(`\n加载模型…（${table.length} 个标签）`);
  const session = await ort.InferenceSession.create(path.join(dir, "model.onnx"));
  console.log("模型就绪\n");

  const toLibTag = (en) => {
    const k = en.toLowerCase();
    return nameMap.get(k) || null; // 只写映射得到的中文标签，避免把英文词典塞进图库
  };

  /* 单张本地图片试算 */
  if (args.image) {
    const buf = fs.readFileSync(args.image);
    const r = await tagImage(session, ort, sharp, buf, table, args);
    console.log(`「${path.basename(args.image)}」识别结果：`);
    r.top.forEach((h) => console.log(`  ${(h.p * 100).toFixed(0).padStart(3)}%  ${h.name}${toLibTag(h.name) ? `  → ${toLibTag(h.name)}` : ""}`));
    console.log(`  分级：${r.level || "未判定"}`);
    if (r.ratings.length) console.log(`  分级标签：${r.ratings.map((x) => `${x.name} ${(x.p * 100).toFixed(0)}%`).join("、")}`);
    console.log("");
    return;
  }

  /* 批量处理图库 */
  let photos = await fetchPhotos(args);
  if (args.onlyUntagged) photos = photos.filter((p) => !(p.tags || []).length);
  if (args.onlyNoCategory) photos = photos.filter((p) => !(Array.isArray(p.categories) ? p.categories.length : p.category));
  if (args.limit) photos = photos.slice(0, args.limit);
  console.log(`目标：${args.url}`);
  console.log(`待处理 ${photos.length} 张｜阈值 ${args.threshold}｜每张最多 ${args.maxTags} 个标签｜${willWrite ? "会写回图库" : "只报告（加 --write 才写回）"}\n`);

  let done = 0, changed = 0, r18suggest = 0;
  const errors = [];
  for (const p of photos) {
    try {
      const buf = await downloadImage(args, p);
      const r = await tagImage(session, ort, sharp, buf, table, args);
      const mappedLib = r.top.map((h) => toLibTag(h.name)).filter((x) => x && libNames.has(x));
      const mappedAll = r.top.map((h) => toLibTag(h.name)).filter(Boolean);
      const inLib = [...new Set(mappedLib)];
      const outside = [...new Set(mappedAll.filter((x) => !libNames.has(x)))];
      const wantR18 = r.level === "questionable" || r.level === "explicit";
      if (wantR18) r18suggest++;

      const line = `  「${p.title}」${r.top.length ? ` → ${r.top.map((h) => `${h.name}(${(h.p * 100).toFixed(0)}%)`).join("、")}` : " → 无命中"}`;
      console.log(line);
      if (inLib.length) console.log(`     可映射到图库标签：${inLib.join("、")}`);
      if (outside.length) console.log(`     图库中还没有（未写入）：${outside.join("、")}`);
      if (wantR18) console.log(`     ⚠️ 分级判定：${r.level}${args.writeR18 ? "（将标记 R18）" : "（加 --write-r18 可自动标记）"}`);

      if (willWrite) {
        const nextTags = [...new Set([...(p.tags || []), ...inLib])].slice(0, 10);
        const body = { tags: nextTags };
        if (args.writeR18 && wantR18) body.r18 = true;
        const tagsChanged = nextTags.length !== (p.tags || []).length;
        if (tagsChanged || (args.writeR18 && wantR18 && p.r18 !== true)) {
          const res = await fetch(`${args.url}/api/photos/${p.id}?token=${encodeURIComponent(args.token)}`, {
            method: "PATCH",
            headers: Object.assign({ "Content-Type": "application/json" }, args.token ? { "X-Auth-Token": args.token } : {}),
            body: JSON.stringify(body),
          });
          if (!res.ok) throw new Error(`PATCH HTTP ${res.status}`);
          changed++;
        }
      }
      done++;
    } catch (e) {
      errors.push(`${p.title || p.id}: ${e.message}`);
    }
  }

  console.log(`\n处理完成：${done} 张${willWrite ? `，写入 ${changed} 张` : ""}${r18suggest ? `，其中 ${r18suggest} 张被判定为可疑/露骨分级` : ""}`);
  if (errors.length) {
    console.log(`失败 ${errors.length} 张：`);
    errors.slice(0, 8).forEach((e) => console.log(`  ✗ ${e}`));
  }
  if (!willWrite) console.log("\n（本次只报告，没有改动图库；确认效果后加 --write 才会写回）\n");
}

main().catch((e) => { console.error(`\n✗ 失败：${e.message}`); process.exit(1); });
