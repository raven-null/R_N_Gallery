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
const TOKEN = process.env.GALLERY_TOKEN || ""; // 线上启用访问密码时填这个

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

  /* v0.26：模拟布局 —— jsdom 没有真实排版，这里给哨兵一个可控的"距视口顶部"位置，
     以便复现"滚动到底应当加载更多"的场景（innerHeight 固定 800，与代码里的 800px 缓冲对应） */
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  let sentinelTop = 2000; // 初始：远在视口下方（800 + 800 缓冲之外）
  window.Element.prototype.getBoundingClientRect = function () {
    const isSentinel = this && this.id === "gridSentinel";
    const top = isSentinel ? sentinelTop : 0;
    return { top, bottom: top + 1, left: 0, right: 0, width: isSentinel ? 100 : 0, height: 1, x: 0, y: top, toJSON() { return this; } };
  };
  window.fetch = (url, opts) => {
    const abs = String(url).startsWith("http") ? String(url) : BASE + String(url);
    const o = Object.assign({}, opts);
    // v0.54：app.js 会给请求带 AbortSignal.timeout()，但 jsdom 的 AbortSignal 不是
    // Node fetch 认的实例（报 "Expected signal to be an instance of AbortSignal"）。
    // 浏览器里两者同源没有这个问题，所以这里只丢掉 signal（等价于"无超时的浏览器"）。
    delete o.signal;
    if (TOKEN) o.headers = Object.assign({}, o.headers, { "X-Auth-Token": TOKEN });
    return fetch(abs, o);
  };
  window.localStorage.setItem("rn_perf_lite", "1"); // 打开性能模式，覆盖图片回收分支
  window.localStorage.setItem("rn_mode", "admin");   // v0.49：测试以管理员模式跑（观光模式另有专门断言）
  if (TOKEN) window.localStorage.setItem("rn_token", TOKEN); // 线上门禁：预置访问凭证，否则会停在登录页

  window.eval(fs.readFileSync(path.join(ROOT, "public", "assets", "app.js"), "utf8"));

  const doc = window.document;
  /* jsdom 自己也会派发一次 DOMContentLoaded；先等它，避免重复初始化 */
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(1200);
  if (!doc.getElementById("gridSentinel")) {
    doc.dispatchEvent(new window.Event("DOMContentLoaded")); // jsdom 没触发时补一次
  }

  /* 等首屏数据（线上冷启动可能几秒）：轮询直到出现卡片或超时 */
  const waitFor = async (fn, timeout = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (fn()) return true; } catch (e) { /* ignore */ }
      await wait(300);
    }
    return false;
  };
  const gotCards = await waitFor(() => doc.querySelectorAll("#grid .card").length > 0);
  const results = [];
  const check = (name, ok, extra = "") => {
    results.push(ok);
    console.log(`${ok ? "✓" : "✗"} ${name}${extra ? "　" + extra : ""}`);
  };

  const cards0 = doc.querySelectorAll("#grid .card").length;
  check("首屏渲染出卡片", cards0 > 0, `${cards0} 张${gotCards ? "" : "（等待超时）"}`);
  /* v1.13：打开图库默认「正方形网格」，而且不记忆上次的选择（每次刷新都回到方格） */
  check("打开图库默认是正方形网格", doc.getElementById("grid").classList.contains("grid-square")
    && (window.__layoutMode ? window.__layoutMode() : "?") === "square",
    `mode=${window.__layoutMode ? window.__layoutMode() : "?"}`);
  /* v0.89：网格卡片一律走缩略图 —— 不再因为「高清档」或「缺 thumbKey」去拉原图 */
  {
    const imgs = [...doc.querySelectorAll("#grid .card img")];
    const srcOf = (i) => i.dataset.cardSrc || i.getAttribute("src") || "";
    check("网格卡片加载的是缩略图而不是原图", imgs.length > 0 && imgs.every((i) => /\/thumb(\?|$)/.test(srcOf(i))),
      imgs.length ? srcOf(imgs[0]).slice(0, 70) : "无");
  }

  const sentinel = doc.getElementById("gridSentinel");
  check("滚动加载哨兵已创建", !!sentinel);
  const sentObserver = observers.find((o) => o.targets.has(sentinel));
  check("哨兵已被观察", !!sentObserver);

  /* v0.26 回归验证：哨兵在视口外时不该继续加载；滚动到视口附近必须触发追加 */
  await wait(500);
  const stillCards = doc.querySelectorAll("#grid .card").length;
  check("哨兵在视口外时不会乱加载", stillCards === cards0, `${stillCards} 张`);

  sentinelTop = 300; // 模拟滚动：哨兵进入视口 + 800px 缓冲范围
  window.dispatchEvent(new window.Event("scroll"));
  await wait(600);
  const afterScroll = doc.querySelectorAll("#grid .card").length;
  const loadMoreTextNow = () => {
    const lm = doc.getElementById("loadMore");
    return lm && lm.querySelector("span") ? lm.querySelector("span").textContent.trim() : "";
  };
  const gsNow = window.__galleryState ? window.__galleryState() : { filtered: 0 };
  if (gsNow.filtered > cards0) {
    check("滚动到底触发追加", afterScroll > cards0, `${cards0} → ${afterScroll}`);
  } else {
    // 数据量不超过首屏时没有"更多"可加载，改为验证进度提示
    check("数据量不足时进度提示正确", /全部加载|All loaded/.test(loadMoreTextNow()), `本次仅 ${cards0} 张，跳过追加断言`);
  }
  if (window.__galleryState) console.log(`   内部状态：${JSON.stringify(window.__galleryState())}`);

  if (sentObserver) {
    const loadMoreText = () => {
      const lm = doc.getElementById("loadMore");
      return lm && lm.querySelector("span") ? lm.querySelector("span").textContent.trim() : "(无 loadMore)";
    };
    console.log(`   进度提示：${loadMoreText()}`);
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

  /* v0.59：逐张「整理」视图已移除 —— 原先这里 6 项 rvState 断言随之删除 */

  const cssText = fs.readFileSync(path.join(ROOT, "public", "assets", "style.css"), "utf8");
  check("CSS 含 content-visibility 规则", /content-visibility:\s*auto/.test(cssText));
  // v0.61：FAB 上分支两个按钮之间留出间距（之前贴着，hover 放大 1.12 会视觉重叠）
  check("CSS：FAB 上分支按钮之间有 12px 间距", /\.fab-branch\.up\s*\{[^}]*gap:\s*12px/.test(cssText),
    (/\.fab-branch\.up\s*\{[^}]*\}/.exec(cssText) || ["(找不到规则)"])[0].replace(/\s+/g, " ").slice(0, 90));
  // v0.47：灯箱图片铺满可用区域且不变形
  check("CSS：灯箱图片按比例铺满（max-height 100% + object-fit contain）",
    /\.lightbox img\s*\{[^}]*max-height:\s*100%/.test(cssText) && /\.lightbox img\s*\{[^}]*object-fit:\s*contain/.test(cssText));
  // v0.78：新建标签的「所属组」下拉 = 毛玻璃 + 限高可滚动
  check("CSS：所属组下拉是毛玻璃且可滚动",
    /\.gs-menu\s*\{[^}]*backdrop-filter:\s*blur\(24px\)/.test(cssText) && /\.gs-menu\s*\{[^}]*overflow-y:\s*auto/.test(cssText) && /\.gs-menu\s*\{[^}]*max-height:\s*220px/.test(cssText));
  // v0.79：通用确认框要压在所有弹窗上面（它常从别的弹窗里弹出）
  check("CSS：确认弹窗 z-index 高于其他弹窗", /#confirmModal\s*\{[^}]*z-index:\s*240/.test(cssText));
  // v0.81：卡片悬停只露标签，一行不换行、超出裁掉；日期与大小不再显示
  check("CSS：标签条不换行且超出裁剪",
    /\.card__tags\s*\{[^}]*flex-wrap:\s*nowrap/.test(cssText) && /\.card__tags\s*\{[^}]*overflow:\s*hidden/.test(cssText));
  check("卡片悬浮层不再渲染日期 / 大小", !doc.querySelector("#grid .card .card__meta"));

  /* 分类工作台：选中一张卡片 → 点主分类 chips → 真能写进图库 */
  const cwCard = doc.querySelector("#cwCards .cw-card");
  const cwChip = doc.querySelector("#cwCats .cat-pick");
  check("分类工作台有主分类面板", !!(doc.getElementById("cwCats") && cwChip), cwChip ? `${doc.querySelectorAll("#cwCats .cat-pick").length} 个分类` : "未渲染（可能不在分类视图）");
  if (cwCard && cwChip) {
    const catName = cwChip.dataset.cat;
    const id = cwCard.dataset.id;
    const headers = TOKEN ? { "X-Auth-Token": TOKEN } : {};
    const readCats = async () => {
      const res = await fetch(`${BASE}/api/photos?limit=200&_=${Math.random()}`, { headers });
      const d = await res.json();
      const t = (d.photos || []).find((p) => p.id === id);
      return (t && (t.categories || [])) || [];
    };
    /* 线上 Netlify Blobs 写入后有读延迟：连续读两次一致才算稳定，避免期望值判断错 */
    const stableCats = async () => {
      let prev = await readCats();
      for (let i = 0; i < 8; i++) {
        await wait(2000);
        const cur = await readCats();
        if (cur.join(",") === prev.join(",")) return cur;
        prev = cur;
      }
      return prev;
    };
    const before = await stableCats();
    const expectAdd = !before.includes(catName); // toggle 语义：已含则点击是「取消」
    cwCard.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await wait(200);
    const selStatus = () => ((doc.getElementById("cwSelStatus") || {}).textContent || "").trim();
    console.log(`   选中后：${selStatus()}　（卡片 sel 类：${cwCard.classList.contains("sel")}）`);
    const chip2 = doc.querySelector("#cwCats .cat-pick"); // 面板会随选中重建，重新取一次
    console.log(`   点击「${catName}」（预期：${expectAdd ? "加上" : "取消"}，当前 [${before.join(",")}]）…`);
    chip2.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    /* Netlify Blobs 写入后读取有延迟，轮询等待（本地通常立即命中） */
    let finalCats = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      await wait(1500);
      finalCats = await readCats();
      if (finalCats.includes(catName) === expectAdd) break;
    }
    console.log(`   点主分类后：${selStatus()}　读回的分类 [${finalCats.join(",")}]`);
    check("点主分类后已写回图库", finalCats.includes(catName) === expectAdd, `预期${expectAdd ? "有" : "无"}「${catName}」`);
  }

  /* 主分类就地编辑（v0.28）：chips 里的 ✎ 打开编辑弹窗；标题旁「＋ 新建」打开新建弹窗 */
  const cwEditBtn = doc.querySelector("#cwCats .cat-edit");
  check("分类工作台主分类带编辑入口", !!cwEditBtn);
  const modalTitle = () => ((doc.querySelector("#tagModalBody h3") || {}).textContent || "").trim();
  const closeModal = () => {
    const c = doc.querySelector("#tagModalBody #fCancel");
    if (c) c.click();
  };
  if (cwEditBtn) {
    cwEditBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await wait(300);
    check("点 ✎ 打开「编辑主分类」弹窗", doc.getElementById("tagModal").classList.contains("open") && modalTitle().includes("编辑主分类"), modalTitle());
    closeModal();
    await wait(200);
  }
  const cwNewBtn = doc.getElementById("cwNewCat");
  if (cwNewBtn) {
    cwNewBtn.click();
    await wait(300);
    check("点「＋ 新建」打开「新建主分类」弹窗", modalTitle().includes("新建主分类"), modalTitle());
    closeModal();
    await wait(200);
  }

  /* 分组视图：标签组折叠（v0.29） */
  window.localStorage.setItem("rn_tmgr_view", "group");
  window.localStorage.removeItem("rn_tmgr_fold");
  window.__refreshTagManager();
  await wait(400);
  const heads = [...doc.querySelectorAll("#tagMgrRoot [data-gfold]")];
  check("分组视图有可折叠的组头", heads.length > 0, `${heads.length} 个组`);
  const bigHead = heads.find((h) => Number(h.dataset.gcount) > 20);
  if (bigHead) {
    const next = bigHead.nextElementSibling;
    check("标签多的组默认折叠", bigHead.classList.contains("folded") && !(next && next.classList.contains("tmgr-pills")),
      `${bigHead.textContent.trim().replace(/\s+/g, " ")}`);
    bigHead.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await wait(400);
    const again = [...doc.querySelectorAll("#tagMgrRoot [data-gfold]")].find((h) => h.dataset.gfold === bigHead.dataset.gfold);
    const pillNext = again && again.nextElementSibling;
    check("点组头可展开", !!again && !again.classList.contains("folded") && !!(pillNext && pillNext.classList.contains("tmgr-pills")));
    // v0.68：「全部折叠 / 全部展开」按钮已移除
    check("分组视图不再有全部折叠 / 展开按钮", !doc.getElementById("tmgrFoldAll") && !doc.getElementById("tmgrOpenAll"));
    // v0.69 重设计：组头统计 + 降噪 + 顶部搜索 + 双视图
    const statEl = doc.querySelector("#tagMgrRoot .tmgr-head .stat");
    check("组头显示「有素材 / 空」统计", !!statEl && /有素材/.test(statEl.textContent), statEl ? statEl.textContent.trim() : "无");
    check("0 素材的标签被淡化（.empty）", doc.querySelectorAll("#tagMgrRoot .tmgr-pill.empty").length > 0,
      `${doc.querySelectorAll("#tagMgrRoot .tmgr-pill.empty").length} 个空标签`);
    check("数量做成角标（.cnt）", doc.querySelectorAll("#tagMgrRoot .tmgr-pill .cnt").length > 0);
    const catBody = doc.querySelector("#tagMgrRoot .tmgr-catbody");
    check("主分类块默认收起", !!catBody && catBody.hidden);
    const catHead = doc.getElementById("tmgrCatHead");
    const tap = (el) => el && el.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); // 这段在 clickEl 定义之前
    if (catHead) {
      tap(catHead);
      await wait(400);
      const body2 = doc.querySelector("#tagMgrRoot .tmgr-catbody");
      check("点主分类块标题可展开", !!body2 && !body2.hidden);
      const head2 = doc.getElementById("tmgrCatHead");
      if (head2) { tap(head2); await wait(350); }
    }

    // v0.87：「标签流 ⇄ 卡片网格」的切换按钮连同网格模式一起删除
    check("分组视图不再有标签流 / 网格切换按钮",
      !doc.getElementById("tmgrTagViewBtn") && !doc.querySelector("#tagMgrRoot .tmgr-tagcard"));

    // 标签搜索
    const searchInp = doc.getElementById("tmgrTagSearch");
    check("分组视图有标签搜索框", !!searchInp);
    if (searchInp) {
      searchInp.value = "冒烟角色01";
      searchInp.dispatchEvent(new window.Event("input", { bubbles: true }));
      await wait(450);
      const headsNow = [...doc.querySelectorAll("#tagMgrRoot [data-gfold]")];
      const pillsNow = [...doc.querySelectorAll("#tagMgrRoot .tmgr-pill[data-tag]")];
      check("搜索只保留命中的组", headsNow.length === 1, `${headsNow.length} 个组`);
      check("搜索只显示命中的标签", pillsNow.length === 1, `${pillsNow.length} 个标签`);
      const inp2 = doc.getElementById("tmgrTagSearch");
      if (inp2) {
        inp2.value = "zzz不存在zzz";
        inp2.dispatchEvent(new window.Event("input", { bubbles: true }));
        await wait(450);
        check("无命中时给出空态提示", /没有匹配/.test(doc.getElementById("tagMgrRoot").textContent));
        const inp3 = doc.getElementById("tmgrTagSearch");
        if (inp3) { inp3.value = ""; inp3.dispatchEvent(new window.Event("input", { bubbles: true })); }
        await wait(450);
      }
    }

    /* v0.86：概览条 + 过滤（全部 / 有素材 / 空） */
    const ov = doc.querySelector("#tagMgrRoot .tmgr-overview");
    check("分组视图有概览条（组数 / 标签数 / 有素材 / 空）",
      !!ov && /有素材/.test(ov.textContent) && /个标签/.test(ov.textContent),
      ov ? ov.textContent.replace(/\s+/g, " ").trim() : "无");
    const fBtns = [...doc.querySelectorAll("#tagMgrRoot [data-tfilter]")];
    check("概览条有三个过滤开关", fBtns.length === 3, fBtns.map((b) => b.dataset.tfilter).join(","));
    if (fBtns.length === 3) {
      const usedBtn = fBtns.find((b) => b.dataset.tfilter === "used");
      const emptyBtn = fBtns.find((b) => b.dataset.tfilter === "empty");
      if (usedBtn) {
        tap(usedBtn);
        await wait(420);
        // 只看标签胶囊（主分类块的 .tmgr-pill.cat 不属于标签）
        const empties = doc.querySelectorAll("#tagMgrRoot .tmgr-pill[data-tag].empty").length;
        check("过滤「有素材」后不显示空标签", empties === 0, `${empties} 个空标签`);
      }
      if (emptyBtn) {
        tap(emptyBtn);
        await wait(420);
        const pills = [...doc.querySelectorAll("#tagMgrRoot .tmgr-pill[data-tag]")];
        check("过滤「空」只剩空标签", pills.length > 0 && pills.every((p) => p.classList.contains("empty")), `${pills.length} 个`);
      }
      const allBtn = [...doc.querySelectorAll("#tagMgrRoot [data-tfilter]")].find((b) => b.dataset.tfilter === "all");
      if (allBtn) { tap(allBtn); await wait(420); }
      check("恢复「全部」后空标签回来了", doc.querySelectorAll("#tagMgrRoot .tmgr-pill[data-tag].empty").length > 0);
    }
  } else {
    check("存在标签数 >20 的组（折叠验证用）", false, "本地先跑：node scripts/import-chars.js");
  }

  /* 浏览页（v0.56）：一级 = 全部图片 / 收藏夹 / 主分类集合；二级 = 集合内容 */
  const fabAlb = doc.getElementById("fabAlbumsBtn");
  check("FAB 有浏览按钮", !!fabAlb);
  check("页面切换菜单已移除「图库」项", !doc.querySelector('#pageMenu [data-page="gallery"]'));
  const clickEl = (el) => el && el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  if (fabAlb) {
    clickEl(fabAlb);
    await wait(800);
    const page = doc.getElementById("albumPage");
    const cardOf = (key) => doc.querySelector(`#albumBody [data-set="${key}"]`);
    const setCards = () => [...doc.querySelectorAll("#albumBody [data-set]")];
    check("点击后浏览页打开", !!page && page.classList.contains("open"));
    check("有顶部导航栏与内容容器", !!doc.getElementById("albNavTitle") && !!doc.getElementById("albumBody"));
    check("一级有「全部图片」与「收藏夹」入口", !!cardOf("__all") && !!cardOf("__fav"));
    const heads = [...doc.querySelectorAll("#albumBody .alb-group-head")].map((x) => x.textContent.trim());
    check("一级有主分类分组标题", heads.includes("主分类"), heads.join(" / ") || "（无）");
    check("一级按主分类列出集合", setCards().length >= 3, `${setCards().length} 个集合卡片`);
    check("手动相册入口已移除（新建 / 输入行）", !doc.getElementById("albAddBtn") && !doc.getElementById("albNewBar"));
    const st0 = window.__albumsState ? window.__albumsState() : { level: "?" };
    check("初始停在一级列表", st0.level === "list", `层级=${st0.level}`);

    clickEl(cardOf("__all"));
    await wait(600);
    const allN = doc.querySelectorAll("#albumBody .alb-photo").length;
    const st1 = window.__albumsState ? window.__albumsState() : { level: "?" };
    check("点「全部图片」进二级并显示照片", allN > 0 && st1.level === "set", `${allN} 张，层级=${st1.level}`);
    check("导航标题变成集合名", /全部图片|All Photos/.test((doc.getElementById("albNavTitle") || {}).textContent || ""),
      (doc.getElementById("albNavTitle") || {}).textContent || "");

    const firstAlbPhoto = doc.querySelector("#albumBody .alb-photo");
    if (firstAlbPhoto) {
      clickEl(firstAlbPhoto);
      await wait(400);
      check("二级点图片打开灯箱", doc.getElementById("lightbox").classList.contains("open"));
      doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await wait(300);
    }

    clickEl(doc.getElementById("albBack"));
    await wait(400);
    const st2 = window.__albumsState ? window.__albumsState() : { level: "?" };
    check("返回按钮：二级退回一级", st2.level === "list", `层级=${st2.level}`);

    // 主分类集合的渲染数量应与派生规则一致（分批上限 200）
    const catCard = setCards().find((c) => c.dataset.set.startsWith("cat:") && !c.dataset.set.includes("__none"));
    if (catCard) {
      const key = catCard.dataset.set;
      const expect = window.__setPhotoIds ? window.__setPhotoIds(key).length : -1;
      clickEl(catCard);
      await wait(600);
      const got = doc.querySelectorAll("#albumBody .alb-photo").length;
      check("主分类集合数量与派生规则一致", got === Math.min(expect, 200), `${key} 派生 ${expect} 张，渲染 ${got} 张`);
      clickEl(doc.getElementById("albBack"));
      await wait(350);
    }

    clickEl(doc.getElementById("albBack"));
    await wait(600);
    check("再点返回关闭浏览页", !doc.getElementById("albumPage").classList.contains("open"));
  }

  /* 收藏（v0.56）：卡片爱心 → 照片字段 fav → 收藏夹集合收录 */
  {
    const card = doc.querySelector("#grid .card");
    check("卡片右上角有收藏爱心", !!(card && card.querySelector("[data-fav]")));
    if (card) {
      const id = card.dataset.id;
      const headers = TOKEN ? { "X-Auth-Token": TOKEN } : {};
      clickEl(card.querySelector("[data-fav]"));
      await wait(700);
      const after = doc.querySelector(`#grid .card[data-id="${id}"]`);
      check("点爱心后卡片进入已收藏态", !!after && after.classList.contains("fav"), after ? after.className.replace(/\s+/g, " ").trim() : "卡片已重建");
      const favN = window.__setPhotoIds ? window.__setPhotoIds("__fav").length : -1;
      check("「收藏夹」集合收录该图", favN === 1, `收藏夹 ${favN} 张`);
      const one = await (await fetch(`${BASE}/api/photos/${id}?_=${Math.random()}`, { headers })).json();
      check("收藏已写入照片字段（跟着图走）", !!one.photo && one.photo.fav === true, `fav=${one.photo && one.photo.fav}`);

      const card2 = doc.querySelector(`#grid .card[data-id="${id}"]`);
      if (card2) {
        clickEl(card2.querySelector("[data-fav]"));
        await wait(700);
        const favN2 = window.__setPhotoIds ? window.__setPhotoIds("__fav").length : -1;
        const one2 = await (await fetch(`${BASE}/api/photos/${id}?_=${Math.random()}`, { headers })).json();
        check("再点一次取消收藏", favN2 === 0 && !!one2.photo && one2.photo.fav === false, `收藏夹 ${favN2} 张，fav=${one2.photo && one2.photo.fav}`);
      }
    }
  }

  /* v0.60：长按卡片激活多选（触屏手势） */
  {
    const gridEl = doc.getElementById("grid");
    const mkT = (type, x, y) => {
      const ev = new window.Event(type, { bubbles: true });
      ev.changedTouches = [{ clientX: x, clientY: y }];
      ev.touches = [{ clientX: x, clientY: y }];
      return ev;
    };
    const selMode = () => doc.body.classList.contains("select-mode");
    const selIds = () => (window.__selectionState ? window.__selectionState().ids : []);
    const card1 = doc.querySelector("#grid .card");
    if (gridEl && card1) {
      const id = card1.dataset.id;

      // 1) 按住不动 → 进入多选并选中这张
      card1.dispatchEvent(mkT("touchstart", 100, 300));
      await wait(700);
      card1.dispatchEvent(mkT("touchend", 100, 300));
      await wait(200);
      check("长按卡片激活多选", selMode() && !doc.getElementById("batchBar").hidden, `body=${doc.body.className}`);
      check("长按的那张已被选中", selIds().includes(id), JSON.stringify(selIds()));

      // 2) 长按后紧随的 click 被吃掉，不会打开灯箱
      const lbBoxNow = doc.getElementById("lightbox");
      card1.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await wait(300);
      check("长按后的点击不会顺带打开灯箱", !lbBoxNow.classList.contains("open"));

      // 3) 退出多选
      const cancelBtn = doc.getElementById("batchCancel");
      if (cancelBtn) clickEl(cancelBtn);
      await wait(300);
      check("退出多选", !selMode() && selIds().length === 0, `body=${doc.body.className}`);

      // 4) 长按期间滑动 = 滚动，不该激活多选
      card1.dispatchEvent(mkT("touchstart", 100, 300));
      await wait(150);
      card1.dispatchEvent(mkT("touchmove", 170, 300)); // 挪 70px
      await wait(700);
      card1.dispatchEvent(mkT("touchend", 170, 300));
      check("长按期间滑动不会激活多选", !selMode(), `body=${doc.body.className}`);

      // 5) 多选模式下再长按不重复触发，正常单击 = 勾选
      doc.getElementById("fabSelectBtn").click();
      await wait(200);
      const before = selIds().length;
      card1.dispatchEvent(mkT("touchstart", 100, 300));
      await wait(700);
      card1.dispatchEvent(mkT("touchend", 100, 300));
      check("多选模式下长按不重复触发", selIds().length === before, `${before} → ${selIds().length}`);
      window.__exitSelectMode && window.__exitSelectMode();
      await wait(250);

      // 6) v0.61：桌面鼠标按住不动 600ms 也进多选
      const card3 = doc.querySelector("#grid .card");
      card3.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 100, clientY: 300 }));
      await wait(900);
      card3.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true, clientX: 100, clientY: 300 }));
      await wait(150);
      check("鼠标按住不动也能进多选", selMode() && selIds().length === 1, JSON.stringify(selIds()));
      window.__exitSelectMode && window.__exitSelectMode();
      await wait(250);

      // 7) 按下后立刻移动（= 拖拽手势）不该触发长按 —— 两者互斥
      card3.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 100, clientY: 300 }));
      await wait(100);
      card3.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 240, clientY: 340 }));
      await wait(800);
      card3.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
      check("鼠标移动超过阈值不触发长按（与拖拽互斥）", !selMode(), `body=${doc.body.className}`);
    }
  }

  /* v0.61/v0.62：双击 FAB 主按钮切换「循环滚动」（滚到底回到第一张） */
  {
    const fabMain = doc.getElementById("fabMain");
    const inf = () => (window.__infiniteState ? window.__infiniteState() : { wanted: null, active: null });
    /* v1.13：图库现在默认方格，而循环滚动只在瀑布流下生效 —— 先切到瀑布流再测 */
    const gEl = doc.getElementById("grid");
    const lbtn = doc.getElementById("fabLayoutBtn");
    const toMasonry = async () => {
      if (gEl && lbtn && gEl.classList.contains("grid-square")) { clickEl(lbtn); await wait(600); }
    };
    const toSquare = async () => {
      if (!gEl || !lbtn) return;
      const sq = window.__layoutMode ? window.__layoutMode() === "square" : gEl.classList.contains("grid-square");
      if (!sq) { clickEl(lbtn); await wait(600); }
    };
    await toMasonry();
    const dbl = async () => {
      fabMain.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
      fabMain.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); // 第一次单击：展开菜单
      await wait(80);
      fabMain.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0 })); // 判定为双击
      fabMain.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); // 这次 click 被吃掉
      await wait(350);
    };
    check("初始未开启循环滚动", inf().wanted === false, JSON.stringify(inf()));
    check("主按钮标题给出双击提示", /双击/.test(fabMain.title), fabMain.title);

    await dbl();
    check("双击菜单按钮开启循环滚动", inf().wanted === true, JSON.stringify(inf()));
    check("开启后主按钮点亮（.inf）", fabMain.classList.contains("inf"));
    const totalN = window.__galleryState ? window.__galleryState().filtered : -1;
    const slabs = [...doc.querySelectorAll("#grid .loop-slab")];
    check("循环模式渲染两份复本（首尾无缝的前提）", slabs.length === 2, `${slabs.length} 份`);
    check("外层 grid 切到分列模式（不再用 CSS columns）", doc.getElementById("grid").classList.contains("looping"));
    const cols0 = slabs[0] ? [...slabs[0].querySelectorAll(".loop-col")] : [];
    const cols1 = slabs[1] ? [...slabs[1].querySelectorAll(".loop-col")] : [];
    check("循环模式按列容器分列", cols0.length > 0, `${cols0.length} 列`);
    check("两份的列结构完全一致（无缝平移的前提）",
      cols0.length > 0 && cols0.length === cols1.length
        && cols0.every((c, i) => c.querySelectorAll(".card").length === cols1[i].querySelectorAll(".card").length),
      `${cols0.map((c) => c.querySelectorAll(".card").length).join("/")} vs ${cols1.map((c) => c.querySelectorAll(".card").length).join("/")}`);
    const perSlab = slabs[0] ? slabs[0].querySelectorAll(".card").length : 0;
    check("瀑布流下每份都渲染全部结果", perSlab === Math.min(totalN, 600), `每份 ${perSlab} / 共 ${totalN}`);
    check("两份内容完全一致", !!slabs[1] && slabs[1].querySelectorAll(".card").length === perSlab,
      `${perSlab} vs ${slabs[1] ? slabs[1].querySelectorAll(".card").length : "-"}`);
    check("循环滚动时不显示分批进度条", doc.getElementById("loadMore").style.display === "none");
    // v0.62：切换只换渲染策略，不重播图库的入场动画（卡片直接点亮、无过渡延迟）
    const afterCards = [...doc.querySelectorAll("#grid .card")];
    check("切换时不重播入场动画（卡片已全部点亮）",
      afterCards.length > 0 && afterCards.every((c) => c.classList.contains("visible")),
      `${afterCards.filter((c) => c.classList.contains("visible")).length}/${afterCards.length} 已点亮`);
    check("切换时卡片没有过渡延迟（无 stagger）",
      afterCards.every((c) => c.style.transitionDelay === "0s"),
      afterCards[0] ? `delay="${afterCards[0].style.transitionDelay}"` : "");

    /* v0.64：无缝循环 = 首尾复本 + 平移「一份的高度」（不是瞬移回顶部） */
    if (slabs.length === 2) {
      const origScrollTo = window.scrollTo;
      let scrollArg = null;
      window.scrollTo = (arg) => { scrollArg = arg; };
      // 造几何：第一份的文档位置 100、第二份 3100 → 一份高 3000（rect 随 scrollY 变化）
      const fakeRect = (docTop) => () => {
        const y = window.scrollY || 0;
        return { top: docTop - y, bottom: docTop - y + 100, left: 0, right: 0, width: 0, height: 100, x: 0, y: docTop - y, toJSON() { return this; } };
      };
      slabs[0].getBoundingClientRect = fakeRect(100);
      slabs[1].getBoundingClientRect = fakeRect(3100);
      Object.defineProperty(window, "scrollY", { value: 3500, configurable: true });
      window.dispatchEvent(new window.Event("scroll"));
      await wait(350);
      check("滚进第二份时只平移「一份的高度」（画面不变，用户无感）",
        scrollArg !== null && (scrollArg === 500 || scrollArg.top === 500),
        `scrollTo(${JSON.stringify(scrollArg)})　期望 500 = 3500 − 3000`);

      // 还在第一份里 → 不动
      scrollArg = null;
      Object.defineProperty(window, "scrollY", { value: 800, configurable: true });
      window.dispatchEvent(new window.Event("scroll"));
      await wait(350);
      check("还在第一份里时不会动滚动位置", scrollArg === null, JSON.stringify(scrollArg));

      // 大跨度（拖滚动条）：一次就折回正确位置，不会连续抖
      scrollArg = null;
      Object.defineProperty(window, "scrollY", { value: 9300, configurable: true }); // 跨过 2 份
      window.dispatchEvent(new window.Event("scroll"));
      await wait(350);
      check("大幅跳跃也能一次折回第一份内",
        scrollArg !== null && (scrollArg.top >= 100 && scrollArg.top < 3100),
        `scrollTo(${JSON.stringify(scrollArg)})　期望落在 100~3099`);

      window.scrollTo = origScrollTo;
      Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
      delete slabs[0].getBoundingClientRect;
      delete slabs[1].getBoundingClientRect;
    }

    await dbl();
    check("再双击关闭循环滚动", inf().wanted === false, JSON.stringify(inf()));
    check("关闭后主按钮取消点亮", !fabMain.classList.contains("inf"));
    await toSquare(); // v1.13：测完切回方格，后面的用例按默认方格继续
  }

  /* v0.65：批量条上的「⚑ 分级」—— 给选中的多张一次性设置分级 */
  {
    const btnRating = doc.getElementById("batchRating");
    check("批量条有「分级」按钮", !!btnRating);
    if (btnRating) {
      const headers = TOKEN ? { "X-Auth-Token": TOKEN } : {};
      doc.getElementById("fabSelectBtn").click();
      await wait(250);
      const cards = [...doc.querySelectorAll("#grid .card")].slice(0, 2);
      const ids = cards.map((c) => c.dataset.id);
      // 记下原分级：测完按原值还原，别把 seed 的 R16 / R18 洗成大众级
      const origRatings = [];
      for (const id of ids) {
        const d = await (await fetch(`${BASE}/api/photos/${id}?_=${Math.random()}`, { headers })).json();
        origRatings.push((d.photo && d.photo.rating) || "general");
      }
      for (const c of cards) clickEl(c);
      await wait(250);
      const selN = window.__selectionState ? window.__selectionState().ids.length : -1;
      check("已选中 2 张", selN === 2, `${selN} 张`);

      clickEl(btnRating);
      await wait(300);
      const modal = doc.getElementById("batchRatingModal");
      check("点「分级」打开档位选择", !!modal && modal.classList.contains("open"));
      check("弹窗里有三个档位", doc.querySelectorAll("#btRatingPicks .rating-pick").length === 3);

      const pick18 = doc.querySelector('#btRatingPicks .rating-pick[data-rating="r18"]');
      if (pick18) {
        clickEl(pick18);
        await wait(1500);
        const states = [];
        for (const id of ids) {
          const d = await (await fetch(`${BASE}/api/photos/${id}?_=${Math.random()}`, { headers })).json();
          states.push(d.photo && d.photo.rating);
        }
        check("选中的图片都被设为 R18", states.length === 2 && states.every((r) => r === "r18"), JSON.stringify(states));
        check("应用后弹窗自动关闭", !!modal && !modal.classList.contains("open"));

        // 按原值还原
        for (let i = 0; i < ids.length; i++) {
          await fetch(`${BASE}/api/photos/${ids[i]}`, {
            method: "PATCH",
            headers: Object.assign({ "Content-Type": "application/json" }, headers),
            body: JSON.stringify({ rating: origRatings[i] }),
          });
        }
        await wait(250);
        if (window.__reloadData) await window.__reloadData();
        if (window.__refreshGallery) window.__refreshGallery();
        await wait(400);
      }
      window.__exitSelectMode && window.__exitSelectMode();
      await wait(300);
    }
  }

  /* v0.71：批量加标签后**立即**生效（不再整页重拉，不需要刷新） */
  {
    const tap = (el) => el && el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    tap(doc.getElementById("fabSelectBtn"));
    await wait(250);
    // 选标签最少的 2 张：卡片上最多只显示 3 个标签 chip，选多的会看不到新标签
    const cards = [...doc.querySelectorAll("#grid .card")]
      .sort((a, b) => a.querySelectorAll(".card__tags .tg").length - b.querySelectorAll(".card__tags .tg").length)
      .slice(0, 2);
    const ids = cards.map((c) => c.dataset.id);
    const origTags = cards.map((c) => [...c.querySelectorAll(".card__tags .tg")].map((x) => x.textContent.trim()));
    for (const c of cards) tap(c);
    await wait(250);
    check("批量加标签前已选中 2 张", (window.__selectionState ? window.__selectionState().ids.length : -1) === 2);

    const newTag = "即时标签" + Math.random().toString(36).slice(2, 5);
    tap(doc.getElementById("batchTag"));
    await wait(350);
    const inp = doc.getElementById("btTagInput");
    if (inp) {
      inp.value = newTag;
      inp.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await wait(250);
    }
    tap(doc.getElementById("btOk"));
    await wait(1600); // 只等请求，不重新加载页面/数据
    const after = [...doc.querySelectorAll("#grid .card")].filter((c) => ids.includes(c.dataset.id));
    const hit = after.filter((c) => (c.querySelector(".card__tags") || {}).textContent?.includes(newTag)).length;
    check("批量加标签后卡片立即显示新标签（无需刷新）", after.length === 2 && hit === 2, `${hit}/${after.length} 张已显示`);
    check("批量加标签后仍停在原列表（没被整页重载）", doc.querySelectorAll("#grid .card").length > 2,
      `${doc.querySelectorAll("#grid .card").length} 张卡片`);

    // 还原标签，别污染后续断言
    const headers2 = TOKEN ? { "X-Auth-Token": TOKEN } : {};
    for (let i = 0; i < ids.length; i++) {
      await fetch(`${BASE}/api/photos/${ids[i]}`, {
        method: "PATCH",
        headers: Object.assign({ "Content-Type": "application/json" }, headers2),
        body: JSON.stringify({ tags: origTags[i] }),
      });
    }
    await wait(200);
    if (window.__reloadData) await window.__reloadData();
    if (window.__refreshGallery) window.__refreshGallery();
    await wait(400);
  }

  /* v0.71/v0.72：正方形网格下的「日期全选」—— 只在批量选择模式里出现 */
  {
    const tap = (el) => el && el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const layoutBtn = doc.getElementById("fabLayoutBtn");
    const gridEl = doc.getElementById("grid");
    if (gridEl && !gridEl.classList.contains("grid-square")) { tap(layoutBtn); await wait(600); }
    check("正方形网格里存在日期全选入口（DOM）", !!doc.querySelector("#grid .day-pick"));
    // v0.72：按钮默认 display:none，只有 body.select-mode 才露出来 —— jsdom 不加载外部 CSS，用样式文本校验
    check("CSS：全选按钮默认隐藏、只在批量选择模式显示",
      /\.grid-group \.day-pick \{[^}]*display:\s*none/.test(cssText) &&
      /body\.select-mode[^{]*\.grid-group \.day-pick \{[^}]*display:\s*inline-block/.test(cssText));

    // 先进入批量选择模式，再点全选（真实使用路径）
    tap(doc.getElementById("fabSelectBtn"));
    await wait(300);
    const pickBtn = doc.querySelector("#grid .day-pick");
    if (pickBtn) {
      tap(pickBtn);
      await wait(450);
      const selN = window.__selectionState ? window.__selectionState().ids.length : -1;
      const hiN = doc.querySelectorAll("#grid .card.sel").length;
      check("多选模式下点日期全选，选中这一天的图片", selN > 0, `${selN} 张`);
      check("对应的卡片都变成选中态", hiN === selN, `高亮 ${hiN} / 选中 ${selN}`);
    }
    window.__exitSelectMode && window.__exitSelectMode();
    await wait(300);
    check("退出多选后全选按钮隐藏（body 无 select-mode）", !doc.body.classList.contains("select-mode"));
    // v1.13：测完切回方格（现在默认就是方格，后面的用例都按方格跑）
    if (gridEl && !gridEl.classList.contains("grid-square")) { tap(layoutBtn); await wait(600); }
  }

  /* v0.73：鼠标按住向左拖 = 批量选择（框选划过） */
  {
    const selIds = () => (window.__selectionState ? window.__selectionState().ids : []);
    window.__exitSelectMode && window.__exitSelectMode();
    await wait(250);
    const cards = [...doc.querySelectorAll("#grid .card")];
    const cardA = cards[0];
    const cardB = cards[1];
    if (cardA && cardB) {
      // 先确认向右拖不会误触发（那个方向留给「拖到标签组打标」）
      cardA.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 400, clientY: 300 }));
      await wait(60);
      window.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 520, clientY: 300 }));
      await wait(200);
      check("向右拖动不会触发框选（留给拖拽打标）", !doc.body.classList.contains("select-mode"));
      window.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
      await wait(150);

      // 按住向左拖 → 进入批量选择，起点先选上
      cardA.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 400, clientY: 300 }));
      await wait(60);
      window.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 290, clientY: 300 }));
      await wait(220);
      check("按住左滑进入批量选择", doc.body.classList.contains("select-mode"), `body=${doc.body.className}`);
      check("起点那张已被选中", selIds().includes(cardA.dataset.id), JSON.stringify(selIds()));

      // 划过第二张 → 加选
      const origEFP = doc.elementFromPoint;
      doc.elementFromPoint = () => cardB;
      window.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 240, clientY: 302 }));
      await wait(250);
      check("划过（向左拖经过）的卡片被加选", selIds().includes(cardB.dataset.id), JSON.stringify(selIds()));
      doc.elementFromPoint = origEFP;

      window.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
      await wait(200);
      check("松手后不会顺手打开灯箱", !doc.getElementById("lightbox").classList.contains("open"));
      window.__exitSelectMode && window.__exitSelectMode();
      await wait(250);
    }
  }

  /* v0.74：排序菜单 —— 点击 / 滚轮切换方向；v0.90 删掉「主分类在前 / 标签在前」只剩两项 */
  {
    const sortBtn = doc.getElementById("fabSortBtn");
    const sortMenu = doc.getElementById("sortMenu");
    if (sortBtn && sortMenu) {
      const items = [...sortMenu.querySelectorAll(".page-menu-item")];
      check("排序菜单有 2 项（time/size）", items.length === 2 && items.every((i) => ["time", "size"].includes(i.dataset.sort)),
        items.map((i) => i.dataset.sort).join(","));
      check("排序菜单不再有「主分类在前 / 标签在前」", !items.some((i) => i.dataset.sort === "tag") && !/主分类在前|标签在前/.test(sortMenu.textContent));
      const timeItem = items.find((i) => i.dataset.sort === "time");
      const sizeItem = items.find((i) => i.dataset.sort === "size");
      // 初始：time 选中、降序
      check("默认选中时间排序（降序）", timeItem.classList.contains("on"));
      // 再点 time → 切换为升序
      timeItem.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await wait(80);
      check("再点时间切换为升序（localStorage time|asc）", window.localStorage.getItem("rn_sort") === "time|asc", window.localStorage.getItem("rn_sort") || "(空)");
      // 点 size → 选中且默认降序
      sizeItem.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await wait(80);
      check("点大小选中且默认降序（size|desc）", sizeItem.classList.contains("on") && !timeItem.classList.contains("on") && window.localStorage.getItem("rn_sort") === "size|desc", window.localStorage.getItem("rn_sort") || "(空)");
      // 再点 size → 升序
      sizeItem.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await wait(80);
      check("再点大小切换为升序（size|asc）", window.localStorage.getItem("rn_sort") === "size|asc", window.localStorage.getItem("rn_sort") || "(空)");
      // 滚轮在 time 项上 → 选中并回到降序（未选中项滚轮 = 选中默认方向）
      timeItem.dispatchEvent(new window.WheelEvent("wheel", { bubbles: true, deltaY: 120 }));
      await wait(80);
      check("滚轮触发时间项选中并回到降序（time|desc）", timeItem.classList.contains("on") && window.localStorage.getItem("rn_sort") === "time|desc", window.localStorage.getItem("rn_sort") || "(空)");
      window.localStorage.removeItem("rn_sort"); // 清理，不污染后续断言
    }
  }

  /* v0.91：画布墙 —— 方格铺满无限画布，单击就地放大，双击开灯箱
     v1.08：入口从 FAB 页面菜单挪到图库顶部的「照片墙」按钮 */
  {
    const wallItem = doc.getElementById("fabWallBtn");
    check("悬浮按钮上方有「照片墙」入口", !!wallItem);
    check("页面菜单里不再有画布墙项", !doc.querySelector('#pageMenu [data-page="wall"]'));
    if (wallItem) {
      clickEl(wallItem);
      await wait(700);
      const wallPage = doc.getElementById("wallPage");
      const st0 = window.__wallState ? window.__wallState() : null;
      check("打开画布墙并铺出照片", !!wallPage && wallPage.classList.contains("open") && !!st0 && st0.tiles > 0,
        st0 ? `${st0.tiles} 张在画布上 / 共 ${st0.photos} 张` : "无状态");
      const tile = doc.querySelector("#wallPlane .wall-tile[data-id]");
      const tileImg = tile && tile.querySelector("img");
      check("画布墙用的是缩略图", !!tileImg && /\/thumb(\?|$)/.test(tileImg.src || ""), tileImg ? tileImg.src.slice(0, 60) : "无");
      // v0.97：默认方格（正方形、部分随机放大）；切一下才是瀑布流
      {
        const st = window.__wallState();
        check("画布墙默认是方格模式", st.view === "grid", `view=${st.view}`);
        const tiles = [...doc.querySelectorAll("#wallPlane .wall-tile")];
        const square = tiles.filter((t) => t.style.width === t.style.height).length;
        check("方格模式下照片是正方形", tiles.length > 0 && square === tiles.length, `${square}/${tiles.length}`);
        const bigTiles = tiles.filter((t) => t.classList.contains("big"));
        check("方格模式下有一些照片被随机放大（2×2）", bigTiles.length > 0 && bigTiles.every((t) => parseFloat(t.style.width) > 180),
          `${bigTiles.length} 张大图`);
        // v1.01：随机放大的那几张也必须能点小（以前点了没反应）
        const decorBig = bigTiles.find((t) => !t.classList.contains("expanded"));
        if (decorBig) {
          decorBig.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }));
          await wait(500);
          const after = [...doc.querySelectorAll("#wallPlane .wall-tile")].find((x) => x.dataset.id === decorBig.dataset.id);
          check("随机放大的照片点一下能缩回 1×1",
            !!after && after.style.width === "180px" && !after.classList.contains("big"),
            after ? `宽 ${after.style.width}` : "找不到该照片");
        }
        // v0.98：每块的最后一行也要补齐，否则块交界处会出现一条横贯全宽的黑带
        const gs = window.__wallGridStats ? window.__wallGridStats() : null;
        check("方格块的最后一行被补齐（交界处没有黑带）", !!gs && gs.filled === gs.cells,
          gs ? `${gs.filled}/${gs.cells} 格已填` : "无布局信息");
      }
      // 切到瀑布流：列宽统一、高度按原始比例
      {
        const vb = doc.getElementById("wallViewBtn");
        // v1.12：切换按钮只有图标，没有「瀑布 / 方格」文字
        check("画布墙有方格 / 瀑布流切换按钮（只有图标）",
          !!vb && !!vb.querySelector("svg") && !(vb.textContent || "").trim(),
          vb ? `图标 ${vb.querySelector("svg") ? "有" : "无"} · 文字「${(vb.textContent || "").trim()}」` : "无");
        if (vb) {
          clickEl(vb);
          await wait(600);
          const st = window.__wallState();
          const tiles = [...doc.querySelectorAll("#wallPlane .wall-tile")];
          const widths = new Set(tiles.map((t) => t.style.width));
          const heights = new Set(tiles.map((t) => t.style.height));
          check("切到瀑布流（view=masonry）", st.view === "masonry", `view=${st.view}`);
          // v1.07：瀑布流也会随机放大一些（372px 两列宽），其余仍是 180px
          check("瀑布流列宽只有 180 / 372 两种", [...widths].every((w) => w === "180px" || w === "372px"), [...widths].join("/"));
          check("瀑布流高度按原始比例各不相同", heights.size > 1, [...heights].slice(0, 4).join(" / "));
          // v0.96：块的下沿要齐 —— 每列尾部都补满，交界处不会出现横贯全宽的空带
          const cov = window.__wallCoverage ? window.__wallCoverage() : null;
          const worst = cov && cov.shortfalls.length ? Math.max(...cov.shortfalls) : 9999;
          check("瀑布流各列尾部补齐（块交界处没有大空档）", !!cov && worst < 130,
            cov ? `块高 ${cov.blockH}，各列尾部余量 ${cov.shortfalls.join("/")}` : "无布局信息");
          /* v1.11：照片不许被拉长 / 压扁 —— 每个格子的宽高比必须等于照片自己的显示比例
             （补位块是为了块底齐平硬裁的，不算） */
          const asp = window.__wallAspectInfo ? window.__wallAspectInfo() : null;
          check("瀑布流每个格子的比例 = 照片比例（不拉伸）", !!asp && asp.bad.length === 0,
            asp ? `${asp.items} 个格子，比例异常 ${asp.bad.length} 个` : "无布局信息");
          /* v1.11：手机照片带 EXIF 方向时，元数据里的宽高是颠倒的；
             图片加载完会报出真实尺寸，墙要按新比例自动重排，而不是把照片裁成一条 */
          {
            const raw0 = window.__wallLayoutRaw();
            const cell = raw0 && raw0.items.find((it) => !it.filler && it.w === 180);
            let fixed = false, desc = "无可用格子";
            if (cell && window.__wallNoteNatural) {
              const before = cell.h / cell.w;
              const swapped = Math.min(4, Math.max(0.2, 1 / before));
              window.__wallNoteNatural(cell.id, cell.h, cell.w); // 报一个「宽高互换」的真实尺寸
              await wait(520);
              const raw1 = window.__wallLayoutRaw();
              const after = raw1 && raw1.items.find((it) => it.id === cell.id);
              const now = after ? after.h / after.w : 0;
              fixed = Math.abs(now - swapped) < 0.06;
              desc = `${before.toFixed(2)} → ${now.toFixed(2)}（应为 ${swapped.toFixed(2)}）`;
            }
            check("照片报出真实尺寸（EXIF 宽高互换）后自动按正确比例重排", fixed, desc);
            const asp2 = window.__wallAspectInfo ? window.__wallAspectInfo() : null;
            check("纠正之后仍没有比例异常的格子", !!asp2 && asp2.bad.length === 0,
              asp2 ? `比例异常 ${asp2.bad.length} 个` : "无布局信息");
          }
          clickEl(vb); // 切回方格，后面按方格继续测
          await wait(600);
        }
      }
      // v0.96：块的下沿要齐 —— 每列尾部都补满（在瀑布流分支里已断言，这里不再重复）
      // 注意：上面切换过排布，旧的 tile 元素已经被重建 → 这里重新取一张（要挑普通小图，
      // 随机放大的那几张点下去是「缩小」，见前面的用例）
      const tile2 = doc.querySelector("#wallPlane .wall-tile[data-id]:not(.big)");
      if (tile2) {
        const tile = tile2;
        // v0.92：点开 = 布局重排（这张变两列宽，后面的照片被挤开），不是简单放大浮层
        const w0 = tile.style.width;
        const othersBefore = new Map([...doc.querySelectorAll("#wallPlane .wall-tile")]
          .filter((t) => t !== tile).map((t) => [t, t.style.left + "|" + t.style.top]));
        tile.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }));
        await wait(600);
        const stBig = window.__wallState();
        check("点一下就地放大（占两列宽）", tile.classList.contains("expanded") && stBig.expanded === tile.dataset.id && parseFloat(tile.style.width) > parseFloat(w0),
          `${w0} → ${tile.style.width}（expanded=${stBig.expanded} tileId=${tile.dataset.id} cls=${tile.className}）`);
        const moved = [...othersBefore].filter(([el, pos]) => el.isConnected && (el.style.left + "|" + el.style.top) !== pos).length;
        check("放大会把周围照片挤开（位置跟着变）", moved > 0, `${moved} 张被顺移`);
        tile.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }));
        await wait(600);
        check("再点一次收起、照片归位", !tile.classList.contains("expanded") && window.__wallState().expanded === null && tile.style.width === w0);
        /* v0.99：即使这张照片所在格子右边/下边被别的大图占了，点下去也必须能放大
           （以前会「点了没反应」——布局放不下 2×2 就直接跳过） */
        {
          let ok = 0, tried = 0;
          for (let i = 0; i < 6; i++) {
            // 每轮都重新取一张「当前还是小图」的（布局变化后旧元素可能已被虚拟化回收）
            const cand = [...doc.querySelectorAll("#wallPlane .wall-tile[data-id]")].find((t) => !t.classList.contains("big"));
            if (!cand) break;
            const id = cand.dataset.id;
            tried++;
            cand.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }));
            await wait(450);
            const st = window.__wallState();
            const el = [...doc.querySelectorAll("#wallPlane .wall-tile")].find((x) => x.dataset.id === id);
            // 放大后可能被挪出视野（元素被虚拟化回收），这时只要状态对就算成功
            if (st.expanded === id && (!el || parseFloat(el.style.width) > 180)) ok++;
            const back = [...doc.querySelectorAll("#wallPlane .wall-tile")].find((x) => x.dataset.id === id) || cand;
            back.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }));
            await wait(420);
          }
          check("任意一张照片点下去都能放大（放不下就往后挪）", tried > 0 && ok === tried, `${ok}/${tried} 成功`);
        }
        // 双击：第一下（detail 1）挂起的放大要被取消 → 图片不会有任何缩放，直接开灯箱
        const vpEl = doc.getElementById("wallViewport");
        vpEl.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); // 先点空白收掉可能残留的放大
        await wait(200);
        const dblTile = doc.querySelector("#wallPlane .wall-tile[data-id]");
        const sizeBeforeDbl = dblTile.style.width;
        const dblId = dblTile.dataset.id;
        dblTile.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }));
        dblTile.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 2 }));
        dblTile.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
        check("双击时挂起的「单击放大」已取消", window.__wallState().expanded === null);
        await wait(400);
        const lbNow = doc.getElementById("lightbox");
        check("双击打开灯箱", lbNow.classList.contains("open") && lbNow.dataset.cur === dblId, lbNow.dataset.cur || "(无)");
        check("双击过程中图片没有被放大 / 收起（宽度不变）",
          dblTile.style.width === sizeBeforeDbl, `宽度 ${sizeBeforeDbl} → ${dblTile.style.width}`);
        doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await wait(250);
        check("Esc 先关灯箱、画布墙还在", !lbNow.classList.contains("open") && doc.getElementById("wallPage").classList.contains("open"));
        // 拖动平移
        const before = window.__wallState();
        const vp = doc.getElementById("wallViewport");
        vp.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, clientX: 300, clientY: 300 }));
        window.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 240, clientY: 250 }));
        window.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
        await wait(200);
        const after = window.__wallState();
        check("拖动平移画布", after.x !== before.x || after.y !== before.y, `${before.x},${before.y} → ${after.x},${after.y}`);
        // 滚轮缩放
        vp.dispatchEvent(new window.WheelEvent("wheel", { bubbles: true, deltaY: -150, clientX: 400, clientY: 300 }));
        await wait(200);
        check("滚轮缩放画布", window.__wallState().scale !== 1, String(window.__wallState().scale));
        const back = doc.getElementById("wallBack");
        if (back) clickEl(back);
        await wait(450);
        check("返回按钮关闭画布墙", !doc.getElementById("wallPage").classList.contains("open"));
      }
    }
  }

  /* v0.75：筛选菜单修复 —— 位置移到主按钮上方 + 菜单内点击不误关 */
  {
    const tagMenuEl = doc.getElementById("tagMenu");
    const fabMainEl = doc.getElementById("fabMain");
    if (tagMenuEl && fabMainEl) {
      // CSS：tag-menu 应在主按钮正上方（right 与 fab-group 对齐 28px，不再是左分支的 216px）
      check("筛选菜单 CSS 定位到主按钮上方（right: 28px）", /\.tag-menu\s*\{[^}]*right:\s*28px/.test(cssText), (cssText.match(/\.tag-menu\s*\{[^}]*\}/) || ["(未找到)"])[0].replace(/\s+/g, " ").slice(0, 80));
      // 行为：菜单打开时点击内部元素（触发重渲染）不应导致菜单关闭
      const fabBtnEl = doc.getElementById("fabBtn");
      fabBtnEl.dispatchEvent(new window.MouseEvent("mouseenter", { bubbles: false }));
      await wait(50);
      const wasOpen = tagMenuEl.classList.contains("open");
      // 在菜单内派发 click（冒泡到 document），模拟组头点击后重渲染的场景
      const inner = doc.createElement("div");
      tagMenuEl.appendChild(inner);
      inner.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      inner.remove(); // 模拟 innerHTML 重渲染把 target 摘出 DOM
      await wait(50);
      check("菜单内点击（target 已脱离 DOM）不会误关菜单", wasOpen ? tagMenuEl.classList.contains("open") : true, `wasOpen=${wasOpen} now=${tagMenuEl.classList.contains("open")}`);
      // 清理
      tagMenuEl.classList.remove("open");
      fabBtnEl.classList.remove("open");
      doc.getElementById("fabGroup").classList.remove("active");
    }
  }
  /* 灯箱右下角悬浮工具条（v0.38）：工具条默认隐藏，鼠标在灯箱内移动才浮现；
     v0.81：新增 ⓘ 图片信息按钮，点开从底部上拉信息面板 */
  const lbInfoEl = doc.getElementById("lbInfo");
  check("灯箱有信息面板（默认收起）", !!lbInfoEl && !lbInfoEl.classList.contains("open"));
  check("灯箱工具条有收藏按钮（v0.56 归来）", !!doc.getElementById("lbToolFav"));
  const lbBox = doc.getElementById("lightbox");
  const lbBar = doc.getElementById("lbToolsFloat");
  const toolIds = ["lbToolPlay", "lbToolEdit", "lbToolRot", "lbToolDl", "lbToolFav", "lbToolInfo"];
  check("灯箱右下角悬浮工具条含 6 个按钮", !!lbBar && toolIds.every((i) => doc.getElementById(i)));
  check("工具条默认隐藏（无 tools-visible 类）", !!(lbBox && !lbBox.classList.contains("tools-visible")));
  check("筛选菜单不再有收藏行", !doc.querySelector('#tagMenuList [data-tag="__fav"]'));
  const firstCard = doc.querySelector("#grid .card");
  if (lbBox && lbBar && firstCard) {
    doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); // 退出可能残留的多选态
    await wait(150);
    clickEl(firstCard);
    await wait(350);
    check("打开灯箱后工具条仍隐藏", lbBox.classList.contains("open") && !lbBox.classList.contains("tools-visible"),
      `open=${lbBox.classList.contains("open")} tools=${lbBox.classList.contains("tools-visible")} select=${doc.body.classList.contains("select-mode")}`);
    lbBox.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 400, clientY: 300 }));
    await wait(100);
    check("鼠标移动后工具条浮现", lbBox.classList.contains("tools-visible"));
    /* v0.81：ⓘ → 底部上拉信息面板；Esc 只收面板，不关灯箱 */
    const infoBtn = doc.getElementById("lbToolInfo");
    if (infoBtn && lbInfoEl) {
      clickEl(infoBtn);
      await wait(200);
      const rowsN = lbInfoEl.querySelectorAll(".lb-info-row").length;
      check("点 ⓘ 展开信息面板且有内容", lbInfoEl.classList.contains("open") && rowsN >= 6, `${rowsN} 行`);
      const state = window.__lbInfoState ? window.__lbInfoState() : null;
      check("信息面板内容与当前图片对应", !!state && state.open === true && state.rows === rowsN, JSON.stringify(state));
      doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await wait(150);
      check("Esc 先收信息面板（灯箱还开着）", !lbInfoEl.classList.contains("open") && lbBox.classList.contains("open"));
    }
    // v0.43/0.44：切图 = 点图片左右半边 / 左右滑动；关闭 = 点图片外的空白（按钮全删了）
    check("灯箱不再有上一张 / 下一张 / 关闭按钮",
      !doc.querySelector(".lightbox .lb-prev") && !doc.querySelector(".lightbox .lb-next") && !doc.querySelector(".lightbox .lb-close"));
    const cur0 = lbBox.dataset.cur;
    const lbImgEl = doc.getElementById("lbImg");
    const clickAt = async (el, x) => {
      el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, clientX: x, clientY: 400 }));
      await wait(300);
      return lbBox.dataset.cur;
    };
    const w = window.innerWidth || 1024;
    const afterLeft = await clickAt(lbImgEl, Math.round(w * 0.35));
    check("点图片左半边切到上一张", !!afterLeft && afterLeft !== cur0, `${cur0} → ${afterLeft}`);
    const afterRight = await clickAt(lbImgEl, Math.round(w * 0.65));
    check("点图片右半边切回下一张", afterRight === cur0, `${afterLeft} → ${afterRight}`);
    // 左右滑动（移动端）：模拟 touch 事件
    const mkTouch = (type, x) => {
      const ev = new window.Event(type, { bubbles: true });
      ev.changedTouches = [{ clientX: x, clientY: 400 }];
      ev.touches = [{ clientX: x, clientY: 400 }];
      return ev;
    };
    lbBox.dispatchEvent(mkTouch("touchstart", Math.round(w * 0.7)));
    lbBox.dispatchEvent(mkTouch("touchend", Math.round(w * 0.2))); // 左滑 → 下一张
    await wait(300);
    check("左滑切到下一张", lbBox.dataset.cur !== cur0, `${cur0} → ${lbBox.dataset.cur}`);
    lbBox.dispatchEvent(mkTouch("touchstart", Math.round(w * 0.2)));
    lbBox.dispatchEvent(mkTouch("touchend", Math.round(w * 0.7))); // 右滑 → 上一张
    await wait(300);
    check("右滑切回上一张", lbBox.dataset.cur === cur0, `→ ${lbBox.dataset.cur}`);
    doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await wait(100);
    const playBtn = doc.getElementById("lbToolPlay");
    check("空格开始幻灯片（按钮切为暂停态）", !!playBtn && playBtn.classList.contains("playing"));
    doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await wait(100);
    check("再按空格停止幻灯片", !!playBtn && !playBtn.classList.contains("playing"));
    // v0.45：旋转只作用于灯箱预览（不保存原图），切换图片即复位
    const rotBtn = doc.getElementById("lbToolRot");
    if (rotBtn) {
      clickEl(rotBtn);
      await wait(250);
      check("点旋转 = 仅预览旋转 90°", /rotate\(90deg\)/.test(lbImgEl.style.transform || ""), `transform="${lbImgEl.style.transform}"`);
      await clickAt(lbImgEl, Math.round(w * 0.65)); // 切到下一张
      check("切换图片后旋转自动复位", !lbImgEl.style.transform, `transform="${lbImgEl.style.transform}"`);
    }
    // v0.47：桌面端滚轮缩放（只影响预览，切图复位）
    const makeWheel = (deltaY) => {
      const ev = new window.MouseEvent("wheel", { bubbles: true, cancelable: true, clientX: 500, clientY: 400 });
      Object.defineProperty(ev, "deltaY", { value: deltaY });
      return ev;
    };
    lbImgEl.dispatchEvent(makeWheel(-120));
    await wait(150);
    const zoomMatch = (lbImgEl.style.transform || "").match(/scale\(([\d.]+)\)/);
    check("滚轮向上放大图片", !!zoomMatch && parseFloat(zoomMatch[1]) > 1, `transform="${lbImgEl.style.transform}"`);
    for (let i = 0; i < 14; i++) lbImgEl.dispatchEvent(makeWheel(120));
    await wait(150);
    check("滚轮向下缩回 1×（适屏）", !/scale\(/.test(lbImgEl.style.transform || ""), `transform="${lbImgEl.style.transform}"`);
    lbImgEl.dispatchEvent(makeWheel(-120));
    await wait(120);
    await clickAt(lbImgEl, Math.round(w * 0.65));
    check("切换图片后缩放自动复位", !lbImgEl.style.transform, `transform="${lbImgEl.style.transform}"`);
    // v0.48：放大后按住拖动平移
    lbImgEl.dispatchEvent(makeWheel(-120));
    await wait(120);
    const curBeforePan = lbBox.dataset.cur;
    lbImgEl.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, clientX: 500, clientY: 400 }));
    window.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 560, clientY: 430 }));
    await wait(150);
    const panTf = lbImgEl.style.transform || "";
    check("放大后按住拖动 = 平移图片", /translate\(/.test(panTf), `transform="${panTf}"`);
    window.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
    await wait(150);
    check("拖动松手不会顺手切图", lbBox.dataset.cur === curBeforePan, `${curBeforePan} → ${lbBox.dataset.cur}`);
    check("拖动结束后图片仍在放大状态", /scale\(/.test(lbImgEl.style.transform || ""));
    // 缩回 1× 时平移一起清零
    for (let i = 0; i < 14; i++) lbImgEl.dispatchEvent(makeWheel(120));
    await wait(150);
    check("缩回 1× 后平移量清零", !/translate\(/.test(lbImgEl.style.transform || ""), `transform="${lbImgEl.style.transform}"`);
    // 移动端：放大后触摸拖动 = 平移（不再是切图）
    lbImgEl.dispatchEvent(makeWheel(-120));
    await wait(120);
    const curBeforeTouchPan = lbBox.dataset.cur;
    lbImgEl.dispatchEvent(mkTouch("touchstart", 400));
    lbBox.dispatchEvent(mkTouch("touchmove", 470));
    await wait(150);
    check("放大后触摸拖动 = 平移图片", /translate\(/.test(lbImgEl.style.transform || ""), `transform="${lbImgEl.style.transform}"`);
    lbBox.dispatchEvent(mkTouch("touchend", 470));
    await wait(150);
    check("触摸拖动结束不切图", lbBox.dataset.cur === curBeforeTouchPan, `${curBeforeTouchPan} → ${lbBox.dataset.cur}`);
    // v0.44：点图片以外的空白 → 关闭灯箱（拖动后有 400ms 防误触抑制，先等一下）
    await wait(450);
    lbBox.dispatchEvent(new window.MouseEvent("click", { bubbles: true, clientX: Math.round(w * 0.5), clientY: 60 }));
    await wait(300);
    check("点空白关闭灯箱并收起工具条", !lbBox.classList.contains("open") && !lbBox.classList.contains("tools-visible"));
  }
  if (firstCard) {
    firstCard.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 2 }));
    await wait(400);
    const editModal = doc.getElementById("editModal");
    check("双击卡片打开编辑弹窗", !!editModal && editModal.classList.contains("open"));
    // v0.41：描述字段整体移除
    check("编辑弹窗不再有描述输入", !doc.getElementById("edDesc") && !doc.querySelector(".modal-mask #edDesc"));
    check("上传项编辑弹窗不再有描述输入", !doc.getElementById("uqDesc"));
    check("搜索框文案不含描述", !/描述/.test((doc.getElementById("searchInput") || {}).placeholder || ""));
    /* v0.88：标签建议下拉只在开始输入后才出现（空输入时不弹） */
    if (editModal && editModal.classList.contains("open")) {
      const edInp = doc.getElementById("edTagInput");
      const edSug = doc.getElementById("edTagSuggest");
      check("编辑弹窗有标签输入框与建议容器", !!edInp && !!edSug);
      if (edInp && edSug) {
        edInp.dispatchEvent(new window.Event("focus"));
        await wait(80);
        check("空输入时建议下拉不出现", edSug.hidden === true);
        edInp.value = "冒烟";
        edInp.dispatchEvent(new window.Event("input", { bubbles: true }));
        await wait(120);
        check("开始输入后才弹建议下拉", edSug.hidden === false && edSug.querySelectorAll(".ts-item").length > 0,
          `${edSug.querySelectorAll(".ts-item").length} 条`);
        edInp.value = "";
        edInp.dispatchEvent(new window.Event("input", { bubbles: true }));
        await wait(80);
        check("清空输入后建议下拉收起", edSug.hidden === true);
      }
    }
    if (editModal && editModal.classList.contains("open")) {
      const cancel = doc.getElementById("edCancel");
      if (cancel) clickEl(cancel);
      await wait(200);
    }
  }

  /* 标签改名后界面立即更新（v0.31）——用一次性临时标签，写完就删，避免动到真实标签 */
  const uniq = "zz测试" + Math.random().toString(36).slice(2, 6);
  const renamedName = uniq + "改";
  const clickBtn = (el) => el && el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const pillEditByName = (nm) => [...doc.querySelectorAll("#tagMgrRoot .tmgr-pill .act[data-tact='edit']")].find((b) => b.dataset.tname === nm);

  const newTagBtn = doc.getElementById("btnNewTag");
  if (newTagBtn) {
    clickBtn(newTagBtn);
    await wait(300);
    const n1 = doc.querySelector("#tagModalBody #fName");
    const s1 = doc.querySelector("#tagModalBody #fSave");
    if (n1 && s1) { n1.value = uniq; clickBtn(s1); await wait(1500); }
    window.__refreshTagManager();
    await wait(300);
    check("新建的未分组标签能在分组视图看到", !!pillEditByName(uniq), uniq);
    const editBtn = pillEditByName(uniq);
    if (editBtn) {
      clickBtn(editBtn);
      await wait(300);
      const n2 = doc.querySelector("#tagModalBody #fName");
      const s2 = doc.querySelector("#tagModalBody #fSave");
      if (n2 && s2) {
        n2.value = renamedName;
        const t0 = Date.now();
        clickBtn(s2);
        // 轮询等本地渲染（线上要发两个请求，给足 4s；若走"等服务端重读"的老路会因 Blobs 延迟远超这个时间）
        let shown = false;
        while (Date.now() - t0 < 4000) {
          if (pillEditByName(renamedName)) { shown = true; break; }
          await wait(200);
        }
        const errEl = doc.querySelector("#tagModalBody #fErr");
        const stillOpen = doc.getElementById("tagModal").classList.contains("open");
        console.log(`   弹窗仍打开：${stillOpen}　提示：${errEl && errEl.style.display !== "none" ? errEl.textContent : "(无)"}`);
        check("改名后界面立即更新（不等服务端）", shown, `耗时 ${Date.now() - t0}ms`);
      }
      // 清理：删除这个临时标签（线上要等两个请求回来，轮询确认）
      window.__refreshTagManager();
      await wait(300);
      const delBtn = [...doc.querySelectorAll("#tagMgrRoot .tmgr-pill .act[data-tact='remove']")].find((b) => b.dataset.tname === renamedName);
      if (delBtn) {
        clickBtn(delBtn);
        await wait(400);
        const confirm = doc.querySelector("#tagModalBody #fConfirm");
        if (confirm) clickBtn(confirm);
        let cleaned = false;
        const t1 = Date.now();
        while (Date.now() - t1 < 5000) {
          if (!pillEditByName(renamedName)) { cleaned = true; break; }
          await wait(200);
        }
        check("临时标签已清理", cleaned);
      }
      closeModal(); // 万一还开着，关掉以免影响后续断言
      await wait(200);
    }
  }

  /* 组头旁「＋」= 直接在该组新建标签，所属组预选（v0.30） */
  window.__refreshTagManager(); // 先刷新，确保取到带事件监听的最新元素
  await wait(300);
  const gnewBtn = doc.querySelector("#tagMgrRoot [data-gnew]");
  check("组头有「＋」新建标签入口", !!gnewBtn);
  if (gnewBtn) {
    const gid = gnewBtn.dataset.gnew;
    // 上一个弹窗若还没关干净，openTagModal 会被拦下 —— 先确保关闭
    if (doc.getElementById("tagModal").classList.contains("open")) { closeModal(); await wait(400); }
    gnewBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await wait(300);
    const sel = doc.querySelector("#tagModalBody #fGroup");
    const t = modalTitle();
    check("「＋」打开新建标签弹窗", doc.getElementById("tagModal").classList.contains("open") && t.includes("新建标签"), t);
    check("所属组已预选", !!sel && sel.value === gid, sel ? `选中=${sel.value || "(未分组)"}` : "无组选择框");
    /* v0.78：所属组改成自定义下拉（原生 select 做不了毛玻璃 / 滚动） */
    const gsBtn = doc.querySelector("#tagModalBody .gs-btn");
    const gsMenu = doc.querySelector("#tagModalBody .gs-menu");
    check("所属组是自定义下拉组件", !!gsBtn && !!gsMenu);
    if (gsBtn && gsMenu) {
      gsBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await wait(150);
      const items = [...gsMenu.querySelectorAll(".gs-item")];
      check("点开所属组下拉", gsMenu.classList.contains("open"), `${items.length} 个选项`);
      const pick = items[1] || items[0];
      if (pick) {
        pick.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        await wait(150);
        check("选择后写回 #fGroup 并收起", sel.value === (pick.dataset.gid || "") && !gsMenu.classList.contains("open"),
          `${sel.value || "(未分组)"}`);
      }
    }
    closeModal();
    await wait(200);
  }

  /* 展示方式切换（v0.46 / v1.13）：默认正方形网格，切换后不写 localStorage（刷新回到方格） */
  const layoutBtn = doc.getElementById("fabLayoutBtn");
  const gridEl = doc.getElementById("grid");
  check("FAB 分支有展示方式切换按钮", !!layoutBtn && !!gridEl);
  if (layoutBtn && gridEl) {
    const before = gridEl.classList.contains("grid-square");
    clickEl(layoutBtn);
    await wait(400);
    const afterFirst = gridEl.classList.contains("grid-square");
    check("点一下切换展示方式", afterFirst !== before, `${before ? "方格" : "瀑布流"} → ${afterFirst ? "方格" : "瀑布流"}`);
    check("切换后卡片仍在（布局变化不影响渲染）", doc.querySelectorAll("#grid .card").length > 0);
    check("展示方式不写 localStorage（每次刷新都回到方格）",
      window.localStorage.getItem("rn_layout") === null && window.__layoutMode() === (afterFirst ? "square" : "masonry"),
      `rn_layout=${window.localStorage.getItem("rn_layout")} mode=${window.__layoutMode()}`);
    clickEl(layoutBtn);
    await wait(400);
    check("再点一下切回原样", gridEl.classList.contains("grid-square") === before);
  }
  /* v1.13：卡片用小图变体 + 首屏立刻加载（打开图库不等懒加载） */
  {
    const imgs = [...doc.querySelectorAll("#grid .card > img")];
    const first = imgs[0];
    check("卡片图片用小图变体（?w=480）", !!first && /\?w=480|&w=480/.test(first.getAttribute("src") || ""),
      first ? (first.getAttribute("src") || "").split("?")[1] || "(无 query)" : "无卡片");
    check("首屏卡片立刻加载（前几张是 eager + high 优先级）",
      !!first && first.getAttribute("loading") === "eager" && first.getAttribute("fetchpriority") === "high",
      first ? `loading=${first.getAttribute("loading")} prio=${first.getAttribute("fetchpriority")}` : "无卡片");
  }

  /* ---------- 标签筛选 v0.55：多选 / 且或 / 排除 / 我的筛选 ----------
     seed 数据：18 张，「冒烟角色01」1 张、「冒烟角色02」2 张（第 1 张两个标签都带 → 有交集） */
  {
    const bar = doc.getElementById("tagFilterBar");
    const chipsBox = doc.getElementById("tfbChips");
    const gN = () => (window.__galleryState ? window.__galleryState().filtered : -1);
    const rowOf = (name) => doc.querySelector(`#tagMenuList [data-tag="${name}"]`);
    const catOf = (name) => doc.querySelector(`#tagMenuList [data-catf="${name}"]`);
    const chipKeys = () => [...chipsBox.querySelectorAll("[data-chip]")].map((el) => el.dataset.chip);
    const clearAll = async () => { const allRow = doc.querySelector('#tagMenuList [data-tag=""]'); if (allRow) clickEl(allRow); await wait(250); };

    const total = gN();
    check("筛选条默认收起（无条件时不占地方）", !!bar && bar.hidden === true, `全部 ${total} 张`);

    // v0.23 起大组默认折叠（折叠时标签行不进 DOM）—— 先点组头把组展开，再取标签行
    const headOf = (name) => [...doc.querySelectorAll("#tagMenuList .tag-group-head")].find((h) => (h.textContent || "").includes(name));
    const collapsedHead = doc.querySelector("#tagMenuList .tag-group-head.collapsed");
    check("大组默认折叠显示", !!collapsedHead);
    if (collapsedHead) {
      clickEl(collapsedHead);
      await wait(300);
      check("点组头可展开（重渲染补出标签行）", doc.querySelectorAll("#tagMenuList .tag-menu-item[data-tag]:not([data-tag=''])").length > 0,
        `${doc.querySelectorAll("#tagMenuList .tag-menu-item[data-tag]:not([data-tag=''])").length} 行`);
    }
    for (const h of [...doc.querySelectorAll("#tagMenuList .tag-group-head.collapsed")]) { clickEl(h); await wait(200); }

    const rowA = rowOf("冒烟角色01");
    const rowB = rowOf("冒烟角色02");
    check("菜单里有可组合筛选的标签行", !!rowA && !!rowB, headOf("冒烟测试作品") ? "「冒烟测试作品」组已展开" : "未找到测试组");

    if (rowA && rowB) {
      clickEl(rowA);
      await wait(300);
      const nA = gN();
      check("选中标签后筛选条出现且有 1 个条件", bar.hidden === false && chipKeys().length === 1, chipKeys().join(","));
      check("有筛选时 FAB 亮起小红点", doc.getElementById("fabDot").classList.contains("on"));

      clickEl(rowOf("冒烟角色02"));
      await wait(300);
      const nAB = gN();
      const st2 = window.__filterState();
      check("可以同时选中两个标签（多选，不再是互斥单选）", st2.tags.length === 2 && chipKeys().length === 2, `结果 ${nA} → ${nAB} 张`);
      check("默认「或」：多选后结果变大", nAB > nA, `${nA} → ${nAB} 张`);

      const opBtn = doc.getElementById("tfbTagOp");
      check("标签 ≥2 时出现「且 / 或」开关", !!opBtn && opBtn.hidden === false);
      clickEl(opBtn);
      await wait(300);
      const nAnd = gN();
      check("切到「且」后结果收窄为交集", nAnd > 0 && nAnd < nAB, `或 ${nAB} → 且 ${nAnd}`);
      clickEl(doc.getElementById("tfbTagOp"));
      await wait(300);
      check("再点切回「或」", gN() === nAB, `结果 ${gN()} 张`);

      // 排除：单标签 nB 张 → 排除后应剩 total - nB
      await clearAll();
      check("「全部」清空所有条件", window.__filterState().tags.length === 0 && bar.hidden === true, `结果 ${gN()} 张`);

      clickEl(rowOf("冒烟角色02"));
      await wait(300);
      const nB = gN();
      clickEl(doc.getElementById("tfbNeg"));
      await wait(150);
      clickEl(rowOf("冒烟角色02"));
      await wait(300);
      const st3 = window.__filterState();
      check("排除模式：点击的项目进入排除列表", st3.not.includes("tag:冒烟角色02") && st3.tags.length === 0, JSON.stringify(st3.not));
      check("排除后结果 = 全部 − 该标签命中数", gN() === total - nB, `${total} − ${nB} = ${total - nB}，实际 ${gN()}`);
      check("排除项在筛选条上以删除线 chip 呈现", !!chipsBox.querySelector(".tfb-chip.neg"));
      clickEl(doc.getElementById("tfbNeg"));
      await wait(150);
      await clearAll();

      // 主分类多选（层内 OR，与标签层 AND 叠加）
      const c1 = catOf("插画");
      const c2 = catOf("次元女");
      if (c1 && c2) {
        clickEl(c1);
        await wait(300);
        const n1 = gN();
        clickEl(catOf("次元女"));
        await wait(300);
        check("主分类也能多选（层内 OR）", window.__filterState().cats.length === 2 && gN() > n1, `插画 ${n1} → +次元女 ${gN()}`);
        await clearAll();
      }

      // 我的筛选：保存 → 一键恢复 → 删除
      clickEl(rowOf("冒烟角色01"));
      await wait(250);
      clickEl(rowOf("冒烟角色02"));
      await wait(300);
      const beforeSave = gN();
      clickEl(doc.getElementById("tfbSave"));
      await wait(150);
      check("点「保存」展开命名输入行", doc.getElementById("tfbSaverow").hidden === false);
      doc.getElementById("tfbName").value = "冒烟组合";
      clickEl(doc.getElementById("tfbSaveOk"));
      await wait(300);
      let saved = [];
      try { saved = JSON.parse(window.localStorage.getItem("rn_saved_filters") || "[]"); } catch (e) { saved = []; }
      check("筛选组合已写入 localStorage", saved.length === 1 && saved[0].tags.length === 2, JSON.stringify(saved));
      check("菜单里出现「我的筛选」区与条目", !!doc.querySelector("#tagMenuList .tag-group-head.saved") && !!doc.querySelector("#tagMenuList [data-sf]"));

      clickEl(doc.getElementById("tfbClear"));
      await wait(300);
      check("「清空」清掉全部条件并收起筛选条", window.__filterState().tags.length === 0 && gN() === total, `结果 ${gN()} 张`);

      const sfItem = doc.querySelector("#tagMenuList [data-sf]");
      if (sfItem) {
        clickEl(sfItem);
        await wait(300);
        check("点「我的筛选」一键恢复条件", window.__filterState().tags.length === 2 && gN() === beforeSave, `结果 ${gN()} 张`);
      }
      const delBtn = doc.querySelector("#tagMenuList [data-sfdel]");
      if (delBtn) {
        clickEl(delBtn);
        await wait(300);
        let after = [];
        try { after = JSON.parse(window.localStorage.getItem("rn_saved_filters") || "[]"); } catch (e) { after = []; }
        check("删除「我的筛选」条目", after.length === 0, JSON.stringify(after));
      }

      window.__clearFilter(); // 收尾：别把筛选状态留给后面的断言
      await wait(300);
      check("收尾：筛选状态已清空", window.__filterState().tags.length === 0 && gN() === total, `结果 ${gN()} 张`);
      check("清空后 FAB 小红点熄灭", !doc.getElementById("fabDot").classList.contains("on"));
    }
  }

  /* ---------- 分级 v0.57：大众级 / R16 / R18 ----------
     分级是照片自己的字段（meta.rating），与标签库并列而非混在标签里。
     seed 里第 17 张 = R18、第 18 张 = R16，其余大众级。 */
  {
    const gN = () => (window.__galleryState ? window.__galleryState().filtered : -1);
    const total = gN();
    const ratingRow = (r) => doc.querySelector(`#tagMenuList [data-rating="${r}"]`);

    check("筛选菜单有「分级」区（三档）", !!ratingRow("general") && !!ratingRow("r16") && !!ratingRow("r18"),
      [...doc.querySelectorAll("#tagMenuList [data-rating]")].map((b) => b.dataset.rating).join(" / ") || "（无）");
    const badges = doc.querySelectorAll("#grid .card .rating-badge");
    check("卡片上有分级角标", badges.length >= 1, `${badges.length} 个（非大众级才显示）`);

    if (ratingRow("r18")) {
      clickEl(ratingRow("r18"));
      await wait(400);
      const n18 = gN();
      check("按 R18 筛选生效", window.__filterState().rating === "r18" && n18 >= 1 && n18 < total, `R18 ${n18} 张 / 共 ${total} 张`);
      clickEl(ratingRow("general"));
      await wait(400);
      const nGen = gN();
      check("切到大众级只剩大众级", window.__filterState().rating === "general" && nGen === total - n18 - 1,
        `大众级 ${nGen} 张（总 ${total} − R18 ${n18} − R16 1）`);
      clickEl(doc.querySelector('#tagMenuList [data-tag=""]')); // 「全部」清空
      await wait(350);
      check("「全部」同时清掉分级筛选", window.__filterState().rating === null && gN() === total, `结果 ${gN()} 张`);
    }

    // 编辑弹窗里的三档选择
    const card = doc.querySelector("#grid .card");
    if (card) {
      const id = card.dataset.id;
      const headers = TOKEN ? { "X-Auth-Token": TOKEN } : {};
      // 记下原分级，测完按原值还原（第一张卡片可能就是 seed 的 R16 / R18 图）
      const beforeDoc = await (await fetch(`${BASE}/api/photos/${id}?_=${Math.random()}`, { headers })).json();
      const origRating = (beforeDoc.photo && beforeDoc.photo.rating) || "general";
      card.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 2 }));
      await wait(450);
      const modal = doc.getElementById("editModal");
      check("编辑弹窗有分级三档选择", !!modal && modal.classList.contains("open") && doc.querySelectorAll("#edRating .rating-pick").length === 3,
        `${doc.querySelectorAll("#edRating .rating-pick").length} 个档位`);
      const pick18 = doc.querySelector('#edRating .rating-pick[data-rating="r18"]');
      if (pick18) {
        clickEl(pick18);
        await wait(180);
        check("点选档位后高亮（单选互斥）",
          pick18.classList.contains("on") && doc.querySelectorAll("#edRating .rating-pick.on").length === 1);
        clickEl(doc.getElementById("edSave"));
        await wait(1500);
        const one = await (await fetch(`${BASE}/api/photos/${id}?_=${Math.random()}`, { headers })).json();
        check("分级写入照片字段 rating", !!one.photo && one.photo.rating === "r18", `rating=${one.photo && one.photo.rating}`);
        // 还原成原分级（避免影响后续断言与数据形态）
        await fetch(`${BASE}/api/photos/${id}`, {
          method: "PATCH",
          headers: Object.assign({ "Content-Type": "application/json" }, headers),
          body: JSON.stringify({ rating: origRating }),
        });
        await wait(250);
        if (window.__reloadData) await window.__reloadData();
        if (window.__refreshGallery) window.__refreshGallery();
        await wait(600);
      }
    }
  }

  /* 库内查重（v0.42）：筛选菜单入口 + 扫描弹窗（本地 seed 里放了两张相同的图） */
  const dupEntry = doc.querySelector('#tagMenuList [data-dupopen]');
  check("筛选菜单有查重入口", !!dupEntry);
  if (dupEntry) {
    clickEl(dupEntry);
    await wait(4000); // 线上是全量索引，给足时间（首次可能还带函数冷启动）
    const dupModal = doc.getElementById("dupModal");
    const dupBody = doc.getElementById("dupBody");
    check("点查重打开弹窗并完成扫描",
      !!dupModal && dupModal.classList.contains("open") && !!dupBody && /dup-summary|dup-empty/.test(dupBody.innerHTML));
    const st = window.__dupState ? window.__dupState() : null;
    const dupTxt = (dupBody ? dupBody.textContent : "").replace(/\s+/g, " ").trim().slice(0, 160);
    check("扫描结果有状态钩子", !!st && st.scanned > 0,
      st ? `扫了 ${st.scanned} 张，${st.groups} 组（完全相同 ${st.exact}）` : `无 ｜ 弹窗内容：${dupTxt}`);
    // v0.83：弹窗开着时锁住底层页面滚动（避免滚动穿透到图库）
    check("弹窗开着时底层页面被锁滚动", doc.body.classList.contains("modal-open"));
    const dc = doc.getElementById("dupClose");
    if (dc) clickEl(dc);
    await wait(250);
    check("查重弹窗可关闭", !!dupModal && !dupModal.classList.contains("open"));
    check("关闭弹窗后恢复页面滚动", !doc.body.classList.contains("modal-open"));
  }

  /* 清道夫（v0.39）：本测试会新建 / 改名 / 删除临时标签，而改名与删除后的 `apiSaveTags()`
     是全量 PUT —— 若当时 `loadTags()` 读到的是含历史临时标签的旧副本（Blobs 读延迟 1~2 分钟），
     这些残留就会被写回配置。这里统一过滤掉 `zz测试*` 再 PUT 一次，保证跑完不留垃圾。 */
  try {
    const h = TOKEN ? { "X-Auth-Token": TOKEN } : {};
    const cfg = await (await fetch(`${BASE}/api/tags?_=${Math.random()}`, { headers: h })).json();
    const junk = (cfg.tags || []).filter((t) => String(t.name || "").startsWith("zz测试"));
    if (junk.length) {
      cfg.tags = (cfg.tags || []).filter((t) => !String(t.name || "").startsWith("zz测试"));
      const pr = await fetch(`${BASE}/api/tags`, {
        method: "PUT",
        headers: Object.assign({ "Content-Type": "application/json" }, h),
        body: JSON.stringify(cfg),
      });
      const pd = await pr.json().catch(() => ({}));
      check("清道夫：清掉历史残留测试标签", pd.ok !== false, `清掉 ${junk.length} 个（${junk.map((t) => t.name).join(", ")}）`);
    } else {
      check("清道夫：无历史残留测试标签", true);
    }
  } catch (e) {
    check("清道夫：无历史残留测试标签", false, e.message);
  }

  /* 观光 / 管理员模式（v0.49） */
  const modeSt = window.__modeState ? window.__modeState() : null;
  check("默认以管理员模式运行（测试前置）", !!modeSt && modeSt.mode === "admin", modeSt ? modeSt.mode : "无");
  if (modeSt) {
    // 观光模式下：管理入口被拦、编辑弹窗打不开
    window.__setMode("guest");
    await wait(200);
    check("切换到观光模式后 body 带 mode-guest", doc.body.classList.contains("mode-guest") && !doc.body.classList.contains("mode-admin"));
    check("观光模式拦下管理操作", window.__guestBlocked("编辑图片") === true);
    const modalBefore = doc.getElementById("editModal").classList.contains("open");
    if (firstCard) {
      firstCard.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 2 }));
      await wait(300);
      check("观光模式双击卡片不会打开编辑弹窗",
        !modalBefore && !doc.getElementById("editModal").classList.contains("open"));
    }
    check("观光模式查重入口被拦", window.__guestBlocked("查重") === true);
    // 恢复管理员模式（后续断言依赖）
    window.__setMode("admin");
    await wait(200);
    check("切回管理员模式", doc.body.classList.contains("mode-admin") && doc.getElementById("editModal") !== null);
  }
  /* v0.85：观光模式的放行开关拆成两个（R18 / R16 各一个，互不影响） */
  {
    const r18 = doc.getElementById("guestAdultR18");
    const r16 = doc.getElementById("guestAdultR16");
    check("设置页有 R18 / R16 两个放行开关", !!r18 && !!r16 && !doc.getElementById("guestAdult"));
    if (r18 && r16 && window.__modeState) {
      window.localStorage.setItem("rn_guest_r18", "0");
      window.localStorage.setItem("rn_guest_r16", "1");
      window.__setMode("guest");
      await wait(120);
      const st = window.__modeState();
      check("两个开关互不影响（只隐藏 R18）", st.hidden.length === 1 && st.hidden[0] === "r18",
        `hidden=${JSON.stringify(st.hidden)} r18=${st.r18Allowed} r16=${st.r16Allowed}`);
      window.localStorage.setItem("rn_guest_r18", "1");
      window.localStorage.setItem("rn_guest_r16", "0");
      window.__setMode("guest");
      await wait(120);
      const st2 = window.__modeState();
      check("反过来只隐藏 R16", st2.hidden.length === 1 && st2.hidden[0] === "r16", `hidden=${JSON.stringify(st2.hidden)}`);
      window.localStorage.removeItem("rn_guest_r18");
      window.localStorage.removeItem("rn_guest_r16");
      window.__setMode("admin");
      await wait(120);
    }
  }
  /* v0.50：设置里的「访问密码」「R18 密钥」入口与对应后端接口都已删除 */
  check("设置页不再有修改访问密码入口", !doc.getElementById("authPwdNew") && !doc.getElementById("btnSetPwd"));
  check("设置页不再有 R18 密钥入口", !doc.getElementById("authR18New") && !doc.getElementById("btnSetR18"));
  for (const [name, path] of [["修改密码接口", "/api/auth/password"], ["R18 密钥接口", "/api/auth/r18"], ["R18 校验接口", "/api/auth/r18/verify"]]) {
    try {
      const r = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, TOKEN ? { "X-Auth-Token": TOKEN } : {}),
        body: "{}",
      });
      check(`${name}已删除（404）`, r.status === 404, `HTTP ${r.status}`);
    } catch (e) {
      check(`${name}已删除（404）`, false, e.message);
    }
  }

  /* v0.59：整理模式（tagger）已移除 —— body 不再有 mode-tagger，标签管理也只有「分组 / 分类」两个视图 */
  if (modeSt) {
    window.__setMode("admin");
    await wait(200);
    const segBtns = doc.querySelectorAll("#tmgrViewSeg .seg-btn");
    check("标签管理只剩「分组 / 分类」两个视图",
      segBtns.length === 2 && [...segBtns].every((b) => b.dataset.view !== "review"),
      [...segBtns].map((b) => b.dataset.view).join(",") || "(无)");
    check("body 不再有 mode-tagger 类", !doc.body.classList.contains("mode-tagger"));
  }

  /* 服务端 safe=1：观光模式的列表里不返回非大众级（R16 / R18）的图片 —— v0.57 起看 rating 字段 */
  try {
    const all = await (await fetch(`${BASE}/api/photos?limit=300${TOKEN ? "&token=" + encodeURIComponent(TOKEN) : ""}`, { headers: TOKEN ? { "X-Auth-Token": TOKEN } : {} })).json();
    const safe = await (await fetch(`${BASE}/api/photos?limit=300&safe=1${TOKEN ? "&token=" + encodeURIComponent(TOKEN) : ""}`, { headers: TOKEN ? { "X-Auth-Token": TOKEN } : {} })).json();
    const adult = (all.photos || []).filter((p) => (p.rating || "general") !== "general");
    const adultInSafe = (safe.photos || []).filter((p) => (p.rating || "general") !== "general");
    check("safe=1 列表里没有 R16 / R18 图片",
      adultInSafe.length === 0 && (safe.total || 0) === (all.total || 0) - adult.length,
      `全部 ${all.total} · 成人向 ${adult.length} · safe ${safe.total}`);
    check("列表返回三档分级字段", (all.photos || []).every((p) => ["general", "r16", "r18"].includes(p.rating)),
      [...new Set((all.photos || []).map((p) => p.rating))].join(" / "));
    // v0.85：hide=r18 / hide=r16 分开隐藏
    const h18 = await (await fetch(`${BASE}/api/photos?limit=300&hide=r18${TOKEN ? "&token=" + encodeURIComponent(TOKEN) : ""}`, { headers: TOKEN ? { "X-Auth-Token": TOKEN } : {} })).json();
    const h16 = await (await fetch(`${BASE}/api/photos?limit=300&hide=r16${TOKEN ? "&token=" + encodeURIComponent(TOKEN) : ""}`, { headers: TOKEN ? { "X-Auth-Token": TOKEN } : {} })).json();
    const ratings18 = (h18.photos || []).map((p) => p.rating || "general");
    const ratings16 = (h16.photos || []).map((p) => p.rating || "general");
    const hasR18 = (all.photos || []).some((p) => p.rating === "r18");
    const hasR16 = (all.photos || []).some((p) => p.rating === "r16");
    check("hide=r18 只剔除 R18（R16 还在）", !ratings18.includes("r18") && (!hasR16 || ratings18.includes("r16")),
      `hide=r18 → ${[...new Set(ratings18)].join("/")}`);
    check("hide=r16 只剔除 R16（R18 还在）", !ratings16.includes("r16") && (!hasR18 || ratings16.includes("r18")),
      `hide=r16 → ${[...new Set(ratings16)].join("/")}`);
    check("标签里不再混入 r18 / r16", (all.photos || []).every((p) => !(p.tags || []).some((t) => ["r18", "r16"].includes(String(t).trim().toLowerCase()))));
    // v0.50：管理员读成人向图片不再需要额外密钥
    if (adult.length) {
      const rr = await fetch(`${BASE}/api/photos/${adult[0].id}/raw${TOKEN ? "?token=" + encodeURIComponent(TOKEN) : ""}`, {
        headers: TOKEN ? { "X-Auth-Token": TOKEN } : {},
      });
      check("管理员读 R18 图不再需要密钥", rr.status === 200, `HTTP ${rr.status}`);
    }
  } catch (e) {
    check("safe=1 列表里没有 R16 / R18 图片", false, e.message);
  }

  /* v0.84：用量统计要真的算得出字节数（之前一直显示 0 KB） */
  {
    try {
      const r = await fetch(`${BASE}/api/meta/stats`, { headers: TOKEN ? { "X-Auth-Token": TOKEN } : {} });
      const d = await r.json();
      const k = (d && d.byKind) || {};
      check("用量统计返回真实字节数", !!d && d.bytes > 0 && k.img > 0 && k.meta > 0,
        `共 ${d && d.bytes} B · 原图 ${k.img} · 缩略图 ${k.thumb} · 元数据 ${k.meta} · ${d && d.keys} 个文件`);
    } catch (e) {
      check("用量统计返回真实字节数", false, e.message);
    }
  }

  /* v0.93：缩略图预热接口 —— 分批处理并返回进度（前端循环调用） */
  {
    try {
      const r = await fetch(`${BASE}/api/meta/thumbs`, {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, TOKEN ? { "X-Auth-Token": TOKEN } : {}),
        body: JSON.stringify({ offset: 0, batch: 5 }),
      });
      const d = await r.json();
      check("缩略图预热接口可用（分批返回进度）", r.status === 200 && !!d.ok && d.total > 0 && typeof d.next === "number",
        `total=${d.total} next=${d.next} done=${d.done} skipped=${d.skipped}`);
    } catch (e) {
      check("缩略图预热接口可用（分批返回进度）", false, e.message);
    }
  }

  /* v1.06：标签配置带 updatedAt，且刚 PUT 完立刻 GET 就该读到新版本（防 Blobs 写后读延迟） */
  {
    try {
      const hdr = Object.assign({}, TOKEN ? { "X-Auth-Token": TOKEN } : {});
      const cfg1 = await (await fetch(`${BASE}/api/tags`, { headers: hdr })).json();
      const before = Number(cfg1.updatedAt) || 0;
      const put = await fetch(`${BASE}/api/tags`, {
        method: "PUT",
        headers: Object.assign({ "Content-Type": "application/json" }, hdr),
        body: JSON.stringify({ categories: cfg1.categories, groups: cfg1.groups, tags: cfg1.tags }),
      });
      const cfg2 = await (await fetch(`${BASE}/api/tags`, { headers: hdr })).json();
      check("标签配置带 updatedAt，写后立即可读到新版本",
        put.status === 200 && Number(cfg2.updatedAt) > before && (cfg2.tags || []).length === (cfg1.tags || []).length,
        `updatedAt ${before} → ${cfg2.updatedAt}`);
    } catch (e) {
      check("标签配置带 updatedAt，写后立即可读到新版本", false, e.message);
    }
  }

  /* v0.53：所有前端会用到的接口都必须挂载在函数的 config.path 里（漏加会直接 404） */
  {
    const hdr = Object.assign({ "Content-Type": "application/json" }, TOKEN ? { "X-Auth-Token": TOKEN } : {});
    const q = TOKEN ? `token=${encodeURIComponent(TOKEN)}` : "";
    const withToken = (p) => `${BASE}${p}${q ? (p.includes("?") ? "&" : "?") + q : ""}`;
    const probes = [
      ["GET", "/api/auth/state"],
      ["POST", "/api/auth/login"],
      ["GET", "/api/photos?limit=1"],
      ["GET", "/api/tags"],
      ["GET", "/api/albums"],
      ["GET", "/api/meta/stats"],
      ["POST", "/api/meta/thumbs"],
      ["GET", "/api/meta/logs"],
    ];
    const missing = [];
    for (const [m, p, body] of probes) {
      try {
        const r = await fetch(withToken(p), { method: m, headers: hdr, body: m === "POST" ? (body || "{}") : undefined });
        if (r.status === 404) missing.push(`${m} ${p}`);
      } catch (e) {
        missing.push(`${m} ${p}(${e.message})`);
      }
    }
    check("接口都已挂载（没有 404）", missing.length === 0, missing.length ? `404：${missing.join(" / ")}` : `${probes.length} 个接口均可达`);
    // v0.59：整理模式相关接口已删除（应当 404）
    try {
      const r = await fetch(withToken("/api/auth/tagger"), { method: "POST", headers: hdr, body: "{}" });
      check("整理密码接口已删除（404）", r.status === 404, `HTTP ${r.status}`);
    } catch (e) {
      check("整理密码接口已删除（404）", false, e.message);
    }
  }

  /* v0.52：输入框里打字不该被键盘快捷键抢走（曾出现「整理视图的 1-9 吞掉密码里的数字」） */
  const probeInput = doc.getElementById("modePwd") || doc.querySelector("#panelSettings input") || doc.querySelector(".modal-mask input");
  if (probeInput) {
    probeInput.focus();
    const keys = ["1", "3", "9", "0", "s", "S", "Enter", "ArrowLeft", "ArrowRight", "/"];
    const stolen = keys.filter((k) => {
      const ev = new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
      probeInput.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    check("输入框里按键不被快捷键抢走", stolen.length === 0, stolen.length ? `被拦截：${stolen.join(" ")}` : "全部放行");
    if (probeInput.blur) probeInput.blur();
  }
  window.localStorage.setItem("rn_tmgr_view", "group"); // 复位，别影响后续断言
  window.localStorage.removeItem("rn_tmgr_tfilter");   // v0.86：过滤状态也复位

  const failed = results.filter((x) => !x).length;
  console.log(`\n${failed ? `✗ ${failed} 项未通过` : "✓ 全部通过"}（共 ${results.length} 项）\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("测试异常：", e); process.exit(1); });
