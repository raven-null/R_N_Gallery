/* ============================================================
   Netlify Functions 共享库
   - Blobs store 访问（store 名：photos）
   - 鉴权（ADMIN_TOKEN / UPLOAD_TOKEN 环境变量，未配置时放行）
   - 响应封装 / 图片尺寸解析 / id 生成
   ============================================================ */
const { getStore } = require("@netlify/blobs");

const STORE_NAME = "photos";

// v8 推荐：环境配置（NETLIFY_BLOBS_CONTEXT 或 connectLambda）就绪后，
// 直接以 store 名获取；无需显式 siteID/token
function store() {
  return getStore(STORE_NAME);
}

function json(body, statusCode = 200) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
    body: JSON.stringify(body),
  };
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
function auth(event, write = false) {
  const admin = process.env.ADMIN_TOKEN;
  if (!admin) return true;
  const header = (event.headers["x-auth-token"] || event.headers["X-Auth-Token"] || "").trim();
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
