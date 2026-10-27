#!/usr/bin/env node
/* ============================================================
   标签改动的「无刷新」回归测试（v0.75）

   验证：在标签管理里改名 / 删除标签后，图库**不会**被整页重建
   （卡片 DOM 节点保持原样、只有 chips 变化），而不是像以前那样
   grid 被清空重建、滚动位置弹回顶部、入场动画重播一遍。

   不需要起服务：fetch 全部走内存桩。运行：
     npm run test:tagrefresh
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");

let JSDOM;
try {
  ({ JSDOM } = require("jsdom"));
} catch (e) {
  console.error("需要 jsdom：npm install --no-save --no-package-lock --cache .npm-cache jsdom");
  process.exit(1);
}

const ROOT = path.join(__dirname, "..");

/* ---- 假数据：40 张图，前一半带「胡桃」，两种标签交替 ---- */
const PHOTOS = Array.from({ length: 40 }, (_, i) => ({
  id: "p" + i,
  title: "图片 " + i,
  tags: i % 2 ? ["胡桃", "甘雨"] : ["胡桃"],
  categories: i % 3 ? ["原神同人"] : [],
  width: 1200,
  height: 1600,
  size: 200000,
  takenAt: "2026-01-01T00:00:00Z",
  rating: "general",
}));
let TAGS_CONFIG = {
  categories: [{ id: "", name: "原神同人", color: "#ff9f0a", sort: 0 }],
  groups: [{ id: "g1", name: "原神", color: "#ff9f0a", sort: 0 }],
  tags: [
    { id: "", name: "胡桃", aliases: [], group: "g1", color: null, sort: 0 },
    { id: "", name: "甘雨", aliases: [], group: "g1", color: null, sort: 1 },
  ],
};

const json = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });

function mockFetch(url, opts) {
  const u = String(url);
  const method = ((opts && opts.method) || "GET").toUpperCase();
  if (u.startsWith("/api/photos?") && method === "GET") return { photos: PHOTOS, hasMore: false, cursor: null };
  if (/^\/api\/photos\/[^/]+$/.test(u) && method === "PATCH") return { ok: true };
  if (u === "/api/tags" && method === "GET") return TAGS_CONFIG;
  if (u === "/api/tags" && method === "PUT") {
    TAGS_CONFIG = JSON.parse(opts.body); // 服务端"存下来"，方便后续断言
    return { ok: true, config: TAGS_CONFIG };
  }
  if (u === "/api/tags/rename") {
    const { from, to } = JSON.parse(opts.body);
    TAGS_CONFIG.tags = TAGS_CONFIG.tags.map((t) => (t.name === from ? { ...t, name: to } : t));
    PHOTOS.forEach((p) => { p.tags = p.tags.map((x) => (x === from ? to : x)); });
    return { ok: true };
  }
  if (u === "/api/tags/remove") {
    const { name } = JSON.parse(opts.body);
    TAGS_CONFIG.tags = TAGS_CONFIG.tags.filter((t) => t.name !== name);
    PHOTOS.forEach((p) => { p.tags = p.tags.filter((x) => x !== name); });
    return { ok: true };
  }
  if (u === "/api/auth/state") return { gate: false };
  return { ok: true };
}

(async () => {
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true, runScripts: "outside-only" });
  const { window } = dom;
  const doc = window.document;

  window.IntersectionObserver = class {
    constructor(cb, opts) { this.cb = cb; this.opts = opts || {}; this.targets = new Set(); }
    observe(el) { this.targets.add(el); }
    unobserve(el) { this.targets.delete(el); }
    disconnect() { this.targets.clear(); }
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  window.Element.prototype.getBoundingClientRect = function () {
    return { top: 0, bottom: 1, left: 0, right: 0, width: 100, height: 1, x: 0, y: 0, toJSON() { return this; } };
  };
  window.fetch = async (url, opts) => json(mockFetch(url, opts));

  window.localStorage.setItem("rn_mode", "admin");        // 管理员模式（能改标签）
  window.localStorage.setItem("rn_tmgr_view", "group");   // 标签管理默认打开「分组」视图
  window.localStorage.setItem("rn_perf_lite", "0");

  window.eval(fs.readFileSync(path.join(ROOT, "public", "assets", "app.js"), "utf8"));

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(600);

  const results = [];
  const check = (name, ok, extra = "") => {
    results.push(ok);
    console.log(`${ok ? "✓" : "✗"} ${name}${extra ? "　" + extra : ""}`);
  };

  const cards = () => [...doc.querySelectorAll("#grid .card")];
  const n0 = cards().length;
  check("首屏渲染出卡片", n0 > 0, `${n0} 张`);

  /* 给每张卡片打个探针：整页重建后这些节点会消失，探针也就没了 */
  cards().forEach((c, i) => { c.__probe = i; });
  const firstCard = cards()[0];
  const firstChips = firstCard.querySelector(".card__tags").textContent.trim();
  check("第一张卡片带「胡桃」chip", firstChips.includes("胡桃"), firstChips);

  /* ---- 1. 改名：胡桃 → 核桃 ---- */
  const editBtn = doc.querySelector('#tagMgrRoot [data-tact="edit"][data-tname="胡桃"]');
  check("标签管理里找到「胡桃」的编辑按钮", !!editBtn);
  editBtn.click();
  const nameInput = doc.getElementById("fName");
  check("改名弹窗已打开", !!nameInput && doc.getElementById("tagModal").classList.contains("open"));
  nameInput.value = "核桃";
  doc.getElementById("fSave").click();
  await wait(120);

  const afterRename = cards();
  check("改名后卡片节点没有被重建（同一批 DOM 节点）",
    afterRename.length === n0 && afterRename[0] === firstCard && afterRename.every((c) => c.__probe !== undefined),
    `${afterRename.length} 张`);
  const renamedChips = afterRename[0].querySelector(".card__tags").textContent;
  check("改名后卡片 chips 原地更新为「核桃」", renamedChips.includes("核桃") && !renamedChips.includes("胡桃"), renamedChips.trim());
  /* 标签菜单：组默认折叠，用搜索词把它展开来验证计数 / 名字都已同步 */
  const searchEl = doc.getElementById("tagSearch");
  searchEl.value = "核桃";
  searchEl.dispatchEvent(new window.Event("input", { bubbles: true }));
  await wait(60);
  const menuText = doc.getElementById("tagMenuList").textContent || "";
  check("标签菜单同步更新（能搜到「核桃」）", menuText.includes("核桃"));
  check("旧名「胡桃」已从标签菜单消失", !menuText.includes("胡桃"));
  searchEl.value = "";
  searchEl.dispatchEvent(new window.Event("input", { bubbles: true }));

  /* ---- 2. 删除：甘雨 ---- */
  const delBtn = doc.querySelector('#tagMgrRoot [data-tact="remove"][data-tname="甘雨"]');
  check("找到「甘雨」的删除按钮", !!delBtn);
  delBtn.click();
  const confirmBtn = doc.getElementById("fConfirm");
  check("删除确认弹窗已打开", !!confirmBtn);
  confirmBtn.click();
  await wait(120);

  const afterRemove = cards();
  check("删除后卡片节点没有被重建",
    afterRemove.length === n0 && afterRemove[0] === firstCard && afterRemove.every((c) => c.__probe !== undefined));
  const removedChips = afterRemove[0].querySelector(".card__tags").textContent;
  check("删除后卡片 chips 原地更新（不再含「甘雨」）", !removedChips.includes("甘雨"), removedChips.trim());

  /* ---- 3. 直接调钩子：已知受影响卡片时走补丁分支 ---- */
  const mode = window.__refreshAfterTagChange ? window.__refreshAfterTagChange(["p1"]) : "(无钩子)";
  check("__refreshAfterTagChange 走原地补丁分支", mode === "patched", String(mode));

  /* ---- 4. 未知受影响卡片时退回静默重渲，且不用 __renderGallery ---- */
  const beforeSilent = cards()[0];
  const mode2 = window.__refreshAfterTagChange ? window.__refreshAfterTagChange(null) : "(无钩子)";
  check("拿不到受影响卡片时静默重渲（返回 rendered）", mode2 === "rendered", String(mode2));
  check("静默重渲后卡片仍可见", cards().length > 0 && cards()[0] !== beforeSilent);

  cards().forEach((c, i) => { c.__probe = i; }); // 重渲后重新打探针

  /* ---- 5. 收藏（♥）：同样只改这一张卡片 ---- */
  const favCard = cards()[1];
  const favBtn = favCard.querySelector(".fv");
  check("卡片上有收藏按钮", !!favBtn);
  favBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await wait(120);
  check("点收藏后卡片没有被重建", cards()[1] === favCard && cards().every((c) => c.__probe !== undefined));
  check("收藏状态原地切换", favCard.classList.contains("fav") && favBtn.textContent === "♥", favBtn.textContent);
  favBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await wait(120);
  check("再点一次取消收藏", !favCard.classList.contains("fav") && favBtn.textContent === "♡", favBtn.textContent);

  /* ---- 5. 单张编辑弹窗（双击卡片）保存：也不再整库重拉 / 重建 ---- */
  const editTarget = cards()[2];
  editTarget.dispatchEvent(new window.MouseEvent("click", { detail: 2, bubbles: true, cancelable: true }));
  await wait(80);
  check("双击卡片打开单张编辑弹窗", doc.getElementById("editModal").classList.contains("open"));
  doc.getElementById("edSave").click();
  await wait(150);
  check("单张编辑保存后卡片没有被重建（不再 loadData 整库重拉）",
    cards()[2] === editTarget && cards().every((c) => c.__probe !== undefined));

  const okAll = results.every(Boolean);
  console.log(`\n${okAll ? "全部通过" : "有失败项"}：${results.filter(Boolean).length}/${results.length}`);
  process.exit(okAll ? 0 : 1);
})();
