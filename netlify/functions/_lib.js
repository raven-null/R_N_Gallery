/* ============================================================
   Netlify Functions 共享库（v0.9.9，移植自 01-personal-blog 模式）
   - Blobs store：显式 siteID/token 凭据优先，环境注入兜底，
     本地开发回退 .local-data/ 文件存储（与参考项目一致）
   - 鉴权（ADMIN_TOKEN / UPLOAD_TOKEN 环境变量，未配置时放行）
   - 响应封装 / 图片尺寸解析 / id 生成
   ============================================================ */
const { getStore } = require("@netlify/blobs");
const fs = require("fs");
const path = require("path");

const STORE_NAME = "photos";
const LOCAL_DIR = path.join(process.cwd(), ".local-data");

/* ---------- 本地文件回退存储（无 Netlify 环境时使用） ---------- */
function localStore(name) {
  const dir = path.join(LOCAL_DIR, name);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const safe = (key) => {
    const p = path.join(dir, key);
    if (!p.startsWith(dir)) throw new Error("bad key");
    return p;
  };
  return {
    async set(key, val) {
      const p = safe(key);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, Buffer.isBuffer(val) ? val : Buffer.from(String(val)));
    },
    async get(key, opts) {
      const p = safe(key);
      if (!fs.existsSync(p)) return null;
      const buf = fs.readFileSync(p);
      if (opts && opts.type === "json") return JSON.parse(buf.toString("utf8"));
      return buf;
    },
    async delete(key) {
      const p = safe(key);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    },
    async list(opts = {}) {
      if (!fs.existsSync(dir)) return { blobs: [], nextCursor: undefined, hasMore: false };
      const keys = [];
      const walk = (d) => {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
          const fp = path.join(d, f.name);
          if (f.isDirectory()) walk(fp);
          else keys.push(path.relative(dir, fp).replace(/\\/g, "/"));
        }
      };
      walk(dir);
      const prefix = opts.prefix || "";
      const blobs = keys
        .filter((k) => k.startsWith(prefix))
        .sort()
        .map((key) => ({ key, size: fs.statSync(safe(key)).size }));
      const limit = opts.limit || 60;
      const start = opts.cursor ? parseInt(opts.cursor, 10) : 0;
      const page = blobs.slice(start, start + limit);
      const nextCursor = start + limit < blobs.length ? String(start + limit) : undefined;
      return { blobs: page, nextCursor, hasMore: !!nextCursor };
    },
  };
}

/* ---------- Blobs store（参考项目健壮模式） ----------
   1) 有 SITE_ID + token 时显式传参（不依赖环境注入）
   2) 否则走环境自动配置（NETLIFY_BLOBS_CONTEXT）
   3) 部署环境报错时给出明确提示；本地开发回退文件存储 */
function store() {
  const { SITE_ID, NETLIFY_BLOBS_TOKEN, NETLIFY_ACCESS_TOKEN } = process.env;
  try {
    const options = { name: STORE_NAME };
    if (SITE_ID && (NETLIFY_BLOBS_TOKEN || NETLIFY_ACCESS_TOKEN)) {
      options.siteID = SITE_ID;
      options.token = NETLIFY_BLOBS_TOKEN || NETLIFY_ACCESS_TOKEN;
    }
    return getStore(options);
  } catch (err) {
    const isMissing =
      String(err && err.code) === "MissingBlobsEnvironmentError" ||
      String((err && err.message) || "").includes("MissingBlobsEnvironmentError");
    if (SITE_ID) {
      const e = new Error(
        isMissing
          ? "Netlify Blobs 未启用：请在 Netlify 站点 Settings → Data collection 开启 Netlify Blobs"
          : "Netlify Blobs 存储不可用：" + (err && err.message ? err.message : err)
      );
      e.code = "BLOBS_UNAVAILABLE";
      throw e;
    }
    // 本地开发：回退本地文件存储（重启不丢数据）
    return localStore(STORE_NAME);
  }
}

/* ---------- 响应封装（Netlify Functions v2：返回 Response） ---------- */
function json(body, statusCode = 200) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      // 列表/元数据禁止缓存，避免清空/更新后浏览器仍显示旧数据
      "Cache-Control": "no-store",
    },
  });
}

function notFound(msg = "Not found") {
  return json({ error: msg }, 404);
}
function badRequest(msg) {
  return json({ error: msg }, 400);
}
function unauthorized(msg = "Unauthorized") {
  return json({ error: msg }, 401);
}
function serverError(e) {
  console.error("[photos]", e);
  return json({ error: "Internal error: " + (e && e.message) }, 500);
}

/* 鉴权：未配置 ADMIN_TOKEN 时全部放行（开发模式）；
   配置后：读操作校验 X-Auth-Token = ADMIN_TOKEN，写操作额外接受 UPLOAD_TOKEN */
function auth(req, write = false) {
  const admin = process.env.ADMIN_TOKEN;
  if (!admin) return true;
  const header = (req.headers.get("x-auth-token") || "").trim();
  const expected = write ? process.env.UPLOAD_TOKEN || admin : admin;
  return header === expected;
}

function nanoid(len = 8) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/* 解析图片尺寸（webp / jpeg / png / gif），返回 { width, height } 或 null */
function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // JPEG：扫描 SOF 段
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return null;
  }
  // WebP：RIFF....WEBP + VP8 / VP8L / VP8X
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const fourcc = buf.toString("ascii", 12, 16);
    if (fourcc === "VP8X") {
      const w = buf[24] | (buf[25] << 8) | (buf[26] << 16);
      const h = buf[27] | (buf[28] << 8) | (buf[29] << 16);
      return { width: (w & 0xffffff) + 1, height: (h & 0xffffff) + 1 };
    }
    if (fourcc === "VP8 ") {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (fourcc === "VP8L") {
      const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
      return {
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      };
    }
    return null;
  }
  return null;
}

function sniffMime(buf) {
  if (!buf || !buf.length) return "application/octet-stream";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.toString("ascii", 0, 4) === "RIFF") return "image/webp";
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49) return "image/gif";
  return "application/octet-stream";
}

module.exports = {
  store,
  json,
  notFound,
  badRequest,
  unauthorized,
  serverError,
  auth,
  nanoid,
  imageSize,
  sniffMime,
};
