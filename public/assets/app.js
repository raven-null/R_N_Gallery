/* ============================================================
   R_N_Gallery 前端脚本
   数据源（v0.9.4 起）：仅从 Netlify Blobs API（/api/photos）加载；
   已移除本地静态图片与自带假数据（image/ 目录、随机标签等）
   ============================================================ */
"use strict";

// 调试辅助：全局 JS 错误在页面角落显示红条（排查上传问题用）
window.addEventListener("error", (e) => {
  let box = document.getElementById("debugErr");
  if (!box) {
    box = document.createElement("div");
    box.id = "debugErr";
    box.style.cssText =
      "position:fixed;bottom:10px;left:10px;z-index:9999;background:rgba(220,38,38,.92);color:#fff;" +
      "font:12px/1.5 monospace;padding:8px 12px;border-radius:8px;max-width:80vw;white-space:pre-wrap;box-shadow:0 4px 20px rgba(0,0,0,.4)";
    document.body.appendChild(box);
  }
  const st = (e.error && e.error.stack) ? "\\n" + String(e.error.stack).split("\\n").slice(1, 5).join("\\n") : "";
  box.textContent = "JS 错误: " + (e.message || e) + st;
});

let PHOTOS = [];
let USE_API = false;

/* ---------- 标签体系（v0.11）：配置状态（模块级，菜单/管理页共享） ---------- */
let TAGS = { groups: [], tags: [] };
let activeTagName = null; // 图库墙当前筛选的标签名（"__fav" = 收藏）
const collapsedGroups = new Set(); // 筛选菜单中折叠的组 id

/* ---------- 收藏 / 排序 / 批量选择（v0.11.2） ---------- */
const FAV_KEY = "rn_favs";
const SORT_KEY = "rn_sort";
let favs = new Set();
let SORT_MODE = "newest"; // newest | oldest | title | size
let selectMode = false;
const selected = new Set();
let aiFilter = null; // AI 语义筛选：{ tags: [names], match: "any"|"all" }

function loadFavs() {
  try { favs = new Set(JSON.parse(localStorage.getItem(FAV_KEY) || "[]")); }
  catch (e) { favs = new Set(); }
}
function saveFavs() { localStorage.setItem(FAV_KEY, JSON.stringify([...favs])); }
const isFav = (id) => favs.has(id);
function toggleFav(id) {
  if (favs.has(id)) favs.delete(id); else favs.add(id);
  saveFavs();
}

function sortPhotos(list) {
  const out = [...list];
  if (SORT_MODE === "oldest") out.sort((a, b) => String(a.uploadedAt || "").localeCompare(String(b.uploadedAt || "")));
  else if (SORT_MODE === "size") out.sort((a, b) => (b.size || 0) - (a.size || 0));
  else out.sort((a, b) => String(b.uploadedAt || "").localeCompare(String(a.uploadedAt || "")));
  return out;
}

/* ---------- 通用标签 chips 输入（v0.11.2：编辑 / 批量加标签复用） ---------- */
function addTagChip(box, name) {
  const input = box.querySelector("input");
  const dup = [...box.querySelectorAll(".t")].some((el) => el.childNodes[0].textContent.trim() === name);
  if (!dup && name) {
    const el = document.createElement("span");
    el.className = "t";
    el.innerHTML = `${esc(name)}<button type="button" title="移除">×</button>`;
    el.querySelector("button").onclick = () => el.remove();
    box.insertBefore(el, input);
  }
  if (input) input.value = "";
}
const tagsOfBox = (box) => [...box.querySelectorAll(".t")].map((el) => el.childNodes[0].textContent.trim()).filter(Boolean);

/* 标签建议输入（v0.14 借鉴博客后台：focus 显示全部候选、退格删 chip、回车自定义） */
function bindTagSuggest(input, suggest, box, afterPick) {
  if (!input || !suggest) return;
  const hide = () => { suggest.hidden = true; suggest.innerHTML = ""; };
  const renderHits = (kw) => {
    const used = new Set(tagsOfBox(box));
    const q = String(kw || "").trim().toLowerCase();
    let hits = TAGS.tags.filter((t) => !used.has(t.name) && tagQueryMatch(t, q));
    if (!q) hits = hits.slice(0, 12);
    else hits = hits.slice(0, 8);
    if (!hits.length) {
      suggest.innerHTML = `<div class="ts-empty">${q ? "无匹配标签 · 回车可自定义" : "标签库为空，回车可自定义新标签"}</div>`;
      suggest.hidden = false;
      return;
    }
    suggest.innerHTML = hits.map((t) => {
      const c = t.color || tagGroupColor(t.group) || null;
      const g = t.group ? TAGS.groups.find((x) => x.id === t.group) : null;
      return `<button type="button" class="ts-item" data-name="${escAttr(t.name)}">
        <i class="dot"${c ? ` style="--tg:${c}"` : ""}></i>${esc(t.name)}
        ${g ? `<span class="g">${esc(g.name)}</span>` : ""}</button>`;
    }).join("");
    suggest.hidden = false;
  };
  input.addEventListener("focus", () => {
    if (TAGS.tags.length && !suggest.hidden) return;
    if (input.value.trim()) return;
    renderHits("");
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && input.value.trim()) {
      e.preventDefault();
      addTagChip(box, input.value.trim());
      input.value = "";
      hide();
      if (afterPick) afterPick();
    } else if (e.key === "Backspace" && !input.value.trim()) {
      const chips = box.querySelectorAll(".t");
      if (chips.length) {
        chips[chips.length - 1].remove();
        if (afterPick) afterPick();
      }
    }
  });
  input.addEventListener("input", () => {
    if (!suggest) return;
    const kw = input.value.trim().toLowerCase();
    if (!kw || !TAGS.tags.length) return hide();
    renderHits(kw);
  });
  if (suggest) {
    suggest.addEventListener("mousedown", (e) => {
      const it = e.target.closest(".ts-item");
      if (it) { e.preventDefault(); addTagChip(box, it.dataset.name); input.value = ""; hide(); if (afterPick) afterPick(); }
    });
    input.addEventListener("blur", () => setTimeout(hide, 150));
  }
}
/* ---------- 通用确认弹窗 ---------- */
let confirmCb = null;
function askConfirm(title, desc, okLabel, cb) {
  const m = document.getElementById("confirmModal");
  if (!m) return;
  document.getElementById("confirmTitle").textContent = title;
  document.getElementById("confirmDesc").textContent = desc;
  const ok = document.getElementById("confirmOk");
  ok.textContent = okLabel || "确认";
  confirmCb = cb;
  m.classList.add("open");
  document.getElementById("confirmCancel").onclick = () => m.classList.remove("open");
  ok.onclick = () => {
    m.classList.remove("open");
    if (confirmCb) confirmCb();
  };
}
/* Promise 版确认（供上传重复检测等 await 场景） */
function askConfirmAsync(title, desc, okLabel) {
  return new Promise((resolve) => {
    askConfirm(title, desc, okLabel, () => resolve(true));
    document.getElementById("confirmCancel").onclick = () => { document.getElementById("confirmModal").classList.remove("open"); resolve(false); };
    const m = document.getElementById("confirmModal");
    if (!m) return resolve(false);
  });
}

/* ---------- AI 助手（v0.12）：设置状态 + 调用封装 ---------- */
const AI_STORE = { on: "rn_ai_on", key: "rn_ai_key", sys: "rn_ai_sys", temp: "rn_ai_temp" };
function aiEnabled() { return localStorage.getItem(AI_STORE.on) === "1"; }
function aiKey() { return (localStorage.getItem(AI_STORE.key) || "").trim(); }
function aiSys() { return localStorage.getItem(AI_STORE.sys) || "你是「渡影集」私人图库的助手，回答简洁准确；要求输出 JSON 时只输出 JSON，不要额外文字。"; }
function aiTemp() {
  const t = parseFloat(localStorage.getItem(AI_STORE.temp) || "0.7");
  return Number.isFinite(t) ? t : 0.7;
}
function aiReady() {
  if (!aiEnabled()) return { ok: false, msg: "请先在设置中启用 AI 助手" };
  if (!aiKey()) return { ok: false, msg: "请先在设置中填写 API Key（或部署端配置 ZHIPU_API_KEY）" };
  return { ok: true };
}
async function aiChat(content, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  const k = aiKey();
  if (k) headers["X-AI-Key"] = k;
  const history = Array.isArray(opts.history) ? opts.history.slice(-16) : [];
  const res = await fetch("/api/ai/chat", {
    method: "POST",
    headers,
    body: JSON.stringify({
      messages: [
        { role: "system", content: opts.system || aiSys() },
        ...history,
        { role: "user", content },
      ],
      temperature: Number.isFinite(opts.temperature) ? opts.temperature : aiTemp(),
      max_tokens: opts.maxTokens || 500,
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `AI 请求失败 HTTP ${res.status}`);
  const c = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!c) throw new Error("AI 无返回内容");
  return c;
}
/* 要求 AI 返回 JSON 并解析（兼容代码块包裹 / 前后多余文字） */
async function aiJson(content, opts) {
  const text = await aiChat(content, opts);
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch (e) { /* 尝试截取 */ }
  const start = s.search(/[[{]/);
  if (start >= 0) {
    const close = s[start] === "[" ? "]" : "}";
    const end = s.lastIndexOf(close);
    if (end > start) {
      try { return JSON.parse(s.slice(start, end + 1)); } catch (e2) { /* ignore */ }
    }
  }
  throw new Error("AI 返回无法解析为 JSON：" + s.slice(0, 140));
}
function tagListForAI() {
  return TAGS.tags.map((t) => `${t.name}${t.aliases && t.aliases.length ? "（别名：" + t.aliases.join("、") + "）" : ""}`).join("、");
}

/* ---------- HTML 转义 / 标签解析着色 ---------- */
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const escAttr = (s) => esc(s).replace(/`/g, "&#96;");

const tagByName = (name) => TAGS.tags.find((t) => t.name === name);
const tagGroupColor = (gid) => {
  const g = TAGS.groups.find((x) => x.id === gid);
  return g ? g.color : null;
};
/* 标签颜色：标签自身 color → 所属组 color → null（默认主题橙） */
function tagColor(name) {
  const t = tagByName(name);
  if (!t) return null;
  return t.color || tagGroupColor(t.group);
}
/* 标签 chip HTML：内联 --tg 色变量；未知/游离标签为默认色 */
const tagChip = (name) => {
  const c = tagColor(name);
  return `<span class="tg"${c ? ` style="--tg:${c}"` : ""}>${esc(name)}</span>`;
};

/* ---------- 标签配置加载与保存 ---------- */
async function loadTags() {
  try {
    const res = await apiFetch("/api/tags");
    const d = await res.json();
    TAGS = (d && Array.isArray(d.groups) && Array.isArray(d.tags)) ? d : { groups: [], tags: [] };
    if (window.__refreshQuickPick) window.__refreshQuickPick();
  } catch (e) {
    TAGS = { groups: [], tags: [] }; // API 不可用时降级为纯自由标签
  }
}
async function apiSaveTags() {
  const res = await apiFetch("/api/tags", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(TAGS),
  });
  const d = await res.json();
  if (!d.ok) throw new Error(d.error || "保存标签配置失败");
  if (d.config) TAGS = d.config;
}
async function apiRenameTag(from, to) {
  const res = await apiFetch("/api/tags/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to }),
  });
  const d = await res.json();
  if (!d.ok) throw new Error(d.error || "改名失败");
  await loadTags();
  return d;
}
async function apiRemoveTag(name) {
  const res = await apiFetch("/api/tags/remove", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const d = await res.json();
  if (!d.ok) throw new Error(d.error || "删除失败");
  await loadTags();
  return d;
}

/* ---------- 图库状态组件（v0.9.5）：loading / empty / error / null ---------- */
function showGalleryState(mode) {
  const el = document.getElementById("galleryState");
  if (!el) return;
  el.hidden = !mode;
  el.className = "gallery-state" + (mode ? " " + mode : "");
  const r = document.getElementById("btnRetry");
  if (!mode) return;
  if (mode === "loading") {
    r.hidden = true;
  } else if (mode === "empty") {
    r.hidden = true;
  } else if (mode === "error") {
    r.hidden = false;
  }
}

async function loadData() {
  showGalleryState("loading");
  try {
    // cache: no-store 强制绕过浏览器缓存，确保上传后立即可见（v0.9.19）
    const res = await fetch("/api/photos?limit=200", { headers: apiHeaders(), cache: "no-store" });
    if (!res.ok) throw new Error("api unavailable");
    const data = await res.json();
    PHOTOS = (data.photos || []).map((p) => ({
      ...p,
      url: `/api/photos/${p.id}/raw`,
      thumbUrl: p.thumbKey ? `/api/photos/${p.id}/thumb` : null,
    }));
    USE_API = true;
    showGalleryState(null); // 由 render 决定显示图片或空态
  } catch (e) {
    PHOTOS = [];
    showGalleryState("error");
  }
}

/* ---------- API 请求封装（token 存 localStorage，设置页可配置） ---------- */
function apiHeaders() {
  const t = localStorage.getItem("rn_token") || "";
  return t ? { "X-Auth-Token": t } : {};
}
async function apiFetch(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { ...apiHeaders(), ...(options.headers || {}) } });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch (e) { /* ignore */ }
    throw new Error(msg);
  }
  return res;
}

const fmtSize = (b) => (b >= 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.round(b / 1e3) + " KB");
const fmtDate = (s) => {
  const d = new Date(s);
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
};

/* ---------- 缩略图 / 哈希（v0.12） ---------- */
const QUALITY_KEY = "rn_quality";
function qualityMode() {
  const q = localStorage.getItem(QUALITY_KEY);
  return q === "high" || q === "low" ? q : "normal";
}
function cardImgSrc(p) {
  // high=原图；normal/low=缩略图（无缩略图回退原图）
  return qualityMode() === "high" ? p.url : (p.thumbUrl || p.url);
}
function makeThumbDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const s = Math.min(1, 480 / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.width * s));
        c.height = Math.max(1, Math.round(img.height * s));
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        const mime = c.toDataURL("image/webp").startsWith("data:image/webp") ? "image/webp" : "image/jpeg";
        resolve(c.toDataURL(mime, 0.8));
      } catch (e) { reject(e); }
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}
async function sha1HexOf(dataUrl) {
  try {
    const b64 = String(dataUrl).split(",")[1] || String(dataUrl);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const digest = await crypto.subtle.digest("SHA-1", bytes);
    return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
  } catch (e) { return null; }
}

/* ---------- 通用：键盘快捷键 ---------- */
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement.tagName !== "INPUT") {
    // 打开搜索窗口并聚焦输入框
    e.preventDefault();
    if (window.__openWindow) window.__openWindow("search");
    setTimeout(() => document.getElementById("searchInput")?.focus(), 250);
  }
  if (e.key === "Escape") {
    document.querySelectorAll(".lightbox.open, .modal-mask.open").forEach((el) => el.classList.remove("open"));
    if (window.__stopSlide) window.__stopSlide();
    if (selectMode) exitSelectMode();
  }
});

/* ---------- 通用：悬浮弹出菜单（悬停弹出 + 点击固定 + 延迟收起，v0.8.4） ---------- */
const fabGroupEl = document.getElementById("fabGroup");
let flyoutOpenCount = 0; // 任一菜单打开时保持按钮组展开（v0.8.9）
function syncFabGroup() {
  if (fabGroupEl) fabGroupEl.classList.toggle("active", flyoutOpenCount > 0);
}

function initFlyout(btn, menu) {
  if (!btn || !menu) return null;
  let timer = null;
  function open() {
    clearTimeout(timer);
    const wasOpen = menu.classList.contains("open");
    menu.classList.add("open");
    btn.classList.add("open");
    if (!wasOpen) {
      flyoutOpenCount++;
      syncFabGroup();
    }
  }
  function close() {
    clearTimeout(timer);
    const wasOpen = menu.classList.contains("open");
    menu.classList.remove("open");
    btn.classList.remove("open");
    if (wasOpen) {
      flyoutOpenCount = Math.max(0, flyoutOpenCount - 1);
      syncFabGroup();
    }
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(close, 180);
  }
  btn.addEventListener("mouseenter", open);
  btn.addEventListener("mouseleave", (e) => {
    if (!menu.contains(e.relatedTarget)) schedule();
  });
  menu.addEventListener("mouseenter", open);
  menu.addEventListener("mouseleave", (e) => {
    if (e.relatedTarget !== btn) schedule();
  });
  // 点击 = 开关切换（v0.8.10 移除"点击固定"，移开鼠标即正常关闭）
  btn.addEventListener("click", () => {
    if (menu.classList.contains("open")) close();
    else open();
  });
  document.addEventListener("click", (e) => {
    if (!btn.contains(e.target) && !menu.contains(e.target)) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  return { open, close, isOpen: () => menu.classList.contains("open") };
}

/* ---------- 通用：灯箱（全局，图库/搜索共用） ---------- */
function openLightboxById(id, bustCache) {
  const p = PHOTOS.find((x) => x.id === id);
  if (!p) return;
  const img = document.getElementById("lbImg");
  const src = qualityMode() === "low" ? (p.thumbUrl || p.url) : p.url;
  img.dataset.orig = p.url;
  img.src = bustCache ? `${src}?t=${Date.now()}` : src;
  img.onerror = () => {
    if (img.src !== img.dataset.orig) img.src = img.dataset.orig;
  };
  const d = document.getElementById("lbDesc");
  if (p.desc && p.desc.trim()) {
    d.textContent = p.desc;
    d.hidden = false;
  } else {
    d.textContent = "";
    d.hidden = true;
  }
  document.getElementById("lbDate").textContent = fmtDate(p.takenAt);
  document.getElementById("lbSize").textContent = fmtSize(p.size);
  document.getElementById("lbDims").textContent = `${p.width} × ${p.height}`;
  document.getElementById("lbFormat").textContent = p.mime.replace("image/", "").toUpperCase();
  document.getElementById("lbTags").innerHTML = p.tags.map(tagChip).join("");
  const favBtn = document.getElementById("lbToolFav");
  if (favBtn) favBtn.classList.toggle("fav-on", isFav(id));
  const infoBtn = document.getElementById("lbToolInfo");
  const lb = document.getElementById("lightbox");
  lb.classList.add("open");
  lb.dataset.cur = id;
  if (infoBtn) infoBtn.classList.toggle("on", !lb.classList.contains("no-info"));
}

/* ---------- 通用：视口出现动画（v0.8.11）刷新交错浮现 + 滚动进出视口触发 ---------- */
function initReveal(container, selector) {
  if (!container) return;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const items = container.querySelectorAll(selector);
  if (!items.length) return;
  if (reduceMotion) {
    items.forEach((el) => el.classList.add("visible"));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const el = entry.target;
          el.classList.add("visible");
          io.unobserve(el);
          // 过渡完成后清除 stagger delay，避免影响后续 hover 动画
          setTimeout(() => { el.style.transitionDelay = "0s"; }, 700);
        }
      });
    },
    { rootMargin: "0px 0px 120px 0px" } // 提前 120px 触发，滚动更跟手
  );
  items.forEach((el, i) => {
    // 同一批进入视口时按顺序交错浮现（每批最多 12 张，每张 40ms）
    el.style.transitionDelay = `${Math.min(i % 12, 11) * 40}ms`;
    io.observe(el);
  });
}

/* ---------- 标签筛选菜单（v0.11：分组视图 + 搜索，行点击由 initGallery 委托） ---------- */
function tagRowHTML(t, counts) {
  const c = t.color || tagGroupColor(t.group);
  return `<button class="tag-menu-item${activeTagName === t.name ? " active" : ""}" data-tag="${escAttr(t.name)}">
    <span class="nm"><i class="dot"${c ? ` style="--tg:${c}"` : ""}></i>${esc(t.name)}</span>
    <span class="cnt">${counts[t.name] || 0}</span></button>`;
}

function renderTagMenuContent() {
  const list = document.getElementById("tagMenuList");
  if (!list) return;
  const searchEl = document.getElementById("tagSearch");
  const q = (searchEl && searchEl.value || "").trim().toLowerCase();

  // 照片中实际出现的标签计数（0 引用的配置标签不参与筛选菜单）
  const counts = {};
  PHOTOS.forEach((p) => p.tags.forEach((t) => { counts[t] = (counts[t] || 0) + 1; }));
  const used = Object.keys(counts);

  let html = `<button class="tag-menu-item${!activeTagName && !aiFilter ? " active" : ""}" data-tag="">
      <span class="nm">${t("全部", "All")}</span><span class="cnt">${PHOTOS.length}</span></button>
    <button class="tag-menu-item${activeTagName === "__fav" ? " active" : ""}" data-tag="__fav">
      <span class="nm"><i class="dot" style="--tg:var(--accent)"></i>${t("收藏", "Favorites")}</span><span class="cnt">${favs.size}</span></button>`;

  // AI 语义筛选状态行（可点击清除）
  if (aiFilter && aiFilter.tags && aiFilter.tags.length) {
    const anyAll = aiFilter.match === "all" ? t("全部满足", "all match") : t("任一满足", "any match");
    html += `<button class="tag-menu-item active" data-clear-ai title="${t("清除 AI 筛选", "Clear AI filter")}">
      <span class="nm" style="color:var(--accent)">✨ ${esc(aiFilter.tags.join(" · "))}<span style="font-size:10.5px;opacity:.7">（${anyAll}）</span></span>
      <span class="cnt">✕</span></button>`;
  }

  // 相册区（v0.12）：有照片的相册 + 未入册
  if (ALBUMS.albums.length || PHOTOS.length) {
    const inAny = new Set(ALBUMS.albums.flatMap((a) => a.photoIds));
    for (const a of ALBUMS.albums) {
      const n = a.photoIds.filter((x) => PHOTOS.some((p) => p.id === x)).length;
      if (!n) continue;
      html += `<button class="tag-menu-item${activeAlbumId === a.id ? " active" : ""}" data-album="${escAttr(a.id)}" title="只看这个相册">
        <span class="nm"><i class="dot" style="--tg:#0a84ff"></i>${esc(a.name)}</span><span class="cnt">${n}</span></button>`;
    }
    const loose = PHOTOS.filter((p) => !inAny.has(p.id)).length;
    if (loose > 0) {
      html += `<button class="tag-menu-item${activeAlbumId === "__none" ? " active" : ""}" data-album="__none" title="${t("不属于任何相册的照片", "Photos not in any album")}">
        <span class="nm"><i class="dot"></i>${t("未入册", "Unsorted")}</span><span class="cnt">${loose}</span></button>`;
    }
  }

  const kwHit = (t) => tagQueryMatch(t, q);

  if (used.length) {
    const groups = [...TAGS.groups].sort((a, b) => ((a.sort || 0) - (b.sort || 0)) || a.name.localeCompare(b.name, "zh"));
    for (const g of groups) {
      const items = TAGS.tags
        .filter((t) => t.group === g.id && counts[t.name] > 0 && kwHit(t))
        .sort((a, b) => ((a.sort || 0) - (b.sort || 0)) || a.name.localeCompare(b.name, "zh"));
      if (!items.length) continue;
      const col = g.color || null;
      const collapsed = collapsedGroups.has(g.id);
      html += `<div class="tag-group-head${collapsed ? " collapsed" : ""}" data-gid="${escAttr(g.id)}">
        <i class="dot"${col ? ` style="--tg:${col}"` : ""}></i>${esc(g.name)}
        <span class="caret">▼</span></div>`;
      if (!collapsed) html += items.map((t) => tagRowHTML(t, counts)).join("");
    }

    // 游离标签区：照片中有、但未纳入标签库（搜索后仍显示命中的游离标签）
    const freeList = (TAGS.tags.length ? used.filter((n) => !tagByName(n)) : used)
      .filter((n) => kwHit({ name: n, aliases: [] }))
      .sort((a, b) => (counts[b] - counts[a]) || a.localeCompare(b, "zh"));
    if (freeList.length) {
      html += `<div class="tag-group-head"><i class="dot"></i>${t("未分组", "Ungrouped")}</div>`;
      html += freeList.map((n) => tagRowHTML({ name: n, aliases: [], group: "", color: null }, counts)).join("");
    }

    // 无任何可筛选项时的空态提示 + AI 智能搜索入口（启用时）
    const noFilterable = !groups.some((g) => TAGS.tags.some((t) => t.group === g.id && counts[t.name] > 0)) && !freeList.length;
    if (noFilterable) {
      if (q && aiEnabled()) {
        html += `<button class="tag-menu-item ai-run" data-ai-q="${escAttr(q)}" title="${t("用 AI 理解自然语言", "Ask AI")}">
          <span class="nm">🤖 ${t("AI 智能搜索", "AI search")}「${esc(q)}」</span><span class="cnt">›</span></button>`;
      } else {
        html += `<div class="tag-suggest ts-empty" style="margin:6px 8px">${t("没有匹配的标签", "No matching tags")}</div>`;
      }
    }
  }
  list.innerHTML = html;
}

/* ---------- 图库墙页 ---------- */
function initGallery() {
  const grid = document.getElementById("grid");
  const lightbox = document.getElementById("lightbox");
  const lbImg = document.getElementById("lbImg");

  // 标签筛选菜单（v0.11：分组视图 + 搜索，内容由 renderTagMenuContent 渲染）
  const fabBtn = document.getElementById("fabBtn");
  const fabDot = document.getElementById("fabDot");
  const tagMenu = document.getElementById("tagMenu");
  const tagMenuList = document.getElementById("tagMenuList");
  const tagSearch = document.getElementById("tagSearch");
  const tagSearchClear = document.getElementById("tagSearchClear");
  const tagFlyout = initFlyout(fabBtn, tagMenu);

  let shown = 0;
  const PAGE = 12;
  let filtered = [...PHOTOS];

  // 事件委托：标签行筛选切换 / 组头折叠展开 / AI 行 / 相册行
  tagMenuList.addEventListener("click", (e) => {
    const aiRow = e.target.closest("[data-ai-q]");
    if (aiRow) {
      runAiTagSearch(aiRow.dataset.aiQ, aiRow);
      return;
    }
    const clearAi = e.target.closest("[data-clear-ai]");
    if (clearAi) {
      setAiFilter(null);
      if (tagFlyout) tagFlyout.close();
      return;
    }
    const ab = e.target.closest("[data-album]");
    if (ab) {
      activeAlbumId = activeAlbumId === ab.dataset.album ? null : ab.dataset.album;
      renderTagMenuContent();
      if (window.__applyFilter) window.__applyFilter();
      if (tagFlyout) tagFlyout.close();
      return;
    }
    const row = e.target.closest(".tag-menu-item");
    if (row) {
      const name = row.dataset.tag || null;
      setTagFilter(activeTagName === name ? null : name);
      if (tagSearch) { tagSearch.value = ""; if (tagSearchClear) tagSearchClear.classList.remove("on"); }
      renderTagMenuContent();
      if (tagFlyout) tagFlyout.close();
      return;
    }
    const gh = e.target.closest(".tag-group-head");
    if (gh && gh.dataset.gid) {
      const gid = gh.dataset.gid;
      const collapsed = collapsedGroups.has(gid);
      if (collapsed) collapsedGroups.delete(gid);
      else collapsedGroups.add(gid);
      // v0.14.1：纯 DOM 折叠（不重建列表，避免 flyout 因 DOM 替换而退出）
      gh.classList.toggle("collapsed", !collapsed);
      let node = gh.nextElementSibling;
      while (node && !node.classList.contains("tag-group-head")) {
        if (node.classList.contains("tag-menu-item")) node.classList.toggle("is-hidden", !collapsed);
        node = node.nextElementSibling;
      }
    }
  });
  // 组内搜索：匹配标签名与别名
  if (tagSearch) {
    tagSearch.addEventListener("input", () => {
      if (tagSearchClear) tagSearchClear.classList.toggle("on", !!tagSearch.value.trim());
      renderTagMenuContent();
    });
    if (tagSearchClear) {
      tagSearchClear.addEventListener("click", () => {
        tagSearch.value = "";
        tagSearchClear.classList.remove("on");
        renderTagMenuContent();
        tagSearch.focus();
      });
    }
  }

  // 设置筛选（供菜单行 / 外部调用），再点同标签 = 取消回全部
  window.__setTagFilter = setTagFilter;
  function setTagFilter(name) {
    aiFilter = null; // 点具体标签/全部时清除 AI 语义筛选
    activeTagName = name;
    fabDot.classList.toggle("on", !!name);
    applyFilter();
  }

  // 标签筛选（v0.8.6 / v0.11.2 / v0.12：收藏 / 排序 / AI / 相册叠加）
  function basePred(p) {
    if (aiFilter && aiFilter.tags && aiFilter.tags.length) {
      return aiFilter.match === "all"
        ? aiFilter.tags.every((t) => p.tags.includes(t))
        : aiFilter.tags.some((t) => p.tags.includes(t));
    }
    if (activeTagName === "__fav") return favs.has(p.id);
    return !activeTagName || p.tags.includes(activeTagName);
  }
  function albumPred(p) {
    if (!activeAlbumId) return true;
    if (activeAlbumId === "__none") {
      const inAny = new Set(ALBUMS.albums.flatMap((a) => a.photoIds));
      return !inAny.has(p.id);
    }
    const a = albumOf(activeAlbumId);
    return !!a && a.photoIds.includes(p.id);
  }
  function applyFilter() {
    shown = 0;
    filtered = sortPhotos(PHOTOS.filter((p) => albumPred(p) && basePred(p)));
    render();
  }
  window.__applyFilter = applyFilter;

  const favSVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`;
  function cardHTML(p) {
    return `<div class="card${selected.has(p.id) ? " sel" : ""}" data-id="${p.id}" draggable="true">
      <img loading="lazy" draggable="false" src="${cardImgSrc(p)}" data-orig="${p.url}" alt="${escAttr(p.title)}" onerror="this.onerror=null;this.src=this.dataset.orig">
      <button class="pick" title="选中">✓</button>
      <button class="fav-star${isFav(p.id) ? " on" : ""}" title="${isFav(p.id) ? "取消收藏" : "收藏"}">${favSVG}</button>
      <div class="card__content">
        <div class="card__tags">${p.tags.slice(0, 3).map(tagChip).join("")}</div>
        <p class="card__meta">${fmtDate(p.takenAt)} · ${fmtSize(p.size)}</p>
      </div>
    </div>`;
  }

  function updateLoadMore() {
    const lm = document.getElementById("loadMore");
    if (!lm) return;
    lm.style.display = shown < filtered.length ? "block" : "none";
    lm.querySelector("span").textContent =
      shown < filtered.length
        ? t("已加载", "Loaded") + ` ${shown} / ${filtered.length} · ${t("滚动加载更多…", "scroll for more…")}`
        : t("已全部加载", "All loaded") + `（${filtered.length} ${t("张", "photos")}）`;
  }

  /* 全量渲染（初始 / 筛选 / 排序 / 数据变化时；滚动加载走 appendMore） */
  function render() {
    grid.innerHTML = "";
    const slice = filtered.slice(0, shown || PAGE);
    if (!slice.length) {
      document.getElementById("loadMore").style.display = "none";
      // 加载中 / 加载失败的状态不覆盖，其余情况显示空态动画
      const st = document.getElementById("galleryState");
      if (!(st && (st.classList.contains("loading") || st.classList.contains("error")))) {
        showGalleryState("empty");
      }
      return;
    }
    showGalleryState(null);
    grid.innerHTML = slice.map(cardHTML).join("");
    shown = slice.length;
    updateLoadMore();
    // 视口出现动画（仅首次整批；滚动加载的新卡直接可见，避免闪屏）
    initReveal(grid, ".card");
  }
  window.__renderGallery = () => render();

  /* 无限滚动（v0.13.2：增量追加，不再清空重建，杜绝整页闪屏） */
  let scrollBusy = false;
  window.addEventListener("scroll", () => {
    if (scrollBusy) return;
    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 420) {
      if (shown < filtered.length) {
        scrollBusy = true;
        const start = grid.querySelectorAll(".card").length;
        shown = Math.min(shown + PAGE, filtered.length);
        const more = filtered.slice(start, shown);
        if (more.length) {
          grid.insertAdjacentHTML("beforeend", more.map(cardHTML).join(""));
          const newCards = [...grid.querySelectorAll(".card")].slice(start);
          newCards.forEach((c) => c.classList.add("visible"));
        }
        updateLoadMore();
        scrollBusy = false;
      }
    }
  });

  /* 卡片拖拽（v0.14：拖到标签管理窗口的标签上打标） */
  grid.addEventListener("dragstart", (e) => {
    const card = e.target.closest(".card");
    if (!card || selectMode) { e.preventDefault(); return; }
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "copy";
    try { e.dataTransfer.setData("text/plain", card.dataset.id); } catch (err) { /* ignore */ }
  });
  grid.addEventListener("dragend", (e) => {
    const card = e.target.closest(".card");
    if (card) card.classList.remove("dragging");
  });

  /* 卡片事件委托（v0.13.2：星标 / 选中 / 打开灯箱，避免整批重绑） */
  grid.addEventListener("click", (e) => {
    const star = e.target.closest(".fav-star");
    if (star) {
      const card = star.closest(".card");
      const id = card && card.dataset.id;
      if (!id) return;
      toggleFav(id);
      star.classList.toggle("on", isFav(id));
      renderTagMenuContent();
      if (activeTagName === "__fav" && !isFav(id)) applyFilter(); // 收藏视图取消收藏 → 移除卡片
      return;
    }
    const card = e.target.closest(".card");
    if (!card) return;
    const id = card.dataset.id;
    if (selectMode) {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      card.classList.toggle("sel", selected.has(id));
      updateBatchUI();
    } else {
      openLightbox(id);
    }
  });

  // 灯箱（全局实现 openLightboxById；←→ 按当前筛选视图顺序切换）
  const openLightbox = openLightboxById;
  const lbCloseEl = document.querySelector(".lb-close");
  const lbPrevEl = document.querySelector(".lb-prev");
  const lbNextEl = document.querySelector(".lb-next");
  if (lbCloseEl) lbCloseEl.onclick = () => { stopSlide(); lightbox.classList.remove("open"); };
  if (lbPrevEl) lbPrevEl.onclick = () => step(-1);
  if (lbNextEl) lbNextEl.onclick = () => step(1);
  function step(d) {
    const cur = lightbox.dataset.cur;
    // 搜索窗口打开灯箱时可能不在当前筛选列表，回退到全图顺序
    const list = filtered.length && filtered.some((x) => x.id === cur) ? filtered : PHOTOS;
    if (!list.length) return;
    const i = list.findIndex((x) => x.id === cur);
    const next = list[(i + d + list.length) % list.length];
    openLightbox(next.id);
  }
  document.addEventListener("keydown", (e) => {
    if (!lightbox.classList.contains("open")) return;
    if (e.key === "ArrowLeft") step(-1);
    if (e.key === "ArrowRight") step(1);
    if (e.key === " ") { e.preventDefault(); toggleSlide(); } // 空格播放/暂停（v0.13）
  });
  window.__stopSlide = stopSlide;

  /* ---------- 灯箱工具条（v0.11.2） ---------- */
  const lbToolFav = document.getElementById("lbToolFav");
  const lbToolInfo = document.getElementById("lbToolInfo");
  const lbToolRot = document.getElementById("lbToolRot");
  const lbToolDl = document.getElementById("lbToolDl");
  const lbToolEdit = document.getElementById("lbToolEdit");
  const curPhoto = () => PHOTOS.find((x) => x.id === lightbox.dataset.cur);

  if (lbToolFav) {
    lbToolFav.onclick = () => {
      const p = curPhoto();
      if (!p) return;
      toggleFav(p.id);
      lbToolFav.classList.toggle("fav-on", isFav(p.id));
      renderTagMenuContent();
      if (activeTagName === "__fav" && !isFav(p.id)) applyFilter();
      else window.__renderGallery();
    };
  }
  if (lbToolInfo) {
    lbToolInfo.onclick = () => {
      const off = lightbox.classList.toggle("no-info");
      lbToolInfo.classList.toggle("on", !off);
    };
  }
  if (lbToolRot) {
    lbToolRot.onclick = async () => {
      const p = curPhoto();
      if (!p || lbToolRot.disabled) return;
      lbToolRot.disabled = true;
      try {
        const res = await fetch(p.url, { cache: "reload" });
        if (!res.ok) throw new Error("图片读取失败");
        const blob = await res.blob();
        const bmp = await createImageBitmap(blob);
        const canvas = document.createElement("canvas");
        canvas.width = bmp.height;
        canvas.height = bmp.width;
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingQuality = "high";
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate(Math.PI / 2);
        ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
        bmp.close();
        let dataUrl = canvas.toDataURL("image/webp", 0.92);
        let mime = "image/webp";
        if (!dataUrl.startsWith("data:image/webp")) {
          mime = "image/jpeg";
          dataUrl = canvas.toDataURL("image/jpeg", 0.92);
        }
        let thumbDataUrl = null;
        try { thumbDataUrl = await makeThumbDataUrl(dataUrl); } catch (e) { /* ignore */ }
        const r = await apiFetch(`/api/photos/${p.id}/image`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataBase64: dataUrl, thumbBase64: thumbDataUrl }),
        });
        const d = await r.json();
        if (!d.ok) throw new Error(d.error || "保存失败");
        await loadData();
        if (window.__refreshGallery) window.__refreshGallery();
        openLightboxById(p.id, true); // 绕过 immutable 缓存，展示旋转后新图
      } catch (err) {
        alert("旋转失败：" + (err && err.message ? err.message : err));
      }
      lbToolRot.disabled = false;
    };
  }
  if (lbToolDl) {
    lbToolDl.onclick = () => {
      const p = curPhoto();
      if (!p) return;
      const ext = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" }[p.mime] || "jpg";
      const a = document.createElement("a");
      a.href = `/api/photos/${p.id}/raw`;
      a.download = `${String(p.title || "photo").replace(/[\\/:*?"<>|]/g, "_")}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    };
  }
  if (lbToolEdit) {
    lbToolEdit.onclick = () => {
      const p = curPhoto();
      if (p) openEditModal(p.id);
    };
  }
  const lbToolAlbum = document.getElementById("lbToolAlbum");
  if (lbToolAlbum) {
    lbToolAlbum.onclick = () => {
      const p = curPhoto();
      if (p) openAlbumPicker([p.id]);
    };
  }

  /* ---------- 幻灯片放映（v0.13） ---------- */
  const SLIDE_KEY = "rn_slide";
  let slideTimer = null;
  let slidePlaying = false;
  let slideHideTimer = null;
  const lbToolPlay = document.getElementById("lbToolPlay");
  const slideSec = () => {
    const v = parseInt(localStorage.getItem(SLIDE_KEY) || "5", 10);
    return Number.isFinite(v) && v > 0 ? v : 5;
  };
  function stopSlide() {
    slidePlaying = false;
    if (slideTimer) { clearInterval(slideTimer); slideTimer = null; }
    if (slideHideTimer) { clearTimeout(slideHideTimer); slideHideTimer = null; }
    lightbox.classList.remove("sliding", "tools-hidden");
    if (lbToolPlay) {
      lbToolPlay.classList.remove("playing");
      lbToolPlay.title = "幻灯片放映";
    }
    const badge = lightbox.querySelector(".lb-slide-badge");
    if (badge) badge.remove();
  }
  function startSlide() {
    const total = filtered.length || PHOTOS.length;
    if (!total) return;
    stopSlide();
    slidePlaying = true;
    lightbox.classList.add("sliding");
    if (lbToolPlay) {
      lbToolPlay.classList.add("playing");
      lbToolPlay.title = "暂停（空格）";
    }
    // 顶部徽标提示间隔
    const badge = document.createElement("div");
    badge.className = "lb-slide-badge";
    badge.textContent = `自动播放 · 每 ${slideSec()} 秒`;
    lightbox.appendChild(badge);
    setTimeout(() => badge.remove(), 2600);
    slideTimer = setInterval(() => {
      if (!lightbox.classList.contains("open")) { stopSlide(); return; }
      document.querySelector(".lb-next").click();
    }, slideSec() * 1000);
    armHideTools();
  }
  function toggleSlide() {
    if (slidePlaying) stopSlide();
    else startSlide();
  }
  function armHideTools() {
    if (!slidePlaying) return;
    lightbox.classList.remove("tools-hidden");
    if (slideHideTimer) clearTimeout(slideHideTimer);
    slideHideTimer = setTimeout(() => lightbox.classList.add("tools-hidden"), 3000);
  }
  if (lbToolPlay) {
    lbToolPlay.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleSlide();
    });
    lightbox.addEventListener("mousemove", armHideTools);
  }
  // 播放 / 暂停状态在打开灯箱时复位
  const origOpenLb = openLightboxById;
  window.openLightboxById = (id, bust) => {
    if (slidePlaying) stopSlide();
    origOpenLb(id, bust);
  };

  render();

  // 供上传/导入/清空/编辑后刷新图库：保留当前筛选与排序
  window.__refreshGallery = () => {
    shown = 0;
    filtered = sortPhotos(PHOTOS.filter((p) => albumPred(p) && basePred(p)));
    render();
    renderTagMenuContent();
    if (window.__refreshTagManager) window.__refreshTagManager();
  };
}

/* ---------- 上传页（v0.9.6：全部转为 WebP，无默认标题） ---------- */
function initUpload() {
  const dz = document.getElementById("dz");
  const fileInput = document.getElementById("fileInput");
  const queue = document.getElementById("queue");
  const btnUpload = document.getElementById("btnUpload");
  const files = [];

  dz.addEventListener("click", () => fileInput.click());
  // v0.14.3：仅外部文件拖入时高亮/放行；行内拖分类不触发（避免与分类槽冲突）
  const isFileDrag = (e) => !!(e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files")) && !window.__uqDragItems;
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => {
    if (isFileDrag(e)) { e.preventDefault(); dz.classList.add("drag"); }
  }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));
  fileInput.addEventListener("change", () => addFiles(fileInput.files));

  function addFiles(list) {
    [...list].slice(0, 12 - files.length).forEach((f) => {
      const item = { f, status: "ready", pct: 0 };
      files.push(item);
      const row = document.createElement("div");
      row.className = "uq-item";
      row.innerHTML = `
        <img class="thumb" alt="" draggable="false">
        <div class="info">
          <div class="uq-name-row"><span class="name">${esc(f.name)}</span></div>
          <div class="uq-tags"></div>
          <div class="size">${fmtSize(f.size)} · ${f.type || "未知格式"}</div>
          <div class="sub">待上传</div>
          <div class="progress"><div class="bar"></div></div>
        </div>
        <div class="status">待上传</div>
        <div class="uq-ops">
          <button class="u-edit" title="编辑描述 / 标签">✎</button>
          <button class="danger u-del" title="从队列移除">✕</button>
        </div>`;
      const img = row.querySelector("img");
      const reader = new FileReader();
      reader.onload = (e) => { img.src = e.target.result; };
      reader.readAsDataURL(f);
      item.row = row;
      queue.appendChild(row);
      row.__item = item;
      row.querySelector(".sub").textContent = "拖到右侧分类槽，或点行多选后拖动";
      // v0.14.3：整行可拖到右侧分类槽
      row.draggable = true;
      row.addEventListener("dragstart", (e) => {
        if (item.status === "ok") { e.preventDefault(); return; }
        let group = uqSelSet.has(item) ? [...uqSelSet] : [item];
        group = group.filter((x) => x.status !== "ok");
        if (!group.length) { e.preventDefault(); return; }
        window.__uqDragItems = group;
        e.dataTransfer.effectAllowed = "copyMove";
        try { e.dataTransfer.setData("text/x-uq", String(group.length)); } catch (err) { /* ignore */ }
        row.classList.add("dragging");
        if (group.length > 1) setUqStatus(`已选 ${group.length} 张，拖到分类槽即可整批归类`);
      });
      row.addEventListener("dragend", () => {
        row.classList.remove("dragging");
        document.querySelectorAll(".uq-slot.drop-over").forEach((s) => s.classList.remove("drop-over"));
        window.__uqDragItems = null;
      });
      // v0.14.3：点击行 = 多选（再拖任意一张 = 整批归类）
      row.addEventListener("click", (e) => {
        if (e.target.closest("button") || e.target.closest(".uq-tags")) return;
        if (item.status === "ok") return;
        toggleUqSelect(item);
      });
      // v0.13：逐张编辑 / 移除
      row.querySelector(".u-edit").onclick = () => openUqEdit(item);
      row.querySelector(".u-del").onclick = () => {
        if (uqSelSet.has(item)) { uqSelSet.delete(item); }
        const idx = files.indexOf(item);
        if (idx >= 0) files.splice(idx, 1);
        row.remove();
        btnUpload.disabled = !files.length;
        updateUqSelStatus();
        refreshUqSlots();
      };
    });
    btnUpload.disabled = !files.length;
    btnUpload.textContent = "开始上传";
    const upHintFresh = document.getElementById("upHint");
    if (upHintFresh) upHintFresh.innerHTML = "拖图片到右侧分类槽可单独归类；<b>15 秒</b>后自动上传，也可点按钮立即开始";
    refreshUqSlots();
    // v0.14.3：延迟自动上传，给拖拽分类留时间（可点「开始上传」立即开始）
    if (files.length) {
      clearTimeout(window.__uqAutoTimer);
      window.__uqAutoTimer = setTimeout(() => startUpload(), 15000);
    }
  }

  // 浏览器端转换：最长边 2048、WebP 质量 0.85（不支持 WebP 编码时回退 JPEG）
  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = async () => {
          const scale = Math.min(1, 2048 / Math.max(img.width, img.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          // v0.12：加水印（启用时；失败不影响上传）
          try { await paintWatermark(ctx, canvas.width, canvas.height); } catch (e) { /* ignore */ }
          const mime = canvas.toDataURL("image/webp").startsWith("data:image/webp") ? "image/webp" : "image/jpeg";
          resolve({ dataUrl: canvas.toDataURL(mime, 0.85), mime, width: canvas.width, height: canvas.height });
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // 单张真实上传（v0.9：canvas 转 WebP → XHR 带进度 → Blobs）
  function uploadOne(it) {
    return new Promise((resolve, reject) => {
      const row = it.row;
      const setSub = (t) => { row.querySelector(".sub").textContent = t; };
      const setPct = (p) => { row.querySelector(".bar").style.width = p + "%"; row.querySelector(".status").textContent = p + "%"; };
      setSub("转换 WebP 中…");
      compressImage(it.f)
        .then(async ({ dataUrl, mime }) => {
          // 生成缩略图（v0.12）
          let thumbDataUrl = null;
          try { thumbDataUrl = await makeThumbDataUrl(dataUrl); } catch (e) { /* 缩略图失败可继续 */ }
          // 重复检测（内容 sha1，v0.12）
          const hash = await sha1HexOf(dataUrl);
          if (hash) {
            try {
              const chk = await apiFetch(`/api/photos/check?hash=${encodeURIComponent(hash)}`).then((r) => r.json());
              if (chk.duplicate) {
                const force = await askConfirmAsync(
                  "检测到重复图片",
                  "图库中已存在内容完全相同的图片。仍要再上传一份吗？",
                  "仍然上传"
                );
                if (!force) {
                  row.querySelector(".status").textContent = "↻";
                  row.querySelector(".status").className = "status ok";
                  setSub("重复，已跳过");
                  resolve();
                  return;
                }
              }
            } catch (e) { /* 查重失败不阻塞上传 */ }
          }
          setSub("上传中…");
          const xhr = new XMLHttpRequest();
          xhr.open("POST", "/api/photos");
          for (const [k, v] of Object.entries(apiHeaders())) xhr.setRequestHeader(k, v);
          xhr.setRequestHeader("Content-Type", "application/json");
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) setPct(Math.round((e.loaded / e.total) * 100));
          };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              row.querySelector(".status").textContent = "✓";
              row.querySelector(".status").className = "status ok";
              row.classList.add("done");
              setSub("已上传");
              resolve();
            } else {
              let msg = "上传失败";
              try { msg = JSON.parse(xhr.responseText).error || msg; } catch (e) { /* ignore */ }
              row.querySelector(".status").textContent = "✗";
              row.querySelector(".status").className = "status err";
              setSub(msg);
              reject(new Error(msg));
            }
          };
          xhr.onerror = () => {
            row.querySelector(".status").className = "status err";
            setSub("网络错误");
            reject(new Error("network"));
          };
          const tags = rowSendTags(it); // 全局 ∪ 行分类（v0.14.2）
          // 标题：逐张编辑优先，否则取文件名（去扩展名）
          const title = it.title || it.f.name.replace(/\.[^.]+$/, "").trim() || undefined;
          xhr.send(JSON.stringify({
            dataBase64: dataUrl,
            thumbBase64: thumbDataUrl,
            mime,
            title,
            desc: it.desc || "",
            tags,
          }));
        })
        .catch((e) => {
          row.querySelector(".status").className = "status err";
          setSub("转换失败");
          reject(e);
        });
    });
  }

  // 开始上传（v0.9.18 自动调用；v0.13 支持延迟后手动立即开始）
  function startUpload() {
    clearTimeout(window.__uqAutoTimer);
    // 防丢：输入框还有未回车确认的文本时自动补为标签（v0.14.2）
    const uqBox = window.__upTagList;
    const uqInp = document.getElementById("tagInputUpload");
    if (uqBox && uqInp && uqInp.value.trim()) addTagChip(uqBox, uqInp.value.trim());
    const items = files.filter((it) => it.status === "ready");
    if (!items.length) return;
    const upHintEl = document.getElementById("upHint");
    if (upHintEl) upHintEl.innerHTML = "正在上传…请勿关闭窗口";
    btnUpload.textContent = `处理中… (0/${items.length})`;
    btnUpload.disabled = true;
    let done = 0;
    (async () => {
      for (const it of items) {
        it.status = "uploading";
        try {
          await uploadOne(it);
          it.status = "ok";
        } catch (e) {
          it.status = "err";
        }
        if (++done === items.length) {
          btnUpload.disabled = false;
          btnUpload.textContent = "全部完成";
          if (upHintEl) upHintEl.innerHTML = "全部完成 ✓ 可继续添加图片";
          cancelUqSel();
          if (USE_API) {
            await loadData();
            if (window.__refreshGallery) window.__refreshGallery();
          }
        } else {
          btnUpload.textContent = `处理中… (${done}/${items.length})`;
        }
      }
    })();
  }
  btnUpload.addEventListener("click", startUpload);

  // 标签输入（v0.14：统一组件：focus 全列表点选、回车自定义、退格删 chip、快捷点选）
  const tagList = document.getElementById("tagListUpload");
  bindTagSuggest(document.getElementById("tagInputUpload"), document.getElementById("tagSuggest"), tagList, refreshQuickPickAll);
  window.__upTagList = tagList; // 供 uploadOne 读取
  // 右侧分类槽（v0.14.3）：槽容器事件委托 + 自定义分类输入
  const uqSlotsEl = document.getElementById("uqSlots");
  if (uqSlotsEl) {
    uqSlotsEl.addEventListener("dragover", (e) => {
      const slot = e.target.closest(".uq-slot");
      if (!slot || !(window.__uqDragItems || []).length) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      uqSlotsEl.querySelectorAll(".uq-slot.drop-over").forEach((s) => { if (s !== slot) s.classList.remove("drop-over"); });
      slot.classList.add("drop-over");
    });
    uqSlotsEl.addEventListener("dragleave", (e) => {
      const slot = e.target.closest(".uq-slot");
      if (slot) slot.classList.remove("drop-over");
    });
    uqSlotsEl.addEventListener("drop", (e) => {
      const slot = e.target.closest(".uq-slot");
      if (!slot) return;
      e.preventDefault();
      slot.classList.remove("drop-over");
      const items = window.__uqDragItems || [];
      window.__uqDragItems = null;
      if (items.length) {
        applyTagsToItems(items, slot.dataset.tag);
        clearUqSelection();
      }
    });
  }
  const uqNewSlotInput = document.getElementById("uqNewSlotInput");
  if (uqNewSlotInput) {
    uqNewSlotInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const v = uqNewSlotInput.value.trim();
      if (!v) return;
      uqNewSlotInput.value = "";
      const libHit = TAGS.tags.find((t) => t.name === v);
      if (libHit) {
        // 已在标签库：仅提示并闪烁对应槽
        const slotEl = [...(uqSlotsEl ? uqSlotsEl.querySelectorAll(".uq-slot") : [])].find((s) => s.dataset.tag === v);
        if (slotEl) { slotEl.classList.add("flash"); setTimeout(() => slotEl.classList.remove("flash"), 1000); }
        return;
      }
      uqExtraSlots.add(v);
      refreshUqSlots();
      const slotEl = uqSlotsEl ? [...uqSlotsEl.querySelectorAll(".uq-slot")].find((s) => s.dataset.tag === v) : null;
      if (slotEl) { slotEl.classList.add("flash"); setTimeout(() => slotEl.classList.remove("flash"), 1000); }
    });
  }
  refreshUqSlots();
}
/* ---------- 批量选择模式（v0.11.2） ---------- */
function updateBatchUI() {
  const bar = document.getElementById("batchBar");
  if (!bar) return;
  bar.hidden = !selectMode;
  const cnt = document.getElementById("batchCount");
  if (cnt) cnt.textContent = t("已选", "Selected") + ` ${selected.size} ` + t("张", "");
}
function toggleSelectMode() {
  selectMode = !selectMode;
  document.body.classList.toggle("select-mode", selectMode);
  const b = document.getElementById("fabSelectBtn");
  if (b) b.classList.toggle("on", selectMode);
  selected.clear();
  // 勾选圈显隐由 body.select-mode 的 CSS 控制；仅清理选中高亮，不整屏重绘（v0.13.2）
  document.querySelectorAll("#grid .card.sel").forEach((el) => el.classList.remove("sel"));
  updateBatchUI();
}
function exitSelectMode() {
  if (!selectMode) return;
  toggleSelectMode();
}
function initSelection() {
  const btn = document.getElementById("fabSelectBtn");
  const bar = document.getElementById("batchBar");
  if (!btn || !bar) return;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleSelectMode();
  });
  document.getElementById("batchCancel").addEventListener("click", exitSelectMode);
  document.getElementById("batchDel").addEventListener("click", batchDelete);
  document.getElementById("batchTag").addEventListener("click", openBatchTag);
}
async function batchDelete() {
  const ids = [...selected];
  if (!ids.length) return;
  askConfirm(`删除选中的 ${ids.length} 张图片？`, "原图与元数据将被永久删除，不可恢复。建议先导出元数据备份。", "全部删除", async () => {
    try {
      await Promise.all(ids.map((id) => apiFetch(`/api/photos/${id}`, { method: "DELETE" })));
      await loadData();
      if (window.__refreshGallery) window.__refreshGallery();
      exitSelectMode();
    } catch (e) {
      alert("删除失败：" + e.message);
    }
  });
}

/* ---------- 批量加标签（v0.11.2） ---------- */
let btMode = "add";
function openBatchTag() {
  if (!selected.size) return;
  document.getElementById("batchTagTitle").textContent = `为选中的 ${selected.size} 张图片添加标签`;
  const box = document.getElementById("btTagBox");
  box.querySelectorAll(".t").forEach((el) => el.remove());
  const err = document.getElementById("btErr");
  err.style.display = "none";
  document.getElementById("batchTagModal").classList.add("open");
  setBtMode("add");
}
function setBtMode(mode) {
  btMode = mode;
  const seg = document.getElementById("btMode");
  if (seg) seg.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  const box = document.getElementById("btTagBox");
  const hint = box && box.parentElement && box.parentElement.querySelector(".hint");
  const input = document.getElementById("btTagInput");
  if (mode === "clear") {
    box.querySelectorAll(".t").forEach((el) => el.remove());
    if (input) input.disabled = true;
    if (hint) hint.textContent = "清空所选图片的全部标签";
  } else {
    if (input) input.disabled = false;
    if (hint) hint.textContent = mode === "replace" ? "将覆盖为以下标签（原标签移除）" : "添加到全部选中图片（原有标签保留）";
  }
}
async function applyBatchTag() {
  const box = document.getElementById("btTagBox");
  const inputTags = tagsOfBox(box);
  const okBtn = document.getElementById("btOk");
  const err = document.getElementById("btErr");
  if (btMode === "replace" && !inputTags.length) {
    err.textContent = "覆盖模式请至少输入一个标签";
    err.style.display = "block";
    return;
  }
  okBtn.disabled = true;
  try {
    const ids = [...selected];
    await Promise.all(ids.map(async (id) => {
      const p = PHOTOS.find((x) => x.id === id);
      if (!p) return;
      let next;
      if (btMode === "clear") next = [];
      else if (btMode === "replace") next = inputTags.slice(0, 10);
      else next = [...new Set([...(p.tags || []), ...inputTags])].slice(0, 10);
      await apiFetch(`/api/photos/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: next }),
      });
    }));
    document.getElementById("batchTagModal").classList.remove("open");
    await loadData();
    if (window.__refreshGallery) window.__refreshGallery();
    exitSelectMode();
  } catch (e) {
    err.textContent = "操作失败：" + e.message;
    err.style.display = "block";
  }
  okBtn.disabled = false;
}
/* ---------- 单张编辑弹窗（v0.11.2：描述 / 标签 / 删除） ---------- */
let editTargetId = null;
function openEditModal(id) {
  const p = PHOTOS.find((x) => x.id === id);
  if (!p) return;
  editTargetId = id;
  document.getElementById("edDesc").value = p.desc || "";
  const box = document.getElementById("edTagBox");
  box.querySelectorAll(".t").forEach((el) => el.remove());
  (p.tags || []).forEach((t) => addTagChip(box, t));
  const err = document.getElementById("edErr");
  err.style.display = "none";
  document.getElementById("editModal").classList.add("open");
  if (window.__refreshQuickPick) window.__refreshQuickPick();
}
async function saveEditModal() {
  const id = editTargetId;
  if (!id) return;
  const err = document.getElementById("edErr");
  const btn = document.getElementById("edSave");
  btn.disabled = true;
  try {
    const r = await apiFetch(`/api/photos/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        desc: document.getElementById("edDesc").value.trim(),
        tags: tagsOfBox(document.getElementById("edTagBox")),
      }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || "保存失败");
    document.getElementById("editModal").classList.remove("open");
    await loadData();
    if (window.__refreshGallery) window.__refreshGallery();
    const lb = document.getElementById("lightbox");
    if (lb.classList.contains("open") && lb.dataset.cur === id) openLightboxById(id);
  } catch (e) {
    err.textContent = e.message;
    err.style.display = "block";
  }
  btn.disabled = false;
}
function delFromEditModal() {
  const id = editTargetId;
  const p = PHOTOS.find((x) => x.id === id);
  if (!p) return;
  askConfirm("删除这张图片？", "原图与元数据将被永久删除，不可恢复。", "删除", async () => {
    try {
      await apiFetch(`/api/photos/${id}`, { method: "DELETE" });
    } catch (e) {
      alert("删除失败：" + e.message);
      return;
    }
    document.getElementById("editModal").classList.remove("open");
    const lb = document.getElementById("lightbox");
    if (lb.classList.contains("open")) lb.classList.remove("open");
    await loadData();
    if (window.__refreshGallery) window.__refreshGallery();
  });
}
function initEditModal() {
  const m = document.getElementById("editModal");
  if (!m) return;
  document.getElementById("edCancel").addEventListener("click", () => m.classList.remove("open"));
  document.getElementById("edSave").addEventListener("click", saveEditModal);
  const delBtn = document.createElement("div");
  delBtn.className = "ed-del";
  delBtn.innerHTML = `<button class="btn danger sm" type="button" id="edDelete">删除这张图片</button>`;
  m.querySelector("form").appendChild(delBtn);
  m.querySelector("#edDelete").addEventListener("click", delFromEditModal);
  bindTagSuggest(document.getElementById("edTagInput"), document.getElementById("edTagSuggest"), document.getElementById("edTagBox"), refreshQuickPickAll);
  const btSeg = document.getElementById("btMode");
  if (btSeg) btSeg.querySelectorAll(".seg-btn").forEach((b) => b.addEventListener("click", () => setBtMode(b.dataset.mode)));
  bindTagSuggest(document.getElementById("btTagInput"), document.getElementById("btTagSuggest"), document.getElementById("btTagBox"));
  document.getElementById("btCancel").addEventListener("click", () => document.getElementById("batchTagModal").classList.remove("open"));
  document.getElementById("btOk").addEventListener("click", applyBatchTag);
}

/* ---------- 排序菜单（v0.11.2） ---------- */
function initSortMenu() {
  const btn = document.getElementById("fabSortBtn");
  const menu = document.getElementById("sortMenu");
  if (!btn || !menu) return;
  const flyout = initFlyout(btn, menu);
  const items = menu.querySelectorAll(".page-menu-item");
  const saved = localStorage.getItem(SORT_KEY);
  if (saved === "title") localStorage.removeItem(SORT_KEY); // 标题排序已移除（v0.13.1）
  if (saved) SORT_MODE = saved;
  const apply = (mode) => {
    SORT_MODE = mode;
    localStorage.setItem(SORT_KEY, mode);
    items.forEach((it) => it.classList.toggle("on", it.dataset.sort === mode));
    if (window.__applyFilter) window.__applyFilter();
    flyout.close();
  };
  items.forEach((it) => {
    it.classList.toggle("on", it.dataset.sort === SORT_MODE);
    it.addEventListener("click", () => apply(it.dataset.sort));
  });
}

/* ---------- AI 功能（v0.12） ---------- */
function initAiSettings() {
  const sec = document.getElementById("aiSection");
  if (!sec) return;
  const on = document.getElementById("aiOn");
  const key = document.getElementById("aiKey");
  const sys = document.getElementById("aiSys");
  const temp = document.getElementById("aiTemp");
  const tempVal = document.getElementById("aiTempVal");
  if (!on || !key) return;
  const applyDisabled = () => sec.classList.toggle("ai-disabled", !on.checked);
  on.checked = aiEnabled();
  key.value = localStorage.getItem(AI_STORE.key) || "";
  sys.value = localStorage.getItem(AI_STORE.sys) || "";
  const t0 = parseFloat(localStorage.getItem(AI_STORE.temp) || "0.7");
  temp.value = String(Number.isFinite(t0) ? t0 : 0.7);
  tempVal.textContent = temp.value;
  applyDisabled();
  on.addEventListener("change", () => { localStorage.setItem(AI_STORE.on, on.checked ? "1" : "0"); applyDisabled(); if (window.__updateAiFab) window.__updateAiFab(); });
  key.addEventListener("change", () => localStorage.setItem(AI_STORE.key, key.value.trim()));
  sys.addEventListener("change", () => localStorage.setItem(AI_STORE.sys, sys.value));
  temp.addEventListener("input", () => { tempVal.textContent = temp.value; localStorage.setItem(AI_STORE.temp, temp.value); });
  const kt = document.getElementById("aiKeyToggle");
  if (kt) kt.addEventListener("click", () => {
    const show = key.type === "password";
    key.type = show ? "text" : "password";
    kt.textContent = show ? "隐藏" : "显示";
  });
  const testBtn = document.getElementById("aiTest");
  const result = document.getElementById("aiTestResult");
  if (testBtn && result) {
    testBtn.addEventListener("click", async () => {
      const ready = aiReady();
      if (!ready.ok) { result.textContent = ready.msg; result.className = "ai-result err"; return; }
      testBtn.disabled = true;
      result.textContent = "连接中…";
      result.className = "ai-result loading";
      try {
        const c = await aiChat("只回复两个字：正常", { temperature: 0.1, maxTokens: 20 });
        result.textContent = `✓ ${c}`;
        result.className = "ai-result ok";
      } catch (e) {
        result.textContent = `✗ ${e.message}`;
        result.className = "ai-result err";
      }
      testBtn.disabled = false;
    });
  }
}

/* AI 语义筛选状态（多标签，菜单顶部可清除） */
function setAiFilter(obj) {
  aiFilter = obj;
  activeTagName = null;
  const fabDot = document.getElementById("fabDot");
  if (fabDot) fabDot.classList.toggle("on", !!obj);
  renderTagMenuContent();
  if (window.__applyFilter) window.__applyFilter();
}

/* 4.1 智能标签搜索：标签菜单里自然语言 → 标签组合 */
async function runAiTagSearch(q, btnEl) {
  const ready = aiReady();
  if (!ready.ok) { alert(ready.msg); return; }
  if (btnEl) { btnEl.disabled = true; btnEl.innerHTML = "🤖 AI 解析中…"; }
  try {
    const obj = await aiJson(
      `图库标签库：${tagListForAI() || "（空）"}。\n用户想筛选「${q}」。请从标签库中选出相关的标签名称。\n只输出 JSON：标签名称数组，例如 ["胡桃","甘雨"]；无匹配则输出 []。`
    );
    const names = Array.isArray(obj) ? obj : (Array.isArray(obj.tags) ? obj.tags : []);
    const valid = names.filter((n) => typeof n === "string" && tagByName(n));
    if (!valid.length) {
      alert("AI 未能从标签库找到相关标签，可尝试更明确的说法，或先在设置中补充标签。");
      return;
    }
    setAiFilter({ tags: valid, match: "any" });
    const menu = document.getElementById("tagMenu");
    const fb = document.getElementById("fabBtn");
    if (menu) menu.classList.remove("open");
    if (fb) fb.classList.remove("open");
  } catch (e) {
    alert("AI 搜索失败：" + e.message);
  } finally {
    if (btnEl) { btnEl.disabled = false; btnEl.innerHTML = ""; }
  }
}

/* 4.2 自然语言筛选（搜索窗口空态） */
async function aiSearchFromInput(q, btn) {
  const ready = aiReady();
  if (!ready.ok) { alert(ready.msg); return; }
  if (btn) { btn.disabled = true; btn.textContent = "AI 解析中…"; }
  try {
    const obj = await aiJson(
      `图库标签库：${tagListForAI() || "（空）"}。\n用户搜索意图：「${q}」。请把意图解析为标签组合。\n只输出 JSON：{"tags":["标签名"],"match":"any"}（要求所有标签时 match 用 "all"）；无法对应任何标签则 tags 为空数组。`
    );
    const tags = Array.isArray(obj.tags) ? obj.tags.filter((n) => typeof n === "string" && tagByName(n)) : [];
    if (!tags.length) {
      alert("AI 无法把这句话对应到现有标签。试试：「找 twitter 的图」这类说法。");
      return;
    }
    setAiFilter({ tags, match: obj.match === "all" ? "all" : "any" });
    // 回到图库视图
    const back = document.getElementById("btnBackSearch");
    if (back) back.click();
  } catch (e) {
    alert("AI 搜索失败：" + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "✨ 让 AI 理解这句搜索"; }
  }
}

/* ---------- URL 导入（v0.12） ---------- */
function initImportUrl() {
  const btn = document.getElementById("btnImportUrl");
  const ta = document.getElementById("urlList");
  const res = document.getElementById("importResult");
  if (!btn || !ta) return;
  btn.addEventListener("click", async () => {
    const urls = ta.value.split(/\r?\n|,|，/).map((s) => s.trim()).filter(Boolean).slice(0, 50);
    if (!urls.length) {
      res.textContent = "请输入至少一个图片 URL";
      res.className = "hint err";
      return;
    }
    btn.disabled = true;
    res.textContent = `正在导入 ${urls.length} 个链接…`;
    res.className = "hint";
    try {
      const tags = [...document.querySelectorAll("#tagListUpload .t")].map((el) => el.childNodes[0].textContent.trim()).filter(Boolean);
      const r = await apiFetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: urls.map((url) => ({ url, tags })) }),
      });
      const d = await r.json();
      const errLines = (d.errors || []).map((e) => `${e.url} → ${e.error}`).join("\n");
      res.textContent = `成功导入 ${d.imported || 0} 个${d.errors && d.errors.length ? `，失败 ${d.errors.length} 个` : ""}${errLines ? "\n" + errLines : ""}`;
      res.className = d.errors && d.errors.length ? "hint err" : "hint ok";
      if (d.imported > 0) {
        await loadData();
        if (window.__refreshGallery) window.__refreshGallery();
      }
    } catch (e) {
      res.textContent = "导入失败：" + e.message;
      res.className = "hint err";
    }
    btn.disabled = false;
  });
}

/* ============================================================
   v0.12 扩展：相册 / 访客门禁 / 操作日志 / 水印 / 语言
   ============================================================ */

/* ---------- 相册 ---------- */
let ALBUMS = { albums: [] };
let activeAlbumId = null;
let albumPickerIds = [];

async function loadAlbums() {
  try {
    const r = await apiFetch("/api/albums");
    const d = await r.json();
    ALBUMS = d && Array.isArray(d.albums) ? d : { albums: [] };
  } catch (e) { ALBUMS = { albums: [] }; }
}
async function saveAlbums() {
  const r = await apiFetch("/api/albums", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ALBUMS),
  });
  const d = await r.json();
  if (!d.ok) throw new Error(d.error || "保存相册失败");
  if (d.config) ALBUMS = d.config;
}
function albumOf(id) { return ALBUMS.albums.find((a) => a.id === id); }

function renderAlbumList() {
  const listEl = document.getElementById("albumList");
  if (!listEl) return;
  if (!ALBUMS.albums.length) {
    listEl.innerHTML = `<div class="logs-empty">还没有相册，在下方新建一个吧</div>`;
    return;
  }
  listEl.innerHTML = ALBUMS.albums.map((a) => `
    <div class="album-row" data-aid="${escAttr(a.id)}">
      <span class="nm">📁 ${esc(a.name)}</span>
      <button class="act" data-act="rename" title="重命名">✎</button>
      <button class="act danger" data-act="del" title="删除相册">×</button>
      <span class="cnt">${a.photoIds.length} 张</span>
    </div>`).join("");
  listEl.querySelectorAll(".album-row").forEach((rowEl) => {
    const id = rowEl.dataset.aid;
    rowEl.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]");
      if (act) {
        e.stopPropagation();
        if (act.dataset.act === "del") {
          askConfirmAsync(`删除相册「${albumOf(id).name}」？`, "相册将被删除，其中的图片不受影响。", "删除").then((ok) => {
            if (!ok) return;
            ALBUMS.albums = ALBUMS.albums.filter((x) => x.id !== id);
            if (activeAlbumId === id) activeAlbumId = null;
            saveAlbums().then(() => { renderAlbumList(); if (window.__refreshGallery) window.__refreshGallery(); });
          });
        } else {
          const nm = rowEl.querySelector(".nm");
          const old = albumOf(id).name;
          nm.innerHTML = `<input type="text" value="${escAttr(old)}" maxlength="30" style="width:140px">`;
          const input = nm.querySelector("input");
          input.focus();
          input.select();
          const commit = async () => {
            const v = input.value.trim();
            if (v && v !== old) {
              albumOf(id).name = v;
              await saveAlbums();
              if (window.__refreshGallery) window.__refreshGallery();
            }
            renderAlbumList();
          };
          input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") commit(); if (ev.key === "Escape") renderAlbumList(); });
          input.addEventListener("blur", commit);
        }
        return;
      }
      addToAlbum(id);
    });
  });
}

function openAlbumPicker(ids) {
  albumPickerIds = ids;
  renderAlbumList();
  const hint = document.getElementById("albumHint");
  if (hint) hint.style.display = "none";
  document.getElementById("albumModal").classList.add("open");
}

async function addToAlbum(aid) {
  const a = albumOf(aid);
  if (!a) return;
  a.photoIds = [...new Set([...a.photoIds, ...albumPickerIds])];
  try {
    await saveAlbums();
    document.getElementById("albumModal").classList.remove("open");
    if (window.__refreshGallery) window.__refreshGallery();
  } catch (e) {
    const hint = document.getElementById("albumHint");
    hint.textContent = "保存失败：" + e.message;
    hint.style.display = "block";
    hint.style.color = "var(--danger)";
  }
}

function initAlbumModal() {
  const modal = document.getElementById("albumModal");
  if (!modal) return;
  document.getElementById("albumClose").addEventListener("click", () => modal.classList.remove("open"));
  document.getElementById("albumNewBtn").addEventListener("click", async () => {
    const name = document.getElementById("albumNewName").value.trim();
    if (!name) return;
    ALBUMS.albums.push({ id: "", name, photoIds: [...albumPickerIds], sort: ALBUMS.albums.length });
    document.getElementById("albumNewName").value = "";
    try {
      await saveAlbums();
      document.getElementById("albumModal").classList.remove("open");
      if (window.__refreshGallery) window.__refreshGallery();
    } catch (e) {
      const hint = document.getElementById("albumHint");
      hint.textContent = "保存失败：" + e.message;
      hint.style.display = "block";
      hint.style.color = "var(--danger)";
    }
  });
  document.getElementById("batchAlbum").addEventListener("click", () => {
    if (selected.size) openAlbumPicker([...selected]);
  });
}

/* ---------- 操作日志 ---------- */
async function openLogs() {
  const m = document.getElementById("logsModal");
  const list = document.getElementById("logsList");
  if (!m) return;
  m.classList.add("open");
  list.innerHTML = `<div class="logs-empty">加载中…</div>`;
  try {
    const r = await apiFetch("/api/meta/logs");
    const d = await r.json();
    const logs = d.logs || [];
    list.innerHTML = logs.length
      ? logs.map((l) => `<div class="log-item">
          <span class="lt">${esc(String(l.t || "").replace("T", " ").slice(0, 19))}</span>
          <span class="la">${esc(l.action)}</span>
          <span class="ld" title="${escAttr(l.detail)}">${esc(l.detail)}</span>
          <span class="lip">${esc(l.ip)}</span></div>`).join("")
      : `<div class="logs-empty">暂无操作记录</div>`;
  } catch (e) {
    list.innerHTML = `<div class="logs-empty">读取失败：${esc(e.message)}（日志需管理员权限）</div>`;
  }
}
function initLogsUI() {
  const btn = document.getElementById("btnLogs");
  const m = document.getElementById("logsModal");
  if (!btn || !m) return;
  btn.addEventListener("click", openLogs);
  document.getElementById("logsClose").addEventListener("click", () => m.classList.remove("open"));
  document.getElementById("logsClearBtn").addEventListener("click", () => {
    askConfirmAsync("清空操作日志？", "全部日志记录将被删除，不可恢复。", "清空").then(async (ok) => {
      if (!ok) return;
      try {
        await apiFetch("/api/meta/logs", { method: "DELETE" });
        openLogs();
      } catch (e) { alert("清空失败：" + e.message); }
    });
  });
}

/* ---------- 水印（前端 canvas 合成） ---------- */
const WM_KEY = "rn_wm";
function wmCfg() {
  try {
    const c = JSON.parse(localStorage.getItem(WM_KEY) || "null");
    return c && c.dataUrl ? c : { on: false, dataUrl: null };
  } catch (e) { return { on: false, dataUrl: null }; }
}
function wmEnabled() { return !!wmCfg().on; }
let wmCache = null;
async function paintWatermark(ctx, w, h) {
  const cfg = wmCfg();
  if (!cfg.on || !cfg.dataUrl) return;
  if (!wmCache || wmCache.src !== cfg.dataUrl) {
    wmCache = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => { im.__src = cfg.dataUrl; res(im); };
      im.onerror = rej;
      im.src = cfg.dataUrl;
    });
  }
  const img = wmCache;
  const bw = Math.max(24, w * 0.18);
  const bh = Math.max(24, (img.height / img.width) * bw);
  const m = Math.max(8, w * 0.03);
  ctx.save();
  ctx.globalAlpha = 0.88;
  ctx.drawImage(img, w - bw - m, h - bh - m, bw, bh);
  ctx.restore();
}
function initWmSettings() {
  const sec = document.getElementById("wmSection");
  if (!sec) return;
  const on = document.getElementById("wmOn");
  const preview = document.getElementById("wmPreview");
  const upBtn = document.getElementById("wmUpload");
  const clrBtn = document.getElementById("wmClear");
  const file = document.getElementById("wmFile");
  const cfg = wmCfg();
  on.checked = !!cfg.on;
  const show = () => {
    sec.classList.toggle("wm-disabled", !on.checked);
    const c = wmCfg();
    if (c.dataUrl) {
      preview.src = c.dataUrl;
      preview.hidden = false;
      clrBtn.hidden = false;
    } else {
      preview.hidden = true;
      clrBtn.hidden = true;
    }
  };
  show();
  on.addEventListener("change", () => {
    const c = wmCfg();
    c.on = on.checked;
    localStorage.setItem(WM_KEY, JSON.stringify(c));
    show();
  });
  upBtn.addEventListener("click", () => file.click());
  file.addEventListener("change", () => {
    const f = file.files && file.files[0];
    if (!f) return;
    if (f.size > 1024 * 1024) { alert("水印图请小于 1MB"); return; }
    const rd = new FileReader();
    rd.onload = () => {
      const c = wmCfg();
      c.dataUrl = rd.result;
      localStorage.setItem(WM_KEY, JSON.stringify(c));
      show();
    };
    rd.readAsDataURL(f);
  });
  clrBtn.addEventListener("click", () => {
    localStorage.setItem(WM_KEY, JSON.stringify({ on: on.checked, dataUrl: null }));
    show();
  });
}

/* ---------- 语言切换（v0.12/0.13：骨架文案字典 + 动态文案 t()） ---------- */
const LANG_KEY = "rn_lang";
function curLang() { return localStorage.getItem(LANG_KEY) === "en" ? "en" : "zh"; }
const t = (zh, en) => (curLang() === "en" ? en : zh);
const I18N_DICT = {
  "上传图片": "Upload Photos", "设置": "Settings", "搜索": "Search", "图库": "Gallery",
  "外观": "Appearance", "图库统计": "Library Stats", "AI 助手": "AI Assistant", "快捷键": "Shortcuts",
  "标签管理": "Tag Manager", "水印": "Watermark", "数据维护": "Maintenance", "危险操作": "Danger Zone",
  "主题": "Theme", "浅色": "Light", "深色": "Dark", "跟随系统": "Auto",
  "瀑布流列宽": "Column Width", "窄 180": "Narrow", "标准 240": "Standard", "宽 320": "Wide",
  "图片加载": "Image Quality", "高画质": "High", "平衡": "Balanced", "省流": "Low Data", "语言": "Language",
  "图片数量": "Photos", "已用空间": "Used Space",
  "导出元数据": "Export Metadata", "操作日志": "Activity Log", "清空整个图库": "Erase Library",
  "返回图库": "Back", "上传": "Upload",
  "打开搜索窗口": "Open search window", "灯箱中切换上一张 / 下一张": "Prev / next in lightbox",
  "关闭灯箱 / 弹窗 / 悬浮菜单": "Close lightbox / dialogs / menus",
  "标签筛选": "Filter by tag", "搜索标签 / 别名…": "Search tags / aliases…",
  "启用 AI 助手": "Enable AI assistant", "API Key": "API Key", "温度": "Temperature",
  "测试对话": "Test chat", "发送「你好」": "Say hi",
  "或从 URL 导入（每行一个图片链接）": "Or import from URLs (one per line)", "导入": "Import",
  "拖拽图片到这里，或点击选择": "Drop images here, or click to select",
  "标签（输入时从标签库选择，回车可自定义）": "Tags (type to pick, Enter for custom)",
  "输入后按回车…": "Type & press Enter…", "输入后回车添加…": "Type & press Enter…",
  "开始上传": "Upload now",
  "取消": "Cancel", "关闭": "Close", "保存": "Save", "应用": "Apply", "删除": "Delete", "确认": "Confirm",
  "确认删除": "Delete", "清空": "Clear", "清空日志": "Clear logs",
  "加标签": "Add Tags", "入相册": "Add to Album", "全部": "All", "收藏": "Favorites",
  "最新上传": "Newest", "最早上传": "Oldest", "标题 A–Z": "Title A–Z", "文件大小": "Size",
  "标题": "Title", "描述": "Description", "标签": "Tags",
  "加入相册": "Add to Album", "新建相册名称…": "New album name…", "＋ 新建并加入": "Create & add",
  "编辑待上传项": "Edit upload item", "编辑图片信息": "Edit photo",
  "留空则使用文件名": "Empty = use file name", "留空则跟随上方全局标签": "Empty = use global tags",
  "图片编辑": "Edit", "操作日志": "Activity Log", "暂无操作记录": "No activity yet",
  "水印图": "Watermark image", "上传时加图片水印": "Add watermark on upload",
  "建议使用透明底 PNG；水印将等比缩放到图片宽度的 18%，置于右下角。仅作用于启用后新上传的图片。": "Use transparent PNG; watermark scales to 18% width, bottom-right. Applies to new uploads only.",
  "进入": "Enter", "私人图库": "Private Gallery", "输入访问密码以继续": "Enter password to continue", "访问密码": "Password",
  "启用 AI 助手": "Enable AI", "开关": "", "关闭状态：AI 选项行淡化": "",
};
function applyLang(lang) {
  document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const key = n.nodeValue.trim();
    if (!key) continue;
    const parent = n.parentElement;
    if (!parent) continue;
    if (lang === "en" && I18N_DICT[key]) {
      if (parent.childNodes.length === 1 && !parent.dataset.zh) parent.dataset.zh = n.nodeValue;
      n.nodeValue = n.nodeValue.replace(key, I18N_DICT[key]);
    } else if (lang === "zh" && parent.dataset.zh && parent.childNodes.length === 1) {
      n.nodeValue = parent.dataset.zh;
    }
  }
}
function initLang() {
  const seg = document.getElementById("langSeg");
  if (!seg) return;
  const pref = localStorage.getItem(LANG_KEY) || "zh";
  applyLang(pref);
  [...seg.querySelectorAll(".seg-btn")].forEach((b) => {
    b.classList.toggle("on", b.dataset.lang === pref);
    b.addEventListener("click", () => {
      [...seg.querySelectorAll(".seg-btn")].forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      localStorage.setItem(LANG_KEY, b.dataset.lang);
      applyLang(b.dataset.lang);
      // 重渲染动态文案部分
      if (window.__refreshGallery) window.__refreshGallery();
    });
  });
}

/* 幻灯片间隔设置（v0.13） */
function initSlideSetting() {
  const seg = document.getElementById("slideSeg");
  if (!seg) return;
  const cur = localStorage.getItem("rn_slide") || "5";
  [...seg.querySelectorAll(".seg-btn")].forEach((b) => {
    b.classList.toggle("on", b.dataset.sec === cur);
    b.addEventListener("click", () => {
      [...seg.querySelectorAll(".seg-btn")].forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      localStorage.setItem("rn_slide", b.dataset.sec);
    });
  });
}

/* ---------- 拼音匹配（v0.13：pinyin-pro CDN，离线自动降级） ---------- */
const pinyinCache = new Map();
function pinyinOf(text) {
  const key = String(text).toLowerCase();
  if (pinyinCache.has(key)) return pinyinCache.get(key);
  const r = { full: "", first: "" };
  try {
    if (window.pinyinPro) {
      r.full = window.pinyinPro.pinyin(text, { pattern: "pinyin", toneType: "none", type: "array", nonZh: "consecutive" }).join("").toLowerCase();
      r.first = window.pinyinPro.pinyin(text, { pattern: "first", toneType: "none", type: "array", nonZh: "consecutive" }).join("").toLowerCase();
    }
  } catch (e) { /* ignore */ }
  pinyinCache.set(key, r);
  return r;
}
/* 统一标签查询匹配：名称/别名包含 + 纯字母查询时匹配拼音全拼/首字母 */
function tagQueryMatch(t, q) {
  const kw = String(q).trim().toLowerCase();
  if (!kw) return true;
  const labels = [t.name, ...(t.aliases || [])];
  if (labels.some((x) => x.toLowerCase().includes(kw))) return true;
  if (/^[a-z\s]+$/i.test(kw)) {
    const qc = kw.replace(/\s+/g, "");
    return labels.some((x) => {
      const p = pinyinOf(x);
      return (p.full && p.full.startsWith(qc)) || (p.first && p.first.startsWith(qc)) || (p.full && p.full.includes(kw));
    });
  }
  return false;
}

/* ---------- 上传队列逐张编辑（v0.13：描述 / 标签） ---------- */
let uqTarget = null;
function openUqEdit(it) {
  uqTarget = it;
  const m = document.getElementById("uqModal");
  if (!m) return;
  document.getElementById("uqDesc").value = it.desc || "";
  const box = document.getElementById("uqTagBox");
  box.querySelectorAll(".t").forEach((el) => el.remove());
  if (Array.isArray(it.tags)) it.tags.forEach((t) => addTagChip(box, t));
  const err = document.getElementById("uqErr");
  if (err) err.style.display = "none";
  m.classList.add("open");
}
function saveUqEdit() {
  const it = uqTarget;
  if (!it) return;
  const desc = document.getElementById("uqDesc").value.trim();
  const tags = tagsOfBox(document.getElementById("uqTagBox"));
  it.desc = desc || null;
  it.tags = tags.length ? tags : undefined; // undefined → 跟随全局标签
  const nameRow = it.row && it.row.querySelector(".uq-name-row");
  if (nameRow) {
    const edited = !!(it.desc || it.tags);
    nameRow.innerHTML = `<span class="name">${esc(it.f.name)}</span>` + (edited ? `<span class="edited-mark">已编辑</span>` : "");
  }
  document.getElementById("uqModal").classList.remove("open");
  renderUqRowTags(it);
  refreshUqSlots();
}
function initUqModal() {
  const m = document.getElementById("uqModal");
  if (!m) return;
  const uqC = document.getElementById("uqCancel");
  const uqS = document.getElementById("uqSave");
  if (uqC) uqC.onclick = () => m.classList.remove("open");
  if (uqS) uqS.onclick = saveUqEdit;
  bindTagSuggest(document.getElementById("uqTagInput"), document.getElementById("uqTagSuggest"), document.getElementById("uqTagBox"));
}

/* ---------- FAB 展开保持（v0.13.3：hover 后保持展开便于点击分支按钮） ---------- */
function initFabHold() {
  const g = document.getElementById("fabGroup");
  if (!g) return;
  let leaveT = null;
  g.addEventListener("mouseenter", () => { clearTimeout(leaveT); g.classList.add("hover-hold"); });
  g.addEventListener("mouseleave", () => {
    clearTimeout(leaveT);
    leaveT = setTimeout(() => g.classList.remove("hover-hold"), 600);
  });
  document.addEventListener("pointerdown", (e) => {
    if (!g.contains(e.target)) g.classList.remove("hover-hold");
  });
  const main = document.getElementById("fabMain");
  if (main) {
    main.addEventListener("click", (e) => {
      e.stopPropagation();
      g.classList.toggle("hover-hold"); // 触屏：点主按钮展开/收起
    });
  }
}

/* ---------- AI 快捷对话气泡（v0.13.4） ---------- */
let aiChatOpen = false;
let aiChatHistory = [];

function updateAiFab() {
  const fab = document.getElementById("aiFab");
  if (!fab) return;
  fab.hidden = !aiEnabled();
  if (!aiEnabled()) closeAiChat();
}
function closeAiChat() {
  aiChatOpen = false;
  const box = document.getElementById("aiChatBox");
  if (box) box.hidden = true;
  const fab = document.getElementById("aiFab");
  if (fab) fab.classList.remove("on");
}
function aiChatAddMsg(role, text) {
  const msgs = document.getElementById("aiChatMsgs");
  if (!msgs) return null;
  const div = document.createElement("div");
  div.className = "ai-msg " + (role === "user" ? "user" : role === "err" ? "err" : role === "typing" ? "typing" : "bot");
  div.textContent = text;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}
function toggleAiChat() {
  const box = document.getElementById("aiChatBox");
  const fab = document.getElementById("aiFab");
  if (!box) return;
  aiChatOpen = !aiChatOpen;
  box.hidden = !aiChatOpen;
  if (fab) fab.classList.toggle("on", aiChatOpen);
  if (aiChatOpen) {
    const msgs = document.getElementById("aiChatMsgs");
    if (msgs && !msgs.children.length) {
      aiChatHistory = [];
      aiChatAddMsg("bot", "你好，我是图库 AI 助手 ✨ 可以问我图库里有什么、帮你找图或整理标签。");
    }
    setTimeout(() => { const inp = document.getElementById("aiChatText"); if (inp) inp.focus(); }, 80);
  }
}
async function sendAiChat() {
  const input = document.getElementById("aiChatText");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  aiChatAddMsg("user", text);
  const ready = aiReady();
  if (!ready.ok) {
    aiChatAddMsg("err", ready.msg);
    return;
  }
  const typing = aiChatAddMsg("typing", "思考中…");
  try {
    const history = [...aiChatHistory];
    const reply = await aiChat(text, { system: aiSys(), temperature: aiTemp(), maxTokens: 800, history });
    typing.remove();
    aiChatAddMsg("bot", reply);
    aiChatHistory = [...history, { role: "user", content: text }, { role: "assistant", content: reply }].slice(-20);
  } catch (e) {
    typing.remove();
    aiChatAddMsg("err", "请求失败：" + (e && e.message ? e.message : e));
  }
}
function initAiChat() {
  updateAiFab();
  window.__updateAiFab = updateAiFab;
  const fab = document.getElementById("aiFab");
  const box = document.getElementById("aiChatBox");
  if (!fab || !box) return;
  fab.addEventListener("click", () => toggleAiChat());
  document.getElementById("aiChatClose").addEventListener("click", closeAiChat);
  document.getElementById("aiChatSend").addEventListener("click", sendAiChat);
  const inp = document.getElementById("aiChatText");
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); sendAiChat(); }
  });
}

/* ---------- 设置页标签管理（v0.11：分组 / 别名 / 颜色 / 改名同步） ---------- */
const SWATCHES = ["#ff9f0a", "#ff453a", "#ffd60a", "#30d158", "#0a84ff", "#5e5ce6", "#bf5af2", "#ff375f", "#64d2ff"];

function tagCounts() {
  const counts = {};
  PHOTOS.forEach((p) => p.tags.forEach((t) => { counts[t] = (counts[t] || 0) + 1; }));
  return counts;
}

function mgrPills(tagObjs, counts) {
  if (!tagObjs.length) return `<div class="tag-mgr-empty" style="padding:2px 2px 0">（空）</div>`;
  return `<div class="tmgr-pills">` + tagObjs.map((t) => {
    const c = t.color || tagGroupColor(t.group) || null;
    return `<span class="tmgr-pill" data-tag="${escAttr(t.name)}">
      <i class="dot"${c ? ` style="--tg:${c}"` : ""}></i>${esc(t.name)}
      <span class="cnt">${counts[t.name] || 0} 张</span>
      <button class="act" data-tact="edit" data-tname="${escAttr(t.name)}" title="编辑 / 改名">✎</button>
      <button class="act danger" data-tact="remove" data-tname="${escAttr(t.name)}" title="删除">×</button>
    </span>`;
  }).join("") + `</div>`;
}

const TMGR_VIEW_KEY = "rn_tmgr_view";
/* ---------- 分类工作台状态（v0.14.4：统计视图 → 两栏拖拽分类） ---------- */
let cwFilter = "all";        // all | loose（只显示未入库分类的图片）
let cwShown = 40;            // 左栏一次性渲染张数
let cwList = [];             // 当前筛选后的图片列表
const cwSel = new Set();     // 左栏点选（再拖任意一张 = 整批归类）
const cwExtraSlots = new Set(); // 面板内临时自定义分类（不回写标签库）
function refreshTagManager() {
  const root = document.getElementById("tagMgrRoot");
  if (!root) return;
  const counts = tagCounts();
  const used = Object.keys(counts);
  const view = localStorage.getItem(TMGR_VIEW_KEY) === "group" ? "group" : "classify";

  let html = `<div class="tmgr-seg">
      <div class="seg" id="tmgrViewSeg" role="group" aria-label="视图">
        <button class="seg-btn${view === "group" ? " on" : ""}" data-view="group">分组</button>
        <button class="seg-btn${view === "classify" ? " on" : ""}" data-view="classify">分类</button>
      </div>
    </div>`;

  if (view === "group") {
    html += `<div class="tag-mgr-hint">分组与别名用于筛选菜单和上传建议；<b style="color:var(--text)">改名 / 删除</b>会同步所有图片。</div>`;
    if (!used.length && !TAGS.tags.length) {
      html += `<div class="tag-mgr-empty" style="padding:4px 2px 2px">图库中还没有标签。上传图片时填写标签，即可在此分组管理。</div>`;
    } else {
      const groups = [...TAGS.groups].sort((a, b) => ((a.sort || 0) - (b.sort || 0)) || a.name.localeCompare(b.name, "zh"));
      if (groups.length) {
        for (const g of groups) {
          const items = TAGS.tags
            .filter((t) => t.group === g.id)
            .sort((a, b) => ((a.sort || 0) - (b.sort || 0)) || a.name.localeCompare(b.name, "zh"));
          html += `<div class="tmgr-head" style="margin-top:6px">
            <i class="dot" style="--tg:${g.color || "#ff9f0a"}"></i>${esc(g.name)}
            <span class="cnt">${items.length} 个标签</span>
            <button class="act" data-gact="edit" data-gid="${escAttr(g.id)}" title="编辑组">✎</button>
          </div>`;
          html += mgrPills(items, counts);
        }
      }
      const freeNames = used.filter((n) => !tagByName(n));
      if (freeNames.length) {
        html += `<div class="tmgr-head" style="margin-top:6px">
          <i class="dot"></i>未分组 · 待整理<span class="cnt">${freeNames.length}</span>
        </div>`;
        html += mgrPills(freeNames.map((n) => ({ name: n, color: null, group: "" })), counts);
      }
    }
  } else {
    // 分类工作台（v0.14.4）：左=图片小卡（点选可多选），右=分类槽，拖入即打标
    html += `<div class="cw">
      <div class="cw-left">
        <div class="cw-head">
          <span class="cw-title">图片 <span class="cnt" id="cwTotal"></span></span>
          <span class="seg cw-filters" id="cwFilters" role="group">
            <button class="seg-btn sm${cwFilter === "all" ? " on" : ""}" data-cwf="all">全部</button>
            <button class="seg-btn sm${cwFilter === "loose" ? " on" : ""}" data-cwf="loose" title="只显示没有入库分类的图片">未分类</button>
          </span>
        </div>
        <div class="cw-hint" id="cwHint"></div>
        <div class="cw-cards" id="cwCards"></div>
        <div class="cw-more" id="cwMoreWrap"><button class="btn ghost sm" id="cwMore" hidden></button></div>
      </div>
      <div class="cw-right">
        <div class="uq-panel">
          <div class="uq-panel-title">分类</div>
          <div class="uq-panel-sub">拖左侧图片到分类槽 = 加上该标签；也可把图库卡片直接拖进来</div>
          <div class="uq-panel-status" id="cwSelStatus"></div>
          <div class="uq-slots" id="cwSlots"></div>
          <div class="uq-new-slot">
            <input type="text" id="cwNewSlotInput" placeholder="+ 新分类标签，回车创建" autocomplete="off">
          </div>
        </div>
      </div>
    </div>`;
  }

  html += `<div class="tag-mgr-actions">
    <button class="btn ghost sm" id="btnNewTag">＋ 新建标签</button>
    <button class="btn ghost sm" id="btnNewGroup">＋ 新建标签组</button>
  </div>`;
  root.innerHTML = html;

  const q = (sel) => root.querySelector(sel);
  if (q("#btnNewTag")) q("#btnNewTag").addEventListener("click", () => openTagModal("new-tag"));
  if (q("#btnNewGroup")) q("#btnNewGroup").addEventListener("click", () => openTagModal("new-group"));
  const seg = q("#tmgrViewSeg");
  if (seg) {
    seg.querySelectorAll(".seg-btn").forEach((b) => {
      b.addEventListener("click", () => {
        localStorage.setItem(TMGR_VIEW_KEY, b.dataset.view);
        refreshTagManager();
      });
    });
  }
  if (view === "classify") initCwView(root);
  root.querySelectorAll("[data-gact='edit']").forEach((b) => b.addEventListener("click", () => openTagModal("edit-group", b.dataset.gid)));
  root.querySelectorAll("[data-tact='edit']").forEach((b) => b.addEventListener("click", () => {
    const nm = b.dataset.tname;
    if (tagByName(nm)) openTagModal("edit-tag", nm);
    else openTagModal("new-tag", null, nm); // 游离标签：入库整理（预填名称，同名照片引用自动归属）
  }));
  root.querySelectorAll("[data-tact='remove']").forEach((b) => b.addEventListener("click", () => openTagModal("remove-tag", b.dataset.tname)));
  bindTagDrops(root); // 分组视图标签 pill 仍是拖放目标
}
function refreshTagUI() {
  refreshTagManager();
  renderTagMenuContent();
}

/* ---------- 分类工作台视图（v0.14.4） ---------- */
function initCwView(root) {
  cwList = PHOTOS.filter((p) => cwFilter === "all" || !(p.tags || []).some((n) => tagByName(n)));
  renderCwCards();
  renderCwSlots();
  updateCwSelStatus();
  const q = (sel) => root.querySelector(sel);
  q("#cwFilters").querySelectorAll("[data-cwf]").forEach((b) => b.addEventListener("click", () => {
    cwFilter = b.dataset.cwf;
    cwShown = 40;
    cwSel.clear();
    refreshTagManager();
  }));
  const more = q("#cwMore");
  if (more) more.addEventListener("click", () => { cwShown += 40; renderCwCards(); });
  const inp = q("#cwNewSlotInput");
  if (inp) inp.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const v = inp.value.trim();
    if (!v) return;
    inp.value = "";
    const libHit = TAGS.tags.find((t) => t.name === v);
    if (libHit) { flashCwSlot(v); return; }
    cwExtraSlots.add(v);
    refreshTagManager();
    flashCwSlot(v);
  });
  const cardsEl = q("#cwCards");
  if (cardsEl) {
    cardsEl.addEventListener("click", (e) => {
      const card = e.target.closest(".cw-card");
      if (!card) return;
      const id = card.dataset.id;
      if (cwSel.has(id)) cwSel.delete(id);
      else cwSel.add(id);
      card.classList.toggle("sel", cwSel.has(id));
      updateCwSelStatus();
    });
    cardsEl.addEventListener("dragstart", (e) => {
      const card = e.target.closest(".cw-card");
      if (!card) return;
      let ids = cwSel.has(card.dataset.id) ? [...cwSel] : [card.dataset.id];
      window.__cwDrag = ids;
      e.dataTransfer.effectAllowed = "copy";
      try { e.dataTransfer.setData("text/plain", ids[0]); } catch (err) { /* ignore */ }
      card.classList.add("dragging");
      if (ids.length > 1) updateCwSelStatus(`已选 <span class="cnt">${ids.length}</span> 张 · 拖到分类槽即整批归类`);
    });
    cardsEl.addEventListener("dragend", (e) => {
      const card = e.target.closest(".cw-card");
      if (card) card.classList.remove("dragging");
      window.__cwDrag = null;
      document.querySelectorAll("#cwSlots .uq-slot.drop-over").forEach((s) => s.classList.remove("drop-over"));
      updateCwSelStatus();
    });
  }
  const slotsEl = q("#cwSlots");
  if (slotsEl) {
    slotsEl.addEventListener("dragover", (e) => {
      const slot = e.target.closest(".uq-slot");
      if (!slot) return;
      if (!(e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes("text/plain"))) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      slotsEl.querySelectorAll(".uq-slot.drop-over").forEach((s) => { if (s !== slot) s.classList.remove("drop-over"); });
      slot.classList.add("drop-over");
    });
    slotsEl.addEventListener("dragleave", (e) => {
      const slot = e.target.closest(".uq-slot");
      if (slot) slot.classList.remove("drop-over");
    });
    slotsEl.addEventListener("drop", async (e) => {
      const slot = e.target.closest(".uq-slot");
      if (!slot) return;
      e.preventDefault();
      slot.classList.remove("drop-over");
      const tag = slot.dataset.tag;
      if (!tag) return;
      let ids = window.__cwDrag && window.__cwDrag.length ? [...window.__cwDrag] : [];
      window.__cwDrag = null;
      if (!ids.length) {
        const id0 = e.dataTransfer.getData("text/plain");
        if (id0 && PHOTOS.some((p) => p.id === id0)) ids = [id0]; // 图库卡片直接拖入
      }
      if (!ids.length) return;
      const todo = ids.map((id) => PHOTOS.find((p) => p.id === id)).filter((p) => p && !(p.tags || []).includes(tag));
      if (!todo.length) return;
      try {
        await Promise.all(todo.map((p) => apiFetch(`/api/photos/${p.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tags: [...new Set([...(p.tags || []), tag])].slice(0, 10) }),
        })));
        await loadData();
        cwSel.clear();
        if (window.__refreshGallery) window.__refreshGallery(); // 内部含 refreshTagManager
      } catch (err) { /* 静默 */ }
    });
  }
}
function updateCwSelStatus(msg) {
  const el = document.getElementById("cwSelStatus");
  if (!el) return;
  if (msg) { el.innerHTML = msg; el.classList.add("show"); return; }
  if (cwSel.size) {
    el.innerHTML = `已选 <span class="cnt">${cwSel.size}</span> 张 · 拖任意一张到分类槽即整批归类（点卡片取消）`;
    el.classList.add("show");
  } else el.classList.remove("show");
}
function flashCwSlot(name) {
  setTimeout(() => {
    const s = [...document.querySelectorAll("#cwSlots .uq-slot")].find((el) => el.dataset.tag === name);
    if (s) { s.classList.add("flash"); setTimeout(() => s.classList.remove("flash"), 1000); }
  }, 30);
}
function renderCwSlots() {
  const wrap = document.getElementById("cwSlots");
  if (!wrap) return;
  const counts = tagCounts();
  wrap.innerHTML = slotSectionsHTML((n) => counts[n] || 0, cwExtraSlots,
    "还没有分类。用下方输入框创建临时分类，或先到「分组」页建好标签库再回来。");
}
function renderCwCards() {
  const wrap = document.getElementById("cwCards");
  if (!wrap) return;
  const total = document.getElementById("cwTotal");
  if (total) total.textContent = cwList.length + " 张";
  const hint = document.getElementById("cwHint");
  if (hint) hint.textContent = cwFilter === "loose" ? "未分类 = 没有库里标签的图片（含游离标签）" : "点图片可多选，拖到右侧分类槽打标";
  if (!cwList.length) {
    wrap.innerHTML = `<div class="cw-empty">${cwFilter === "loose" ? "全部图片都已归类 🎉" : "图库暂无图片"}</div>`;
    return;
  }
  wrap.innerHTML = cwList.slice(0, cwShown).map((p) => {
    const n = (p.tags || []).length;
    return `<div class="cw-card${cwSel.has(p.id) ? " sel" : ""}" data-id="${p.id}" draggable="true" title="${escAttr((p.tags || []).join(" · ") || "无标签")}">
      <img loading="lazy" draggable="false" src="${cardImgSrc(p)}" alt="">
      ${n ? `<span class="cw-badge">${n}</span>` : ""}
    </div>`;
  }).join("");
  const more = document.getElementById("cwMore");
  if (more) {
    const rest = cwList.length - cwShown;
    more.hidden = rest <= 0;
    if (rest > 0) more.textContent = `再显示 ${Math.min(40, rest)} 张（已 ${Math.min(cwShown, cwList.length)}/${cwList.length}）`;
  }
}

/* ---------- 拖拽分类（v0.14：把图库卡片拖到分组视图标签 pill 上打标） ---------- */
function bindTagDrops(scope) {
  const targets = scope ? scope.querySelectorAll(".tmgr-pill[data-tag]") : document.querySelectorAll(".tmgr-pill[data-tag]");
  targets.forEach((el) => {
    el.classList.remove("drop-hover");
    el.addEventListener("dragover", (e) => {
      if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes("text/plain")) {
        e.preventDefault();
        el.classList.add("drop-hover");
      }
    });
    el.addEventListener("dragleave", () => el.classList.remove("drop-hover"));
    el.addEventListener("drop", async (e) => {
      e.preventDefault();
      el.classList.remove("drop-hover");
      const id = e.dataTransfer.getData("text/plain");
      const tag = el.dataset.tag;
      if (!id || !tag) return;
      const p = PHOTOS.find((x) => x.id === id);
      if (!p) return;
      if ((p.tags || []).includes(tag)) return;
      const merged = [...new Set([...(p.tags || []), tag])].slice(0, 10);
      try {
        await apiFetch(`/api/photos/${p.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tags: merged }),
        });
        await loadData();
        if (window.__refreshGallery) window.__refreshGallery();
      } catch (err) { /* 静默 */ }
    });
  });
}

/* ---------- 快捷点选（v0.14：编辑/上传时点击即选） ---------- */
function renderQuickPick(boxEl, wrapEl) {
  if (!wrapEl || !boxEl) return;
  if (!TAGS.tags.length) {
    wrapEl.classList.remove("show");
    wrapEl.innerHTML = `<div class="qp-empty">标签库为空，可先到「标签」页新建</div>`;
    return;
  }
  const used = new Set(tagsOfBox(boxEl));
  wrapEl.classList.add("show");
  wrapEl.innerHTML = TAGS.tags.slice(0, 60).map((t) => {
    const c = t.color || tagGroupColor(t.group) || null;
    return `<span class="qp-item${used.has(t.name) ? " sel" : ""}" data-tag="${escAttr(t.name)}">
      <i class="dot"${c ? ` style="--tg:${c}"` : ""}></i>${esc(t.name)}</span>`;
  }).join("");
  wrapEl.querySelectorAll(".qp-item").forEach((el) => {
    el.addEventListener("click", () => {
      const n = el.dataset.tag;
      const has = tagsOfBox(boxEl).includes(n);
      if (has) {
        [...boxEl.querySelectorAll(".t")].forEach((chip) => {
          if (chip.childNodes[0].textContent.trim() === n) chip.remove();
        });
      } else {
        addTagChip(boxEl, n);
      }
      renderQuickPick(boxEl, wrapEl);
      const pick = document.getElementById("edQuickPick") === wrapEl ? "ed" : "up";
      if (pick === "up") {
        // 上传页需要重新启用按钮（chips 变化不影响 disabled 逻辑，无需处理）
      }
    });
  });
}
function refreshQuickPickAll() {
  renderQuickPick(document.getElementById("edTagBox"), document.getElementById("edQuickPick"));
  renderQuickPick(document.getElementById("tagListUpload"), document.getElementById("upQuickPick"));
  refreshUqSlots();
  renderAllUqRowTags();
}

/* ---------- 上传队列两栏拖拽分类（v0.14.3：左图片行 → 右侧分类槽） ---------- */
let uqSelSet = new Set();          // 点选多张：再拖任意一张 = 整批归类
const uqExtraSlots = new Set();    // 上传面板临时自定义分类（不回写标签库）
function uqGlobalTags() {
  return [...(window.__upTagList || document.getElementById("tagListUpload")).querySelectorAll(".t")]
    .map((el) => el.childNodes[0].textContent.trim()).filter(Boolean);
}
/* 行最终发送标签 = 全局标签 ∪ 行分类（v0.14.2 修正：不再互相覆盖） */
function rowSendTags(it) {
  return [...new Set([...uqGlobalTags(), ...(it.tags || [])])].slice(0, 10);
}
function renderAllUqRowTags() {
  const queue = document.getElementById("queue");
  if (!queue) return;
  queue.querySelectorAll(".uq-item").forEach((rowEl) => {
    if (rowEl.__item) renderUqRowTags(rowEl.__item);
  });
}
/* 行 chips = 该行专属分类（拖入的）；点 ✕ 移除。全局标签见右侧顶部输入 */
function renderUqRowTags(it) {
  const row = it.row;
  if (!row) return;
  const el = row.querySelector(".uq-tags");
  if (!el) return;
  const tags = it.tags || [];
  el.innerHTML = tags.map((n) => `<span class="cls" data-tag="${escAttr(n)}">${esc(n)}<i class="x" title="移除此分类">✕</i></span>`).join("");
  el.querySelectorAll(".cls").forEach((c) => {
    c.addEventListener("click", (e) => {
      e.stopPropagation();
      const nm = c.dataset.tag;
      if (Array.isArray(it.tags)) {
        it.tags = it.tags.filter((x) => x !== nm);
        if (!it.tags.length) it.tags = undefined;
      }
      renderUqRowTags(it);
      refreshUqSlots();
    });
  });
}
/* 右侧分类槽计数：队列中（未完成）归属该分类的图片数 */
function uqSlotCount(name) {
  const queue = document.getElementById("queue");
  if (!queue) return 0;
  let n = 0;
  queue.querySelectorAll(".uq-item").forEach((r) => {
    const it = r.__item;
    if (it && it.status !== "ok" && Array.isArray(it.tags) && it.tags.includes(name)) n++;
  });
  return n;
}
/* 槽列表 HTML（上传面板 / 标签分类工作台共用）：标签库按组 + 临时自定义槽 */
function slotSectionsHTML(countOf, extraSet, emptyTip) {
  const gmap = new Map();
  (TAGS.groups || []).forEach((g) => gmap.set(g.id, g));
  const grouped = new Map();
  TAGS.tags.forEach((t) => {
    const g = t.group && gmap.has(t.group) ? gmap.get(t.group) : null;
    const key = g ? g.id : "__none";
    if (!grouped.has(key)) grouped.set(key, { g, items: [] });
    grouped.get(key).items.push(t);
  });
  const sections = [];
  grouped.forEach(({ g, items }) => sections.push({ title: g ? g.name : "", color: g ? g.color : null, items }));
  if (extraSet && extraSet.size) {
    sections.push({ title: "", color: null, items: [...extraSet].map((n) => ({ name: n, extra: true })) });
  }
  if (!sections.length) return `<div class="uq-empty-tip">${emptyTip || "还没有分类。"}</div>`;
  return sections.map((sec) => {
    const head = sec.title
      ? `<div class="uq-sec">${sec.color ? `<i class="dot" style="--tg:${sec.color}"></i>` : ""}${esc(sec.title)}</div>`
      : "";
    const slots = sec.items.map((t) => {
      const c = t.color || sec.color || "";
      const ct = countOf(t.name);
      return `<div class="uq-slot" data-tag="${escAttr(t.name)}">
        ${c ? `<i class="dot" style="--tg:${c}"></i>` : `<i class="dot"></i>`}
        <span class="nm">${esc(t.name)}</span>
        <span class="ct${ct ? " hot" : ""}">${ct || ""}</span>
      </div>`;
    }).join("");
    return head + slots;
  }).join("");
}
/* 渲染分类槽：标签库标签按组展示 + 临时自定义槽 */
function refreshUqSlots() {
  const wrap = document.getElementById("uqSlots");
  if (!wrap) return;
  wrap.innerHTML = slotSectionsHTML(uqSlotCount, uqExtraSlots,
    "还没有分类。用下方输入框创建临时分类，或先到「标签」页建好标签库再回来。");
}
function setUqStatus(msg) {
  const el = document.getElementById("uqSelStatus");
  if (!el) return;
  if (msg) { el.innerHTML = msg; el.classList.add("show"); }
  else el.classList.remove("show");
}
function updateUqSelStatus() {
  if (uqSelSet.size) setUqStatus(`已选 <span class="cnt">${uqSelSet.size}</span> 张 · 拖任意一张到分类槽即整批归类`);
  else setUqStatus(null);
}
function toggleUqSelect(it) {
  if (uqSelSet.has(it)) uqSelSet.delete(it);
  else uqSelSet.add(it);
  if (it.row) it.row.classList.toggle("sel", uqSelSet.has(it));
  updateUqSelStatus();
}
function clearUqSelection() {
  uqSelSet.forEach((it) => { if (it.row) it.row.classList.remove("sel"); });
  uqSelSet.clear();
  updateUqSelStatus();
}
function cancelUqSel() { clearUqSelection(); }
function applyTagsToItems(items, name) {
  if (!items.length || !name) return;
  items.forEach((it) => {
    if (it.status === "ok") return;
    it.tags = [...new Set([...(it.tags || []), name])].slice(0, 10);
    renderUqRowTags(it);
  });
  refreshUqSlots();
  clearUqSelection();
}
window.__refreshQuickPick = refreshQuickPickAll;


function closeTagModal() {
  const m = document.getElementById("tagModal");
  if (m) m.classList.remove("open");
}

function swatchHTML(sel) {
  return `<div class="tag-swatches" id="fSwatches">
    <button type="button" class="tag-swatch none${!sel ? " on" : ""}" data-v="" title="默认"></button>
    ${SWATCHES.map((c) => `<button type="button" class="tag-swatch${sel === c ? " on" : ""}" data-v="${c}" style="background:${c}" title="${c}"></button>`).join("")}
  </div>`;
}

function groupSelectHTML(sel) {
  return `<select id="fGroup">
    <option value=""${!sel ? " selected" : ""}>未分组</option>
    ${TAGS.groups.map((g) => `<option value="${escAttr(g.id)}"${g.id === sel ? " selected" : ""}>${esc(g.name)}</option>`).join("")}
  </select>`;
}

/* 标签 / 标签组编辑弹窗。payload：标签名或组 id */
function openTagModal(mode, payload, presetName) {
  const modal = document.getElementById("tagModal");
  const body = document.getElementById("tagModalBody");
  if (!modal || !body) return;

  /* ---- 删除确认（标签 / 组） ---- */
  if (mode === "remove-tag") {
    const name = payload;
    const n = (tagCounts()[name] || 0);
    const inLib = !!tagByName(name);
    body.innerHTML = `
      <h3>删除标签「${esc(name)}」？</h3>
      <p>将同时从 <b style="color:var(--danger)">${n} 张图片</b>中移除${inLib ? "，并从标签库删除" : "（该标签本就不在标签库中）"}。此操作不可恢复。</p>
      <div class="m-actions">
        <button class="btn ghost" id="fCancel">取消</button>
        <button class="btn danger" id="fConfirm">确认删除</button>
      </div>
      <div class="hint" id="fErr" style="color:var(--danger);display:none;margin-top:12px"></div>`;
    modal.classList.add("open");
    body.querySelector("#fCancel").onclick = closeTagModal;
    body.querySelector("#fConfirm").onclick = async () => {
      const b = body.querySelector("#fConfirm");
      b.disabled = true;
      b.textContent = "删除中…";
      try {
        await apiRemoveTag(name);
        await loadData();
        if (window.__refreshGallery) window.__refreshGallery();
        closeTagModal();
      } catch (err) {
        b.disabled = false;
        b.textContent = "确认删除";
        const el = body.querySelector("#fErr");
        el.style.display = "block";
        el.textContent = err.message;
      }
    };
    return;
  }
  if (mode === "remove-group") {
    const g = TAGS.groups.find((x) => x.id === payload);
    if (!g) return closeTagModal();
    const n = TAGS.tags.filter((t) => t.group === g.id).length;
    body.innerHTML = `
      <h3>删除标签组「${esc(g.name)}」？</h3>
      <p>组内 <b>${n} 个标签</b>将变为「未分组」（图片与标签本身不受影响）。</p>
      <div class="m-actions">
        <button class="btn ghost" id="fCancel">取消</button>
        <button class="btn danger" id="fConfirm">删除该组</button>
      </div>
      <div class="hint" id="fErr" style="color:var(--danger);display:none;margin-top:12px"></div>`;
    modal.classList.add("open");
    body.querySelector("#fCancel").onclick = closeTagModal;
    body.querySelector("#fConfirm").onclick = async () => {
      const b = body.querySelector("#fConfirm");
      b.disabled = true;
      b.textContent = "删除中…";
      try {
        TAGS.groups = TAGS.groups.filter((x) => x.id !== g.id);
        TAGS.tags.forEach((t) => { if (t.group === g.id) t.group = ""; });
        await apiSaveTags();
        refreshTagUI();
        closeTagModal();
      } catch (err) {
        b.disabled = false;
        b.textContent = "删除该组";
        const el = body.querySelector("#fErr");
        el.style.display = "block";
        el.textContent = err.message;
      }
    };
    return;
  }

  /* ---- 新建 / 编辑表单 ---- */
  const isGroup = mode === "new-group" || mode === "edit-group";
  const target = isGroup
    ? TAGS.groups.find((g) => g.id === payload) || null
    : tagByName(payload) || null;
  if ((mode === "edit-group" || mode === "edit-tag") && !target) return closeTagModal();

  const editName = target ? target.name : (presetName || "");
  const selGroup = target ? (target.group || "") : "";
  const selColor = target ? (target.color || (target.group ? tagGroupColor(target.group) : null)) : null;
  const title = isGroup ? (target ? "编辑标签组" : "新建标签组") : (target ? "编辑标签" : "新建标签");

  body.innerHTML = `
    <h3>${title}</h3>
    <form class="tag-form" id="fForm" onsubmit="return false">
      <div class="field">
        <label>${isGroup ? "组名称" : "标签名称"}</label>
        <input type="text" id="fName" value="${escAttr(editName)}" maxlength="30" placeholder="${isGroup ? "如：游戏角色" : "如：胡桃"}">
        ${isGroup ? "" : `<div class="hint">${target ? "改名会同步更新所有图片中的该标签（照片以标签名关联）" : "保存后进入标签库，上传时可直接从建议中选择"}</div>`}
      </div>
      ${isGroup ? "" : `
      <div class="field">
        <label>别名（逗号分隔，用于筛选搜索）</label>
        <input type="text" id="fAliases" value="${escAttr(target ? (target.aliases || []).join("，") : "")}" placeholder="如：核桃, Hu Tao">
      </div>
      <div class="field">
        <label>所属组</label>${groupSelectHTML(selGroup)}
      </div>`}
      <div class="field">
        <label>颜色</label>${swatchHTML(selColor)}
      </div>
      <div class="m-actions">
        <button class="btn ghost" id="fCancel" type="button">取消</button>
        <button class="btn primary" id="fSave" type="button">保存</button>
      </div>
    </form>
    ${target ? `<div class="tag-modal-danger">
      <button class="btn danger sm" id="fDel" type="button">${isGroup ? "删除该组" : "删除标签"}</button>
    </div>` : ""}
    <div class="hint" id="fErr" style="color:var(--danger);display:none;margin-top:12px"></div>`;
  modal.classList.add("open");

  // 色板选择
  let color = selColor;
  body.querySelector("#fSwatches").addEventListener("click", (e) => {
    const b = e.target.closest(".tag-swatch");
    if (!b) return;
    color = b.dataset.v || null;
    body.querySelectorAll(".tag-swatch").forEach((x) => x.classList.remove("on"));
    b.classList.add("on");
  });

  const fName = body.querySelector("#fName");
  const fSave = body.querySelector("#fSave");
  const fErr = body.querySelector("#fErr");
  const showErr = (m) => { fErr.style.display = "block"; fErr.textContent = m; };
  const busy = (b, text) => { b.disabled = !!text; if (text !== null) b.textContent = text || "保存"; };
  fName.focus();

  body.querySelector("#fCancel").onclick = closeTagModal;
  const fDelEl = body.querySelector("#fDel"); // 仅编辑模式存在（新建模式无删除按钮）
  if (fDelEl) {
    fDelEl.onclick = () => {
      openTagModal(isGroup ? "remove-group" : "remove-tag", isGroup ? target.id : target.name);
    };
  }

  fSave.onclick = async () => {
    const name = fName.value.trim();
    if (!name) return showErr("名称不能为空");
    busy(fSave, "保存中…");
    let renamed = false;
    try {
      if (isGroup) {
        if (target) { target.name = name; target.color = color; }
        else TAGS.groups.push({ id: "", name, color, sort: TAGS.groups.length });
      } else {
        const aliases = (body.querySelector("#fAliases").value || "").split(/[,，]/).map((s) => s.trim()).filter(Boolean);
        const gid = body.querySelector("#fGroup").value || "";
        if (target) {
          if (name !== target.name) {
            renamed = true;
            // 改名：后端同步照片引用（名称即引用键）
            await apiRenameTag(target.name, name);
            const nt = tagByName(name);
            if (nt) { nt.color = color; nt.group = gid; nt.aliases = aliases; }
          } else {
            target.color = color; target.group = gid; target.aliases = aliases;
          }
        } else {
          TAGS.tags.push({ id: "", name, aliases, group: gid, color, sort: TAGS.tags.length });
        }
      }
      await apiSaveTags();
      if (renamed) {
        await loadData(); // 照片引用已同步改名 → 重载后统一刷新
        if (window.__refreshGallery) window.__refreshGallery();
      } else {
        refreshTagUI();
      }
      closeTagModal();
    } catch (err) {
      busy(fSave, null);
      showErr(err.message);
    }
  };
}

/* ---------- 外观设置（v0.11.1）：主题（浅/深/跟随系统） + 瀑布流列宽 ---------- */
const THEME_KEY = "rn_theme";
const COLS_KEY = "rn_cols";

function applyTheme(pref) {
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  const resolved = pref === "auto" ? (mq.matches ? "light" : "dark") : pref;
  document.documentElement.setAttribute("data-theme", resolved);
  document.documentElement.style.colorScheme = resolved;
  return resolved;
}

function initAppearance() {
  // 主题分段选择
  const segTheme = document.getElementById("themeSeg");
  const themePref = localStorage.getItem(THEME_KEY) || "dark";
  applyTheme(themePref);
  if (segTheme) {
    [...segTheme.querySelectorAll(".seg-btn")].forEach((b) => {
      b.classList.toggle("on", b.dataset.theme === themePref);
      b.addEventListener("click", () => {
        [...segTheme.querySelectorAll(".seg-btn")].forEach((x) => x.classList.remove("on"));
        b.classList.add("on");
        localStorage.setItem(THEME_KEY, b.dataset.theme);
        applyTheme(b.dataset.theme);
      });
    });
    // 跟随系统时响应系统主题变化
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
      if ((localStorage.getItem(THEME_KEY) || "dark") === "auto") applyTheme("auto");
    });
  }

  // 瀑布流列宽分段选择
  const segCols = document.getElementById("colsSeg");
  const colsPref = localStorage.getItem(COLS_KEY) || "standard";
  document.documentElement.setAttribute("data-cols", colsPref);
  if (segCols) {
    [...segCols.querySelectorAll(".seg-btn")].forEach((b) => {
      b.classList.toggle("on", b.dataset.cols === colsPref);
      b.addEventListener("click", () => {
        [...segCols.querySelectorAll(".seg-btn")].forEach((x) => x.classList.remove("on"));
        b.classList.add("on");
        document.documentElement.setAttribute("data-cols", b.dataset.cols);
        localStorage.setItem(COLS_KEY, b.dataset.cols);
      });
    });
  }

  // 图片加载质量（v0.12）：高画质=原图 / 平衡·省流=缩略图（灯箱省流也用缩略图）
  const segQ = document.getElementById("qualitySeg");
  if (segQ) {
    const qPref = qualityMode();
    [...segQ.querySelectorAll(".seg-btn")].forEach((b) => {
      b.classList.toggle("on", b.dataset.quality === qPref);
      b.addEventListener("click", () => {
        [...segQ.querySelectorAll(".seg-btn")].forEach((x) => x.classList.remove("on"));
        b.classList.add("on");
        localStorage.setItem(QUALITY_KEY, b.dataset.quality);
        if (window.__refreshGallery) window.__refreshGallery();
        const lb = document.getElementById("lightbox");
        if (lb && lb.classList.contains("open") && lb.dataset.cur) openLightboxById(lb.dataset.cur);
      });
    });
  }
}

/* ---------- 设置页（v0.10：Apple 风格，无登录） ---------- */
function initSettings() {
  const stPhotos = document.getElementById("stPhotos");
  const stUsed = document.getElementById("stUsed");

  /* ---------- 图库统计（v0.12：含配额进度条） ---------- */
  function renderStats(count, bytes, quota) {
    stPhotos.textContent = count + " 张";
    stUsed.textContent = (bytes / 1e6).toFixed(1) + " MB";
    const fill = document.getElementById("quotaFill");
    const txt = document.getElementById("quotaText");
    if (!fill || !txt) return;
    if (!quota) {
      txt.textContent = "";
      fill.style.width = "0";
      fill.className = "quota-fill";
      return;
    }
    const pct = Math.min(100, (bytes / quota) * 100);
    fill.style.width = pct.toFixed(2) + "%";
    fill.className = "quota-fill" + (pct > 90 ? " danger" : pct > 70 ? " warn" : "");
    txt.textContent = `${(bytes / 1e9).toFixed(2)} GB / ${(quota / 1e9).toFixed(1)} GB · ${pct.toFixed(1)}%`;
  }
  async function refreshStats() {
    if (USE_API) {
      try {
        const res = await apiFetch("/api/meta/stats");
        const d = await res.json();
        renderStats(d.count, d.bytes || 0, d.quota || 0);
        return;
      } catch (e) { /* 回退本地统计 */ }
    }
    const total = PHOTOS.reduce((s, p) => s + (p.size || 0), 0);
    renderStats(PHOTOS.length, total, 0);
  }
  refreshStats();

  /* ---------- 标签管理（v0.11：分组 / 别名 / 颜色） ---------- */
  refreshTagManager();
  window.__refreshTagManager = refreshTagManager;

  /* ---------- 清空图库 ---------- */
  const modal = document.getElementById("wipeModal");
  document.getElementById("btnWipe").onclick = () => modal.classList.add("open");
  document.getElementById("btnConfirmWipe").onclick = async () => {
    modal.classList.remove("open");
    const b = document.getElementById("btnWipe");
    const old = b.querySelector(".settings-label").textContent;
    b.disabled = true;
    b.querySelector(".settings-label").textContent = "清空中…";
    if (USE_API) {
      try {
        const res = await apiFetch("/api/photos", { method: "DELETE" });
        const d = await res.json();
        b.querySelector(".settings-label").textContent = `已清空 ${d.deleted || 0} 项`;
        await loadData();
        if (window.__refreshGallery) window.__refreshGallery();
        refreshStats();
        refreshTagManager();
      } catch (e) {
        b.querySelector(".settings-label").textContent = `清空失败: ${e.message}`;
      }
      setTimeout(() => { b.querySelector(".settings-label").textContent = old; b.disabled = false; }, 2600);
    } else {
      b.querySelector(".settings-label").textContent = "本地模式无可清空";
      setTimeout(() => { b.querySelector(".settings-label").textContent = old; b.disabled = false; }, 1600);
    }
  };
  document.getElementById("btnCancelWipe").onclick = () => modal.classList.remove("open");
  document.querySelectorAll(".modal .btn.ghost").forEach((x) => {
    x.onclick = () => x.closest(".modal-mask").classList.remove("open");
  });

  /* ---------- 导出元数据 ---------- */
  document.getElementById("btnExport").onclick = async function () {
    const label = this.querySelector(".settings-label");
    const old = label.textContent;
    this.disabled = true;
    label.textContent = "导出中…";
    try {
      if (USE_API) {
        const res = await apiFetch("/api/export");
        const data = await res.json();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "export.json";
        a.click();
        URL.revokeObjectURL(a.href);
      } else {
        const blob = new Blob([JSON.stringify({ photos: PHOTOS }, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "export.json";
        a.click();
        URL.revokeObjectURL(a.href);
      }
      label.textContent = "✓ 已导出";
    } catch (e) {
      label.textContent = `✗ ${e.message}`;
    }
    setTimeout(() => { label.textContent = old; this.disabled = false; }, 2000);
  };
}

/* ---------- 搜索窗口（v0.8.6，独立界面） ---------- */
function initSearch() {
  const input = document.getElementById("searchInput");
  const results = document.getElementById("searchResults");
  const hint = document.getElementById("searchHint");
  const count = document.getElementById("searchCount");
  const clear = document.getElementById("searchClear");
  if (!input) return;

  function render() {
    const q = input.value;
    const keyword = q.trim().toLowerCase();
    hint.style.display = keyword ? "none" : "";
    clear.classList.toggle("on", !!keyword);
    if (!keyword) {
      results.innerHTML = "";
      count.hidden = true;
      return;
    }
    // v0.11/0.13：搜索词命中标签别名或拼音时，该标签也算匹配
    const aliasNames = new Set();
    for (const t of TAGS.tags) {
      if (tagQueryMatch({ name: t.name, aliases: t.aliases || [] }, keyword) && !t.name.toLowerCase().includes(keyword)) {
        aliasNames.add(t.name);
      }
    }
    const list = PHOTOS.filter((p) => {
      if ((p.title + " " + p.desc).toLowerCase().includes(keyword)) return true;
      return p.tags.some((t) => t.toLowerCase().includes(keyword) || aliasNames.has(t));
    });
    count.hidden = false;
    count.textContent = `${t("找到", "Found")} ${list.length} ${t("张", "photos")}`;
    if (!list.length) {
      const aiPart = aiEnabled()
        ? `<div style="grid-column:1/-1;display:flex;justify-content:center;margin-top:-6px"><button class="btn ghost sm ai-empty-btn" id="aiNlBtn">✨ 让 AI 理解这句搜索</button></div>`
        : "";
      results.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="big"><svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg></div>没有找到与「${esc(q)}」相关的图片</div>${aiPart}`;
      const b = results.querySelector("#aiNlBtn");
      if (b) b.onclick = () => aiSearchFromInput(q.trim(), b);
      return;
    }
    results.innerHTML = list.map((p) => `
      <div class="search-card" data-id="${p.id}">
        <img loading="lazy" src="${cardImgSrc(p)}" data-orig="${p.url}" alt="${escAttr(p.title)}" onerror="this.onerror=null;this.src=this.dataset.orig">
        <div class="t">${p.tags.length ? p.tags.slice(0, 2).map(tagChip).join(" / ") : ""}</div>
      </div>`).join("");
    results.querySelectorAll(".search-card").forEach((c) => {
      c.onclick = () => openLightboxById(c.dataset.id);
    });
    initReveal(results, ".search-card");
  }

  input.addEventListener("input", render);
  clear.addEventListener("click", () => {
    input.value = "";
    render();
    input.focus();
  });
  render();
}

/* ---------- 分发（v0.9.5：先显示加载动画 → 初始化 → 拉取数据） ---------- */
document.addEventListener("DOMContentLoaded", async () => {
  showGalleryState("loading");
  loadFavs();
  initPageSwitch();
  initGallery();
  initSearch();
  initUpload();
  initSettings();
  initAppearance();
  initSelection();
  initSortMenu();
  initEditModal();
  initUqModal();
  initImportUrl();
  initAiSettings();
  initAlbumModal();
  initLogsUI();
  initWmSettings();
  initLang();
  initSlideSetting();
  initFabHold();
  initAiChat();

  // 重试按钮
  const retry = document.getElementById("btnRetry");
  if (retry) {
    retry.onclick = async () => {
      await Promise.all([loadData(), loadTags()]);
      if (window.__refreshGallery) window.__refreshGallery();
      renderTagMenuContent();
      refreshTagManager();
    };
  }
  // 并行加载图片 / 标签配置 / 相册，随后刷新图库 / 筛选菜单 / 标签管理
  await Promise.all([loadData(), loadTags(), loadAlbums()]);
  if (window.__refreshGallery) window.__refreshGallery();
  renderTagMenuContent();
  refreshTagManager();
  refreshQuickPickAll();
});

/* ---------- 页面窗口（v0.8）· 上传/设置以独立窗口层叠悬浮于图库上方 ---------- */
function initPageSwitch() {
  const fabPageBtn = document.getElementById("fabPageBtn");
  const pageMenu = document.getElementById("pageMenu");
  const panels = {
    upload: document.getElementById("panelUpload"),
    settings: document.getElementById("panelSettings"),
    search: document.getElementById("panelSearch"),
    tags: document.getElementById("panelTags"),
  };
  const btnBack = {
    upload: document.getElementById("btnBackUpload"),
    settings: document.getElementById("btnBackSettings"),
    search: document.getElementById("btnBackSearch"),
    tags: document.getElementById("btnBackTags"),
  };
  const btnClose = {
    upload: document.getElementById("closeUpload"),
    settings: document.getElementById("closeSettings"),
    search: document.getElementById("closeSearch"),
    tags: document.getElementById("closeTags"),
  };
  const menuItems = pageMenu.querySelectorAll(".page-menu-item");
  const displacement = document.getElementById("genieDisplacement");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const OFFSET_STEP = window.innerWidth < 720 ? 8 : 14; // 文件堆层间距（px）
  const openStack = []; // 窗口打开顺序（栈）
  const closeQueue = []; // 待关闭窗口队列（逐个吸入，避免并发滤镜）
  let animating = false;

  // 菜单开关（v0.8.3/0.8.4）：悬停弹出（苹果感 stagger），点击可固定；点外部/Esc 关闭
  initFlyout(fabPageBtn, pageMenu);

  // 弹性缓动（带轻微过冲，模拟"弹出来"）
  function easeOutBack(x) {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
  }

  /* 窗口层级与"文件堆"排布（v0.8.1）：
     顶层端正（轻微 -1deg），下层按深度旋转（角度交替方向）+ 向外散开，
     关闭/置顶时其余窗口经 CSS transition 平滑归位 */
  function refreshStack() {
    const depthMax = openStack.length - 1;
    openStack.forEach((id, i) => {
      const el = panels[id];
      const depth = depthMax - i; // 0 = 顶层
      el.style.zIndex = 60 + i * 2;
      const isTop = i === openStack.length - 1;
      el.classList.toggle("dimmed", !isTop);
      if (isTop) {
        el.style.setProperty("--win-x", "0px");
        el.style.setProperty("--win-y", "0px");
        el.style.setProperty("--win-r", "-1deg");
      } else {
        // 下层：旋转角度交替方向，封顶 5deg；位移随深度外扩
        const rot = (depth % 2 === 1 ? 1 : -1) * Math.min(depth * 1.6, 5);
        el.style.setProperty("--win-x", depth * OFFSET_STEP + "px");
        el.style.setProperty("--win-y", depth * OFFSET_STEP + "px");
        el.style.setProperty("--win-r", rot.toFixed(1) + "deg");
      }
    });
    const top = openStack[openStack.length - 1];
    menuItems.forEach((item) => {
      item.classList.toggle("active", item.dataset.page === top);
    });
  }

  /* Genie 核心：dir=1 喷出（从右下角展开到窗口位置），dir=-1 吸入（收回右下角）
     性能优化（v0.7.1 沿用）：滤镜分段启用、嵌套毛玻璃动画期间禁用 */
  function genie(el, dir, done) {
    if (reduceMotion) {
      el.classList.toggle("open", dir > 0);
      done && done();
      return;
    }
    const dur = dir > 0 ? 480 : 360;
    const t0 = performance.now();
    const bx = parseFloat(el.style.getPropertyValue("--win-x")) || 0;
    const by = parseFloat(el.style.getPropertyValue("--win-y")) || 0;
    el.style.transition = "none";
    el.classList.add("genie");
    if (dir > 0) el.classList.add("open");
    el.scrollTop = 0;
    // 滤镜启用区间：喷出时前段，吸入时后段
    const filterFrom = dir > 0 ? 0 : 0.55;
    const filterTo = dir > 0 ? 0.42 : 1;
    let filterOn = false;
    function applyFilter(on) {
      if (on === filterOn) return;
      filterOn = on;
      el.classList.toggle("genie", on);
      if (!on && displacement) displacement.setAttribute("scale", "0");
    }
    applyFilter(true);

    function frame(now) {
      const p = Math.min(1, (now - t0) / dur);
      let e, scale, tx, ty, wave;
      if (dir > 0) {
        e = easeOutBack(p);
        scale = 0.05 + 0.95 * e;
        tx = (1 - e) * 52;
        ty = (1 - e) * 52;
        const w = Math.min(1, p / filterTo);
        wave = Math.sin(w * Math.PI) * (1 - w) * 78;
        applyFilter(p < filterTo);
      } else {
        e = p * p * p;
        scale = 1 - 0.95 * e;
        tx = e * 52;
        ty = e * 52;
        const w = Math.max(0, (p - filterFrom) / (1 - filterFrom));
        wave = w * w * 30 + Math.sin(w * Math.PI) * 12;
        applyFilter(p >= filterFrom);
      }
      if (displacement) displacement.setAttribute("scale", Math.max(0, wave).toFixed(1));
      el.style.transform = `translate(calc(-50% + ${bx + tx}px), calc(-50% + ${by + ty}px)) scale(${scale})`;
      el.style.opacity = dir > 0 ? Math.min(1, p / 0.1) : Math.max(0, 1 - p / 0.7);
      if (p < 1) {
        requestAnimationFrame(frame);
      } else {
        applyFilter(false);
        el.style.transition = "";
        el.style.transform = "";
        el.style.opacity = "";
        if (dir < 0) el.classList.remove("open");
        done && done();
      }
    }
    requestAnimationFrame(frame);
  }

  /* 打开窗口：新窗口入栈为顶层（位置由 refreshStack 统一排布）；已存在则置顶 */
  function openWindow(page) {
    const el = panels[page];
    if (!el || animating) return;
    const existed = openStack.includes(page);
    if (!existed) {
      openStack.push(page);
      refreshStack();
      genie(el, 1, () => {});
    } else {
      openStack.splice(openStack.indexOf(page), 1);
      openStack.push(page);
      refreshStack();
    }
  }

  /* 关闭窗口：吸入收回；全部关闭后回到图库。动画串行执行（排队），避免并发滤镜卡顿 */
  function closeWindow(page) {
    const idx = openStack.indexOf(page);
    if (idx < 0) return;
    openStack.splice(idx, 1);
    const el = panels[page];
    refreshStack();
    if (animating) {
      closeQueue.push(el);
      return;
    }
    runClose(el);
  }
  function runClose(el) {
    animating = true;
    genie(el, -1, () => {
      animating = false;
      if (closeQueue.length) {
        runClose(closeQueue.shift());
      } else if (!openStack.length) {
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    });
  }

  /* 关闭全部窗口（点菜单"图库"） */
  function closeAll() {
    [...openStack].forEach((id) => closeWindow(id));
  }

  // 窗口点击 → 置顶（像点击 macOS 窗口带到前面）
  Object.entries(panels).forEach(([id, el]) => {
    el.addEventListener("pointerdown", () => {
      if (openStack.includes(id) && openStack[openStack.length - 1] !== id) {
        openStack.splice(openStack.indexOf(id), 1);
        openStack.push(id);
        refreshStack();
      }
    });
  });

  // 页面菜单点击（修复：tagMenu/fabBtn 为 initGallery 局部变量，须经 DOM 引用）
  menuItems.forEach((item) => {
    item.addEventListener("click", () => {
      pageMenu.classList.remove("open");
      fabPageBtn.classList.remove("open");
      const tm = document.getElementById("tagMenu");
      const fb = document.getElementById("fabBtn");
      if (tm) tm.classList.remove("open");
      if (fb) fb.classList.remove("open");
      flyoutOpenCount = 0;
      syncFabGroup();
      if (selectMode) exitSelectMode();
      if (item.dataset.page === "gallery") closeAll();
      else openWindow(item.dataset.page);
    });
  });

  // 供快捷键等外部调用
  window.__openWindow = openWindow;

  // 返回按钮与红点关闭
  Object.entries(panels).forEach(([id]) => {
    btnBack[id].addEventListener("click", () => closeWindow(id));
    btnClose[id].addEventListener("click", () => closeWindow(id));
  });
}
