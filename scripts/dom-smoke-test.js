#!/usr/bin/env node
/* ============================================================
   前端冒烟测试（v0.25）：用 jsdom 真跑一遍 app.js + index.html
   先启动本地服务并放一些照片，再执行本脚本：
     npm run dev                                   # 另开一个终端
     node scripts/dom-smoke-test.js                # 默认 http://localhost:8787
   需要 jsdom（不写进项目依赖，按需临时装）：
     npm install --no-save --no-package-lock --cache .npm-cache jsdom
   检查点：首屏渲染、无限滚动哨兵、图片回收（离开视口换占位 / 回来恢复）、
          CSS 性能规则是否在位。
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");

let JSDOM;
try {
  ({ JSDOM } = require("jsdom"));
} catch (e) {
  console.error("\n✗ 需要 jsdom，先安装（不会写进 package.json）：");
  console.error("    npm install --no-save --no-package-lock --cache .npm-cache jsdom\n");
  process.exit(1);
}

const ROOT = path.join(__dirname, "..");
const BASE = (process.env.GALLERY_URL || "http://localhost:8787").replace(/\/+$/, "");

(async () => {
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const dom = new JSDOM(html, { url: `${BASE}/`, pretendToBeVisual: true, runScripts: "outside-only" });
  const { window } = dom;

  /* 浏览器 API stub：IntersectionObserver 记录下来，便于手动触发 */
  const observers = [];
  window.IntersectionObserver = class {
    constructor(cb, opts) { this.cb = cb; this.opts = opts || {}; this.targets = new Set(); observers.push(this); }
    observe(el) { this.targets.add(el); }
    unobserve(el) { this.targets.delete(el); }
    disconnect() { this.targets.clear(); }
  };
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  window.fetch = (url, opts) => fetch(String(url).startsWith("http") ? String(url) : BASE + String(url), opts);
  window.localStorage.setItem("rn_perf_lite", "1"); // 打开性能模式，覆盖图片回收分支

  window.eval(fs.readFileSync(path.join(ROOT, "public", "assets", "app.js"), "utf8"));
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
  await new Promise((r) => setTimeout(r, 2500)); // 等首屏数据

  const doc = window.document;
  const results = [];
  const check = (name, ok, extra = "") => {
    results.push(ok);
    console.log(`${ok ? "✓" : "✗"} ${name}${extra ? "　" + extra : ""}`);
  };

  const cards0 = doc.querySelectorAll("#grid .card").length;
  check("首屏渲染出卡片", cards0 > 0, `${cards0} 张`);

  const sentinel = doc.getElementById("gridSentinel");
  check("滚动加载哨兵已创建", !!sentinel);
  const sentObserver = observers.find((o) => o.targets.has(sentinel));
  check("哨兵已被观察", !!sentObserver);
  if (sentObserver) {
    sentObserver.cb([{ target: sentinel, isIntersecting: true }]);
    await new Promise((r) => setTimeout(r, 500));
    const cards1 = doc.querySelectorAll("#grid .card").length;
    check("哨兵触发后追加卡片", cards1 > cards0, `${cards0} → ${cards1}`);
  }

  const releaseIO = observers.find((o) => String(o.opts.rootMargin || "").includes("150%"));
  check("图片回收观察器已创建", !!releaseIO, releaseIO ? `观察 ${releaseIO.targets.size} 个卡片` : "");
  if (releaseIO) {
    const card = [...releaseIO.targets].find((el) => el.querySelector("img"));
    const img = card && card.querySelector("img");
    if (img) {
      Object.defineProperty(img, "complete", { value: true, configurable: true });
      Object.defineProperty(img, "naturalWidth", { value: 480, configurable: true });
      const origin = img.src;
      releaseIO.cb([{ target: card, isIntersecting: false }]);
      check("离开视口 → 图片换成占位", img.dataset.released === "1" && img.src.startsWith("data:image/gif"));
      releaseIO.cb([{ target: card, isIntersecting: true }]);
      check("回到视口 → 图片恢复", img.dataset.released === "0" && img.src === origin);
    } else {
      check("找到可测卡片", false);
    }
  }

  const cssText = fs.readFileSync(path.join(ROOT, "public", "assets", "style.css"), "utf8");
  check("CSS 含 content-visibility 规则", /content-visibility:\s*auto/.test(cssText));

  const failed = results.filter((x) => !x).length;
  console.log(`\n${failed ? `✗ ${failed} 项未通过` : "✓ 全部通过"}（共 ${results.length} 项）\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("测试异常：", e); process.exit(1); });
