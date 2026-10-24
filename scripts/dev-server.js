/* ============================================================
   本地开发服务器（无需 netlify-cli / 网络）
   - 静态文件服务（index.html / assets / image）
   - /api/* 路由 → 调用 netlify/functions/photos.js 的 handler
   - Blobs 用内存实现模拟（set/get/list/delete + 游标分页）
   启动：npm run dev  →  http://localhost:8787
   ============================================================ */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const PORT = parseInt(process.env.PORT, 10) || 8787;
const ROOT = path.join(__dirname, "..", "public"); // 与 netlify.toml publish 一致

/* ---------- 内存 Blobs 模拟 ---------- */
const memStores = new Map();
function memStore(name) {
  if (!memStores.has(name)) memStores.set(name, new Map());
  const map = memStores.get(name);
  return {
    async set(key, val) {
      map.set(key, Buffer.isBuffer(val) ? val : Buffer.from(String(val)));
    },
    async get(key, opts) {
      const v = map.get(key);
      if (v === undefined) return null;
      // 模拟 @netlify/blobs v8 行为：默认返回字符串；json/arrayBuffer 按类型
      if (opts && opts.type === "json") return JSON.parse(v.toString("utf8"));
      if (opts && opts.type === "arrayBuffer") return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
      return v.toString("utf8");
    },
    async delete(key) {
      map.delete(key);
    },
    async list(opts = {}) {
      const prefix = opts.prefix || "";
      const keys = [...map.keys()].filter((k) => k.startsWith(prefix)).sort();
      const blobs = keys.map((key) => ({ key, size: map.get(key).length }));
      const limit = opts.limit || 60;
      const start = opts.cursor ? parseInt(opts.cursor, 10) : 0;
      const page = blobs.slice(start, start + limit);
      const nextCursor = start + limit < blobs.length ? String(start + limit) : undefined;
      return { blobs: page, nextCursor, hasMore: !!nextCursor };
    },
  };
}
// 拦截 @netlify/blobs，替换为内存实现（含 v8 的 connectLambda 兼容）
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "@netlify/blobs") {
    return {
      getStore: (name) => memStore(typeof name === "string" ? name : name.name),
      deleteStore: async () => {},
      connectLambda: () => {},
    };
  }
  return origLoad.apply(this, arguments);
};

const photosFn = require("../netlify/functions/photos");
const handler = photosFn.default;

/* ---------- 路由白名单校验（v0.54） ----------
   线上真正生效的是各函数 `exports.config.path` 里声明的路由；漏加一条就会 404
   （v0.53 的 /api/auth/tagger 就踩过这个坑）。本地按同一份声明校验一次：
   默认只打印警告并放行，设 STRICT_ROUTES=1 则按线上行为返回 404。 */
function declaredRoutes() {
  const out = [];
  // 注意：Functions v2 的 config 挂在**模块导出**上（exports.config），不在 default 函数上
  for (const mod of [photosFn]) {
    const list = (mod && mod.config && mod.config.path) || (mod && mod.default && mod.default.config && mod.default.config.path) || [];
    for (const item of (Array.isArray(list) ? list : [list])) {
      const p = typeof item === "string" ? item : item && item.path;
      if (p) out.push(p);
    }
  }
  return out;
}
const ROUTES = declaredRoutes();
function routeDeclared(pathname) {
  const p = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  return ROUTES.some((route) => {
    if (!route.includes(":")) return route === p;
    const re = new RegExp("^" + route.replace(/:[^/]+/g, "[^/]+").replace(/\*/g, ".*") + "$");
    return re.test(p);
  });
}

/* ---------- 静态文件 ---------- */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/* ---------- HTTP 服务 ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);

  // API 路由 → 交给 Netlify Functions v2（export default + Request/Response）
  if (pathname.startsWith("/api/")) {
    if (!routeDeclared(pathname)) {
      console.warn(`  ⚠ 路由未声明：${req.method} ${pathname} 不在函数 config.path 里 —— 线上会直接 404`);
      if (process.env.STRICT_ROUTES === "1") {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: `Route not declared in config.path: ${pathname}` }));
        return;
      }
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const fnReq = new Request(`http://localhost:${PORT}${url.pathname}${url.search}`, {
      method: req.method,
      headers: req.headers,
      body: body || undefined,
    });
    try {
      const fnRes = await handler(fnReq);
      res.writeHead(fnRes.status, {
        ...Object.fromEntries(fnRes.headers.entries()),
        "Access-Control-Allow-Origin": "*",
      });
      const buf = Buffer.from(await fnRes.arrayBuffer());
      res.end(buf);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 静态文件
  const file = path.join(ROOT, pathname === "/" ? "index.html" : pathname);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log("");
  console.log("  R_N_Gallery 本地开发服务器已启动");
  console.log(`  浏览器打开: http://localhost:${PORT}`);
  console.log(`  API 测试:   http://localhost:${PORT}/api/photos`);
  console.log(`  （Blobs 为内存模拟，重启后数据清空）`);
  console.log("");
});
