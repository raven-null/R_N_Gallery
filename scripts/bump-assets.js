#!/usr/bin/env node
/* ============================================================
   刷新静态资源版本号（解决 /assets/* 的 immutable 长缓存）
     node scripts/bump-assets.js          # 用当天日期，如 20261205
     node scripts/bump-assets.js 1.2.3    # 或用自定义标记（会去掉点号，需为合法 query 值）

   会把 public/index.html 里 `style.css?v=` 与 `app.js?v=` 的**任意当前值**
   都替换成新值 —— 用正则匹配，不依赖"上一个值是什么"。
   （v0.73 的教训：手工替换时漏掉了 app.js 那一处，结果浏览器一直跑着
     旧版 app.js，新加的按钮在前端根本没渲染出来。）
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const INDEX = path.join(ROOT, "public", "index.html");

const arg = process.argv[2];
/* 默认用「日期 + 时分」而不是纯日期：同一天里反复改代码也能让 URL 变化，
   否则浏览器仍会拿 immutable 缓存里的旧文件 */
const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const stamp = arg
  ? String(arg).replace(/[^0-9a-zA-Z]/g, "")
  : `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;

let s = fs.readFileSync(INDEX, "utf8");
const before = s;
const hits = [];

const bump = (file) => {
  const re = new RegExp(`(${file.replace(/[.]/g, "\\.")}\\?v=)[^"']+`, "g");
  s = s.replace(re, (m, head) => { hits.push(`${file} → ${stamp}`); return head + stamp; });
};

bump("style.css");
bump("app.js");
bump("pinyin-pro.min.js");

if (s === before) {
  console.error("✗ index.html 里没找到任何 ?v= 引用，检查文件是否正确");
  process.exit(1);
}
fs.writeFileSync(INDEX, s);
console.log(`✓ 版本号已更新为 ${stamp}`);
console.log("  " + hits.join("\n  "));
