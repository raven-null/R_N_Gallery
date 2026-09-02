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
     GET    /api/tags                  获取标签配置（groups + tags）
     PUT    /api/tags                  整体保存标签配置
     POST   /api/tags/rename           标签改名/合并（同步所有照片）
     POST   /api/tags/remove           删除标签（同步从照片移除）
     POST   /api/photos/:id/image      覆盖原图字节（旋转等编辑后保存）
   ============================================================ */
const {
  store, json, notFound, badRequest, unauthorized, serverError,
  auth, cookieVal, nanoid, imageSize, sniffMime,
} = require("./_lib");
const crypto = require("crypto");

const PREFIX_META = "meta/";
const PREFIX_IMG = "img/";
const KEY_TAGS = "tags-config"; // 标签分组配置（v0.11）
const KEY_ALBUMS = "albums-config"; // 相册配置（v0.12）
const KEY_LOGS = "logs"; // 操作日志（v0.12）
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const sha1hex = (buf) => crypto.createHash("sha1").update(buf).digest("hex");
const thumbKeyOf = (id) => `thumb-${id}`;

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

    // 登录验证必须先于鉴权（登录请求自身不带 token）
    if (method === "POST" && path.endsWith("/api/auth/login")) return authLogin(req);
    if (method === "POST" && path.endsWith("/api/auth/guest")) return guestLogin(req);
    if (method === "GET" && path.endsWith("/api/auth/check")) return authCheck(req);

    // 鉴权（v0.9.24 / v0.12）：写操作校验 ADMIN/UPLOAD_TOKEN；
    // 读操作在配置 VIEW_TOKEN 访客密码后校验 cookie rn_view（普通浏览需先访问密码）
    const isWrite = method === "POST" || method === "PATCH" || method === "DELETE";
    if (isWrite && !auth(req, true)) return unauthorized();
    if (!isWrite && !auth(req, false)) return unauthorized();

    if (method === "GET" && path.endsWith("/api/photos")) return list(url);
    if (method === "GET" && path.endsWith("/api/tags")) return tagsGet();
    if (method === "PUT" && path.endsWith("/api/tags")) return tagsPut(req);
    if (method === "POST" && path.endsWith("/api/tags/rename")) return tagsRename(req);
    if (method === "POST" && path.endsWith("/api/tags/remove")) return tagsRemove(req);
    if (method === "GET" && path.endsWith("/api/albums")) return albumsGet();
    if (method === "PUT" && path.endsWith("/api/albums")) return albumsPut(req);
    if (method === "GET" && path.endsWith("/api/meta/logs")) {
      if (!auth(req, true)) return unauthorized();
      return logsGet();
    }
    if (method === "DELETE" && path.endsWith("/api/meta/logs")) {
      if (!auth(req, true)) return unauthorized();
      return logsClear();
    }
    if (method === "GET" && path.startsWith("/api/photos/") && rest.length === 2 && rest[1] === "raw") return raw(rest[0]);
    if (method === "GET" && path.startsWith("/api/photos/") && rest.length === 2 && rest[1] === "thumb") return thumb(rest[0]);
    if (method === "GET" && path.endsWith("/api/photos/check")) return checkHash(url);
    if (method === "GET" && path.startsWith("/api/photos/") && rest.length === 1) return getMeta(rest[0]);
    if (method === "POST" && path.endsWith("/api/photos")) return upload(req);
    if (method === "PATCH" && path.startsWith("/api/photos/") && rest.length === 1) return patch(req, rest[0]);
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
    "/api/photos/:id/image",
    "/api/meta/stats",
    "/api/export",
    "/api/import",
    "/api/auth/login",
    "/api/auth/check",
    "/api/auth/guest",
    "/api/tags",
    "/api/tags/rename",
    "/api/tags/remove",
    "/api/albums",
    "/api/meta/logs",
  ],
};

/* ---------- 管理员登录验证（v0.9.24） ----------
   密码 = ADMIN_TOKEN 环境变量；登录成功后前端将其作为 X-Auth-Token 使用 */
async function authLogin(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }
  const admin = process.env.ADMIN_TOKEN;
  if (!admin) return json({ ok: false, error: "站点未配置管理员密码（请设置 ADMIN_TOKEN 环境变量）" }, 403);
  if (String(body.password || "") === admin) {
    logAction(req, "管理员登录", "");
    return json({ ok: true });
  }
  logAction(req, "管理员登录失败", "");
  return unauthorized("密码错误");
}

function authCheck(req) {
  const admin = process.env.ADMIN_TOKEN;
  const view = process.env.VIEW_TOKEN;
  const header = (req.headers.get("x-auth-token") || "").trim();
  const isAdmin = !!admin && header === admin;
  const vc = cookieVal(req, "rn_view");
  return json({
    admin: isAdmin,
    guest: !!(view && (vc === view || (header && header === view))),
    viewEnabled: !!view,
    adminEnabled: !!admin,
  });
}

/* ---------- 访客登录（v0.12：VIEW_TOKEN → HttpOnly cookie） ---------- */
async function guestLogin(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }
  const view = process.env.VIEW_TOKEN;
  if (!view) return json({ ok: false, error: "站点未开启访客密码（未配置 VIEW_TOKEN）" }, 403);
  if (String(body.password || "") !== view) {
    logAction(req, "访客登录失败", "");
    return unauthorized("密码错误");
  }
  logAction(req, "访客登录", "");
  const res = json({ ok: true });
  res.headers.append(
    "Set-Cookie",
    `rn_view=${encodeURIComponent(view)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`
  );
  return res;
}

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

/* ---------- 列表（分页） ---------- */
async function list(url) {
  const q = url.searchParams;
  const limit = Math.min(parseInt(q.get("limit"), 10) || 60, 200);
  const s = store();
  const res = await s.list({ prefix: PREFIX_META, cursor: q.get("cursor"), limit });
  const photos = [];
  for (const item of res.blobs) {
    const m = await s.get(item.key, { type: "json" });
    if (m) photos.push(m);
  }
  photos.sort((a, b) => (b.uploadedAt || "").localeCompare(a.uploadedAt || ""));
  return json({ photos, cursor: res.nextCursor || null, hasMore: !!res.nextCursor });
}

/* ---------- 单张元数据 ---------- */
async function getMeta(id) {
  const m = await store().get(`${PREFIX_META}${id}.json`, { type: "json" });
  if (!m) return notFound("Photo not found");
  return json({ photo: m });
}

/* ---------- 图片字节输出（v0.9.20：必须用 arrayBuffer 读，v8 默认返回字符串会损坏二进制） ---------- */
async function raw(id) {
  const s = store();
  const m = await s.get(`${PREFIX_META}${id}.json`, { type: "json" });
  if (!m) return notFound("Photo not found");
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
  if (thumb) {
    meta.thumbKey = thumbKeyOf(id);
    meta.thumbMime = thumb.mime;
    await s.set(meta.thumbKey, thumb.buf);
  }
  meta.updatedAt = new Date().toISOString();
  await s.set(`${PREFIX_META}${id}.json`, JSON.stringify(meta));
  logAction(req, "替换图片内容", (meta.title || id) + ` ${dims.width}x${dims.height}`);
  return json({ ok: true, photo: meta });
}

/* ---------- 缩略图输出（v0.12：前端生成上传，key: thumb-{id}） ---------- */
async function thumb(id) {
  const s = store();
  const meta = await s.get(`${PREFIX_META}${id}.json`, { type: "json" });
  if (!meta || !meta.thumbKey) return notFound("Thumbnail not found");
  const buf = await s.get(meta.thumbKey, { type: "arrayBuffer" });
  if (!buf) return notFound("Thumbnail data not found");
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
    desc: (body.desc || "").trim(),
    tags: Array.isArray(body.tags) ? body.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 10) : [],
    takenAt: body.takenAt || new Date().toISOString(),
    uploadedAt: new Date().toISOString(),
    size: buf.length,
    width: dims.width,
    height: dims.height,
    mime,
    origKey,
    hash: sha1hex(buf), // 内容哈希（v0.12 重复检测）
  };
  if (thumb) {
    meta.thumbKey = thumbKeyOf(id);
    meta.thumbMime = thumb.mime;
  }

  const s = store();
  if (thumb) await s.set(meta.thumbKey, thumb.buf);
  await s.set(origKey, buf);
  await s.set(`${PREFIX_META}${id}.json`, JSON.stringify(meta));
  logAction(req, "上传图片", meta.title);
  return json({ ok: true, photo: meta }, 201);
}

/* ---------- 更新元数据 ---------- */
async function patch(req, id) {
  let body;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }
  const s = store();
  const meta = await s.get(`${PREFIX_META}${id}.json`, { type: "json" });
  if (!meta) return notFound("Photo not found");
  if (body.title !== undefined) meta.title = String(body.title).trim() || "未命名";
  if (body.desc !== undefined) meta.desc = String(body.desc).trim();
  if (body.tags !== undefined) meta.tags = Array.isArray(body.tags) ? body.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 10) : [];
  if (body.takenAt !== undefined) meta.takenAt = body.takenAt;
  await s.set(`${PREFIX_META}${id}.json`, JSON.stringify(meta));
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

/* ---------- 用量统计 ---------- */
async function stats() {
  const s = store();
  let cursor;
  let count = 0;
  let bytes = 0;
  const byMonth = {};
  do {
    const res = await s.list({ prefix: PREFIX_META, cursor, limit: 200 });
    for (const item of res.blobs) {
      const m = await s.get(item.key, { type: "json" });
      if (!m) continue;
      count++;
      bytes += m.size || 0;
      const month = (m.uploadedAt || "").slice(0, 7) || "unknown";
      byMonth[month] = (byMonth[month] || 0) + 1;
    }
    cursor = res.nextCursor;
  } while (cursor);
  // 配额（默认 1GB，可用 QUOTA_BYTES 环境变量覆盖）
  const quota = Math.max(parseInt(process.env.QUOTA_BYTES, 10) || 1024 * 1024 * 1024, 1);
  return json({ count, bytes, byMonth, quota });
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
        desc: "",
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
      };
      await s.set(origKey, buf);
      await s.set(`${PREFIX_META}${id}.json`, JSON.stringify(meta));
      imported++;
    } catch (e) {
      errors.push({ url: typeof item === "string" ? item : item && item.url, error: e.message });
    }
  }
  logAction(req, "URL/批量导入", `${imported} 成功 / ${errors.length} 失败`);
  return json({ ok: true, imported, errors });
}

/* ============================================================
   标签体系（v0.11）：分组 + 别名配置，Blob key: tags-config
   - 照片 meta.tags 仍存「标签名」数组（旧数据零迁移，名称即引用键）
   - 配置仅描述：分组归属 / 别名 / 颜色，供前端分组展示与搜索
   ============================================================ */

async function loadConfig(s) {
  const raw = await s.get(KEY_TAGS, { type: "json" });
  return raw && Array.isArray(raw.groups) && Array.isArray(raw.tags)
    ? raw
    : { groups: [], tags: [] };
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
  return changed;
}

/* ---------- GET /api/tags ---------- */
async function tagsGet() {
  return json(await loadConfig(store()));
}

/* ---------- PUT /api/tags（整体替换，归一化校验） ---------- */
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

  const cfg = { groups, tags };
  await store().set(KEY_TAGS, JSON.stringify(cfg));
  logAction(req, "保存标签配置", `${groups.length} 组 / ${tags.length} 标签`);
  return json({ ok: true, config: cfg });
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
  const s = store();
  const cfg = await loadConfig(s);
  const idx = cfg.tags.findIndex((t) => t.name === from);
  if (idx < 0) return notFound(`标签不存在: ${from}`);
  if (from === to) return json({ ok: true, photos: 0, merged: false });

  const merged = cfg.tags.some((t) => t.name === to);
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
