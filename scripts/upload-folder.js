/* ============================================================
   按目录批量上传图片（递归 + 子目录名做标签 + 统一分级）
   用法:
     node scripts/upload-folder.js <目录> [选项]

   选项:
     --site=https://xxx.netlify.app   目标站点（默认读 RN_SITE，否则 https://r-gallery.netlify.app）
     --token=xxx                     访问密码（默认读 RN_TOKEN）
     --rating=r16|r18|general        统一分级（默认不传，即由标签推导）
     --tag=subdir|root|none          标签来源（默认 subdir：用子目录名；root：用根目录名；none：不打标签）
     --tag-prefix=xxx                给每个标签加前缀（可选）
     --categories=二次元-女           主分类（可逗号分隔多个，默认不加）
     --title=filename|stem           标题（默认 stem：文件名去扩展名）
     --concurrency=3                 并发数（默认 3）
     --dry                           只打印计划，不上传
     --skip-existing                 已存在同内容（sha1）时跳过（默认行为，传 --no-skip-existing 关闭）
     --report=path                   结果写入 JSON（默认 .local-data/upload-report-<时间>.json）

   说明:
     · 支持 webp / jpg / jpeg / png / gif；avif 及其它 sharp 能读的格式会先转 webp（服务端只认前五种）
     · 目录嵌套任意深度：标签取「相对根目录的第一层子目录名」，根目录下的散图取根目录名
     · 单张上限 15MB（服务端限制），超限直接报错跳过
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const argv = process.argv.slice(2);
const rootArg = argv.find((a) => !a.startsWith("--"));
const flag = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  return argv.includes(`--${name}`) ? true : def;
};
const SITE = String(flag("site", process.env.RN_SITE || "https://r-gallery.netlify.app")).replace(/\/+$/, "");
const TOKEN = String(flag("token", process.env.RN_TOKEN || ""));
const RATING = flag("rating", "");
const TAG_MODE = String(flag("tag", "subdir"));
const TAG_PREFIX = String(flag("tag-prefix", "") || "");
const CATEGORIES = flag("categories", "")
  ? String(flag("categories", ""))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : [];
const TITLE_MODE = String(flag("title", "stem"));
const CONCURRENCY = Math.max(1, Number(flag("concurrency", 3)) || 3);
const DRY = !!flag("dry", false);
const SKIP_EXISTING = flag("no-skip-existing", false) ? false : true;
const REPORT = String(flag("report", path.join(__dirname, "..", ".local-data", `upload-report-${Date.now()}.json`)));
const MAX_BYTES = 15 * 1024 * 1024;
const PASS_EXTS = new Set([".webp", ".jpg", ".jpeg", ".png", ".gif"]);
const CONVERT_EXTS = new Set([".avif", ".bmp", ".tif", ".tiff", ".heic", ".heif"]);
const sha1 = (buf) => crypto.createHash("sha1").update(buf).digest("hex");

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (ent.isFile()) out.push(full);
  }
  return out;
}

function tagFor(file, root) {
  if (TAG_MODE === "none") return "";
  if (TAG_MODE === "root") return path.basename(root);
  const rel = path.relative(root, file).split(path.sep);
  return rel.length > 1 ? rel[0] : path.basename(root); // 第一层子目录名；散图退化成根目录名
}

async function existingHashes() {
  const set = new Set();
  if (!SKIP_EXISTING) return set;
  let cursor = null;
  for (let i = 0; i < 200; i++) {
    const url = new URL(`${SITE}/api/photos`);
    url.searchParams.set("limit", "500");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url, { headers: TOKEN ? { "X-Auth-Token": TOKEN } : {} });
    if (!res.ok) throw new Error(`拉取现有列表失败 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    for (const p of data.photos || []) if (p.hash) set.add(p.hash);
    cursor = data.cursor; // 服务端分页字段是 cursor（Blobs 游标）
    if (!cursor) break;
  }
  return set;
}

async function prepare(file) {
  const ext = path.extname(file).toLowerCase();
  let buf = fs.readFileSync(file);
  if (!PASS_EXTS.has(ext)) {
    if (!CONVERT_EXTS.has(ext)) return { skip: `不支持的格式 ${ext}` };
    const sharp = require("sharp");
    buf = await sharp(buf).webp({ quality: 92 }).toBuffer(); // 服务端只认 webp/jpg/png/gif
    if (!buf.length) return { skip: "转换失败" };
  }
  if (buf.length > MAX_BYTES) return { skip: `超过 15MB（${(buf.length / 1048576).toFixed(1)}MB）` };
  const stem = path.basename(file, path.extname(file));
  return { buf, hash: sha1(buf), converted: !PASS_EXTS.has(ext), title: TITLE_MODE === "filename" ? path.basename(file) : stem };
}

async function main() {
  if (!rootArg || !fs.existsSync(rootArg)) {
    console.error("用法: node scripts/upload-folder.js <目录> [--token=xxx] [--rating=r16] [--tag=subdir] [--dry]");
    process.exit(1);
  }
  const root = path.resolve(rootArg);
  const files = walk(root);
  console.log(`目录: ${root}`);
  console.log(`图片: ${files.length} 个文件 | 站点: ${SITE} | 分级: ${RATING || "(不传)"} | 标签来源: ${TAG_MODE}`);
  if (!files.length) process.exit(1);

  console.log("拉取线上已有内容哈希 ...");
  const seen = await existingHashes();
  console.log(`已有 ${seen.size} 张（按 sha1 查重）`);

  const ok = [];
  const failed = [];
  const skipped = [];
  let cursor = 0;
  let done = 0;

  async function worker() {
    while (cursor < files.length) {
      const idx = cursor++;
      const file = files[idx];
      const rel = path.relative(root, file);
      const tag = tagFor(file, root);
      const tags = tag ? [TAG_PREFIX + tag] : [];
      let prep;
      try {
        prep = await prepare(file);
      } catch (e) {
        failed.push({ file: rel, error: `读取/转换失败: ${e.message}` });
        console.log(`  ✗ ${rel}: 读取/转换失败 ${e.message}`);
        continue;
      }
      if (prep.skip) {
        skipped.push({ file: rel, reason: prep.skip });
        console.log(`  - ${rel}: ${prep.skip}`);
        continue;
      }
      if (seen.has(prep.hash)) {
        skipped.push({ file: rel, reason: "内容已存在（sha1 相同）" });
        console.log(`  = ${rel}: 已存在，跳过`);
        continue;
      }
      if (DRY) {
        ok.push({ file: rel, tags, rating: RATING, bytes: prep.buf.length, converted: prep.converted });
        console.log(`  · ${rel} → 标签[${tags.join(",") || "-"}] 分级=${RATING || "-"} ${(prep.buf.length / 1024).toFixed(0)}KB${prep.converted ? " (转webp)" : ""}`);
        continue;
      }
      try {
        const body = { dataBase64: prep.buf.toString("base64"), title: prep.title, tags, categories: CATEGORIES };
        if (RATING) body.rating = RATING;
        const res = await fetch(`${SITE}/api/photos`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(TOKEN ? { "X-Auth-Token": TOKEN } : {}) },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) {
          seen.add(prep.hash);
          ok.push({ file: rel, id: data.photo.id, tags: data.photo.tags, rating: data.photo.rating, bytes: data.photo.size, duplicate: !!data.duplicate });
          done++;
          console.log(`  ✓ [${done}/${files.length}] ${rel} → ${data.photo.id} ${data.photo.width}x${data.photo.height} ${(data.photo.size / 1024).toFixed(0)}KB 标签[${(data.photo.tags || []).join(",") || "-"}] 分级=${data.photo.rating}`);
        } else {
          failed.push({ file: rel, error: data.error || `HTTP ${res.status}` });
          console.log(`  ✗ ${rel}: ${data.error || "HTTP " + res.status}`);
        }
      } catch (e) {
        failed.push({ file: rel, error: e.message });
        console.log(`  ✗ ${rel}: ${e.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log("");
  console.log(`完成：上传 ${ok.length}，跳过 ${skipped.length}，失败 ${failed.length}${DRY ? "（干跑，未真正上传）" : ""}`);
  if (failed.length) for (const f of failed.slice(0, 20)) console.log(`  ✗ ${f.file}: ${f.error}`);
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify({ root, site: SITE, rating: RATING, tagMode: TAG_MODE, dry: DRY, ok, skipped, failed }, null, 1));
  console.log(`报告: ${REPORT}`);
  if (failed.length) process.exitCode = 1;
}

main();
