/* ============================================================
   统一 API 入口（Netlify Functions v2，v0.9.9 移植参考项目模式）
   路由由 config.path 声明，无需 netlify.toml redirects：
     GET    /api/photos                列表（分页，游标）
     GET    /api/photos/:id            单张元数据
     GET    /api/photos/:id/raw        图片字节（CDN 缓存）
     POST   /api/photos                上传（JSON + base64，自动转 WebP 由前端完成）
     PATCH  /api/photos/:id            更新元数据
     DELETE /api/photos/:id            删除单张
     DELETE /api/photos                清空图库
     GET    /api/meta/stats            用量统计
     GET    /api/export                导出全部元数据
     POST   /api/import                批量导入（供自建静态源使用）
     GET    /api/tags                  获取标签配置（categories + groups + tags）
     PUT    /api/tags                  整体保存标签配置（删除主分类会同步清空照片引用）
     POST   /api/tags/rename           标签改名/合并（同步所有照片）
     POST   /api/tags/remove           删除标签（同步从照片移除）
     POST   /api/tags/category-rename  主分类改名（同步所有照片的 categories）
     POST   /api/tags/category-remove  删除主分类（同步从照片的 categories 移除）
     POST   /api/photos/:id/image      覆盖原图字节（旋转等编辑后保存）
   ============================================================ */
const {
  store, json, notFound, badRequest, serverError, unauthorized,
  nanoid, imageSize, sniffMime,
  authConfig, saveAuthConfig, checkAuth, isR18Photo, isR16Photo, isAdultPhoto, sha256hex,
  RATINGS, RATING_LABEL, normRating, ratingOf, // v0.57 三档分级
} = require("./_lib");
const crypto = require("crypto");
const dns = require("dns").promises;
const sharp = require("sharp"); // v0.13.8：服务端缩略图（列表秒开）

const PREFIX_META = "meta/";
const PREFIX_HASH = "hash/"; // v0.54：内容 sha1 → 照片 id 的反查键，查重从 O(N) 降到 O(1)
const hashKeyOf = (h) => `${PREFIX_HASH}${h}`;
const PREFIX_IMG = "img/";
const KEY_TAGS = "tags-config"; // 标签分组配置（v0.11 / v0.15 主分类）
const KEY_ALBUMS = "albums-config"; // 相册配置（v0.12）
const KEY_LOGS = "logs"; // 操作日志（v0.12）
const KEY_INDEX = "photos-index"; // v0.24 的旧单 Blob 索引（v0.54 起被 idx/ 取代，仅在重建/清空时清理遗留）
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
/* 内置主分类（上传必选、可多选；照片 meta.categories 存名称数组，名称即引用键）
   首次读写配置时若 categories 缺失则自动补这份默认值 */
const DEFAULT_CATEGORIES = [
  { name: "次元女", color: "#ff6fa5" },
  { name: "次元男", color: "#6aa5ff" },
  { name: "插画", color: "#b58cff" },
  { name: "风景", color: "#4ec97b" },
  { name: "美女", color: "#ffb340" },
  { name: "帅哥", color: "#00c2b8" },
];
const sha1hex = (buf) => crypto.createHash("sha1").update(buf).digest("hex");
const thumbKeyOf = (id) => `thumb-${id}`;
const sanitizeCat = (v) => String(v || "").trim().slice(0, 20); // 单个主分类名清洗（配置增删改时用）
/* 照片主分类数组清洗：字符串 / 数组都接受，去重、去空、上限 6（v0.19 主分类改为多选） */
function sanitizeCats(v) {
  const arr = Array.isArray(v) ? v : (v ? [v] : []);
  return [...new Set(arr.map((x) => sanitizeCat(x)).filter(Boolean))].slice(0, 6);
}
/* v0.55 / v0.57：保留名 —— r18 / r16 现在是**图库分级档位**（见 _lib.js 的 ratingOf），
   不该再作为普通标签 / 主分类存在：
   · 新建同名标签或主分类一律 400（存量由 scripts/migrate-rating.js 清理）；
   · 照片写入时若 tags / categories 里出现它们，折算进 meta.rating 并从数组剔除
     （旧脚本"打 r18 标签即标 R18"的习惯仍然有效，但数组里不留脏名字）。 */
const RESERVED_NAMES = new Set(["r18", "r16"]);
const isReservedName = (n) => RESERVED_NAMES.has(String(n == null ? "" : n).trim().toLowerCase());
/* 从数组里剔除保留名（分级已折算进 meta.rating） */
const stripRatingNames = (arr) => (Array.isArray(arr) ? arr : []).filter((x) => !isReservedName(x));
const RATING_RANK = { general: 0, r16: 1, r18: 2 };
/* 把一组名字里的 r18 / r16 折算进 meta.rating —— 只升不降（降级必须显式传 rating） */
function bumpRating(meta, names) {
  const low = (Array.isArray(names) ? names : []).map((x) => String(x).trim().toLowerCase());
  const cur = RATING_RANK[ratingOf(meta)] || 0;
  if (low.includes("r18") && cur < 2) meta.rating = "r18";
  else if (low.includes("r16") && cur < 1) meta.rating = "r16";
  return meta;
}
/* 照片标签清洗（v0.55，与 sanitizeCats 对称）：去空、去重、单名限长 40、最多 10 个。
   以前这里只有 map(trim).filter(Boolean).slice(0,10) —— 同一张图能存重复标签，
   也能塞进任意长字符串（整库导出会被撑大）。 */
const TAG_NAME_MAX = 40;
const TAGS_MAX = 10;
function sanitizeTags(v) {
  const arr = Array.isArray(v) ? v : (v ? [v] : []);
  const out = [];
  const seen = new Set();
  for (const x of arr) {
    const name = String(x == null ? "" : x).trim().slice(0, TAG_NAME_MAX);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= TAGS_MAX) break;
  }
  return out;
}
/* 主分类列表归一化：无/空 → 默认六类；补 id/color/sort，名称去重 */
function normCategories(list) {
  const out = [];
  const seen = new Set();
  (Array.isArray(list) && list.length ? list : DEFAULT_CATEGORIES).forEach((c) => {
    if (!c || typeof c !== "object") return;
    const name = String(c.name || "").trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({
      id: String(c.id || "").trim() || `c-${nanoid(6)}`,
      name,
      color: HEX_RE.test(String(c.color || "")) ? String(c.color) : null,
      sort: Number.isFinite(c.sort) ? c.sort : out.length,
    });
  });
  return out;
}

/* 服务端生成 480px 缩略图（v0.13.8）：最长边 480、webp q80、自动旋转、不放大 */
async function genThumbBuf(buf) {
  const out = await sharp(buf, { failOn: "none", animated: false })
    .rotate()
    .resize(480, 480, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 80, effort: 4 })
    .toBuffer();
  return out;
}
/* dHash 感知哈希（v0.21）：缩放到 9×8 灰度、逐行比较相邻像素，64 位 → 16 位十六进制
   与前端 dhashOfFile 算法保持一致（拉伸到 9×8、左<右记 1），用于「相似图片」提醒 */
async function genDHash(buf) {
  try {
    const raw = await sharp(buf, { failOn: "none", animated: false })
      .rotate()
      .resize(9, 8, { fit: "fill" })
      .grayscale()
      .raw()
      .toBuffer();
    let hex = "";
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x += 4) {
        let nibble = 0;
        for (let k = 0; k < 4; k++) {
          nibble = (nibble << 1) | (raw[y * 9 + x + k] < raw[y * 9 + x + k + 1] ? 1 : 0);
        }
        hex += nibble.toString(16);
      }
    }
    return hex;
  } catch (e) {
    return null; // 算不出来不影响主流程
  }
}
/* 保存缩略图到 meta（有前端 thumb 用前端的，否则服务端生成） */
async function saveThumb(s, meta, id, origBuf, frontThumb) {
  try {
    if (frontThumb) {
      meta.thumbKey = thumbKeyOf(id);
      meta.thumbMime = frontThumb.mime;
      await s.set(meta.thumbKey, frontThumb.buf);
    } else if (origBuf) {
      const out = await genThumbBuf(origBuf);
      meta.thumbKey = thumbKeyOf(id);
      meta.thumbMime = "image/webp";
      await s.set(meta.thumbKey, out);
    }
  } catch (e) { /* 缩略图失败不影响主流程 */ }
}

/* 解析可选缩略图（前端生成，webp/jpeg 兼容），非法时返回 null */
function parseThumb(body) {
  const raw = body.thumbBase64 || body.thumb;
  if (!raw) return null;
  const m = String(raw).match(/^data:image\/(\w+);base64,([\s\S]+)$/);
  const buf = Buffer.from(m ? m[2] : String(raw), "base64");
  if (!buf.length || buf.length > 3 * 1024 * 1024) return null;
  const mime = m ? `image/${m[1] === "jpg" ? "jpeg" : m[1]}` : sniffMime(buf);
  return { buf, mime };
}

exports.default = async (req) => {
  try {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const seg = path.split("/").filter(Boolean); // ["api", "photos", id?, "raw"?]
    const rest = seg.slice(2);



    /* ---- 访问控制端点（无需登录） ---- */
    if (method === "GET" && path.endsWith("/api/auth/state")) return authState();
    if (method === "POST" && path.endsWith("/api/auth/login")) return authLogin(req);

    /* ---- 其余端点默认都需要密码（未设置密码时自动放行）----
       role：admin = 访问密码（全部权限）；tagger = 整理密码（只能看图 + 给照片打标签）
       v0.49 观光模式：既没密码也没整理密码时，仍放行「只读 + 已做安全过滤」的请求 */
    const auth = await checkAuth(req, url);
    const role = auth.ok ? auth.role : null;
    const guest = !auth.ok && guestReadOK(method, path, url, rest);
    if (!auth.ok && !guest) return unauthorized("需要访问密码，或密码已失效");
    // 整理模式：只允许读取 + 修改单张照片的标签 / 主分类，其余管理操作一律拒绝
    if (role === "tagger") {
      const isPatchPhoto = method === "PATCH" && path.startsWith("/api/photos/") && rest.length === 1;
      if (method !== "GET" && !isPatchPhoto) return unauthorized("整理模式只能给图片添加标签");
    }

    if (method === "POST" && path.endsWith("/api/auth/tagger")) return authTagger(req, role); // v0.51 设置整理密码（仅管理员）

    if (method === "GET" && path.endsWith("/api/photos")) return list(url, role);
    if (method === "GET" && path.endsWith("/api/tags")) return tagsGet();
    if (method === "PUT" && path.endsWith("/api/tags")) return tagsPut(req);
    if (method === "POST" && path.endsWith("/api/tags/rename")) return tagsRename(req);
    if (method === "POST" && path.endsWith("/api/tags/remove")) return tagsRemove(req);
    if (method === "POST" && path.endsWith("/api/tags/category-rename")) return categoryRename(req);
    if (method === "POST" && path.endsWith("/api/tags/category-remove")) return categoryRemove(req);
    if (method === "GET" && path.endsWith("/api/albums")) return albumsGet();
    if (method === "PUT" && path.endsWith("/api/albums")) return albumsPut(req);
    if (method === "GET" && path.endsWith("/api/meta/logs")) {
      return logsGet();
    }
    if (method === "DELETE" && path.endsWith("/api/meta/logs")) {
      return logsClear();
    }
    if (method === "GET" && path.startsWith("/api/photos/") && rest.length === 2 && rest[1] === "raw") return raw(rest[0], req, url, role);
    if (method === "GET" && path.startsWith("/api/photos/") && rest.length === 2 && rest[1] === "thumb") return thumb(rest[0], req, url, role);
    if (method === "GET" && path.endsWith("/api/photos/check")) return checkHash(url);
    if (method === "GET" && path.startsWith("/api/photos/") && rest.length === 1) return getMeta(rest[0]);
    if (method === "POST" && path.endsWith("/api/photos")) return upload(req);
    if (method === "POST" && path.endsWith("/api/photos/reindex-dhash")) return reindexDHash(req); // v0.21 补算感知哈希
    if (method === "POST" && path.endsWith("/api/photos/reindex")) return reindexIndex(req); // v0.24 重建列表索引
    if (method === "PATCH" && path.startsWith("/api/photos/") && rest.length === 1) return patch(req, rest[0], role);
    if (method === "DELETE" && path.endsWith("/api/photos")) return clearAll(req);
    if (method === "DELETE" && path.startsWith("/api/photos/") && rest.length === 1) return remove(req, rest[0]);
    if (method === "POST" && path.startsWith("/api/photos/") && rest.length === 2 && rest[1] === "image") return replaceImage(req, rest[0]);
    if (method === "GET" && path.endsWith("/api/meta/stats")) return stats();
    if (method === "GET" && path.endsWith("/api/export")) return exportAll();
    if (method === "POST" && path.endsWith("/api/import")) return importStatic(req);

    return notFound("Route not found");
  } catch (e) {
    return serverError(e);
  }
};

exports.config = {
  path: [
    "/api/photos",
    "/api/photos/:id",
    "/api/photos/:id/raw",
    "/api/photos/:id/thumb",
    "/api/photos/check",
    "/api/photos/reindex-dhash",
    "/api/photos/reindex",
    "/api/photos/:id/image",
    "/api/meta/stats",
    "/api/export",
    "/api/import",
    "/api/tags",
    "/api/tags/rename",
    "/api/tags/remove",
    "/api/tags/category-rename",
    "/api/tags/category-remove",
    "/api/albums",
    "/api/meta/logs",
    "/api/auth/state",
    "/api/auth/login",
    "/api/auth/tagger", // v0.51：设置整理模式密码（漏加这个会让请求直接 404）
  ],
};

/* ============================================================
   访问控制（v0.16）
   ============================================================ */
async function authState() {
  const cfg = await authConfig();
  return json({ gate: !!cfg.accessHash, hasTagger: !!cfg.taggerHash });
}

/* 登录：一次输入，服务端判断是管理员还是整理角色 */
async function authLogin(req) {
  const body = await req.json().catch(() => ({}));
  const cfg = await authConfig();
  if (!cfg.accessHash && !cfg.taggerHash) return json({ ok: true, gate: false, role: "admin" }); // 未设置密码：直接通过
  const t = String(body.token || "").trim();
  if (t && cfg.accessHash && sha256hex(t) === cfg.accessHash) return json({ ok: true, gate: true, role: "admin" });
  if (t && cfg.taggerHash && sha256hex(t) === cfg.taggerHash) return json({ ok: true, gate: true, role: "tagger" });
  return unauthorized("密码错误");
}

/* 设置 / 清除整理模式密码（v0.51；只有管理员能改，taggerKey 传空串即清除） */
async function authTagger(req, role) {
  if (role !== "admin") return unauthorized("只有管理员能设置整理密码");
  const body = await req.json().catch(() => ({}));
  const k = String(body.taggerKey || "").trim();
  const cfg = await authConfig();
  if (!k) {
    delete cfg.taggerHash;
    await saveAuthConfig(cfg);
    await logAction(req, "清除整理模式密码", "");
    return json({ ok: true, hasTagger: false });
  }
  if (k.length < 4) return badRequest("整理密码至少 4 位");
  if (cfg.accessHash && sha256hex(k) === cfg.accessHash) return badRequest("整理密码不能与访问密码相同");
  cfg.taggerHash = sha256hex(k);
  await saveAuthConfig(cfg);
  await logAction(req, "设置整理模式密码", "");
  return json({ ok: true, hasTagger: true });
}

/* v0.50：修改访问密码 / 设置 R18 密钥的接口已删除 ——
   访问密码只能通过 Netlify 环境变量 ADMIN_TOKEN + 清空 auth-config 重新初始化 */

/* ---------- 操作日志（v0.12） ---------- */
async function logAction(req, action, detail) {
  try {
    const s = store();
    const raw = await s.get(KEY_LOGS, { type: "json" });
    const logs = Array.isArray(raw) ? raw : [];
    const ip = req.headers.get("x-nf-client-connection-ip") ||
      (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "local";
    logs.unshift({ t: new Date().toISOString(), action, detail: String(detail || "").slice(0, 200), ip });
    await s.set(KEY_LOGS, JSON.stringify(logs.slice(0, 500)));
  } catch (e) { /* 日志失败不影响主流程 */ }
}

async function logsGet() {
  const raw = await store().get(KEY_LOGS, { type: "json" });
  return json({ logs: Array.isArray(raw) ? raw : [] });
}

async function logsClear() {
  await store().delete(KEY_LOGS);
  return json({ ok: true });
}

/* ---------- 相册（v0.12）：albums-config ---------- */
async function loadAlbums(s) {
  const raw = await s.get(KEY_ALBUMS, { type: "json" });
  return raw && Array.isArray(raw.albums) ? raw : { albums: [] };
}
async function albumsGet() {
  return json(await loadAlbums(store()));
}
async function albumsPut(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }
  const inAlbums = Array.isArray(body.albums) ? body.albums : null;
  if (!inAlbums) return badRequest("需要 albums 数组");
  const seen = new Set();
  const albums = [];
  for (const a of inAlbums) {
    if (!a || typeof a !== "object") continue;
    const name = String(a.name || "").trim();
    if (!name) return badRequest("相册名称不能为空");
    const id = String(a.id || "").trim() || `a-${nanoid(6)}`;
    if (seen.has(id)) return badRequest(`相册 id 重复: ${id}`);
    seen.add(id);
    const photoIds = Array.isArray(a.photoIds)
      ? [...new Set(a.photoIds.map((x) => String(x).trim()).filter(Boolean))].slice(0, 2000)
      : [];
    albums.push({ id, name, photoIds, sort: Number.isFinite(a.sort) ? a.sort : albums.length });
  }
  const cfg = { albums };
  await store().set(KEY_ALBUMS, JSON.stringify(cfg));
  await logAction(req, "保存相册配置", `${albums.length} 个相册`);
  return json({ ok: true, config: cfg });
}
/* 删除照片后从相册移除引用 */
async function scrubAlbums(ids) {
  try {
    const s = store();
    const cfg = await loadAlbums(s);
    const del = new Set(ids);
    let changed = false;
    for (const a of cfg.albums) {
      const next = a.photoIds.filter((x) => !del.has(x));
      if (next.length !== a.photoIds.length) { a.photoIds = next; changed = true; }
    }
    if (changed) await s.set(KEY_ALBUMS, JSON.stringify(cfg));
  } catch (e) { /* ignore */ }
}

/* ============================================================
   照片列表索引（v0.24）：把列表/筛选/搜索所需的轻量字段存在一个 Blob 里
   —— 图片字节仍按需取（raw / thumb），但列表接口不必再逐个读 meta，
   几千张时从「几千次 Blobs 读」降到「一次读」。
   索引会在上传/编辑/删除/导入时增量维护，批量改写（改名、删标签、删分类）后整体重建。
   ============================================================ */
function indexEntry(m) {
  return {
    id: m.id,
    title: m.title || "",
    tags: Array.isArray(m.tags) ? m.tags : [],
    categories: Array.isArray(m.categories) ? m.categories : (m.category ? [m.category] : []),
    rating: ratingOf(m), // v0.57：三档分级（general / r16 / r18），取代原来的 r18 布尔
    fav: m.fav === true, // v0.56 收藏夹：照片上的标记（跟着图走，换设备也在）
    width: m.width || 0,
    height: m.height || 0,
    size: m.size || 0,
    mime: m.mime || "",
    uploadedAt: m.uploadedAt || "",
    takenAt: m.takenAt || "",
    thumbKey: m.thumbKey || null,
    hash: m.hash || null,
    dhash: m.dhash || null,
    src: m.src || null,
  };
}
/* ---------- 索引条目（v0.54：一条一 key，根治并发丢更新） ----------
   旧实现把整份索引存在单个 Blob 里，每次上传/编辑/删除都要「整表读 → 改 → 整表写」；
   两张图并发上传时后写的会覆盖先写的 —— 照片从列表里消失（meta 还在，要跑 reindex 才回来）。
   现在 key = idx/<13 位倒序时间戳>-<id>.json：
   · 写入只碰自己那一条，不存在 read-modify-write 竞态，也不会随图库变大而变慢；
   · 倒序时间戳让字典序 = 「最新在前」，list 分页可直接用，无需再排序。
   编辑与替换原图都不改 uploadedAt，所以同一张照片的 key 始终不变。 */
const PREFIX_IDX = "idx/";
const TS_MAX = 9999999999999;
function idxStampOf(iso) {
  const t = Date.parse(String(iso || ""));
  const ms = Number.isFinite(t) ? Math.min(Math.max(t, 0), TS_MAX) : 0;
  return String(TS_MAX - ms).padStart(13, "0");
}
const idxKeyOf = (id, uploadedAt) => `${PREFIX_IDX}${idxStampOf(uploadedAt)}-${id}.json`;

/* 读一页索引（管理员列表路径）：list 只给 key，条目内容要逐条取，一页几十次并发读可接受 */
async function indexGetPage(s, { limit = 60, cursor } = {}) {
  const res = await s.list({ prefix: PREFIX_IDX, cursor, limit });
  const entries = await Promise.all(res.blobs.map((b) => s.get(b.key, { type: "json" }).catch(() => null)));
  return { entries: entries.filter((e) => e && e.id), cursor: res.nextCursor || null, hasMore: !!res.nextCursor };
}
/* 全量读取（观光模式过滤、用量统计、重建用）*/
async function indexAll(s) {
  const keys = [];
  let cursor;
  do {
    const res = await s.list({ prefix: PREFIX_IDX, cursor, limit: 200 });
    for (const b of res.blobs) keys.push(b.key);
    cursor = res.nextCursor;
  } while (cursor);
  const out = [];
  for (let i = 0; i < keys.length; i += 20) { // 分批并发，避免一次打满连接
    const batch = await Promise.all(keys.slice(i, i + 20).map((k) => s.get(k, { type: "json" }).catch(() => null)));
    for (const e of batch) if (e && e.id) out.push(e);
  }
  return out; // 顺序由 key 保证：最新在前
}
async function indexCount(s) {
  let total = 0;
  let cursor;
  do {
    const res = await s.list({ prefix: PREFIX_IDX, cursor, limit: 1000 });
    total += res.blobs.length;
    cursor = res.nextCursor;
  } while (cursor);
  return total;
}
/* 增量维护：只写 / 只删自己那一条 */
const indexPut = (s, meta) => s.set(idxKeyOf(meta.id, meta.uploadedAt), JSON.stringify(indexEntry(meta)));
async function indexDrop(s, metas) { // metas: [{ id, uploadedAt }]，传完整 meta 即可
  await Promise.all(metas.map((m) => s.delete(idxKeyOf(m.id, m.uploadedAt))));
}
async function indexClear(s) { // 先收集再删：边列边删在不同 Blobs 实现下会漏删
  const keys = [];
  let cursor;
  do {
    const res = await s.list({ prefix: PREFIX_IDX, cursor, limit: 200 });
    for (const b of res.blobs) keys.push(b.key);
    cursor = res.nextCursor;
  } while (cursor);
  for (let i = 0; i < keys.length; i += 20) {
    await Promise.all(keys.slice(i, i + 20).map((k) => s.delete(k)));
  }
  await s.delete(KEY_INDEX); // 顺手清掉 v0.54 之前遗留的单 Blob 索引
  return keys.length;
}
/* 全量重建（低频：批量改写 / reindex 接口）：先写后删 ——
   meta 数量不变时只是覆盖内容，中途失败也不会出现「列表空窗」 */
async function indexRebuild(s) {
  const metas = [];
  let cursor;
  do {
    const res = await s.list({ prefix: PREFIX_META, cursor, limit: 200 });
    const batch = await Promise.all(res.blobs.map((b) => s.get(b.key, { type: "json" }).catch(() => null)));
    for (const m of batch) if (m && m.id) metas.push(m);
    cursor = res.nextCursor;
  } while (cursor);

  const entries = metas.map(indexEntry);
  for (let i = 0; i < entries.length; i += 20) {
    await Promise.all(entries.slice(i, i + 20).map((e) => s.set(idxKeyOf(e.id, e.uploadedAt), JSON.stringify(e))));
  }
  // 清掉 meta 已不存在 / key 已变化的残留条目
  const alive = new Set(entries.map((e) => idxKeyOf(e.id, e.uploadedAt)));
  const stale = [];
  let cur2;
  do {
    const res = await s.list({ prefix: PREFIX_IDX, cursor: cur2, limit: 200 });
    for (const b of res.blobs) if (!alive.has(b.key)) stale.push(b.key);
    cur2 = res.nextCursor;
  } while (cur2);
  for (let i = 0; i < stale.length; i += 20) {
    await Promise.all(stale.slice(i, i + 20).map((k) => s.delete(k)));
  }
  await s.delete(KEY_INDEX); // 清掉 v0.54 之前遗留的单 Blob 索引
  return entries;
}
/* v0.54：原 indexUpsert / indexDrop（整表读改写）已由上面的 indexPut / indexDrop 取代 */

/* v0.54：老库自动迁移 —— idx/ 为空但仍存在照片 meta 时（升级后第一次访问，
   或只有 v0.24 那份单 Blob 索引）自动重建一次；索引正常时只多一次极廉价的 list。
   返回重建后的条数，索引本来就正常时返回 null（调用方自己算 total）。 */
async function indexHeal(s) {
  const probe = await s.list({ prefix: PREFIX_IDX, limit: 1 });
  if (probe.blobs.length) return null;
  const meta = await s.list({ prefix: PREFIX_META, limit: 1 });
  if (!meta.blobs.length) return 0; // 确实是空库
  return (await indexRebuild(s)).length;
}

/* ---------- 列表（v0.54：索引按条存储，两种模式各自分页） ----------
   管理员：直接按 key 顺序分页（cursor 是 Blobs 游标，一次只读一页）；
   观光 / 整理模式：必须「分页前过滤」成人向，否则能靠翻页反推数量 ——
   这条路径读全量索引后在内存里过滤分页（cursor 是数字偏移）。
   两种模式的 cursor 语义不同，但前端切换模式时会从头重新加载，不会混用。 */
async function list(url, role) {
  const q = url.searchParams;
  const limit = Math.min(parseInt(q.get("limit"), 10) || 60, 500);
  const s = store();
  const healed = await indexHeal(s); // v0.54：老库首次访问自动重建索引
  const hideAdult = safeMode(q) || role === "tagger"; // v0.51：整理模式同样看不到成人向
  let photos;
  let cursor = null;
  let total;

  if (!hideAdult) {
    const page = await indexGetPage(s, { limit, cursor: q.get("cursor") || undefined });
    photos = page.entries.map((e) => ({ ...e, rating: ratingOf(e) }));
    cursor = page.cursor;
    total = healed !== null ? healed : await indexCount(s);
  } else {
    const arr = (await indexAll(s)).filter((e) => !isAdultPhoto(e));
    const start = Math.max(parseInt(q.get("cursor"), 10) || 0, 0);
    photos = arr.slice(start, start + limit).map((e) => ({ ...e, rating: ratingOf(e) }));
    const nextStart = start + limit;
    cursor = nextStart < arr.length ? String(nextStart) : null;
    total = arr.length;
  }
  return json({ photos, cursor, hasMore: !!cursor, total });
}

/* ---------- 观光模式（v0.49） ---------- */
/* 是否属于「观光访客可读」的请求：只读、且不涉及成人向内容 */
function safeMode(q) {
  const v = String((q && q.get && q.get("safe")) || "").toLowerCase();
  return v === "1" || v === "true";
}
function guestReadOK(method, path, url, rest) {
  if (method !== "GET") return false;
  // 图片列表：必须显式带 safe=1（服务端会剔除 R18 / R16）
  if (path.endsWith("/api/photos")) return safeMode(url.searchParams);
  // 标签配置与相册列表：不含成人向内容，可读
  if (path.endsWith("/api/tags") || path.endsWith("/api/albums")) return true;
  // 图片字节：放行到这里，raw / thumb 内部再按「成人向」判断
  if (path.startsWith("/api/photos/") && rest.length === 2 && (rest[1] === "raw" || rest[1] === "thumb")) return true;
  return false;
}

/* ---------- 单张元数据 ---------- */
async function getMeta(id) {
  const m = await store().get(`${PREFIX_META}${id}.json`, { type: "json" });
  if (!m) return notFound("Photo not found");
  return json({ photo: { ...m, rating: ratingOf(m) } });
}

/* ---------- 图片字节输出（v0.9.20：必须用 arrayBuffer 读，v8 默认返回字符串会损坏二进制） ---------- */
async function raw(id, req, url, role) {
  const s = store();
  const m = await s.get(`${PREFIX_META}${id}.json`, { type: "json" });
  if (!m) return notFound("Photo not found");
  // 成人向内容：只有管理员能看（观光访客与整理模式都拒绝）
  if (isAdultPhoto(m) && role !== "admin") return unauthorized("当前模式不可查看该内容");
  const buf = await s.get(m.origKey || `${PREFIX_IMG}${id}`, { type: "arrayBuffer" });
  if (!buf) return notFound("Image data not found");
  return new Response(buf, {
    status: 200,
    headers: {
      "Content-Type": m.mime || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/* ---------- 覆盖原图字节（v0.11.2：旋转等编辑后保存） ---------- */
async function replaceImage(req, id) {
  let body;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }
  const data = body.dataBase64 || body.data;
  if (!data) return badRequest("Missing dataBase64");
  const buf = Buffer.from(String(data).replace(/^data:image\/\w+;base64,/, ""), "base64");
  if (!buf.length || buf.length > 15 * 1024 * 1024) return badRequest("Image empty or too large (>15MB)");
  const dims = imageSize(buf);
  if (!dims) return badRequest("Unsupported image format");

  const s = store();
  const meta = await s.get(`${PREFIX_META}${id}.json`, { type: "json" });
  if (!meta) return notFound("Photo not found");

  const mime = sniffMime(buf);
  const origKey = meta.origKey || `${PREFIX_IMG}${id}`;
  const thumb = parseThumb(body);
  await s.set(origKey, buf);
  meta.size = buf.length;
  meta.width = dims.width;
  meta.height = dims.height;
  meta.mime = mime;
  const oldHash = meta.hash; // v0.54：覆盖原图后同步 hash/ 反查键
  meta.hash = sha1hex(buf);
  meta.dhash = await genDHash(buf); // v0.21：替换原图后重算感知哈希
  await saveThumb(s, meta, id, buf, thumb); // 前端缩略图优先，否则服务端生成
  meta.updatedAt = new Date().toISOString();
  await s.set(`${PREFIX_META}${id}.json`, JSON.stringify(meta));
  await indexPut(s, meta); // v0.54 同步列表索引（尺寸/大小/哈希都变了）
  if (oldHash && oldHash !== meta.hash) {
    const stale = await s.get(hashKeyOf(oldHash), { type: "json" }).catch(() => null);
    if (stale && stale.id === id) await s.delete(hashKeyOf(oldHash));
  }
  await s.set(hashKeyOf(meta.hash), JSON.stringify({ id, title: meta.title }));
  await logAction(req, "替换图片内容", (meta.title || id) + ` ${dims.width}x${dims.height}`);
  return json({ ok: true, photo: meta });
}

/* ---------- 缩略图输出（v0.12/0.13.8：无缩略图时服务端即时生成并缓存，旧图自动补齐） ---------- */
async function thumb(id, req, url, role) {
  const s = store();
  const meta = await s.get(`${PREFIX_META}${id}.json`, { type: "json" });
  if (!meta) return notFound("Photo not found");
  // 成人向内容：只有管理员能看（观光访客与整理模式都拒绝）
  if (isAdultPhoto(meta) && role !== "admin") return unauthorized("当前模式不可查看该内容");
  let buf = null;
  if (meta.thumbKey) buf = await s.get(meta.thumbKey, { type: "arrayBuffer" });
  if (!buf) {
    // 懒生成：读原图 → sharp 480px → 存入 Blobs（下次直接命中，immutable 缓存）
    const orig = await s.get(meta.origKey || `${PREFIX_IMG}${id}`, { type: "arrayBuffer" });
    if (!orig) return notFound("Image data not found");
    try {
      const out = await genThumbBuf(Buffer.from(orig));
      meta.thumbKey = thumbKeyOf(id);
      meta.thumbMime = "image/webp";
      await s.set(meta.thumbKey, out);
      await s.set(`${PREFIX_META}${id}.json`, JSON.stringify(meta));
      await indexPut(s, meta); // v0.54 懒生成缩略图后同步索引
      buf = out;
    } catch (e) {
      return notFound("Thumbnail generation failed");
    }
  }
  return new Response(buf, {
    status: 200,
    headers: {
      "Content-Type": meta.thumbMime || "image/webp",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/* ---------- 重复检测（v0.12 按内容 sha1；v0.54 改走 hash/<sha1> 反查键） ----------
   旧实现每次都要遍历全库 meta，而前端每上传一张就调一次 → 整体 O(N²)。
   现在一次 get 即可；老库还没有反查键时回退线性扫描，并顺手把键补上。 */
async function checkHash(url) {
  const hash = (url.searchParams.get("hash") || "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hash)) return badRequest("Invalid hash");
  const s = store();
  const hit = await s.get(hashKeyOf(hash), { type: "json" }).catch(() => null);
  if (hit && hit.id) {
    const alive = await s.get(`${PREFIX_META}${hit.id}.json`, { type: "json" });
    if (alive) return json({ duplicate: true, photo: { id: alive.id, title: alive.title } });
    await s.delete(hashKeyOf(hash)); // 反查键指向的照片已被删除 → 清掉后继续找
  }
  let cursor;
  do {
    const res = await s.list({ prefix: PREFIX_META, cursor, limit: 200 });
    for (const item of res.blobs) {
      const m = await s.get(item.key, { type: "json" });
      if (m && m.hash === hash) {
        await s.set(hashKeyOf(hash), JSON.stringify({ id: m.id, title: m.title })); // 惰性补键
        return json({ duplicate: true, photo: { id: m.id, title: m.title } });
      }
    }
    cursor = res.nextCursor;
  } while (cursor);
  return json({ duplicate: false });
}

/* ---------- POST /api/photos/reindex-dhash：为老照片补算感知哈希（v0.21，一次性） ---------- */
async function reindexDHash(req) {
  const s = store();
  let cursor;
  let updated = 0;
  let failed = 0;
  let skipped = 0;
  do {
    const res = await s.list({ prefix: PREFIX_META, cursor, limit: 100 });
    for (const item of res.blobs) {
      const m = await s.get(item.key, { type: "json" });
      if (!m) continue;
      if (m.dhash) { skipped++; continue; }
      const buf = await s.get(m.origKey || `${PREFIX_IMG}${m.id}`, { type: "arrayBuffer" });
      if (!buf) { failed++; continue; }
      const dh = await genDHash(Buffer.from(buf));
      if (!dh) { failed++; continue; }
      m.dhash = dh;
      await s.set(item.key, JSON.stringify(m));
      updated++;
    }
    cursor = res.nextCursor;
  } while (cursor);
  await logAction(req, "补算感知哈希", `${updated} 张已补算 / ${skipped} 张已有 / ${failed} 张失败`);
  if (updated) await indexRebuild(s); // v0.24：索引里的 dhash 也一起刷新
  return json({ ok: true, updated, skipped, failed });
}

/* ---------- POST /api/photos/reindex：重建列表索引（v0.24，可修复索引与 meta 不一致） ---------- */
async function reindexIndex(req) {
  const arr = await indexRebuild(store());
  await logAction(req, "重建列表索引", `${arr.length} 张`);
  return json({ ok: true, count: arr.length });
}

/* ---------- 上传 ---------- */
async function upload(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }
  const data = body.dataBase64 || body.data;
  if (!data) return badRequest("Missing dataBase64");
  const buf = Buffer.from(String(data).replace(/^data:image\/\w+;base64,/, ""), "base64");
  if (!buf.length || buf.length > 15 * 1024 * 1024) return badRequest("Image empty or too large (>15MB)");
  const dims = imageSize(buf);
  if (!dims) return badRequest("Unsupported image format");

  const id = nanoid();
  const mime = sniffMime(buf);
  // key 带扩展名（参考项目模式）：缓存友好、可按扩展名推断 mime
  const ext = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" }[mime] || "bin";
  const origKey = `${PREFIX_IMG}${id}.${ext}`;
  const thumb = parseThumb(body);
  const hash = sha1hex(buf); // v0.54：内容哈希（同时用于 hash/ 反查键）
  /* v0.57：分级 —— 标签 / 主分类里写了 r18、r16 就折算成分级（安全优先，只升不降），
     并把这两个名字从数组里剔掉；显式 body.rating 可以再往上抬，但不能把带 r18 标签的图降成大众级 */
  const tagsRaw = sanitizeTags(body.tags); // v0.55：去重 / 单名限长 40 / 上限 10
  const catsRaw = sanitizeCats(body.categories !== undefined ? body.categories : body.category); // v0.19 多选
  let rating = ratingOf({ tags: tagsRaw, categories: catsRaw });
  if (body.rating !== undefined) {
    const v = String(body.rating).trim().toLowerCase();
    if (!RATINGS.includes(v)) return badRequest(`分级只能是 ${RATINGS.join(" / ")}`);
    if (RATING_RANK[v] > RATING_RANK[rating]) rating = v;
  }
  const meta = {
    id,
    title: (body.title || "").trim() || "未命名",
    categories: stripRatingNames(catsRaw),
    tags: stripRatingNames(tagsRaw),
    rating, // v0.57：三档分级（general / r16 / r18）
    takenAt: body.takenAt || new Date().toISOString(),
    uploadedAt: new Date().toISOString(),
    size: buf.length,
    width: dims.width,
    height: dims.height,
    mime,
    origKey,
    hash, // 内容哈希（v0.12 重复检测）
    dhash: await genDHash(buf), // 感知哈希（v0.21 相似图片提醒）
  };

  const s = store();
  // v0.54：服务端也查一次重 —— 前端查重可被绕过，直接 POST 就能无限重复上传
  const dupHit = await s.get(hashKeyOf(hash), { type: "json" }).catch(() => null);
  await s.set(origKey, buf);
  await saveThumb(s, meta, id, buf, thumb); // 前端缩略图优先，否则服务端生成（v0.13.8）
  await s.set(`${PREFIX_META}${id}.json`, JSON.stringify(meta));
  await indexPut(s, meta); // v0.54 同步列表索引（只写自己那一条）
  await s.set(hashKeyOf(hash), JSON.stringify({ id, title: meta.title })); // 反查键（同内容保留最新一张）
  await logAction(req, dupHit && dupHit.id ? "上传重复图片" : "上传图片", meta.title);
  return json(
    { ok: true, photo: meta, duplicate: dupHit && dupHit.id ? { id: dupHit.id, title: dupHit.title || "" } : null },
    201
  );
}

/* ---------- 更新元数据 ---------- */
async function patch(req, id, role) {
  let body;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }
  const s = store();
  const meta = await s.get(`${PREFIX_META}${id}.json`, { type: "json" });
  if (!meta) return notFound("Photo not found");
  // v0.57：先把「靠老标签 / 老字段推导出来的分级」固化成显式字段 —— 否则下面把 r18 标签洗掉后，
  // 这张图会从 R18 直接掉回大众级（观光模式立刻就能看到）。固化之后分级只由 meta.rating 决定。
  if (!RATINGS.includes(String(meta.rating || "").trim().toLowerCase())) meta.rating = ratingOf(meta);
  delete meta.r18;
  delete meta.r16;
  // v0.51 整理模式：只能改标签与主分类（其余字段一律忽略，防止越权改名 / 标分级）
  // v0.57：分级已与标签解耦 —— tagger 改不动 rating（body 被裁掉），
  //        而且 tags / categories 里一旦出现 r18 / r16 会折算分级，所以这两类保留名直接拒绝
  if (role === "tagger") {
    if (body.tags === undefined && body.categories === undefined && body.category === undefined) {
      return badRequest("整理模式只能添加标签或设置主分类");
    }
    body = { tags: body.tags, categories: body.categories, category: body.category };
    if (body.tags !== undefined && sanitizeTags(body.tags).some(isReservedName)) {
      return badRequest("整理模式不能设置分级（r18 / r16 是分级档位，不是标签）");
    }
    if ((body.categories !== undefined || body.category !== undefined)
      && sanitizeCats(body.categories !== undefined ? body.categories : body.category).some(isReservedName)) {
      return badRequest("整理模式不能设置分级（r18 / r16 是分级档位，不是主分类）");
    }
  }
  if (body.title !== undefined) meta.title = String(body.title).trim() || "未命名";
  // v0.41：描述（desc）字段已整体移除，不再接受写入
  if (body.tags !== undefined) {
    const raw = sanitizeTags(body.tags); // v0.55：去重 / 单名限长 40 / 上限 10
    bumpRating(meta, raw);              // v0.57：标签里若写了 r18 / r16，折算成分级（只升不降）
    meta.tags = stripRatingNames(raw);  // 并从标签数组里剔除（分级不是标签）
  }
  if (body.categories !== undefined || body.category !== undefined) {
    // 主分类（v0.19 多选数组；同时接受旧的单值 category 字段）
    const raw = sanitizeCats(body.categories !== undefined ? body.categories : body.category);
    bumpRating(meta, raw);
    meta.categories = stripRatingNames(raw);
    delete meta.category; // 迁移旧字段
  }
  if (body.rating !== undefined) {
    const v = String(body.rating).trim().toLowerCase();
    if (!RATINGS.includes(v)) return badRequest(`分级只能是 ${RATINGS.join(" / ")}`);
    meta.rating = v; // 显式设置可以升降（管理员专属：整理角色的 body 已被裁掉）
  } else if (body.r18 !== undefined) {
    // 兼容旧调用方：r18: true → R18，false → 大众级
    meta.rating = (body.r18 === true || body.r18 === "true" || body.r18 === 1) ? "r18" : "general";
  }
  // v0.56 收藏夹：照片上的标记。整理模式的 body 上面已被裁剪成 tags/categories，
  // 所以整理角色改不动收藏（只有管理员能收藏）——这正是想要的边界
  if (body.fav !== undefined) meta.fav = body.fav === true || body.fav === "true" || body.fav === 1;
  if (body.takenAt !== undefined) meta.takenAt = body.takenAt;
  await s.set(`${PREFIX_META}${id}.json`, JSON.stringify(meta));
  await indexPut(s, meta); // v0.54 同步列表索引（只写自己那一条）
  await logAction(req, "编辑图片", meta.title || id);
  return json({ ok: true, photo: { ...meta, rating: ratingOf(meta) } });
}

/* ---------- 删除单张 ---------- */
async function remove(req, id) {
  const s = store();
  const meta = await s.get(`${PREFIX_META}${id}.json`, { type: "json" });
  if (!meta) return notFound("Photo not found");
  await s.delete(meta.origKey || `${PREFIX_IMG}${id}`);
  if (meta.thumbKey) await s.delete(meta.thumbKey);
  await s.delete(`${PREFIX_META}${id}.json`);
  await indexDrop(s, [meta]); // v0.54：按 idx key 精确删除，不整表重写
  if (meta.hash) { // v0.54：反查键指向本图时一并清掉（同内容还有别的图时属近似，可接受）
    const cur = await s.get(hashKeyOf(meta.hash), { type: "json" }).catch(() => null);
    if (cur && cur.id === id) await s.delete(hashKeyOf(meta.hash));
  }
  await scrubAlbums([id]);
  await logAction(req, "删除图片", meta.title || id);
  return json({ ok: true });
}

/* ---------- 清空图库 ---------- */
/* v0.54：只删「照片数据」三类 key（img/ thumb- meta/），其余配置一律保留。
   旧实现按黑名单跳过 tags 与 logs，会把 auth-config（访问密码）和 albums-config 一起删掉 ——
   清空后门禁失效（未设密码时 checkAuth 直接把所有人当 admin），且相册配置一起丢失。 */
const PHOTO_DATA_PREFIXES = [PREFIX_IMG, "thumb-", PREFIX_META, PREFIX_HASH];
async function clearAll(req) {
  const s = store();
  // 先收集、再删除：边列边删在不同 Blobs 实现下游标语义不一致，会漏删
  const keys = [];
  let cursor;
  do {
    const res = await s.list({ cursor, limit: 200 });
    for (const item of res.blobs) {
      if (PHOTO_DATA_PREFIXES.some((p) => item.key.startsWith(p))) keys.push(item.key);
    }
    cursor = res.nextCursor;
  } while (cursor);

  const removedIds = keys
    .filter((k) => k.startsWith(PREFIX_META))
    .map((k) => k.slice(PREFIX_META.length).replace(/\.json$/, ""));

  let deleted = 0;
  for (const key of keys) {
    await s.delete(key);
    deleted++;
  }
  await indexClear(s); // 索引条目一并清空（保留 auth / albums / tags / logs）
  if (removedIds.length) await scrubAlbums(removedIds);
  await logAction(req, "清空图库", `${removedIds.length} 张图片`);
  return json({ ok: true, deleted });
}

/* ---------- 用量统计（v0.54：真实遍历 Blobs 统计总占用） ----------
   旧实现只累加原图的 size，缩略图（每张几十 KB，占比可达 20%+）、meta、索引、配置全没算，
   所以「已用空间」明显偏小。现在直接遍历所有 Blob key 累加真实字节，并按用途分类。 */
async function stats() {
  const s = store();
  const byKind = { img: 0, thumb: 0, meta: 0, idx: 0, other: 0 };
  const countByKind = { img: 0, thumb: 0, meta: 0, idx: 0, other: 0 };
  let bytes = 0;
  let keys = 0;
  let cursor;
  do {
    const res = await s.list({ cursor, limit: 500 });
    for (const item of res.blobs) {
      const size = Number(item.size) || 0;
      bytes += size;
      keys++;
      const kind = item.key.startsWith(PREFIX_IMG) ? "img"
        : item.key.startsWith("thumb-") ? "thumb"
        : item.key.startsWith(PREFIX_META) ? "meta"
        : item.key.startsWith(PREFIX_IDX) ? "idx"
        : "other";
      byKind[kind] += size;
      countByKind[kind]++;
    }
    cursor = res.nextCursor;
  } while (cursor);

  // 照片数与按月份分布仍走索引（轻量，不必再读一遍 meta）
  const arr = await indexAll(s);
  const byMonth = {};
  let originalBytes = 0;
  for (const e of arr) {
    originalBytes += e.size || 0;
    const month = String(e.uploadedAt || "").slice(0, 7) || "unknown";
    byMonth[month] = (byMonth[month] || 0) + 1;
  }
  // 配额（默认 1GB，可用 QUOTA_BYTES 环境变量覆盖）
  const quota = Math.max(parseInt(process.env.QUOTA_BYTES, 10) || 1024 * 1024 * 1024, 1);
  return json({ count: arr.length, bytes, originalBytes, keys, byKind, countByKind, byMonth, quota });
}

/* ---------- 导出全部元数据 ---------- */
async function exportAll() {
  const s = store();
  let cursor;
  const photos = [];
  do {
    const res = await s.list({ prefix: PREFIX_META, cursor, limit: 200 });
    for (const item of res.blobs) {
      const m = await s.get(item.key, { type: "json" });
      if (m) photos.push(m);
    }
    cursor = res.nextCursor;
  } while (cursor);
  return json({ exportedAt: new Date().toISOString(), count: photos.length, photos });
}

/* ---------- 远程抓取的安全护栏（v0.54） ----------
   旧实现直接 fetch(src)：可打内网与云元数据（169.254.169.254）、可被重定向带进内网、
   没有超时也没有体积上限。这里逐跳校验协议与目标地址，并限制跳数 / 超时 / 体积。 */
const MAX_IMPORT_BYTES = 15 * 1024 * 1024;
function isPrivateAddress(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
  if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true; // IPv6 本机 / 链路本地 / ULA
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false; // 普通域名：下面会再解析一次
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;              // 云元数据
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;    // CGNAT
  return false;
}
async function assertImportableUrl(src) {
  let u;
  try {
    u = new URL(String(src));
  } catch {
    throw new Error("URL 不合法");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("只支持 http/https");
  if (isPrivateAddress(u.hostname)) throw new Error("禁止访问内网 / 本机地址");
  // 域名再解析一次，挡住「公网域名解析到内网」；解析失败不阻断（字面量校验已经通过）
  const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => []);
  for (const a of addrs) if (isPrivateAddress(a.address)) throw new Error("该域名解析到内网地址，已拒绝");
  return u;
}
async function fetchRemoteImage(src, { maxHops = 3, timeoutMs = 15000 } = {}) {
  let url = await assertImportableUrl(src);
  for (let hop = 0; hop <= maxHops; hop++) {
    const res = await fetch(url, {
      redirect: "manual", // 自己跟随重定向：每一跳都要重新校验目标
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "image/*" },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`HTTP ${res.status}（重定向缺少 Location）`);
      url = await assertImportableUrl(new URL(loc, url).toString());
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const declared = parseInt(res.headers.get("content-length") || "0", 10);
    if (declared > MAX_IMPORT_BYTES) throw new Error("图片超过 15MB");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMPORT_BYTES) throw new Error("图片超过 15MB");
    return { buf, finalUrl: url.toString() };
  }
  throw new Error("重定向次数过多");
}

/* ---------- 批量导入（供自建静态图片源使用） ---------- */
async function importStatic(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }
  // v0.54：上限从 300 降到 50 —— 每项都要「抓取 + 缩略图 + dhash」，300 项必然超时
  const items = Array.isArray(body.items) ? body.items.slice(0, 50) : [];
  if (!items.length) return badRequest("Missing items list");

  const s = store();
  let imported = 0;
  const errors = [];
  for (const item of items) {
    try {
      const src = typeof item === "string" ? item : item.url;
      if (!src) throw new Error("no url");
      const title = typeof item === "string" ? null : item.title;
      const tags = stripRatingNames(sanitizeTags(item && item.tags)); // v0.57：分级名不进标签
      const { buf, finalUrl } = await fetchRemoteImage(src); // v0.54：校验协议 / 内网 / 跳数 / 超时 / 体积
      const dims = imageSize(buf);
      if (!dims) throw new Error("Unsupported format");
      const id = nanoid();
      const mime = sniffMime(buf);
      const ext = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" }[mime] || "bin";
      const origKey = `${PREFIX_IMG}${id}.${ext}`;
      const catsRaw = sanitizeCats(item && (item.categories !== undefined ? item.categories : item.category));
      const meta = {
        id,
        title: (title || "").trim() || "未命名",
        categories: stripRatingNames(catsRaw),
        tags,
        rating: ratingOf({ tags, categories: catsRaw, rating: item && item.rating }), // v0.57：分级
        takenAt: new Date().toISOString(),
        uploadedAt: new Date().toISOString(),
        size: buf.length,
        width: dims.width,
        height: dims.height,
        mime,
        origKey,
        src: finalUrl,
        hash: sha1hex(buf),
        dhash: await genDHash(buf), // v0.21 感知哈希
      };
      await s.set(origKey, buf);
      await saveThumb(s, meta, id, buf, null); // 导入图无前端缩略图 → 服务端生成（v0.13.8）
      await s.set(`${PREFIX_META}${id}.json`, JSON.stringify(meta));
      await indexPut(s, meta); // v0.54 同步列表索引（只写自己那一条）
      await s.set(hashKeyOf(meta.hash), JSON.stringify({ id, title: meta.title })); // v0.54 hash 反查键
      imported++;
    } catch (e) {
      errors.push({ url: typeof item === "string" ? item : item && item.url, error: e.message });
    }
  }
  await logAction(req, "URL/批量导入", `${imported} 成功 / ${errors.length} 失败`);
  return json({ ok: true, imported, errors });
}

/* ============================================================
   标签体系（v0.11 / v0.15 主分类）：Blob key: tags-config
   - 照片 meta.tags 仍存「标签名」数组（旧数据零迁移，名称即引用键）
   - meta.categories 存主分类名数组（v0.19：上传必选、可多选；旧 meta.category 单值字段自动迁移）
   - 配置描述：categories（主分类字典）/ groups（作品等分组）/ tags（组内标签、别名、颜色）
   ============================================================ */

async function loadConfig(s) {
  const raw = await s.get(KEY_TAGS, { type: "json" });
  return raw && Array.isArray(raw.groups) && Array.isArray(raw.tags)
    ? { categories: Array.isArray(raw.categories) ? raw.categories : [], groups: raw.groups, tags: raw.tags }
    : { categories: [], groups: [], tags: [] };
}

/* 遍历全部照片元数据，fn(tags) 返回新数组则写回（去重 + 上限 10） */
async function rewritePhotos(s, fn) {
  let cursor;
  let changed = 0;
  do {
    const res = await s.list({ prefix: PREFIX_META, cursor, limit: 200 });
    for (const item of res.blobs) {
      const m = await s.get(item.key, { type: "json" });
      if (!m || !Array.isArray(m.tags)) continue;
      const next = fn(m.tags);
      if (next) {
        m.tags = sanitizeTags(next); // v0.55：批量改写也走同一套清洗（去重 / 限长 / 上限 10）
        await s.set(item.key, JSON.stringify(m));
        changed++;
      }
    }
    cursor = res.nextCursor;
  } while (cursor);
  if (changed) await indexRebuild(s); // v0.24：批量改写后重建列表索引
  return changed;
}

/* 读取照片的主分类数组（兼容旧单值 category 字段） */
function catsOfMeta(m) {
  if (Array.isArray(m.categories)) return sanitizeCats(m.categories);
  return m.category ? sanitizeCats([m.category]) : [];
}

/* 遍历全部照片元数据改写主分类：fn(cats 数组) 返回新数组则写回（[] = 清空），返回 null 跳过；
   顺带把旧的单值 category 字段迁移掉（v0.19：主分类改为多选数组） */
async function rewriteByCategory(s, fn) {
  let cursor;
  let changed = 0;
  do {
    const res = await s.list({ prefix: PREFIX_META, cursor, limit: 200 });
    for (const item of res.blobs) {
      const m = await s.get(item.key, { type: "json" });
      if (!m) continue;
      const cur = catsOfMeta(m);
      const hasOldField = m.category !== undefined;
      if (!cur.length && !hasOldField) continue;
      const next = fn(cur);
      if (next === null || next === undefined) {
        if (hasOldField) { // 只迁移字段：把 category 归一为 categories
          m.categories = cur;
          delete m.category;
          await s.set(item.key, JSON.stringify(m));
          changed++;
        }
        continue;
      }
      const norm = sanitizeCats(next);
      const same = norm.length === cur.length && norm.every((x, i) => x === cur[i]);
      if (same && !hasOldField) continue;
      m.categories = norm;
      delete m.category;
      await s.set(item.key, JSON.stringify(m));
      changed++;
    }
    cursor = res.nextCursor;
  } while (cursor);
  if (changed) await indexRebuild(s); // v0.24：批量改写后重建列表索引
  return changed;
}

/* ---------- GET /api/tags（categories 缺失时返回内置默认） ---------- */
async function tagsGet() {
  const cfg = await loadConfig(store());
  cfg.categories = normCategories(cfg.categories);
  return json(cfg);
}

/* ---------- PUT /api/tags（整体替换，归一化校验；删除主分类会同步清空照片引用） ---------- */
async function tagsPut(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }
  const groupsIn = Array.isArray(body.groups) ? body.groups : null;
  const tagsIn = Array.isArray(body.tags) ? body.tags : null;
  if (!groupsIn || !tagsIn) return badRequest("需要 groups 与 tags 数组");

  const seenGroups = new Set();
  const groups = [];
  for (const g of groupsIn) {
    if (!g || typeof g !== "object") continue;
    const name = String(g.name || "").trim();
    if (!name) return badRequest("标签组名称不能为空");
    const id = String(g.id || "").trim() || `g-${nanoid(6)}`;
    if (seenGroups.has(id)) return badRequest(`标签组 id 重复: ${id}`);
    seenGroups.add(id);
    groups.push({
      id,
      name,
      color: HEX_RE.test(String(g.color || "")) ? String(g.color) : null,
      sort: Number.isFinite(g.sort) ? g.sort : groups.length,
    });
  }

  const seenTags = new Set();
  const tags = [];
  for (const t of tagsIn) {
    if (!t || typeof t !== "object") continue;
    const name = String(t.name || "").trim();
    if (!name) return badRequest("标签名称不能为空");
    if (seenTags.has(name)) return badRequest(`标签名称重复: ${name}`);
    seenTags.add(name);
    const aliases = Array.isArray(t.aliases)
      ? [...new Set(t.aliases.map((a) => String(a).trim()).filter((a) => a && a !== name))].slice(0, 20)
      : [];
    tags.push({
      id: String(t.id || "").trim() || `t-${nanoid(6)}`,
      name,
      aliases,
      group: seenGroups.has(String(t.group || "")) ? String(t.group) : "",
      color: HEX_RE.test(String(t.color || "")) ? String(t.color) : null,
      sort: Number.isFinite(t.sort) ? t.sort : tags.length,
    });
  }

  const s = store();
  const oldCfg = await loadConfig(s);
  const categories = normCategories(body.categories);
  // v0.55：保留名（r18 / r16）不能作为普通标签 / 主分类**新建**；存量同名条目允许继续保留，
  // 免得老库因为已经有 r18 标签而整份 PUT 被拒（那会把标签管理彻底锁死）
  const oldTagNames = new Set((oldCfg.tags || []).map((t) => String(t.name).trim().toLowerCase()));
  const freshTag = tags.find((t) => isReservedName(t.name) && !oldTagNames.has(t.name.trim().toLowerCase()));
  if (freshTag) {
    return badRequest(`「${freshTag.name}」是图库分级档位（大众级 / R16 / R18），不是标签 —— 分级请在图片编辑里设置`);
  }
  const oldCatNames = new Set((oldCfg.categories || []).map((c) => String(c.name).trim().toLowerCase()));
  const freshCat = categories.find((c) => isReservedName(c.name) && !oldCatNames.has(c.name.trim().toLowerCase()));
  if (freshCat) {
    return badRequest(`「${freshCat.name}」是图库分级档位（大众级 / R16 / R18），不是主分类 —— 分级请在图片编辑里设置`);
  }
  const cfg = { categories, groups, tags };
  await s.set(KEY_TAGS, JSON.stringify(cfg));

  // 本次提交删除了某主分类 → 同步从引用照片的 categories 数组里移除（v0.15 / v0.19 多选）
  const del = new Set((oldCfg.categories || []).filter((o) => !categories.some((n) => n.name === o.name)).map((c) => c.name));
  const cleared = del.size
    ? await rewriteByCategory(s, (cats) => {
        const next = cats.filter((c) => !del.has(c));
        return next.length === cats.length ? null : next;
      })
    : 0;

  await logAction(req, "保存标签配置", `${categories.length} 主分类 / ${groups.length} 组 / ${tags.length} 标签` + (cleared ? `（清空 ${cleared} 张引用已删主分类）` : ""));
  return json({ ok: true, config: cfg, clearedPhotos: cleared });
}

/* v0.55：改名后把旧名收进别名 —— 别名只服务搜索，旧名留成别名，用户按旧名仍然搜得到。
   （此前旧名会彻底消失：把「胡桃」改成「桃桃」后搜「胡桃」什么都搜不到。） */
function keepAlias(tag, oldName) {
  if (!tag || !oldName || oldName === tag.name) return;
  const list = (Array.isArray(tag.aliases) ? tag.aliases : []).filter(Boolean);
  if (!list.includes(oldName)) list.push(oldName);
  tag.aliases = [...new Set(list)].slice(0, 20);
}

/* ---------- POST /api/tags/rename：改名；目标已存在则合并 ----------
   照片中的旧名引用同步改写（名称 = 照片引用键） */
async function tagsRename(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }
  const from = String(body.from || "").trim();
  const to = String(body.to || "").trim();
  if (!from || !to) return badRequest("需要 from 与 to");
  if (from === to) return json({ ok: true, photos: 0, merged: false });
  const s = store();
  const cfg = await loadConfig(s);
  const idx = cfg.tags.findIndex((t) => t.name === from);
  const merged = cfg.tags.some((t) => t.name === to);
  // v0.55：不允许把普通标签改名成 r18 / r16（保留名）；合并进已有的保留名仍放行
  if (!merged && isReservedName(to)) {
    return badRequest("r18 / r16 是图库分级档位，不能作为标签名（分级请在图片编辑里设置）");
  }

  if (idx >= 0) {
    if (merged) {
      // 合并：别名并入目标（去重）
      const fromTag = cfg.tags[idx];
      const toTag = cfg.tags.find((t) => t.name === to);
      const aliases = new Set(toTag.aliases || []);
      (fromTag.aliases || []).forEach((a) => aliases.add(a));
      aliases.delete(to);
      toTag.aliases = [...aliases];
      keepAlias(toTag, from); // v0.55：并入的旧名留作别名
      cfg.tags.splice(idx, 1);
    } else {
      cfg.tags[idx].name = to;
      keepAlias(cfg.tags[idx], from); // v0.55：旧名留作别名，按旧名仍能搜到
    }
  } else if (!merged) {
    // v0.33：配置里暂时看不到旧名（刚新建、Blobs 写入还没传播）时**不要直接失败**，
    // 至少保证新名存在于配置里；照片引用照样改写，前端随后会用完整配置 PUT 覆盖对齐。
    // v0.55：旧名一并留成别名 —— 照片上的游离标签（有引用、库里没有）改名后也该能按旧名搜到。
    cfg.tags.push({ id: `t-${nanoid(6)}`, name: to, aliases: [from], group: "", color: null, sort: cfg.tags.length });
  }
  await s.set(KEY_TAGS, JSON.stringify(cfg));

  const photos = await rewritePhotos(s, (tags) => {
    const next = [];
    let changed = false;
    for (const t of tags) {
      if (t === from) {
        next.push(to);
        changed = true;
      } else {
        next.push(t);
      }
    }
    return changed ? next : null;
  });
  await logAction(req, merged ? "标签合并" : "标签改名", `${from} → ${to}（${photos} 张照片）`);
  return json({ ok: true, photos, merged });
}

/* ---------- POST /api/tags/remove：从配置与全部照片移除 ---------- */
async function tagsRemove(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }
  const name = String(body.name || "").trim();
  if (!name) return badRequest("需要 name");
  const s = store();
  const cfg = await loadConfig(s);
  cfg.tags = cfg.tags.filter((t) => t.name !== name);
  await s.set(KEY_TAGS, JSON.stringify(cfg));

  const photos = await rewritePhotos(s, (tags) => {
    const next = tags.filter((t) => t !== name);
    return next.length === tags.length ? null : next;
  });
  await logAction(req, "删除标签", `${name}（从 ${photos} 张照片移除）`);
  return json({ ok: true, photos });
}

/* ---------- POST /api/tags/category-rename：主分类改名（同步照片 meta.category） ---------- */
async function categoryRename(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }
  const from = sanitizeCat(body.from);
  const to = sanitizeCat(body.to);
  if (!from || !to) return badRequest("需要 from 与 to");
  if (from === to) return json({ ok: true, photos: 0 });

  const s = store();
  const cfg = await loadConfig(s);
  const cats = normCategories(cfg.categories);
  const idx = cats.findIndex((c) => c.name === from);
  const toExists = cats.some((c) => c.name === to);
  if (toExists) return badRequest(`主分类已存在: ${to}`);
  // v0.55 / v0.57：不允许新造 r18 / r16 主分类（它们是分级档位）；合并进已存在的同名分类仍放行
  if (isReservedName(to) && !toExists) return badRequest("r18 / r16 是图库分级档位，不能作为主分类名");
  if (idx >= 0) cats[idx].name = to;
  else cats.push({ id: `c-${nanoid(6)}`, name: to, color: null, sort: cats.length }); // v0.33：宽容处理（配置暂不可见旧名时不失败）
  cfg.categories = cats;
  await s.set(KEY_TAGS, JSON.stringify(cfg));

  const photos = await rewriteByCategory(s, (cats2) => (cats2.includes(from) ? cats2.map((c) => (c === from ? to : c)) : null));
  await logAction(req, "主分类改名", `${from} → ${to}（${photos} 张照片）`);
  return json({ ok: true, photos });
}

/* ---------- POST /api/tags/category-remove：删除主分类（同步清空照片引用） ---------- */
async function categoryRemove(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }
  const name = sanitizeCat(body.name);
  if (!name) return badRequest("需要 name");

  const s = store();
  const cfg = await loadConfig(s);
  // v0.33：配置里找不到该分类也继续（可能刚删除或写入未传播）——照片引用照样清理，不再直接报错
  cfg.categories = (Array.isArray(cfg.categories) ? cfg.categories : []).filter((c) => c.name !== name);
  await s.set(KEY_TAGS, JSON.stringify(cfg));

  const photos = await rewriteByCategory(s, (cats) => (cats.includes(name) ? cats.filter((c) => c !== name) : null));
  await logAction(req, "删除主分类", `${name}（清空 ${photos} 张照片的分类）`);
  return json({ ok: true, photos });
}
