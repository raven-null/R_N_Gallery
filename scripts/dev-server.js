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

const PORT = 8787;
const ROOT = path.join(__dirname, "..");

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
      if (opts && opts.type === "json") return JSON.parse(v.toString("utf8"));
      return v;
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

const { handler } = require("../netlify/functions/photos");

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

  // API 路由 → 交给 Netlify Function handler
  if (pathname.startsWith("/api/")) {
    let body = "";
    for await (const chunk of req) body += chunk;
    const event = {
      rawUrl: `http://localhost:${PORT}${url.pathname}${url.search}`,
      httpMethod: req.method,
      path: pathname,
      headers: req.headers,
      body: body || null,
      queryStringParameters: Object.fromEntries(url.searchParams),
    };
    try {
      const result = await handler(event);
      res.writeHead(result.statusCode || 200, {
        ...result.headers,
        "Access-Control-Allow-Origin": "*",
      });
      if (result.isBase64Encoded) res.end(Buffer.from(result.body, "base64"));
      else res.end(result.body);
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
