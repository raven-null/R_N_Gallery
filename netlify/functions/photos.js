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
   ============================================================ */
const {
  store, json, notFound, badRequest, unauthorized, serverError,
  auth, nanoid, imageSize, sniffMime,
} = require("./_lib");

const PREFIX_META = "meta/";
const PREFIX_IMG = "img/";

exports.default = async (req) => {
  try {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const seg = path.split("/").filter(Boolean); // ["api", "photos", id?, "raw"?]
    const rest = seg.slice(2);

    // 统一鉴权：写操作（POST/PATCH/DELETE）校验写令牌，读操作校验读令牌
    const isWrite = method === "POST" || method === "PATCH" || method === "DELETE";
    if (!auth(req, isWrite)) return unauthorized();

    if (method === "GET" && path.endsWith("/api/photos")) return list(url);
    if (method === "GET" && path.startsWith("/api/photos/") && rest.length === 2 && rest[1] === "raw") return raw(rest[0]);
    if (method === "GET" && path.startsWith("/api/photos/") && rest.length === 1) return getMeta(rest[0]);
    if (method === "POST" && path.endsWith("/api/photos")) return upload(req);
    if (method === "PATCH" && path.startsWith("/api/photos/") && rest.length === 1) return patch(req, rest[0]);
    if (method === "DELETE" && path.endsWith("/api/photos")) return clearAll();
    if (method === "DELETE" && path.startsWith("/api/photos/") && rest.length === 1) return remove(rest[0]);
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
    "/api/meta/stats",
    "/api/export",
    "/api/import",
  ],
};

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
  };

  const s = store();
  await s.set(origKey, buf);
  await s.set(`${PREFIX_META}${id}.json`, JSON.stringify(meta));
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
  return json({ ok: true, photo: meta });
}

/* ---------- 删除单张 ---------- */
async function remove(id) {
  const s = store();
  const meta = await s.get(`${PREFIX_META}${id}.json`, { type: "json" });
  if (!meta) return notFound("Photo not found");
  await s.delete(meta.origKey || `${PREFIX_IMG}${id}`);
  await s.delete(`${PREFIX_META}${id}.json`);
  return json({ ok: true });
}

/* ---------- 清空图库 ---------- */
async function clearAll() {
  const s = store();
  let cursor;
  let deleted = 0;
  do {
    const res = await s.list({ cursor, limit: 200 });
    for (const item of res.blobs) {
      await s.delete(item.key);
      deleted++;
    }
    cursor = res.nextCursor;
  } while (cursor);
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
  return json({ count, bytes, byMonth });
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
      };
      await s.set(origKey, buf);
      await s.set(`${PREFIX_META}${id}.json`, JSON.stringify(meta));
      imported++;
    } catch (e) {
      errors.push({ url: typeof item === "string" ? item : item && item.url, error: e.message });
    }
  }
  return json({ ok: true, imported, errors });
}
