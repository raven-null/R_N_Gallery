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
} = require("./_lib");
const crypto = require("crypto");
const sharp = require("sharp"); // v0.13.8：服务端缩略图（列表秒开）

const PREFIX_META = "meta/";
const PREFIX_IMG = "img/";
const KEY_TAGS = "tags-config"; // 标签分组配置（v0.11 / v0.15 主分类）
const KEY_ALBUMS = "albums-config"; // 相册配置（v0.12）
const KEY_LOGS = "logs"; // 操作日志（v0.12）
const KEY_INDEX = "photos-index"; // 列表索引（v0.24）：轻量元数据数组，避免列表接口逐个读 meta
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
    logAction(req, "清除整理模式密码", "");
    return json({ ok: true, hasTagger: false });
  }
  if (k.length < 4) return badRequest("整理密码至少 4 位");
  if (cfg.accessHash && sha256hex(k) === cfg.accessHash) return badRequest("整理密码不能与访问密码相同");
  cfg.taggerHash = sha256hex(k);
  await saveAuthConfig(cfg);
  logAction(req, "设置整理模式密码", "");
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
  logAction(req, "保存相册配置", `${albums.length} 个相册`);
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
    r18: m.r18 === true,
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
async function indexGet(s) {
  const raw = await s.get(KEY_INDEX, { type: "json" });
  return Array.isArray(raw) ? raw : null;
}
const indexSet = (s, arr) => s.set(KEY_INDEX, JSON.stringify(arr));
/* 全量重建（低频操作后调用；也能修复索引与 meta 不一致） */
async function indexRebuild(s) {
  const out = [];
  let cursor;
  do {
    const res = await s.list({ prefix: PREFIX_META, cursor, limit: 200 });
    for (const item of res.blobs) {
      const m = await s.get(item.key, { type: "json" });
      if (m) out.push(indexEntry(m));
    }
    cursor = res.nextCursor;
  } while (cursor);
  out.sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
  await indexSet(s, out);
  return out;
}
/* 索引不存在时构建（老库第一次访问会慢一次，之后走索引） */
async function indexEnsure(s) {
  const cur = await indexGet(s);
  if (cur) return cur;
  return indexRebuild(s);
}
async function indexUpsert(s, meta) {
  const arr = (await indexGet(s)) || [];
  const e = indexEntry(meta);
  const i = arr.findIndex((x) => x.id === e.id);
  if (i >= 0) arr[i] = e;
  else {
    arr.unshift(e);
    arr.sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
  }
  await indexSet(s, arr);
}
async function indexDrop(s, ids) {
  const arr = await indexGet(s);
  if (!arr) return;
  const del = new Set(ids);
  await indexSet(s, arr.filter((x) => !del.has(x.id)));
}

/* ---------- 列表（v0.24：走索引，分页用数字偏移） ---------- */
async function list(url, role) {
  const q = url.searchParams;
  const limit = Math.min(parseInt(q.get("limit"), 10) || 60, 500);
  const s = store();
  let arr = await indexEnsure(s);
  // v0.49 观光模式（?safe=1）：列表里直接剔除 R18 / R16 的图片
  // v0.51：整理模式（tagger）同样看不到成人向，即使没带 safe=1
  if (safeMode(q) || role === "tagger") arr = arr.filter((e) => !isAdultPhoto(e));
  const start = Math.max(parseInt(q.get("cursor"), 10) || 0, 0);
  const page = arr.slice(start, start + limit).map((e) => ({ ...e, r18: isR18Photo(e) }));
  const nextStart = start + limit;
  const next = nextStart < arr.length ? String(nextStart) : null;
  return json({ photos: page, cursor: next, hasMore: !!next, total: arr.length });
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
  return json({ photo: { ...m, r18: isR18Photo(m) } });
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
  meta.hash = sha1hex(buf);
  meta.dhash = await genDHash(buf); // v0.21：替换原图后重算感知哈希
  await saveThumb(s, meta, id, buf, thumb); // 前端缩略图优先，否则服务端生成
  meta.updatedAt = new Date().toISOString();
  await s.set(`${PREFIX_META}${id}.json`, JSON.stringify(meta));
  await indexUpsert(s, meta); // v0.24 同步列表索引（尺寸/大小/哈希都变了）
  logAction(req, "替换图片内容", (meta.title || id) + ` ${dims.width}x${dims.height}`);
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
      await indexUpsert(s, meta); // v0.24 懒生成缩略图后同步索引
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

/* ---------- 重复检测（v0.12：按内容 sha1 查询） ---------- */
async function checkHash(url) {
  const hash = (url.searchParams.get("hash") || "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hash)) return badRequest("Invalid hash");
  const s = store();
  let cursor;
  do {
    const res = await s.list({ prefix: PREFIX_META, cursor, limit: 200 });
    for (const item of res.blobs) {
      const m = await s.get(item.key, { type: "json" });
      if (m && m.hash === hash) {
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
  logAction(req, "补算感知哈希", `${updated} 张已补算 / ${skipped} 张已有 / ${failed} 张失败`);
  if (updated) await indexRebuild(s); // v0.24：索引里的 dhash 也一起刷新
  return json({ ok: true, updated, skipped, failed });
}

/* ---------- POST /api/photos/reindex：重建列表索引（v0.24，可修复索引与 meta 不一致） ---------- */
async function reindexIndex(req) {
  const arr = await indexRebuild(store());
  logAction(req, "重建列表索引", `${arr.length} 张`);
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
  const meta = {
    id,
    title: (body.title || "").trim() || "未命名",
    categories: sanitizeCats(body.categories !== undefined ? body.categories : body.category), // 主分类（v0.19 必选、可多选）
    tags: Array.isArray(body.tags) ? body.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 10) : [],
    takenAt: body.takenAt || new Date().toISOString(),
    uploadedAt: new Date().toISOString(),
    size: buf.length,
    width: dims.width,
    height: dims.height,
    mime,
    origKey,
    hash: sha1hex(buf), // 内容哈希（v0.12 重复检测）
    dhash: await genDHash(buf), // 感知哈希（v0.21 相似图片提醒）
  };

  const s = store();
  await s.set(origKey, buf);
  await saveThumb(s, meta, id, buf, thumb); // 前端缩略图优先，否则服务端生成（v0.13.8）
  await s.set(`${PREFIX_META}${id}.json`, JSON.stringify(meta));
  await indexUpsert(s, meta); // v0.24 同步列表索引
  logAction(req, "上传图片", meta.title);
  return json({ ok: true, photo: meta }, 201);
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
  // v0.51 整理模式：只能改标签与主分类（其余字段一律忽略，防止越权改名 / 标记 R18）
  if (role === "tagger") {
    if (body.tags === undefined && body.categories === undefined && body.category === undefined) {
      return badRequest("整理模式只能添加标签或设置主分类");
    }
    body = { tags: body.tags, categories: body.categories, category: body.category };
  }
  if (body.title !== undefined) meta.title = String(body.title).trim() || "未命名";
  // v0.41：描述（desc）字段已整体移除，不再接受写入
  if (body.tags !== undefined) meta.tags = Array.isArray(body.tags) ? body.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 10) : [];
  if (body.categories !== undefined || body.category !== undefined) {
    // 主分类（v0.19 多选数组；同时接受旧的单值 category 字段）
    meta.categories = sanitizeCats(body.categories !== undefined ? body.categories : body.category);
    delete meta.category; // 迁移旧字段
  }
  if (body.r18 !== undefined) meta.r18 = body.r18 === true || body.r18 === "true" || body.r18 === 1; // R18 独立开关
  if (body.takenAt !== undefined) meta.takenAt = body.takenAt;
  await s.set(`${PREFIX_META}${id}.json`, JSON.stringify(meta));
  await indexUpsert(s, meta); // v0.24 同步列表索引
  logAction(req, "编辑图片", meta.title || id);
  return json({ ok: true, photo: meta });
}

/* ---------- 删除单张 ---------- */
async function remove(req, id) {
  const s = store();
  const meta = await s.get(`${PREFIX_META}${id}.json`, { type: "json" });
  if (!meta) return notFound("Photo not found");
  await s.delete(meta.origKey || `${PREFIX_IMG}${id}`);
  if (meta.thumbKey) await s.delete(meta.thumbKey);
  await s.delete(`${PREFIX_META}${id}.json`);
  await indexDrop(s, [id]); // v0.24 同步列表索引
  await scrubAlbums([id]);
  logAction(req, "删除图片", meta.title || id);
  return json({ ok: true });
}

/* ---------- 清空图库 ---------- */
async function clearAll(req) {
  const s = store();
  let cursor;
  let deleted = 0;
  const removedIds = [];
  do {
    const res = await s.list({ cursor, limit: 200 });
    for (const item of res.blobs) {
      if (item.key === KEY_TAGS || item.key === KEY_LOGS) continue; // 保留标签配置与日志（v0.11/0.12）
      if (item.key.startsWith(PREFIX_META)) removedIds.push(item.key.slice(PREFIX_META.length, -5));
      await s.delete(item.key);
      deleted++;
    }
    cursor = res.nextCursor;
  } while (cursor);
  if (removedIds.length) await scrubAlbums(removedIds);
  logAction(req, "清空图库", `${removedIds.length} 张图片`);
  return json({ ok: true, deleted });
}

/* ---------- 用量统计（v0.24：走索引，不再逐个读 meta） ---------- */
async function stats() {
  const s = store();
  const arr = await indexEnsure(s);
  let bytes = 0;
  const byMonth = {};
  for (const e of arr) {
    bytes += e.size || 0;
    const month = String(e.uploadedAt || "").slice(0, 7) || "unknown";
    byMonth[month] = (byMonth[month] || 0) + 1;
  }
  // 配额（默认 1GB，可用 QUOTA_BYTES 环境变量覆盖）
  const quota = Math.max(parseInt(process.env.QUOTA_BYTES, 10) || 1024 * 1024 * 1024, 1);
  return json({ count: arr.length, bytes, byMonth, quota });
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

/* ---------- 批量导入（供自建静态图片源使用） ---------- */
async function importStatic(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }
  const items = Array.isArray(body.items) ? body.items.slice(0, 300) : [];
  if (!items.length) return badRequest("Missing items list");

  const s = store();
  let imported = 0;
  const errors = [];
  for (const item of items) {
    try {
      const src = typeof item === "string" ? item : item.url;
      if (!src) throw new Error("no url");
      const title = typeof item === "string" ? null : item.title;
      const tags = Array.isArray(item && item.tags) ? item.tags.slice(0, 10) : [];
      const res = await fetch(src);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const dims = imageSize(buf);
      if (!dims) throw new Error("Unsupported format");
      const id = nanoid();
      const mime = sniffMime(buf);
      const ext = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" }[mime] || "bin";
      const origKey = `${PREFIX_IMG}${id}.${ext}`;
      const meta = {
        id,
        title: (title || "").trim() || "未命名",
        categories: sanitizeCats(item && (item.categories !== undefined ? item.categories : item.category)),
        tags,
        takenAt: new Date().toISOString(),
        uploadedAt: new Date().toISOString(),
        size: buf.length,
        width: dims.width,
        height: dims.height,
        mime,
        origKey,
        src,
        hash: sha1hex(buf),
        dhash: await genDHash(buf), // v0.21 感知哈希
      };
      await s.set(origKey, buf);
      await saveThumb(s, meta, id, buf, null); // 导入图无前端缩略图 → 服务端生成（v0.13.8）
      await s.set(`${PREFIX_META}${id}.json`, JSON.stringify(meta));
      await indexUpsert(s, meta); // v0.24 同步列表索引
      imported++;
    } catch (e) {
      errors.push({ url: typeof item === "string" ? item : item && item.url, error: e.message });
    }
  }
  logAction(req, "URL/批量导入", `${imported} 成功 / ${errors.length} 失败`);
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
        m.tags = [...new Set(next)].slice(0, 10);
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

  logAction(req, "保存标签配置", `${categories.length} 主分类 / ${groups.length} 组 / ${tags.length} 标签` + (cleared ? `（清空 ${cleared} 张引用已删主分类）` : ""));
  return json({ ok: true, config: cfg, clearedPhotos: cleared });
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

  if (idx >= 0) {
    if (merged) {
      // 合并：别名并入目标（去重）
      const fromTag = cfg.tags[idx];
      const toTag = cfg.tags.find((t) => t.name === to);
      const aliases = new Set(toTag.aliases || []);
      (fromTag.aliases || []).forEach((a) => aliases.add(a));
      aliases.delete(to);
      toTag.aliases = [...aliases];
      cfg.tags.splice(idx, 1);
    } else {
      cfg.tags[idx].name = to;
    }
  } else if (!merged) {
    // v0.33：配置里暂时看不到旧名（刚新建、Blobs 写入还没传播）时**不要直接失败**，
    // 至少保证新名存在于配置里；照片引用照样改写，前端随后会用完整配置 PUT 覆盖对齐。
    cfg.tags.push({ id: `t-${nanoid(6)}`, name: to, aliases: [], group: "", color: null, sort: cfg.tags.length });
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
  logAction(req, merged ? "标签合并" : "标签改名", `${from} → ${to}（${photos} 张照片）`);
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
  logAction(req, "删除标签", `${name}（从 ${photos} 张照片移除）`);
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
  if (cats.some((c) => c.name === to)) return badRequest(`主分类已存在: ${to}`);
  const idx = cats.findIndex((c) => c.name === from);
  if (idx >= 0) cats[idx].name = to;
  else cats.push({ id: `c-${nanoid(6)}`, name: to, color: null, sort: cats.length }); // v0.33：宽容处理（配置暂不可见旧名时不失败）
  cfg.categories = cats;
  await s.set(KEY_TAGS, JSON.stringify(cfg));

  const photos = await rewriteByCategory(s, (cats2) => (cats2.includes(from) ? cats2.map((c) => (c === from ? to : c)) : null));
  logAction(req, "主分类改名", `${from} → ${to}（${photos} 张照片）`);
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
  logAction(req, "删除主分类", `${name}（清空 ${photos} 张照片的分类）`);
  return json({ ok: true, photos });
}
