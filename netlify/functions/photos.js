/* ============================================================
   统一 API 入口：所有 /api/* 请求经 netlify.toml 重定向到此
   路由（基于原始路径解析）：
     GET    /api/photos            列表（分页，游标）
     GET    /api/photos/:id        单张元数据
     GET    /api/photos/:id/raw    图片字节（CDN 缓存）
     POST   /api/photos            上传（JSON + base64）
     PATCH  /api/photos/:id        更新元数据
     DELETE /api/photos/:id        删除单张
     DELETE /api/photos            清空图库
     GET    /api/meta/stats        用量统计
     GET    /api/export            导出全部元数据
     POST   /api/import            从站点静态 image/ 目录导入 Blobs
   ============================================================ */
const {
  store, json, notFound, badRequest, unauthorized, serverError,
  auth, nanoid, imageSize, sniffMime,
} = require("./_lib");

const PREFIX_META = "meta/";
const PREFIX_IMG = "img/";

exports.handler = async (event) => {
  try {
    const path = new URL(event.rawUrl).pathname;
    const seg = path.split("/").filter(Boolean); // ["api", "photos", id?, "raw"?]
    const method = event.httpMethod;
    const rest = seg.slice(2);

    if (method === "GET" && path.endsWith("/api/photos")) return list(event);
    if (method === "GET" && path.startsWith("/api/photos/") && rest.length === 2 && rest[1] === "raw") return raw(event, rest[0]);
    if (method === "GET" && path.startsWith("/api/photos/") && rest.length === 1) return getMeta(event, rest[0]);
    if (method === "POST" && path.endsWith("/api/photos")) return upload(event);
    if (method === "PATCH" && rest.length === 1) return patch(event, rest[0]);
    if (method === "DELETE" && path.endsWith("/api/photos")) return clearAll(event);
    if (method === "DELETE" && rest.length === 1) return remove(event, rest[0]);
    if (method === "GET" && path.endsWith("/api/meta/stats")) return stats(event);
    if (method === "GET" && path.endsWith("/api/export")) return exportAll(event);
    if (method === "POST" && path.endsWith("/api/import")) return importStatic(event);

    return notFound("Route not found");
  } catch (e) {
    return serverError(e);
  }
};

/* ---------- 列表（分页） ---------- */
async function list(event) {
  if (!auth(event)) return unauthorized();
  const q = event.queryStringParameters || {};
  const limit = Math.min(parseInt(q.limit, 10) || 60, 200);
  const s = store();
  const res = await s.list({ prefix: PREFIX_META, cursor: q.cursor, limit });
  const photos = [];
  for (const item of res.blobs) {
    const m = await s.get(item.key, { type: "json" });
    if (m) photos.push(m);
  }
  photos.sort((a, b) => (b.uploadedAt || "").localeCompare(a.uploadedAt || ""));
  return json({ photos, cursor: res.nextCursor || null, hasMore: !!res.nextCursor });
}

/* ---------- 单张元数据 ---------- */
async function getMeta(event, id) {
  if (!auth(event)) return unauthorized();
  const m = await store().get(`${PREFIX_META}${id}.json`, { type: "json" });
  if (!m) return notFound("Photo not found");
  return json({ photo: m });
}

/* ---------- 图片字节输出 ---------- */
async function raw(event, id) {
  if (!auth(event)) return unauthorized();
  const s = store();
  const m = await s.get(`${PREFIX_META}${id}.json`, { type: "json" });
  if (!m) return notFound("Photo not found");
  const buf = await s.get(m.origKey || `${PREFIX_IMG}${id}`);
  if (!buf) return notFound("Image data not found");
  return {
    statusCode: 200,
    headers: {
      "Content-Type": m.mime || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Length": String(buf.length),
      "X-Content-Type-Options": "nosniff",
    },
    body: buf.toString("base64"),
    isBase64Encoded: true,
  };
}

/* ---------- 上传 ---------- */
async function upload(event) {
  if (!auth(event, true)) return unauthorized();
  let body;
  try {
    body = JSON.parse(event.body || "{}");
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
    origKey: `${PREFIX_IMG}${id}`,
  };

  const s = store();
  await s.set(meta.origKey, buf, { metadata: { mime, width: String(dims.width), height: String(dims.height) } });
  await s.set(`${PREFIX_META}${id}.json`, JSON.stringify(meta), { metadata: { mime: "application/json" } });
  return json({ ok: true, photo: meta }, 201);
}

/* ---------- 更新元数据 ---------- */
async function patch(event, id) {
  if (!auth(event, true)) return unauthorized();
  let body;
  try {
    body = JSON.parse(event.body || "{}");
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
  await s.set(`${PREFIX_META}${id}.json`, JSON.stringify(meta), { metadata: { mime: "application/json" } });
  return json({ ok: true, photo: meta });
}

/* ---------- 删除单张 ---------- */
async function remove(event, id) {
  if (!auth(event, true)) return unauthorized();
  const s = store();
  const meta = await s.get(`${PREFIX_META}${id}.json`, { type: "json" });
  if (!meta) return notFound("Photo not found");
  await s.delete(meta.origKey || `${PREFIX_IMG}${id}`);
  await s.delete(`${PREFIX_META}${id}.json`);
  return json({ ok: true });
}

/* ---------- 清空图库 ---------- */
async function clearAll(event) {
  if (!auth(event, true)) return unauthorized();
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
async function stats(event) {
  if (!auth(event)) return unauthorized();
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
async function exportAll(event) {
  if (!auth(event)) return unauthorized();
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

/* ---------- 从站点静态 image/ 目录导入 Blobs ----------
   前端把图片文件名列表 POST 过来，函数从站点同源 URL 拉取并写入 Blobs */
async function importStatic(event) {
  if (!auth(event, true)) return unauthorized();
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return badRequest("Invalid JSON body");
  }
  const files = Array.isArray(body.files) ? body.files.map((f) => String(f).trim()).filter(Boolean).slice(0, 300) : [];
  if (!files.length) return badRequest("Missing files list");

  const host = event.headers["x-forwarded-host"] || event.headers.host;
  const proto = host.includes("localhost") || host.startsWith("127.") ? "http" : "https";
  const origin = `${proto}://${host}`;
  const s = store();
  let imported = 0;
  const errors = [];

  for (const file of files) {
    try {
      const res = await fetch(`${origin}/image/${encodeURIComponent(file)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const dims = imageSize(buf);
      if (!dims) throw new Error("Unsupported format");
      const id = nanoid();
      const mime = sniffMime(buf);
      const meta = {
        id,
        title: file.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ").trim() || "未命名",
        desc: "",
        tags: [],
        takenAt: new Date().toISOString(),
        uploadedAt: new Date().toISOString(),
        size: buf.length,
        width: dims.width,
        height: dims.height,
        mime,
        origKey: `${PREFIX_IMG}${id}`,
        src: `image/${file}`,
      };
      await s.set(meta.origKey, buf, { metadata: { mime } });
      await s.set(`${PREFIX_META}${id}.json`, JSON.stringify(meta), { metadata: { mime: "application/json" } });
      imported++;
    } catch (e) {
      errors.push({ file, error: e.message });
    }
  }
  return json({ ok: true, imported, errors }, imported || errors.length ? 200 : 500);
}
