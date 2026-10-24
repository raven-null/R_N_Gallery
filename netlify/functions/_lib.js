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
const crypto = require("crypto");

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
      // 与 @netlify/blobs v8 行为一致：默认返回字符串，json/arrayBuffer 按类型
      if (opts && opts.type === "json") return JSON.parse(buf.toString("utf8"));
      if (opts && opts.type === "arrayBuffer") return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      return buf.toString("utf8");
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

/* ============================================================
   访问控制（v0.16）：访问密码 + R18 密钥
   - 密码与密钥都只存 SHA-256 哈希，配置存 Blobs 的 auth-config
   - 首次启动若环境变量 ADMIN_TOKEN 存在，用它初始化访问密码（之后可在设置页修改）
   - 两者都未设置时：不启用门禁 / 不额外保护 R18（避免把自己锁在外面）
   ============================================================ */
const KEY_AUTH = "auth-config";
const sha256hex = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");

async function authConfig() {
  const s = store();
  let cfg = null;
  try {
    cfg = await s.get(KEY_AUTH, { type: "json" });
  } catch {
    cfg = null;
  }
  if (!cfg || typeof cfg !== "object") cfg = {};
  // 首次启动：用环境变量初始化访问密码
  if (!cfg.accessHash && process.env.ADMIN_TOKEN) {
    cfg.accessHash = sha256hex(process.env.ADMIN_TOKEN);
    try {
      await s.set(KEY_AUTH, JSON.stringify(cfg));
    } catch {
      /* 写失败也继续用内存里的值 */
    }
  }
  return cfg;
}

async function saveAuthConfig(cfg) {
  await store().set(KEY_AUTH, JSON.stringify(cfg || {}));
}

/* 凭证来源：请求头 X-Auth-Token 或 URL 参数 ?token=（<img> 无法带请求头） */
function tokenFrom(req, url) {
  const h = (req && req.headers && (req.headers.get("X-Auth-Token") || req.headers.get("x-auth-token"))) || "";
  return String(h || (url ? url.searchParams.get("token") || "" : "")).trim();
}

/* 返回 { ok, gate, role }：
   role = "admin"（持访问密码，全部权限）/ null（无凭证 → 走观光只读白名单）
   gate 表示是否启用了门禁（以访问密码为准）
   v0.59：整理模式（tagger 角色 / 整理密码）整块删除 —— 只剩管理员与观光两种模式。
   存量 auth-config 里可能还留着 taggerHash 字段，这里不再读取，等于自动失效。 */
async function checkAuth(req, url) {
  const cfg = await authConfig();
  const t = tokenFrom(req, url);
  const hitAdmin = !!cfg.accessHash && !!t && sha256hex(t) === cfg.accessHash;
  if (!cfg.accessHash) return { ok: true, gate: false, role: "admin" }; // 未设访问密码：门禁关闭
  if (hitAdmin) return { ok: true, gate: true, role: "admin" };
  return { ok: false, gate: true, role: null };
}

/* ============================================================
   分级（v0.57）：整库统一的三档 —— general（大众级）/ r16 / r18
   v0.56 及以前成人向是「独立布尔字段 + 标签名 + 主分类名」三路任一命中，
   于是标签名一撞车就能改可见性（还出过「整理角色删掉图上 r18 标签把自己解锁」的越权）。
   现在收敛成一个字段 meta.rating：
     · 写入 —— 只有管理员能设（整理角色的 body 被裁剪成 tags/categories，天然写不进）
     · 读取 —— ratingOf() 优先读字段；**迁移期兜底**再看老布尔字段 / 老标签 / 老主分类，
       保证在跑 scripts/migrate-rating.js 之前，老数据的成人向图片一张都不会漏
   ============================================================ */
const RATINGS = ["general", "r16", "r18"];
const RATING_LABEL = { general: "大众级", r16: "R16", r18: "R18" };
/* 归一化：缺失 / 非法值 → 大众级 */
function normRating(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  return RATINGS.includes(s) ? s : "general";
}
/* 判定顺序：显式字段 → 老布尔字段 → 标签 → 主分类（后三者只为兼容迁移前的数据） */
function ratingOf(p) {
  if (!p) return "general";
  const raw = String(p.rating || "").trim().toLowerCase();
  if (RATINGS.includes(raw)) return raw;
  if (p.r18 === true) return "r18";
  if (p.r16 === true) return "r16";
  const low = (v) => (Array.isArray(v) ? v : (v ? [v] : [])).map((x) => String(x).trim().toLowerCase());
  const tags = low(p.tags);
  if (tags.includes("r18")) return "r18";
  if (tags.includes("r16")) return "r16";
  const cats = low(Array.isArray(p.categories) && p.categories.length ? p.categories : p.category);
  if (cats.includes("r18")) return "r18";
  if (cats.includes("r16")) return "r16";
  return "general";
}
const isR18Photo = (p) => ratingOf(p) === "r18";
const isR16Photo = (p) => ratingOf(p) === "r16";
/* 成人向 = 非大众级（观光 / 整理模式对 R16 与 R18 一视同仁） */
const isAdultPhoto = (p) => ratingOf(p) !== "general";

module.exports = {
  store,
  json,
  notFound,
  badRequest,
  unauthorized,
  serverError,
  nanoid,
  imageSize,
  sniffMime,
  authConfig,
  saveAuthConfig,
  checkAuth,
  RATINGS,
  RATING_LABEL,
  normRating,
  ratingOf,
  isR18Photo,
  isR16Photo,
  isAdultPhoto,
  tokenFrom,
  sha256hex,
};
