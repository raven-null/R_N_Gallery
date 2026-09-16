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
    if (TOKEN) o.headers = Object.assign({}, o.headers, { "X-Auth-Token": TOKEN });
    return fetch(abs, o);
  };
  window.localStorage.setItem("rn_perf_lite", "1"); // 打开性能模式，覆盖图片回收分支
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

  /* 整理视图：应用过的图片刷新后不再回到待整理队列（v0.27） */
  window.localStorage.setItem("rn_tmgr_view", "review");
  window.__refreshTagManager();
  await wait(400);
  const rv1 = window.__rvState ? window.__rvState() : null;
  check("整理视图有待整理项", !!(rv1 && rv1.ids.length), rv1 ? `${rv1.ids.length} 张` : "无 __rvState（未切换到整理视图）");
  if (rv1 && rv1.ids.length) {
    const firstId = rv1.ids[0];
    // 保证至少选中一个主分类：挑一个当前未选中的 chip 点（点已选中的是取消）
    const rvChips = [...doc.querySelectorAll("#rvCats .cat-pick")];
    const pick = rvChips.find((c) => !c.classList.contains("on")) || rvChips[0];
    if (pick) pick.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const picked = [...doc.querySelectorAll("#rvCats .cat-pick.on")].map((c) => c.dataset.cat);
    console.log(`   选中主分类：[${picked.join(",")}]`);
    doc.getElementById("rvApply").click();
    await wait(1500);
    const rv2 = window.__rvState();
    check("应用后记入整理进度", rv2.done.includes(firstId));
    check("应用后前进到下一张", rv2.idx === rv1.idx + 1, `idx ${rv1.idx} → ${rv2.idx}`);
    window.__refreshTagManager(); // 模拟刷新：重新读进度并重算队列
    await wait(500);
    const rv3 = window.__rvState();
    check("重新加载后不再出现", !rv3.ids.includes(firstId), `队列剩 ${rv3.ids.length} 张`);
    window.localStorage.setItem("rn_tmgr_view", "classify"); // 切回分类视图，供后续检查
    window.__refreshTagManager();
    await wait(400);
  }

  const cssText = fs.readFileSync(path.join(ROOT, "public", "assets", "style.css"), "utf8");
  check("CSS 含 content-visibility 规则", /content-visibility:\s*auto/.test(cssText));

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
    const foldAll = doc.getElementById("tmgrFoldAll");
    if (foldAll) {
      foldAll.click();
      await wait(400);
      check("「全部折叠」生效", [...doc.querySelectorAll("#tagMgrRoot [data-gfold]")].every((h) => h.classList.contains("folded")));
    }
    const openAll = doc.getElementById("tmgrOpenAll");
    if (openAll) {
      openAll.click();
      await wait(400);
      check("「全部展开」生效", ![...doc.querySelectorAll("#tagMgrRoot [data-gfold]")].some((h) => h.classList.contains("folded")));
    }
  } else {
    check("存在标签数 >20 的组（折叠验证用）", false, "本地先跑：node scripts/import-chars.js");
  }

  /* 相册整页（v0.34）：FAB 相册按钮进入，iOS 风格一级/二级 */
  const fabAlb = doc.getElementById("fabAlbumsBtn");
  check("FAB 有相册按钮", !!fabAlb);
  check("页面切换菜单已移除「图库」项", !doc.querySelector('#pageMenu [data-page="gallery"]'));
  const clickEl = (el) => el && el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  if (fabAlb) {
    clickEl(fabAlb);
    await wait(800);
    const page = doc.getElementById("albumPage");
    check("点击后相册整页打开", !!page && page.classList.contains("open"));
    check("有顶部导航栏与大标题容器", !!doc.getElementById("albNavTitle") && !!doc.getElementById("albumBody"));
    const addBtn = doc.getElementById("albAddBtn");
    if (addBtn) {
      clickEl(addBtn);
      await wait(250);
      const bar = doc.getElementById("albNewBar");
      check("点＋展开新建相册输入框", !!bar && !bar.hidden && !!doc.getElementById("albNewName"));
    }
    if (!TOKEN) {
      const inp = doc.getElementById("albNewName");
      if (inp) {
        const albName = "zz测试相册" + Math.random().toString(36).slice(2, 5);
        inp.value = albName;
        inp.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        await wait(1800);
        const st = window.__albumsState ? window.__albumsState() : { albums: [] };
        const created = st.albums[st.albums.length - 1];
        const covers = doc.querySelectorAll("#albumBody .alb-cover").length;
        check("新建相册出现在一级网格", !!created && covers > 0, created ? `${created.name}（${covers} 个封面）` : "");
        const firstCard = doc.querySelector("#grid .card");
        const photoId = firstCard && firstCard.dataset.id;
        if (created && photoId) {
          const headers = TOKEN ? { "X-Auth-Token": TOKEN } : {};
          const list = await (await fetch(`${BASE}/api/albums?_=${Math.random()}`, { headers })).json();
          const albums = list.albums || [];
          const target = albums.find((a) => a.id === created.id);
          if (target) {
            target.photoIds = [photoId];
            await fetch(`${BASE}/api/albums`, {
              method: "PUT",
              headers: Object.assign({ "Content-Type": "application/json" }, headers),
              body: JSON.stringify({ albums }),
            });
            await window.__reloadAlbums();
            await wait(400);
            // 点封面进二级，应看到照片网格
            const cover = doc.querySelector(`#albumBody .alb-cover[data-aid="${created.id}"]`);
            if (cover) {
              clickEl(cover);
              await wait(500);
              const photos = doc.querySelectorAll("#albumBody .alb-photo").length;
              const lv = window.__albumsState ? window.__albumsState().level : "?";
              check("点封面进入二级并显示照片", photos > 0 && lv === "album", `${photos} 张，层级=${lv}`);
              // 返回按钮：二级 → 一级 → 关闭
              clickEl(doc.getElementById("albBack"));
              await wait(400);
              const lv2 = window.__albumsState ? window.__albumsState().level : "?";
              check("返回按钮：二级退回一级", lv2 === "list", `层级=${lv2}`);
              clickEl(doc.getElementById("albBack"));
              await wait(600);
              const stillOpen = doc.getElementById("albumPage").classList.contains("open");
              check("再点返回关闭相册页", !stillOpen);
            }
          }
        }
      }
    } else {
      console.log("   （线上跳过相册创建与加图，避免改动真实数据）");
    }
  }
  /* 灯箱右下角悬浮工具条（v0.38）：信息面板不恢复；工具条默认隐藏，鼠标在灯箱内移动才浮现 */
  check("灯箱不再有信息面板", !doc.getElementById("lbInfo") && !doc.querySelector(".lightbox .lb-info"));
  check("灯箱不再有收藏按钮", !doc.getElementById("lbToolFav"));
  const lbBox = doc.getElementById("lightbox");
  const lbBar = doc.getElementById("lbToolsFloat");
  const toolIds = ["lbToolPlay", "lbToolEdit", "lbToolRot", "lbToolDl", "lbToolAlbum"];
  check("灯箱右下角悬浮工具条含 5 个按钮", !!lbBar && toolIds.every((i) => doc.getElementById(i)));
  check("工具条默认隐藏（无 tools-visible 类）", !!(lbBox && !lbBox.classList.contains("tools-visible")));
  check("筛选菜单不再有收藏行", !doc.querySelector('#tagMenuList [data-tag="__fav"]'));
  const firstCard = doc.querySelector("#grid .card");
  if (lbBox && lbBar && firstCard) {
    doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); // 退出可能残留的多选态
    await wait(150);
    clickEl(firstCard);
    await wait(350);
    check("打开灯箱后工具条仍隐藏", lbBox.classList.contains("open") && !lbBox.classList.contains("tools-visible"));
    lbBox.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 400, clientY: 300 }));
    await wait(100);
    check("鼠标移动后工具条浮现", lbBox.classList.contains("tools-visible"));
    doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await wait(100);
    const playBtn = doc.getElementById("lbToolPlay");
    check("空格开始幻灯片（按钮切为暂停态）", !!playBtn && playBtn.classList.contains("playing"));
    doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await wait(100);
    check("再按空格停止幻灯片", !!playBtn && !playBtn.classList.contains("playing"));
    clickEl(doc.querySelector(".lb-close"));
    await wait(250);
    check("关闭灯箱并收起工具条", !lbBox.classList.contains("open") && !lbBox.classList.contains("tools-visible"));
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
    gnewBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await wait(300);
    const sel = doc.querySelector("#tagModalBody #fGroup");
    const t = modalTitle();
    check("「＋」打开新建标签弹窗", doc.getElementById("tagModal").classList.contains("open") && t.includes("新建标签"), t);
    check("所属组已预选", !!sel && sel.value === gid, sel ? `选中=${sel.value || "(未分组)"}` : "无组选择框");
    closeModal();
    await wait(200);
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

  const failed = results.filter((x) => !x).length;
  console.log(`\n${failed ? `✗ ${failed} 项未通过` : "✓ 全部通过"}（共 ${results.length} 项）\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("测试异常：", e); process.exit(1); });
