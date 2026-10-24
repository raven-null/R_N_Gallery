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

/* ---------- 标签体系（v0.11 / v0.15 主分类）：配置状态（模块级，菜单/管理页共享） ---------- */
/* 内置主分类（可选、可多选；v0.19 起曾是"上传必选"，v0.58 起彻底放开）；照片 meta.categories 存名称数组（名称即引用键） */
const DEFAULT_CATEGORIES = [
  { id: "cat-2d-girl", name: "次元女", color: "#ff6fa5", sort: 0 },
  { id: "cat-2d-boy", name: "次元男", color: "#6aa5ff", sort: 1 },
  { id: "cat-illust", name: "插画", color: "#b58cff", sort: 2 },
  { id: "cat-scenery", name: "风景", color: "#4ec97b", sort: 3 },
  { id: "cat-beauty", name: "美女", color: "#ffb340", sort: 4 },
  { id: "cat-handsome", name: "帅哥", color: "#00c2b8", sort: 5 },
];
let TAGS = { categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })), groups: [], tags: [] };
/* v0.55 / v0.57：保留名 —— r18 / r16 现在是**图库分级档位**（见 ratingOf），不该再作为普通标签 /
   主分类存在。标签库里新建或改名成它们会被前端拦下（后端也拦一道），照片上则会折算进分级。 */
const RESERVED_NAMES_UI = new Set(["r18", "r16"]);
const isReservedNameUI = (n) => RESERVED_NAMES_UI.has(String(n == null ? "" : n).trim().toLowerCase());
/* 筛选状态（v0.55）：原来是 activeTagName / activeCategory / activeGroupId 三个互斥标量，
   只能表达「单标签」「单组」「单分类」，加不了组合与排除。现在收进一个结构化对象 ——
   每层内部 OR（标签层可切 AND），层与层之间 AND，另有一层「排除」（命中即出局）。
   判定只集中在 basePred 一处，落盘 / 复用走 filterSnapshot()。 */
const FILTER = {
  cats: new Set(),   // 主分类名（"__none" = 未分类）
  groups: new Set(), // 标签组 id（整组筛选：组内任一标签命中即可）
  tags: new Set(),   // 标签名
  tagOp: "or",       // 标签层内部组合：or = 命中任一，and = 全部命中
  not: new Set(),    // 排除项，形如 "tag:胡桃" / "group:g-xxx" / "cat:风景"
  rating: null,      // v0.57：分级档位（general | r16 | r18，null = 不限）；与其它层 AND 叠加
};
let filterNegMode = false;            // 菜单处于「排除」模式：接下来点击的项目加入排除
const SAVED_KEY = "rn_saved_filters"; // 「我的筛选」收藏（v0.55）
const collapsedGroups = new Set(); // 筛选菜单中折叠的组 id

/* ---------- 排序 / 批量选择（v0.11.2；收藏功能已在 v0.35 移除，改用「加入相册」） ---------- */
const SORT_KEY = "rn_sort";
let SORT_MODE = "newest"; // newest | oldest | title | size
let selectMode = false;
const selected = new Set();

/* v0.54：照片的时间线字段（拍摄时间优先，缺失时回退上传时间）——
   排序与方格模式的分段都走这里，保证两者顺序一致 */
const photoTimeOf = (p) => String((p && (p.takenAt || p.uploadedAt)) || "");

function sortPhotos(list) {
  const out = [...list];
  if (SORT_MODE === "oldest") out.sort((a, b) => photoTimeOf(a).localeCompare(photoTimeOf(b)));
  else if (SORT_MODE === "size") out.sort((a, b) => (b.size || 0) - (a.size || 0));
  else out.sort((a, b) => photoTimeOf(b).localeCompare(photoTimeOf(a)));
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
/* v0.52：判断事件目标是不是「正在打字」的地方（输入框 / 文本域 / 下拉框 / 可编辑区域）。
   所有全局键盘快捷键都要先过这一关，否则会抢走用户正在输入的数字、方向键、空格等。
   （此前整理视图的 1-9 打标签快捷键就曾把设置页密码框里的数字吞掉） */
function isTypingTarget(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
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
/* 多选项确认（v0.22：相似图片提醒用）。choices: [{ value, label, kind }]
   返回所选 value；点「取消」返回 null。复用同一个 confirmModal 容器 */
function askChoice(title, desc, choices) {
  return new Promise((resolve) => {
    const m = document.getElementById("confirmModal");
    if (!m) return resolve(null);
    document.getElementById("confirmTitle").textContent = title;
    document.getElementById("confirmDesc").textContent = desc;
    const actions = m.querySelector(".m-actions");
    const original = actions.innerHTML;
    actions.innerHTML = "";
    const finish = (v) => {
      actions.innerHTML = original; // 还原，供其他确认弹窗继续使用
      m.classList.remove("open");
      resolve(v);
    };
    (choices || []).forEach((c) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn " + (c.kind || "ghost");
      b.textContent = c.label;
      b.onclick = () => finish(c.value);
      actions.appendChild(b);
    });
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn ghost";
    cancel.textContent = "取消";
    cancel.onclick = () => finish(null);
    actions.appendChild(cancel);
    m.classList.add("open");
  });
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

/* ---------- 主分类 helpers（v0.15 单选 → v0.19 多选） ---------- */
const catByName = (name) => (TAGS.categories || []).find((c) => c.name === name);
const catColor = (name) => {
  const c = catByName(name);
  return c ? c.color : null;
};
function sortedCategories() {
  return [...(TAGS.categories || [])].sort((a, b) => ((a.sort || 0) - (b.sort || 0)) || a.name.localeCompare(b.name, "zh"));
}
/* 照片的主分类数组（兼容旧的单值 category 字段） */
const catsOf = (p) => (Array.isArray(p.categories) ? p.categories.filter(Boolean) : (p.category ? [p.category] : []));

/* ---------- 收藏夹（v0.56）----------
   v0.35 曾把「收藏」整块删掉、改用「加入相册」；v0.56 相册退场后收藏回归，
   这次存在**照片自己的字段**上（meta.fav），跟图走：换设备、重装都在，
   也不用担心像"单独一份 id 列表"那样删图后留下悬空引用。
   只有管理员能改 —— 服务端对整理角色会把 body 裁剪成 tags/categories，fav 自然被丢掉。 */
const favOf = (p) => !!p && p.fav === true;
async function setFav(id, on) {
  const p = PHOTOS.find((x) => x.id === id);
  if (!p) return false;
  if (!isAdmin()) return false; // 静默兜底：各入口已按模式隐藏 / 提示
  const prev = favOf(p);
  const next = on === undefined ? !prev : !!on;
  if (next === prev) return true;
  p.fav = next; // 乐观更新：手感优先，失败回滚
  if (window.__renderGallery) window.__renderGallery();
  updateLbFav();
  try {
    const r = await apiFetch(`/api/photos/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fav: next }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || "收藏失败");
    return true;
  } catch (e) {
    p.fav = prev;
    if (window.__renderGallery) window.__renderGallery();
    updateLbFav();
    alert((next ? "收藏" : "取消收藏") + "失败：" + e.message);
    return false;
  }
}
/* 批量收藏（多选后批量条上的「♥ 收藏」） */
async function setFavMany(ids, on) {
  let n = 0;
  for (const id of ids) { if (await setFav(id, on)) n++; }
  return n;
}

/* ---------- 分级三档选择（v0.57）：单选，只有管理员能改 ---------- */
function renderRatingPicks(container, cur) {
  if (!container) return;
  const v = normRating(cur);
  container.querySelectorAll(".rating-pick").forEach((b) => {
    b.classList.toggle("on", b.dataset.rating === v);
  });
}
function ratingPicksValue(container) {
  const on = container && container.querySelector(".rating-pick.on");
  return on ? normRating(on.dataset.rating) : "general";
}
function bindRatingPicks(container) {
  if (!container || container.dataset.bound) return;
  container.dataset.bound = "1";
  container.addEventListener("click", (e) => {
    const btn = e.target.closest(".rating-pick");
    if (!btn) return;
    renderRatingPicks(container, btn.dataset.rating);
  });
}
/* 卡片 / 灯箱上的分级角标（大众级不显示） */
function ratingBadge(p) {
  const r = ratingOf(p);
  if (r === "general") return "";
  return `<span class="rating-badge r-${r}" title="分级：${RATING_LABEL[r]}">${RATING_LABEL[r]}</span>`;
}
/* 展示用主分类 chip（与标签 chip 同款胶囊，色随分类配置） */
const catChip = (name) => {
  if (!name) return "";
  const c = catColor(name) || "#8e8e93";
  return `<span class="tg cat" style="--tg:${c}" title="主分类">${esc(name)}</span>`;
};
/* 多分类 chip 串：最多显示 max 个，其余折成 +N */
function catChipsOf(p, max = 2) {
  const cats = catsOf(p);
  if (!cats.length) return "";
  return cats.slice(0, max).map(catChip).join("")
    + (cats.length > max ? `<span class="tg cat" style="--tg:#8e8e93" title="${escAttr(cats.join("、"))}">+${cats.length - max}</span>` : "");
}
/* 主分类 chips 渲染（sel 可为字符串或数组）；容器 data-multi="1" 时多选
   v0.28：容器 data-can-edit="1" 时每个分类带「✎」编辑入口（改名 / 改色 / 删除） */
function renderCatPicks(container, sel) {
  if (!container) return;
  const set = new Set(Array.isArray(sel) ? sel : (sel ? [sel] : []));
  const canEdit = container.dataset.canEdit === "1";
  container.innerHTML = sortedCategories().map((c) =>
    `<button type="button" class="cat-pick${set.has(c.name) ? " on" : ""}" data-cat="${escAttr(c.name)}" style="--tg:${c.color || "var(--accent)"}">
      <i class="dot"></i>${esc(c.name)}${canEdit ? `<span class="cat-edit" title="编辑该主分类（改名 / 改色 / 删除）">✎</span>` : ""}</button>`).join("");
}
/* 读取容器里已选的主分类（数组） */
const selCatsOf = (container) => {
  if (!container) return [];
  return [...container.querySelectorAll(".cat-pick.on")].map((el) => el.dataset.cat);
};
const selCatOf = (container) => selCatsOf(container)[0] || null;
/* 绑定选择（事件委托，innerHTML 重建无需重绑）
   多选容器（data-multi="1"）：点一下开关一项；
   单选容器：data-allow-off="1" 时再点已选项 = 取消 */
function bindCatPicks(container, onChange) {
  if (!container) return;
  container.addEventListener("click", (e) => {
    // v0.28：点「✎」= 打开主分类编辑弹窗（改名 / 改色 / 删除），不影响当前选择
    const editBtn = e.target.closest(".cat-edit");
    if (editBtn) {
      const host = editBtn.closest(".cat-pick");
      if (host && host.dataset.cat) {
        e.preventDefault();
        e.stopPropagation();
        openCatModal("edit-category", host.dataset.cat);
      }
      return;
    }
    const b = e.target.closest(".cat-pick");
    if (!b) return;
    const multi = container.dataset.multi === "1";
    const wasOn = b.classList.contains("on");
    if (multi) {
      b.classList.toggle("on", !wasOn);
      if (onChange) onChange(selCatsOf(container));
      return;
    }
    const allowOff = container.dataset.allowOff === "1";
    if (wasOn && allowOff) {
      b.classList.remove("on");
      if (onChange) onChange(null);
      return;
    }
    container.querySelectorAll(".cat-pick.on").forEach((x) => x.classList.remove("on"));
    b.classList.add("on");
    if (onChange) onChange(b.dataset.cat);
  });
}

/* ---------- 标签配置加载与保存 ---------- */
async function loadTags() {
  try {
    const res = await apiFetch("/api/tags");
    const d = await res.json();
    TAGS = (d && Array.isArray(d.groups) && Array.isArray(d.tags))
      ? { categories: Array.isArray(d.categories) ? d.categories : DEFAULT_CATEGORIES.map((c) => ({ ...c })), groups: d.groups, tags: d.tags }
      : { categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })), groups: [], tags: [] };
    if (window.__refreshQuickPick) window.__refreshQuickPick();
    clearGroupNameCache(); // v0.55：标签 / 组变了，整组筛选用的名字集合必须重建
  } catch (e) {
    TAGS = { categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })), groups: [], tags: [] }; // API 不可用时降级为纯自由标签
    clearGroupNameCache();
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
/* v0.31：改名 / 删除类接口不再内部重读配置（loadTags）。
   Netlify Blobs 写入后读取有 1~2 分钟延迟，重读会拿到旧数据，
   界面就会长时间显示旧名 —— 改为「后端写入 + 前端本地立即生效」。 */
async function apiRenameTag(from, to) {
  const res = await apiFetch("/api/tags/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to }),
  });
  const d = await res.json();
  if (!d.ok) throw new Error(d.error || "改名失败");
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
  return d;
}
/* ---------- 主分类管理 API（v0.15） ---------- */
async function apiRenameCategory(from, to) {
  const res = await apiFetch("/api/tags/category-rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to }),
  });
  const d = await res.json();
  if (!d.ok) throw new Error(d.error || "主分类改名失败");
  return d;
}
async function apiRemoveCategory(name) {
  const res = await apiFetch("/api/tags/category-remove", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const d = await res.json();
  if (!d.ok) throw new Error(d.error || "删除主分类失败");
  return d;
}

/* ---------- 本地即时更新（v0.31）：改名 / 删除后立刻反映到界面，不等服务端重读 ---------- */
/* v0.55：改名 / 合并 / 删除会动到「筛选状态」和「组内标签名缓存」——
   统一在这里收口，免得改完名筛选条件指向一个已经不存在的名字（结果突然空掉）。 */
function syncFilterRename(kind, from, to) {
  const set = kind === "tag" ? FILTER.tags : (kind === "cat" ? FILTER.cats : FILTER.groups);
  const fromKey = `${kind}:${from}`;
  const toKey = `${kind}:${to}`;
  if (set.has(from)) { set.delete(from); if (to) set.add(to); }
  if (FILTER.not.has(fromKey)) { FILTER.not.delete(fromKey); if (to) FILTER.not.add(toKey); }
}
function syncFilterRemove(kind, name) {
  const set = kind === "tag" ? FILTER.tags : (kind === "cat" ? FILTER.cats : FILTER.groups);
  set.delete(name);
  FILTER.not.delete(`${kind}:${name}`);
}
/* 标签改名（若目标已存在 = 合并：删掉旧名记录，引用都指向新名）；
   v0.55：旧名收进别名（与服务端 tagsRename 一致），改名后按旧名仍能搜到 */
function renameTagLocally(from, to) {
  const exists = TAGS.tags.some((t) => t.name === to);
  if (exists) {
    const fromTag = TAGS.tags.find((t) => t.name === from);
    const toTag = TAGS.tags.find((t) => t.name === to);
    if (toTag) {
      const aliases = new Set((toTag.aliases || []).concat(fromTag ? (fromTag.aliases || []) : []));
      aliases.add(from);
      aliases.delete(to);
      toTag.aliases = [...aliases].slice(0, 20);
    }
    TAGS.tags = TAGS.tags.filter((t) => t.name !== from);
  } else {
    const t = TAGS.tags.find((x) => x.name === from);
    if (t) {
      t.name = to;
      const aliases = new Set((t.aliases || []).filter(Boolean));
      aliases.add(from);
      aliases.delete(to);
      t.aliases = [...aliases].slice(0, 20);
    }
  }
  syncFilterRename("tag", from, to);
  clearGroupNameCache();
  PHOTOS.forEach((p) => {
    if (Array.isArray(p.tags) && p.tags.includes(from)) {
      p.tags = [...new Set(p.tags.map((x) => (x === from ? to : x)))].slice(0, 10);
    }
  });
}
function removeTagLocally(name) {
  TAGS.tags = TAGS.tags.filter((t) => t.name !== name);
  syncFilterRemove("tag", name);
  clearGroupNameCache();
  PHOTOS.forEach((p) => {
    if (Array.isArray(p.tags) && p.tags.includes(name)) {
      p.tags = p.tags.filter((x) => x !== name);
    }
  });
}
function renameCategoryLocally(from, to) {
  const c = (TAGS.categories || []).find((x) => x.name === from);
  if (c) c.name = to;
  syncFilterRename("cat", from, to);
  PHOTOS.forEach((p) => {
    const cats = catsOf(p);
    if (cats.includes(from)) p.categories = cats.map((x) => (x === from ? to : x));
  });
}
function removeCategoryLocally(name) {
  TAGS.categories = (TAGS.categories || []).filter((c) => c.name !== name);
  syncFilterRemove("cat", name);
  PHOTOS.forEach((p) => {
    const cats = catsOf(p);
    if (cats.includes(name)) p.categories = cats.filter((x) => x !== name);
  });
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

const FIRST_PAGE = 120; // v0.24：首屏只取 120 张，秒开
const NEXT_PAGE = 200;  // 其余后台分批静默补齐
const mapPhoto = (p) => ({
  ...p,
  url: mediaUrl(p.id, "raw"),
  thumbUrl: p.thumbKey ? mediaUrl(p.id, "thumb") : null,
});
/* v0.54：统一超时信号（旧浏览器没有 AbortSignal.timeout，退化为不设超时，不影响功能） */
const timeoutSignal = (ms) =>
  typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
async function fetchPhotosPage(cursor, limit) {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (cursor) qs.set("cursor", String(cursor));
  if (adultHidden()) qs.set("safe", "1"); // v0.49 观光模式：服务端列表里也剔除成人向图片
  const res = await fetch(`/api/photos?${qs}`, { headers: apiHeaders(), cache: "no-store", signal: timeoutSignal(20000) }); // v0.54：加 20s 超时
  if (!res.ok) throw new Error("api unavailable");
  return res.json();
}
/* 后台静默补齐剩余照片（不阻塞首屏；补齐后刷新菜单计数与列表数据） */
let bgLoading = false;
async function backgroundLoad(cursor) {
  if (bgLoading) return;
  bgLoading = true;
  let c = cursor;
  try {
    while (c) {
      const page = await fetchPhotosPage(c, NEXT_PAGE);
      const raw = (page.photos || []).map(mapPhoto);
      if (!raw.length) break; // 用原始条数判断是否还有下一页（v0.49：过滤成人向不能让分页提前结束）
      const items = adultHidden() ? raw.filter((p) => !isAdult(p)) : raw; // v0.49 观光模式双保险
      const known = new Set(PHOTOS.map((p) => p.id));
      PHOTOS.push(...items.filter((p) => !known.has(p.id)));
      c = page.cursor || null;
      renderTagMenuContent();
    }
  } catch (e) { /* 补齐失败不影响已显示的内容 */ }
  bgLoading = false;
  if (window.__photosGrown) window.__photosGrown(); // 让图库墙把新数据纳入筛选（保留当前显示数量）
}

let loadSeq = 0; // v0.54：请求序号，防止「旧响应后到」覆盖新数据
async function loadData() {
  const seq = ++loadSeq;
  showGalleryState("loading");
  try {
    const first = await fetchPhotosPage(null, FIRST_PAGE);
    if (seq !== loadSeq) return; // 期间又发起了新的加载 → 丢弃这次结果
    PHOTOS = (first.photos || []).map(mapPhoto).filter((p) => !adultHidden() || !isAdult(p)); // v0.49 观光模式双保险
    USE_API = true;
    showGalleryState(null); // 由 render 决定显示图片或空态
    if (first.hasMore) backgroundLoad(first.cursor); // 剩余的后台补齐
  } catch (e) {
    if (seq !== loadSeq) return;
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
  const opts = { ...options, headers: { ...apiHeaders(), ...(options.headers || {}) } };
  if (!opts.signal) opts.signal = timeoutSignal(20000); // v0.54：原来完全没有超时，弱网下会一直挂着
  const res = await fetch(path, opts);
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

/* ---------- 访问密码 / 图片可见性（v0.16；v0.50 移除 R18 密钥） ---------- */
const TOKEN_KEY = "rn_token";
const R18_KEY_STORE = "rn_r18"; // 仅用于清除历史遗留值，不再读写
function gateToken() { return localStorage.getItem(TOKEN_KEY) || ""; }
function authState() { return window.__authState || { gate: false, hasTagger: false }; }
async function fetchAuthState() {
  try {
    const r = await fetch("/api/auth/state", { cache: "no-store" });
    const d = await r.json();
    window.__authState = { gate: !!d.gate, hasTagger: !!d.hasTagger };
  } catch (e) {
    window.__authState = { gate: false, hasTagger: false };
  }
  return window.__authState;
}
/* 图片是 <img> 直接加载、带不了请求头，因此把凭证放进 URL 参数
   v0.50：R18 密钥参数已移除（密钥机制删除），只保留访问密码 */
function mediaUrl(id, kind) {
  const q = new URLSearchParams();
  const t = gateToken();
  if (t) q.set("token", t);
  const qs = q.toString();
  return `/api/photos/${id}/${kind}` + (qs ? "?" + qs : "");
}
/* ============================================================
   分级（v0.57）：整库三档 —— general（大众级）/ r16 / r18
   v0.56 及以前成人向是「独立布尔字段 + 标签名 + 主分类名」三路任一命中，标签一撞车就改可见性。
   现在收敛成照片自己的字段 meta.rating。判定顺序与后端 _lib.js 的 ratingOf() 完全一致：
   显式字段 → 老布尔字段 → 老标签 → 老主分类（后三者只为兼容迁移前的数据）。
   注意：分级**不吃标签库** —— 三档图片共用同一套标签 / 组 / 主分类，分级只是并列的一个属性维度。
   ============================================================ */
const RATINGS = ["general", "r16", "r18"];
const RATING_LABEL = { general: "大众级", r16: "R16", r18: "R18" };
const RATING_COLOR = { general: "#4ec97b", r16: "#ff9f0a", r18: "#ff453a" };
const RATING_RANK = { general: 0, r16: 1, r18: 2 };
function normRating(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  return RATINGS.includes(s) ? s : "general";
}
function ratingOf(p) {
  if (!p) return "general";
  const raw = String(p.rating || "").trim().toLowerCase();
  if (RATINGS.includes(raw)) return raw;
  if (p.r18 === true) return "r18";
  if (p.r16 === true) return "r16";
  if (Array.isArray(p.tags) && p.tags.some((t) => String(t).trim().toLowerCase() === "r18")) return "r18";
  if (Array.isArray(p.tags) && p.tags.some((t) => String(t).trim().toLowerCase() === "r16")) return "r16";
  if (catsOf(p).some((c) => String(c).trim().toLowerCase() === "r18")) return "r18";
  if (catsOf(p).some((c) => String(c).trim().toLowerCase() === "r16")) return "r16";
  return "general";
}
const isR18 = (p) => ratingOf(p) === "r18";
const isR16 = (p) => ratingOf(p) === "r16";
/* 成人向 = 非大众级（观光 / 整理模式对 R16 与 R18 一视同仁） */
const isAdult = (p) => ratingOf(p) !== "general";
/* v0.50：R18 密钥的输入 / 校验流程与锁定占位卡都已删除；
   R18 / R16 的可见性现在只由观光模式的 adultHidden() 决定 */
/* ---------- 观光 / 整理 / 管理员 三种模式（v0.49；v0.51 加整理模式） ----------
   观光模式：只能看图与下载（外加筛选/搜索/排序/布局切换这些纯浏览辅助），R18 / R16 隐藏
   整理模式：观光模式的能力 + 「标签管理 → 整理」里给图片打标签 / 设主分类，R18 / R16 照样隐藏
   管理员模式：全部功能、全部图片
   观光 → 整理 / 管理员 需要输入对应密码（服务端登录接口一次判断角色） */
const MODE_KEY = "rn_mode";
const GUEST_ADULT_KEY = "rn_guest_adult";
const GUEST_VISIT_KEY = "rn_guest_visit"; // 观光访客：没有访问密码也允许只读浏览
function guestVisiting() {
  try { return localStorage.getItem(GUEST_VISIT_KEY) === "1"; } catch (e) { return false; }
}
function modeValue() {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === "admin" || v === "tagger" ? v : "guest";
  } catch (e) { return "guest"; }
}
function isAdmin() { return modeValue() === "admin"; }
function isTagger() { return modeValue() === "tagger"; } // 整理模式
function manageAllowed() { return isAdmin() || isTagger(); } // 能打开标签管理的整理视图
function guestAdultAllowed() {
  try { return localStorage.getItem(GUEST_ADULT_KEY) === "1"; } catch (e) { return false; }
}
/* 现在是否需要隐藏成人向图片（只有管理员能看到） */
function adultHidden() { return !isAdmin() && !guestAdultAllowed(); }

function applyMode() {
  const mode = modeValue();
  const guest = mode === "guest";
  document.body.classList.toggle("mode-guest", guest);
  document.body.classList.toggle("mode-tagger", mode === "tagger");
  document.body.classList.toggle("mode-admin", mode === "admin");
  const btn = document.getElementById("fabModeBtn");
  if (btn) {
    btn.title = guest ? "观光模式 · 点此输入密码进入整理 / 管理员模式"
      : mode === "tagger" ? "整理模式 · 点此切换模式（可打标签，不看 R18 / R16）"
        : "管理员模式 · 点此切换模式";
    btn.classList.toggle("on", !guest);
    const g = btn.querySelector(".ico-guest");
    const tg = btn.querySelector(".ico-tagger");
    const a = btn.querySelector(".ico-admin");
    if (g) g.style.display = guest ? "" : "none";
    if (tg) tg.style.display = mode === "tagger" ? "" : "none";
    if (a) a.style.display = mode === "admin" ? "" : "none";
  }
  const state = document.getElementById("modeState");
  if (state) state.textContent = guest ? "观光模式" : (mode === "tagger" ? "整理模式" : "管理员模式");
  const box = document.getElementById("guestAdult");
  if (box) box.checked = guestAdultAllowed();
  // v0.56：非管理员不显示收藏入口（收藏是照片字段的写操作；卡片上的爱心同理按 manageAllowed 控制）
  const favBtn = document.getElementById("lbToolFav");
  if (favBtn) favBtn.style.display = isAdmin() ? "" : "none";
}

/* 初始化：优先用上次的选择；首次访问时——已通过门禁登录算管理员，否则观光 */
function initMode() {
  let saved = null;
  try { saved = localStorage.getItem(MODE_KEY); } catch (e) { /* ignore */ }
  if (saved !== "admin" && saved !== "tagger" && saved !== "guest") {
    saved = gateToken() ? "admin" : "guest";
    try { localStorage.setItem(MODE_KEY, saved); } catch (e) { /* ignore */ }
  }
  applyMode();
}
function setMode(mode) {
  try { localStorage.setItem(MODE_KEY, mode); } catch (e) { /* ignore */ }
  applyMode();
}
/* 受限模式下拦住管理类操作；返回 true 表示已拦下 */
function guestBlocked(what) {
  if (isAdmin()) return false;
  const label = isTagger() ? "整理模式" : "观光模式";
  const extra = isTagger() ? "整理模式下只能给图片打标签。" : "输入访问密码切换到管理员模式后即可使用。";
  alert(`${label}下${what ? "不能" + what : "此功能不可用"}。\n${extra}`);
  return true;
}
window.__modeState = () => ({
  mode: modeValue(),
  guestAdultAllowed: guestAdultAllowed(),
  photos: PHOTOS.length,
  adultVisible: PHOTOS.filter(isAdult).length,
});
window.__setMode = setMode; // 测试钩子：切换观光 / 整理 / 管理员
window.__reloadData = loadData; // 测试 / 调试钩子：重拉照片列表（严格模式下 eval 的声明不会自动挂到 window）
window.__guestBlocked = guestBlocked;

/* 模式切换弹窗：观光 → 输访问密码；管理员 → 确认退出 */
function openModeModal() {
  if (isAdmin()) {
    askConfirm("退出管理员模式？", "将回到观光模式：管理功能隐藏，带 R18 / R16 标签的图片也会隐藏（除非已允许观光观看）。", "退出", () => {
      setMode("guest");
      location.reload();
    });
    return;
  }
  const m = document.getElementById("modeModal");
  if (!m) return;
  const inp = document.getElementById("modePwd");
  const err = document.getElementById("modeErr");
  if (inp) inp.value = "";
  if (err) { err.textContent = ""; err.style.display = "none"; }
  m.classList.add("open");
  setTimeout(() => { if (inp) inp.focus(); }, 80);
}
async function submitModeLogin() {
  const inp = document.getElementById("modePwd");
  const err = document.getElementById("modeErr");
  const btn = document.getElementById("modeOk");
  const v = (inp && inp.value || "").trim();
  if (!v) {
    if (err) { err.textContent = "请输入访问密码"; err.style.display = "block"; }
    return;
  }
  if (btn) btn.disabled = true;
  try {
    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: v }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || "密码错误");
    }
    const d = await r.json().catch(() => ({}));
    localStorage.setItem(TOKEN_KEY, v); // 管理类操作需要凭证（整理密码同样作为 token 使用）
    try { localStorage.removeItem(GUEST_VISIT_KEY); } catch (e) { /* ignore */ }
    setMode(d.role === "tagger" ? "tagger" : "admin"); // v0.51：服务端判断这是整理密码还是访问密码
    location.reload();
  } catch (e) {
    if (err) { err.textContent = e.message || "验证失败"; err.style.display = "block"; }
  }
  if (btn) btn.disabled = false;
}
function initModeModal() {
  const m = document.getElementById("modeModal");
  if (!m || m.dataset.bound === "1") return;
  m.dataset.bound = "1";
  const close = () => m.classList.remove("open");
  const c = document.getElementById("modeCancel");
  if (c) c.onclick = close;
  const ok = document.getElementById("modeOk");
  if (ok) ok.onclick = submitModeLogin;
  const inp = document.getElementById("modePwd");
  if (inp) inp.addEventListener("keydown", (e) => { if (e.key === "Enter") submitModeLogin(); });
  const fbtn = document.getElementById("fabModeBtn");
  if (fbtn) fbtn.addEventListener("click", (e) => { e.stopPropagation(); openModeModal(); });
  const sbtn = document.getElementById("btnModeSwitch");
  if (sbtn) sbtn.onclick = openModeModal;
  const adult = document.getElementById("guestAdult");
  if (adult) {
    adult.addEventListener("change", () => {
      if (guestBlocked("修改该开关")) { adult.checked = guestAdultAllowed(); return; }
      try { localStorage.setItem(GUEST_ADULT_KEY, adult.checked ? "1" : "0"); } catch (e) { /* ignore */ }
      applyMode();
    });
  }
}

/* 门禁页：登录成功后写入 token 并重载（让所有请求与图片 URL 都带上凭证） */
function showGate() {
  const page = document.getElementById("gatePage");
  if (!page) return;
  page.classList.add("open");
  const input = document.getElementById("gateInput");
  const err = document.getElementById("gateErr");
  const btn = document.getElementById("gateEnter");
  const submit = async () => {
    const v = (input.value || "").trim();
    if (!v) { err.textContent = "请输入访问密码"; return; }
    err.textContent = "";
    btn.disabled = true;
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: v }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        err.textContent = d.error || "密码错误";
        btn.disabled = false;
        return;
      }
      const d = await r.json().catch(() => ({}));
      localStorage.setItem(TOKEN_KEY, v);
      // v0.51：输入的是整理密码就进整理模式，是访问密码就进管理员模式
      try { localStorage.setItem(MODE_KEY, d.role === "tagger" ? "tagger" : "admin"); } catch (e2) { /* ignore */ }
      location.reload();
    } catch (e) {
      err.textContent = "网络错误，请重试";
      btn.disabled = false;
    }
  };
  btn.onclick = submit;
  input.onkeydown = (e) => { if (e.key === "Enter") submit(); };
  // v0.49：不输密码也能进——观光模式（只读 + 隐藏 R18 / R16）
  const guestBtn = document.getElementById("gateGuestBtn");
  if (guestBtn) {
    guestBtn.onclick = () => {
      try {
        localStorage.setItem(GUEST_VISIT_KEY, "1");
        localStorage.setItem(MODE_KEY, "guest");
      } catch (e) { /* ignore */ }
      location.reload();
    };
  }
  setTimeout(() => input.focus(), 60);
}

/* 设置页：访问与保护（v0.50 删掉访问密码 / R18 密钥入口；v0.51 加整理模式密码） */
function initAuthSettings() {
  const btnLogout = document.getElementById("btnLogoutGate");
  const taggerInput = document.getElementById("taggerPwdNew");
  const btnTagger = document.getElementById("btnSetTagger");
  const taggerState = document.getElementById("taggerState");
  const paint = () => {
    const st = authState();
    if (taggerState) taggerState.textContent = st.hasTagger ? "已设置（可进整理模式）" : "未设置";
  };
  paint();
  window.__refreshAuthState = async () => { await fetchAuthState(); paint(); };

  if (btnTagger) btnTagger.onclick = async () => {
    if (guestBlocked("设置整理密码")) return;
    const v = (taggerInput.value || "").trim();
    if (v && v.length < 4) { window.alert("整理密码至少 4 位"); return; }
    const tip = v ? "设置 / 修改整理模式密码？" : "留空保存会清除整理模式密码，之后该密码无法登录。确定？";
    if (!window.confirm(tip)) return;
    try {
      const d = await apiFetch("/api/auth/tagger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taggerKey: v }),
      }).then((r) => r.json());
      if (!d.ok) throw new Error(d.error || "保存失败");
      taggerInput.value = "";
      window.alert(v ? "整理模式密码已更新" : "整理模式密码已清除");
      await fetchAuthState();
      paint();
    } catch (e) {
      window.alert("操作失败：" + (e && e.message ? e.message : e));
    }
  };

  if (btnLogout) btnLogout.onclick = () => {
    if (!window.confirm("退出登录会清除本机保存的密码凭据，确定？")) return;
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(R18_KEY_STORE);
    location.reload();
  };
}

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

/* ---------- 感知哈希 / 相似图片（v0.21） ----------
   上传前在本地算 dHash（9×8 灰度、逐行比较相邻亮度 → 64 位），
   与库中照片（meta.dhash，上传时由服务端算好）比对汉明距离，提示「与某张相似」 */
const DHASH_THRESHOLD = 8; // 64 位里差异 ≤ 8 视为相似（实测不同构图约 ≥ 9）

/* 两个 16 位十六进制 dHash 的汉明距离 */
function hammingHex(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = (parseInt(a[i], 16) || 0) ^ (parseInt(b[i], 16) || 0);
    while (x) { x &= x - 1; d++; }
  }
  return d;
}

/* 从本地文件算 dHash（算法与服务端 genDHash 一致） */
function dhashOfFile(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement("canvas");
          c.width = 9;
          c.height = 8;
          const ctx = c.getContext("2d");
          ctx.drawImage(img, 0, 0, 9, 8);
          const d = ctx.getImageData(0, 0, 9, 8).data;
          let hex = "";
          for (let y = 0; y < 8; y++) {
            for (let x = 0; x < 8; x += 4) {
              let nib = 0;
              for (let k = 0; k < 4; k++) {
                const i0 = (y * 9 + x + k) * 4;
                const i1 = (y * 9 + x + k + 1) * 4;
                const g0 = d[i0] * 0.299 + d[i0 + 1] * 0.587 + d[i0 + 2] * 0.114;
                const g1 = d[i1] * 0.299 + d[i1 + 1] * 0.587 + d[i1 + 2] * 0.114;
                nib = (nib << 1) | (g0 < g1 ? 1 : 0);
              }
              hex += nib.toString(16);
            }
          }
          resolve(hex);
        } catch (err) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = e.target.result;
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/* 库中与给定 dHash 相似的照片（按差异升序，最多 limit 条） */
function findSimilarInLibrary(dhash, limit = 3) {
  if (!dhash) return [];
  const out = [];
  PHOTOS.forEach((p) => {
    if (!p.dhash) return;
    const d = hammingHex(dhash, p.dhash);
    if (d <= DHASH_THRESHOLD) out.push({ photo: p, distance: d });
  });
  return out.sort((a, b) => a.distance - b.distance).slice(0, limit);
}

/* 同一批队列里互相比对（还没上传就能发现重复） */
function findSimilarInQueue(item, all) {
  if (!item.dhash) return [];
  return all.filter((x) => x !== item && x.dhash && hammingHex(item.dhash, x.dhash) <= DHASH_THRESHOLD);
}

/* 上传队列行上的「相似」徽标（悬停看具体是哪几张） */
/* v0.54：队列卡片只剩缩略图，提示信息统一写进 title（文件名 / 状态 / 相似提醒） */
function setUqRowHint(row, text) {
  if (!row) return;
  if (text !== undefined) row.dataset.hint = text || "";
  const sim = row.dataset.sim || "";
  row.title = [row.dataset.hint, sim].filter(Boolean).join(" · ");
}
function updateUqSimilarBadge(it) {
  const row = it.row;
  if (!row) return;
  const lib = (it.similar && it.similar.lib) || [];
  const q = (it.similar && it.similar.queue) || [];
  if (!lib.length && !q.length) { delete row.dataset.sim; setUqRowHint(row); return; }
  const parts = [];
  if (lib.length) parts.push(`库中相似：${lib.map((x) => `「${x.photo.title}」差异 ${x.distance}/64`).join("；")}`);
  if (q.length) parts.push(`本批相似：${q.map((x) => x.f.name).join("、")}`);
  row.dataset.sim = parts.join(" · ");
  setUqRowHint(row);
}

/* ---------- 图库查重：完全相同 / 相似图片（v0.42） ----------
   用户诉求：图库里有两张相同或相似的图时提醒他。
   上传时的提醒已有（上面那套）；这里补的是**库内既有照片**的扫描：
   内容哈希 sha1 相同 = 完全相同；感知哈希 dHash 汉明距离 ≤ 8 = 构图相似。 */
let dupAll = [];        // 本次扫描拿到的全量索引（含 url/thumbUrl）
let dupGroups = [];     // 扫描结果分组
let dupScanned = 0;
let dupScanBusy = false;

function popcount32(x) {
  x = x - ((x >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  x = (x + (x >> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}
/* 16 位十六进制 dHash → 两个 32 位整数，便于批量比较时快速算汉明距离 */
function dhashNum(hex) {
  if (!hex || hex.length < 16) return null;
  return [parseInt(hex.slice(0, 8), 16), parseInt(hex.slice(8, 16), 16)];
}
function hammingFast(a, b) {
  return popcount32((a[0] ^ b[0]) >>> 0) + popcount32((a[1] ^ b[1]) >>> 0);
}
function fmtBytes(b) {
  const n = Number(b) || 0;
  return n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.round(n / 1e3) + " KB";
}

/* 拉全量索引（分页 500，走列表接口，不受图库墙已显示数量影响） */
async function fetchAllIndex() {
  const out = [];
  let cursor = null;
  for (let guard = 0; guard < 400; guard++) {
    const page = await fetchPhotosPage(cursor, 500);
    const items = (page.photos || []).map(mapPhoto);
    out.push(...items);
    if (!page.hasMore || !items.length || !page.cursor) break;
    cursor = page.cursor;
  }
  return out;
}

/* 扫描：exact = 完全相同（sha1 相同），similar = 相似（dHash 距离 ≤ 阈值） */
function scanDuplicates(list) {
  const groups = [];
  const byHash = new Map();
  for (const p of list) {
    if (!p.hash) continue;
    if (!byHash.has(p.hash)) byHash.set(p.hash, []);
    byHash.get(p.hash).push(p);
  }
  for (const arr of byHash.values()) {
    if (arr.length > 1) groups.push({ kind: "exact", distance: 0, photos: arr });
  }

  const items = list.map((p) => ({ p, n: dhashNum(p.dhash) })).filter((x) => x.n);
  const pairs = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      // 完全相同的内容哈希已单独成组，不再重复报为「相似」
      if (items[i].p.hash && items[i].p.hash === items[j].p.hash) continue;
      const d = hammingFast(items[i].n, items[j].n);
      if (d <= DHASH_THRESHOLD) pairs.push([i, j, d]);
    }
  }
  // 连通分量：A~B、B~C 归为同一组相似图
  const adj = new Map();
  for (const [i, j, d] of pairs) {
    if (!adj.has(i)) adj.set(i, []);
    if (!adj.has(j)) adj.set(j, []);
    adj.get(i).push([j, d]);
    adj.get(j).push([i, d]);
  }
  const seen = new Set();
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const stack = [start];
    const comp = [];
    let minD = 64;
    seen.add(start);
    while (stack.length) {
      const k = stack.pop();
      comp.push(k);
      for (const [nx, d] of adj.get(k) || []) {
        if (d < minD) minD = d;
        if (!seen.has(nx)) { seen.add(nx); stack.push(nx); }
      }
    }
    if (comp.length > 1) groups.push({ kind: "similar", distance: minD, photos: comp.map((k) => items[k].p) });
  }
  // 完全相同优先，然后按组内张数、差异升序
  return groups.sort((a, b) => (a.kind === b.kind ? (b.photos.length - a.photos.length || a.distance - b.distance) : (a.kind === "exact" ? -1 : 1)));
}

function renderDupResults(err) {
  const body = document.getElementById("dupBody");
  if (!body) return;
  if (err) {
    body.innerHTML = `<div class="dup-empty">扫描失败：${esc(err.message || String(err))}</div>`;
    return;
  }
  if (!dupGroups.length) {
    body.innerHTML = `<div class="dup-empty">✓ 没发现重复或相似的图片（已扫 ${dupScanned} 张）</div>`;
    return;
  }
  const exact = dupGroups.filter((g) => g.kind === "exact").length;
  const sim = dupGroups.length - exact;
  body.innerHTML = `<div class="dup-summary">发现 <b>${dupGroups.length}</b> 组（完全相同 ${exact} · 相似 ${sim}），共扫描 ${dupScanned} 张</div>` +
    dupGroups.map((g, gi) => {
      const kind = g.kind === "exact"
        ? `<span class="dup-kind exact">完全相同</span>`
        : `<span class="dup-kind similar">相似 · 差异 ${g.distance}/64</span>`;
      const items = g.photos.map((p) => `
        <div class="dup-item" data-id="${esc(p.id)}">
          <img class="dup-thumb" src="${esc(p.thumbUrl || p.url)}" alt="" loading="lazy" decoding="async" data-dupview="${esc(p.id)}">
          <div class="dup-meta">
            <b>${esc(p.title || "未命名")}</b>
            <span>${p.width || 0}×${p.height || 0} · ${fmtBytes(p.size)} · ${esc(String(p.uploadedAt || "").slice(0, 10))}</span>
          </div>
          <div class="dup-acts">
            <button class="btn ghost sm" type="button" data-dupview="${esc(p.id)}">看大图</button>
            <button class="btn ghost sm dup-del" type="button" data-dupdel="${esc(p.id)}">删除</button>
          </div>
        </div>`).join("");
      return `<div class="dup-group">
        <div class="dup-head">${kind}<span class="dup-count">${g.photos.length} 张</span>
          <button class="btn ghost sm" type="button" data-dupkeep="${gi}">保留最新一张，删除其余 ${g.photos.length - 1} 张</button>
        </div>
        <div class="dup-items">${items}</div>
      </div>`;
    }).join("");
}

async function runDupScan() {
  const body = document.getElementById("dupBody");
  if (!body || dupScanBusy) return;
  dupScanBusy = true;
  body.innerHTML = `<div class="dup-empty">正在扫描图库…</div>`;
  try {
    dupAll = await fetchAllIndex();
    dupScanned = dupAll.length;
    dupGroups = scanDuplicates(dupAll);
    renderDupResults();
    window.__dupState = () => ({ scanned: dupScanned, groups: dupGroups.length, exact: dupGroups.filter((g) => g.kind === "exact").length });
  } catch (e) {
    dupGroups = [];
    renderDupResults(e);
  }
  dupScanBusy = false;
}

function dropFromDupResults(ids) {
  const set = new Set(ids);
  for (let i = PHOTOS.length - 1; i >= 0; i--) if (set.has(PHOTOS[i].id)) PHOTOS.splice(i, 1);
  dupAll = dupAll.filter((x) => !set.has(x.id));
  dupGroups = dupGroups
    .map((g) => ({ ...g, photos: g.photos.filter((x) => !set.has(x.id)) }))
    .filter((g) => g.photos.length > 1); // 组里只剩一张就不再是「重复」
  if (window.__refreshGallery) window.__refreshGallery();
  renderDupResults();
}

/* 删除单张（在查重弹窗里） */
function deleteDupPhoto(id) {
  const p = dupAll.find((x) => x.id === id) || PHOTOS.find((x) => x.id === id);
  askConfirm(`删除「${p ? p.title || "未命名" : id}」？`, "原图与元数据将被永久删除，不可恢复。", "删除", async () => {
    try {
      await apiFetch(`/api/photos/${id}`, { method: "DELETE" });
    } catch (e) {
      alert("删除失败：" + e.message);
      return;
    }
    dropFromDupResults([id]);
  });
}

/* 整组处理：保留最新上传的一张，删除其余 */
function dupKeepNewest(gi) {
  const g = dupGroups[gi];
  if (!g) return;
  const sorted = [...g.photos].sort((a, b) => String(b.uploadedAt || "").localeCompare(String(a.uploadedAt || "")));
  const keep = sorted[0];
  const del = sorted.slice(1);
  askConfirm(`保留「${keep.title || "未命名"}」，删除其余 ${del.length} 张？`, "删除不可恢复。想留别的可以在组内单独删除。", "删除", async () => {
    const done = [];
    for (const p of del) {
      try {
        await apiFetch(`/api/photos/${p.id}`, { method: "DELETE" });
        done.push(p.id);
      } catch (e) {
        alert(`删除「${p.title || p.id}」失败：${e.message}`);
      }
    }
    if (done.length) dropFromDupResults(done);
  });
}

async function openDupFinder() {
  if (guestBlocked("查重")) return; // v0.49
  const m = document.getElementById("dupModal");
  if (!m) return;
  m.classList.add("open");
  await runDupScan();
}

function initDupFinder() {
  const m = document.getElementById("dupModal");
  if (!m) return;
  const close = document.getElementById("dupClose");
  if (close) close.onclick = () => m.classList.remove("open");
  const rescan = document.getElementById("dupRescan");
  if (rescan) rescan.onclick = () => runDupScan();
  const sbtn = document.getElementById("btnFindDups");
  if (sbtn) sbtn.onclick = () => openDupFinder();
  const body = document.getElementById("dupBody");
  if (body && body.dataset.bound !== "1") {
    body.dataset.bound = "1";
    body.addEventListener("click", (e) => {
      const view = e.target.closest("[data-dupview]");
      if (view) { openLightboxById(view.dataset.dupview); return; }
      const del = e.target.closest("[data-dupdel]");
      if (del) { deleteDupPhoto(del.dataset.dupdel); return; }
      const keep = e.target.closest("[data-dupkeep]");
      if (keep) dupKeepNewest(parseInt(keep.dataset.dupkeep, 10));
    });
  }
  window.__openDupFinder = openDupFinder; // 筛选菜单入口用（内容动态渲染）
}

/* ---------- 通用：键盘快捷键 ---------- */
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !isTypingTarget(document.activeElement)) { // v0.52：输入框 / 文本域里不抢
    // 打开搜索窗口并聚焦输入框
    e.preventDefault();
    if (window.__openWindow) window.__openWindow("search");
    setTimeout(() => document.getElementById("searchInput")?.focus(), 250);
  }
  if (e.key === "Escape") {
    // v0.38：关灯箱时一并停掉幻灯片、收起悬浮工具条
    if (document.querySelector(".lightbox.open")) closeLightbox();
    document.querySelectorAll(".modal-mask.open").forEach((el) => el.classList.remove("open"));
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
  img.dataset.orig = p.url;
  // v0.25：缩略图秒开 → 原图渐进替换（大图不再白屏等下载）
  const thumb = p.thumbUrl || p.url;
  const wantFull = qualityMode() !== "low";
  const busted = (u) => (bustCache ? `${u}${u.includes("?") ? "&" : "?"}t=${Date.now()}` : u);
  img.onerror = () => {
    if (img.dataset.orig && !String(img.src).includes(img.dataset.orig)) img.src = img.dataset.orig;
  };
  if (wantFull && p.thumbUrl) {
    img.src = busted(thumb);
    const full = new Image();
    full.onload = () => {
      const lb = document.getElementById("lightbox");
      if (lb && lb.dataset.cur === p.id) img.src = busted(p.url);
    };
    full.src = p.url;
  } else {
    img.src = busted(wantFull ? p.url : thumb);
  }
  // v0.37：信息面板已移除，灯箱只负责看图
  const lb = document.getElementById("lightbox");
  lb.classList.add("open");
  lb.dataset.cur = id;
  // v0.38：悬浮工具条默认隐藏，鼠标在灯箱内移动才浮现（指针停在工具条上时保持）
  if (!lbToolsHover) {
    clearTimeout(lbHideTimer);
    lbToolsVisible(false);
  }
  resetLbView(); // v0.45/0.47：换图即复位预览旋转与缩放
  syncSlideBtn();
  updateLbFav(); // v0.56：同步收藏按钮状态
}

/* ---------- 灯箱右下角悬浮工具条 + 幻灯片（v0.38） ----------
   工具条固定在灯箱右下角，默认隐藏：鼠标在灯箱内移动 → 浮现；静止 3 秒 → 自动淡出。
   指针停在工具条上时不会自动隐藏。幻灯片播放中同样规则。 */
const LB_HIDE_DELAY = 3000;
const SLIDE_SEC_KEY = "rn_slide";
const SLIDE_SECS = [3, 5, 8];
let slideTimer = null;
let lbHideTimer = null;
let lbToolsHover = false;

function slideSeconds() {
  const v = parseInt(localStorage.getItem(SLIDE_SEC_KEY) || "5", 10);
  return SLIDE_SECS.includes(v) ? v : 5;
}
/* v0.56：灯箱工具条上的收藏按钮状态（打开灯箱 / 切换图片时同步） */
function updateLbFav() {
  const btn = document.getElementById("lbToolFav");
  if (!btn) return;
  const on = favOf(lbCurrentPhoto());
  btn.classList.toggle("on", on);
  btn.title = on ? "取消收藏" : "收藏";
}
function lbEl() { return document.getElementById("lightbox"); }
function lbIsOpen() { const lb = lbEl(); return !!(lb && lb.classList.contains("open")); }
function lbCurrentPhoto() {
  const lb = lbEl();
  if (!lb || !lb.classList.contains("open")) return null;
  return PHOTOS.find((x) => x.id === lb.dataset.cur) || null;
}
function lbToolsVisible(on) {
  const lb = lbEl();
  if (lb) lb.classList.toggle("tools-visible", !!on);
}
function lbShowTools() {
  lbToolsVisible(true);
  clearTimeout(lbHideTimer);
  if (lbToolsHover) return;
  lbHideTimer = setTimeout(() => lbToolsVisible(false), LB_HIDE_DELAY);
}
function closeLightbox() {
  stopSlide();
  clearTimeout(lbHideTimer);
  lbToolsHover = false;
  const lb = lbEl();
  if (lb) {
    lb.classList.remove("open");
    lb.classList.remove("tools-visible");
  }
}

/* 切换上一张 / 下一张：默认按 PHOTOS 顺序，图库页会注册当前筛选后的顺序 */
function lbStepList() {
  try {
    const l = window.__lbStepList && window.__lbStepList();
    if (Array.isArray(l) && l.length) return l;
  } catch (e) { /* ignore */ }
  return PHOTOS;
}
function lbStep(d) {
  const lb = lbEl();
  if (!lb) return;
  const cur = lb.dataset.cur;
  const list = lbStepList();
  if (!list.length) return;
  const i = list.findIndex((x) => x.id === cur);
  const next = list[((i < 0 ? 0 : i) + d + list.length) % list.length];
  if (next && next.id !== cur) openLightboxById(next.id);
}

/* 幻灯片放映（v0.38 恢复：间隔见设置页，空格键开关） */
function isSliding() { return !!slideTimer; }
function syncSlideBtn() {
  const b = document.getElementById("lbToolPlay");
  if (!b) return;
  const on = isSliding();
  b.classList.toggle("playing", on);
  b.title = on ? "暂停幻灯片" : "幻灯片放映";
  const play = b.querySelector(".ico-play");
  const pause = b.querySelector(".ico-pause");
  if (play) play.style.display = on ? "none" : "";
  if (pause) pause.style.display = on ? "" : "none";
}
function startSlide() {
  stopSlide();
  const lb = lbEl();
  if (!lb || !lb.classList.contains("open")) return;
  slideTimer = setInterval(() => {
    if (!lbIsOpen()) { stopSlide(); return; }
    lbStep(1);
  }, slideSeconds() * 1000);
  syncSlideBtn();
  lbShowTools();
}
function stopSlide() {
  if (slideTimer) {
    clearInterval(slideTimer);
    slideTimer = null;
  }
  syncSlideBtn();
}
function toggleSlide() {
  if (isSliding()) stopSlide();
  else startSlide();
}
window.__stopSlide = stopSlide;

/* 旋转（v0.45）与缩放（v0.47）：都只作用于**灯箱里的预览**，不改动原图、不发请求；
   切换图片 / 重新打开灯箱时自动复位（想看旋转后的效果请下载后自行处理） */
let lbRotateDeg = 0;
let lbZoom = 1; // v0.47：桌面端滚轮缩放，1 = 适屏铺满
let lbPanX = 0; // v0.48：放大后按住拖动的平移量（屏幕像素）
let lbPanY = 0;
function applyLbView() {
  const img = document.getElementById("lbImg");
  if (!img) return;
  const deg = ((lbRotateDeg % 360) + 360) % 360;
  const parts = [];
  if (lbPanX || lbPanY) parts.push(`translate(${Math.round(lbPanX)}px, ${Math.round(lbPanY)}px)`);
  if (deg) parts.push(`rotate(${deg}deg)`);
  if (lbZoom !== 1) parts.push(`scale(${lbZoom})`);
  img.style.transform = parts.join(" ");
  const side = deg === 90 || deg === 270; // 竖图转横图时按视口高宽反过来限制，避免溢出屏幕
  img.style.maxWidth = side ? "85vh" : "";
  img.style.maxHeight = side ? "90vw" : "";
  // 放大时去掉过渡（滚轮/拖动才跟手），并提示可以拖、可以缩回
  img.classList.toggle("zoomed", lbZoom > 1);
}
function resetLbView() {
  lbRotateDeg = 0;
  lbZoom = 1;
  lbPanX = 0;
  lbPanY = 0;
  const img = document.getElementById("lbImg");
  if (img) img.style.transformOrigin = "";
  applyLbView();
}
function lbRotateView() {
  lbRotateDeg = (lbRotateDeg + 90) % 360;
  applyLbView();
  lbShowTools();
}
/* 滚轮缩放：以鼠标位置为锚点放大 / 缩小，1× 即适屏（不变形，纯 CSS transform） */
const LB_ZOOM_MAX = 8;
function lbZoomBy(factor, originX, originY) {
  const img = document.getElementById("lbImg");
  if (!img) return;
  const next = Math.min(LB_ZOOM_MAX, Math.max(1, lbZoom * factor));
  if (next === lbZoom) return;
  lbZoom = next;
  if (lbZoom === 1) {
    img.style.transformOrigin = "";
    lbPanX = 0;
    lbPanY = 0;
  } else if (originX !== undefined && originY !== undefined) {
    img.style.transformOrigin = `${originX}% ${originY}%`;
  }
  applyLbView();
}
/* 拖动平移（v0.48）：把 transform-origin 归中的同时补偿平移量，避免图片「跳」一下 */
function lbCenterOrigin() {
  const img = document.getElementById("lbImg");
  if (!img) return;
  const m = String(img.style.transformOrigin || "").match(/([\d.]+)%\s+([\d.]+)%/);
  if (!m) return;
  const ox = parseFloat(m[1]) / 100, oy = parseFloat(m[2]) / 100;
  const bw = img.offsetWidth || 0, bh = img.offsetHeight || 0;
  lbPanX = -(ox - 0.5) * bw * (lbZoom - 1);
  lbPanY = -(oy - 0.5) * bh * (lbZoom - 1);
  img.style.transformOrigin = "";
}
/* 平移范围限制：放大后能看到的边缘为止，图片不会被拖出视口 */
function clampLbPan() {
  const img = document.getElementById("lbImg");
  const wrap = img && img.parentElement; // .lb-img-wrap
  if (!img || !wrap) return;
  const bw = img.offsetWidth || 0, bh = img.offsetHeight || 0;
  const cw = wrap.clientWidth || 0, ch = wrap.clientHeight || 0;
  if (!bw || !bh || !cw || !ch) return; // 量不到尺寸（如无布局环境）就不做限制
  const mx = Math.max(0, (bw * lbZoom - cw) / 2);
  const my = Math.max(0, (bh * lbZoom - ch) / 2);
  lbPanX = Math.min(mx, Math.max(-mx, lbPanX));
  lbPanY = Math.min(my, Math.max(-my, lbPanY));
}

/* 下载原图 */
function lbDownload() {
  const p = lbCurrentPhoto();
  if (!p) return;
  const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" }[p.mime] || "jpg";
  const a = document.createElement("a");
  a.href = p.url;
  a.download = `${(p.title || p.id).replace(/[\\/:*?"<>|]/g, "_")}.${ext}`;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  lbShowTools();
}

function initLightboxTools() {
  const lb = lbEl();
  const bar = document.getElementById("lbToolsFloat");
  if (!lb || !bar || lb.dataset.toolsBound === "1") return;
  lb.dataset.toolsBound = "1";
  lb.addEventListener("mousemove", lbShowTools);
  lb.addEventListener("touchstart", lbShowTools, { passive: true });
  lb.addEventListener("mouseleave", () => { lbToolsVisible(false); });
  bar.addEventListener("mouseenter", () => {
    lbToolsHover = true;
    clearTimeout(lbHideTimer);
    lbToolsVisible(true);
  });
  bar.addEventListener("mouseleave", () => {
    lbToolsHover = false;
    lbShowTools();
  });
  const bind = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.onclick = (e) => { e.stopPropagation(); fn(); };
  };
  bind("lbToolPlay", toggleSlide);
  bind("lbToolEdit", () => { const p = lbCurrentPhoto(); if (p) openEditModal(p.id); });
  bind("lbToolRot", lbRotateView);
  bind("lbToolDl", lbDownload);
  bind("lbToolFav", () => {
    if (guestBlocked("收藏")) return; // 观光 / 整理模式
    const p = lbCurrentPhoto();
    if (p) setFav(p.id).then(updateLbFav);
  });

  // 空格：开始 / 暂停幻灯片（仅在可见输入框内不触发，避免在弹窗里打不出空格）
  document.addEventListener("keydown", (e) => {
    if (e.key !== " " && e.code !== "Space") return;
    if (!lbIsOpen()) return;
    const a = document.activeElement;
    if (isTypingTarget(a) && a.getClientRects && a.getClientRects().length) return; // 可见输入框 → 让位给打字
    e.preventDefault();
    toggleSlide();
  });
}

/* v0.43：灯箱切换改为「点击左右区域」+ 移动端左右滑动（原先的 ‹ › 按钮已删除） */
function initLightboxNav() {
  const lb = lbEl();
  if (!lb || lb.dataset.navBound === "1") return;
  lb.dataset.navBound = "1";
  let suppressClick = 0;

  lb.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;          // 右下角悬浮工具条按钮
    if (e.target.closest(".lb-tools-float")) return;
    if (Date.now() < suppressClick) return;          // 刚滑动过 → 忽略尾随的 click
    // v0.44：点图片 → 左右半边切换；点图片以外的空白 → 关闭灯箱（✕ 按钮已删除）
    if (!e.target.closest("#lbImg")) {
      closeLightbox();
      return;
    }
    const w = lb.clientWidth || window.innerWidth || 1;
    if ((e.clientX || 0) < w / 2) lbStep(-1);        // 图片左半边 = 上一张
    else lbStep(1);                                  // 图片右半边 = 下一张
  });

  /* ---- v0.48：放大后按住拖动平移（桌面鼠标 + 移动端触摸） ---- */
  let dragging = false, dragMoved = false, dragX = 0, dragY = 0, panBaseX = 0, panBaseY = 0;
  const startDrag = (x, y) => {
    lbCenterOrigin(); // 归中缩放锚点，之后 translate 就是纯屏幕位移
    dragging = true;
    dragMoved = false;
    dragX = x;
    dragY = y;
    panBaseX = lbPanX;
    panBaseY = lbPanY;
    const img = document.getElementById("lbImg");
    if (img) img.classList.add("panning");
  };
  const moveDrag = (x, y) => {
    if (!dragging) return false;
    const dx = x - dragX, dy = y - dragY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMoved = true;
    lbPanX = panBaseX + dx;
    lbPanY = panBaseY + dy;
    clampLbPan();
    applyLbView();
    return true;
  };
  const endDrag = () => {
    if (!dragging) return false;
    dragging = false;
    const img = document.getElementById("lbImg");
    if (img) img.classList.remove("panning");
    if (dragMoved) suppressClick = Date.now() + 300; // 拖完松手不要顺手切图
    return dragMoved;
  };

  lb.addEventListener("mousedown", (e) => {
    if (!lbIsOpen() || lbZoom <= 1) return;      // 只有放大后才拖动
    if (!e.target.closest("#lbImg")) return;
    e.preventDefault();                          // 阻止浏览器原生图片拖拽
    startDrag(e.clientX, e.clientY);
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    e.preventDefault();
    moveDrag(e.clientX, e.clientY);
  });
  window.addEventListener("mouseup", () => { endDrag(); });
  window.addEventListener("blur", () => { endDrag(); });

  let sx = 0, sy = 0, tracking = false;
  const pt = (e) => (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]) || null;
  // v0.47：桌面端滚轮缩放（以鼠标位置为锚点；缩放到 1× 即恢复适屏）
  lb.addEventListener("wheel", (e) => {
    if (!lbIsOpen()) return;
    if (!e.target.closest("#lbImg")) return;
    e.preventDefault();
    let ox, oy;
    const img = document.getElementById("lbImg");
    if (img) {
      const r = img.getBoundingClientRect();
      if (r.width && r.height) {
        ox = Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100));
        oy = Math.min(100, Math.max(0, ((e.clientY - r.top) / r.height) * 100));
      }
    }
    lbZoomBy(e.deltaY < 0 ? 1.18 : 1 / 1.18, ox, oy);
    lbShowTools();
  }, { passive: false });
  lb.addEventListener("touchstart", (e) => {
    const t = pt(e);
    if (!t) return;
    sx = t.clientX;
    sy = t.clientY;
    tracking = true;
    // 放大状态下触摸 = 拖动平移（不是切图）
    if (lbZoom > 1) startDrag(t.clientX, t.clientY);
  }, { passive: true });
  lb.addEventListener("touchmove", (e) => {
    if (!dragging) return;
    const t = pt(e);
    if (!t) return;
    if (e.cancelable) e.preventDefault(); // 拖动时别让页面跟着滚
    moveDrag(t.clientX, t.clientY);
  }, { passive: false });
  lb.addEventListener("touchend", (e) => {
    if (dragging) {
      const moved = endDrag();
      tracking = false;
      if (moved) suppressClick = Date.now() + 400;
      return; // 拖动结束，不触发切图
    }
    if (!tracking) return;
    tracking = false;
    const t = pt(e);
    if (!t) return;
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.4) return; // 太短或偏纵向 → 不算滑动
    suppressClick = Date.now() + 400;
    if (dx < 0) lbStep(1);   // 左滑 = 下一张
    else lbStep(-1);         // 右滑 = 上一张
  }, { passive: true });
}

/* 幻灯片间隔设置（v0.13，v0.38 随工具条恢复） */
function initSlideSetting() {
  const seg = document.getElementById("slideSeg");
  if (!seg) return;
  const cur = String(slideSeconds());
  [...seg.querySelectorAll(".seg-btn")].forEach((b) => {
    b.classList.toggle("on", b.dataset.sec === cur);
    b.addEventListener("click", () => {
      [...seg.querySelectorAll(".seg-btn")].forEach((x) => x.classList.toggle("on", x === b));
      localStorage.setItem(SLIDE_SEC_KEY, b.dataset.sec);
      // 播放中改间隔：立即按新间隔重启计时
      if (isSliding()) startSlide();
    });
  });
}

/* ---------- 性能模式：释放滚出很远的卡片图片（v0.25）----------
   几千张时，每张缩略图解码后要占几百 KB 内存；性能模式下把离开视口 1.5 屏
   以外的卡片图片换成 1×1 占位（DOM 与布局不变，滚回来再加载），显著降内存 */
const IMG_PLACEHOLDER = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
function initImgRelease() {
  if (!document.body.classList.contains("perf-lite") || !("IntersectionObserver" in window)) return;
  if (!window.__imgReleaseIO) {
    window.__imgReleaseIO = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        const img = en.target.querySelector("img");
        if (!img) return;
        if (en.isIntersecting) {
          if (img.dataset.released === "1" && img.dataset.cardSrc) {
            img.src = img.dataset.cardSrc;
            img.dataset.released = "0";
          }
        } else if (img.dataset.released !== "1" && img.complete && img.naturalWidth > 0) {
          img.dataset.cardSrc = img.src;
          img.src = IMG_PLACEHOLDER;
          img.dataset.released = "1";
        }
      });
    }, { rootMargin: "150% 0px 150% 0px" });
  }
  document.querySelectorAll("#grid .card").forEach((el) => window.__imgReleaseIO.observe(el));
}
window.__observeNewCards = (cards) => {
  if (!window.__imgReleaseIO || !cards) return;
  cards.forEach((el) => window.__imgReleaseIO.observe(el));
};

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
  // v0.25：复用一个观察器（原先每次渲染都 new 一个，卡片多时是额外的开销）
  if (!window.__revealIO) {
    window.__revealIO = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const el = entry.target;
            el.classList.add("visible");
            window.__revealIO.unobserve(el);
            // 过渡完成后清除 stagger delay，避免影响后续 hover 动画
            setTimeout(() => { el.style.transitionDelay = "0s"; }, 700);
          }
        });
      },
      { rootMargin: "0px 0px 120px 0px" } // 提前 120px 触发，滚动更跟手
    );
  }
  items.forEach((el, i) => {
    // 同一批进入视口时按顺序交错浮现（每批最多 12 张，每张 40ms）
    el.style.transitionDelay = `${Math.min(i % 12, 11) * 40}ms`;
    window.__revealIO.observe(el);
  });
}

/* ---------- 标签筛选菜单（v0.11：分组视图 + 搜索，行点击由 initGallery 委托） ---------- */
/* 组内标签名集合（v0.16 整组筛选 / 计数复用；v0.55 加缓存 —— 判定时每张照片都会问一次） */
const groupNameCache = new Map();
function groupTagNames(gid) {
  let set = groupNameCache.get(gid);
  if (!set) {
    set = new Set(TAGS.tags.filter((t) => t.group === gid).map((t) => t.name));
    groupNameCache.set(gid, set);
  }
  return set;
}
function clearGroupNameCache() { groupNameCache.clear(); }
/* 组命中照片数（v0.16）：组内任一标签命中的照片数（按照片去重） */
function groupHitCount(groupTags) {
  if (!groupTags || !groupTags.length) return 0;
  const names = new Set(groupTags.map((t) => t.name));
  return PHOTOS.filter((p) => (p.tags || []).some((n) => names.has(n))).length;
}

/* ============================================================
   我的筛选（v0.55）：把当前这套筛选条件（含多选 / 逻辑 / 排除）命名存下来复用
   ============================================================ */
function filterSnapshot() {
  return {
    cats: [...FILTER.cats], groups: [...FILTER.groups], tags: [...FILTER.tags],
    tagOp: FILTER.tagOp, not: [...FILTER.not], rating: FILTER.rating || null,
  };
}
function filterCount(f) {
  if (!f) return 0;
  return (f.cats || []).length + (f.groups || []).length + (f.tags || []).length + (f.not || []).length + (f.rating ? 1 : 0);
}
const filterEmpty = (f) => filterCount(f) === 0;
/* 排除项 "tag:胡桃" / "group:g-xxx" / "cat:风景" → 可读名字 */
function notKeyLabel(key) {
  const s = String(key);
  const i = s.indexOf(":");
  const kind = i < 0 ? "tag" : s.slice(0, i);
  const val = i < 0 ? s : s.slice(i + 1);
  if (kind === "group") { const g = TAGS.groups.find((x) => x.id === val); return g ? g.name : val; }
  if (kind === "cat") return val === "__none" ? t("未分类", "Uncategorized") : val;
  return val;
}
/* 一句话摘要：分级 / 主分类 / 整组 / 标签 / 排除各取前几项 */
function filterSummary(f) {
  if (!f) return "";
  const cap = (arr, n = 3) => (arr.length > n ? arr.slice(0, n).concat(`+${arr.length - n}`) : arr);
  const parts = [];
  if (f.rating) parts.push(RATING_LABEL[f.rating] || f.rating);
  const cats = (f.cats || []).map((c) => (c === "__none" ? t("未分类", "Uncategorized") : c));
  if (cats.length) parts.push(cap(cats).join(" / "));
  (f.groups || []).forEach((gid) => { const g = TAGS.groups.find((x) => x.id === gid); parts.push(g ? g.name : gid); });
  if ((f.tags || []).length) parts.push(cap(f.tags).join(f.tagOp === "and" ? " ＋ " : " ／ "));
  if ((f.not || []).length) parts.push("⊘ " + cap((f.not || []).map(notKeyLabel)).join(" / "));
  return parts.join(" · ") || t("空筛选", "Empty");
}
function sameFilter(a, b) {
  const norm = (f) => JSON.stringify({
    cats: [...(f.cats || [])].sort(), groups: [...(f.groups || [])].sort(),
    tags: [...(f.tags || [])].sort(), tagOp: f.tagOp === "and" ? "and" : "or",
    not: [...(f.not || [])].sort(), rating: f.rating || null,
  });
  return norm(a) === norm(b);
}
function loadSavedFilters() {
  try {
    const j = JSON.parse(localStorage.getItem(SAVED_KEY) || "[]");
    return Array.isArray(j) ? j.filter((f) => f && f.id && f.name) : [];
  } catch (e) { return []; }
}
function persistSavedFilters(list) {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(list.slice(0, 50))); } catch (e) { /* 配额满 / 隐私模式：忽略 */ }
}
function applyFilterSnapshot(f) {
  FILTER.cats = new Set((f && f.cats) || []);
  FILTER.groups = new Set((f && f.groups) || []);
  FILTER.tags = new Set((f && f.tags) || []);
  FILTER.not = new Set((f && f.not) || []);
  FILTER.tagOp = f && f.tagOp === "and" ? "and" : "or";
  FILTER.rating = (f && f.rating) ? normRating(f.rating) : null;
  if (window.__updateFabDot) window.__updateFabDot();
  if (window.__applyFilter) window.__applyFilter();
}
/* 保存当前筛选（同名覆盖）—— 名字输入框在筛选条里，避免再引一层弹窗 */
function toggleSaveRow(show) {
  const row = document.getElementById("tfbSaverow");
  const inp = document.getElementById("tfbName");
  if (!row) return;
  row.hidden = !show;
  if (show && inp) { inp.value = ""; inp.focus(); }
}
function saveCurrentFilter() {
  const inp = document.getElementById("tfbName");
  const name = String((inp && inp.value) || "").trim().slice(0, 20);
  if (!name) { if (inp) inp.focus(); return; }
  const list = loadSavedFilters();
  const snap = filterSnapshot();
  const exist = list.find((f) => f.name === name);
  if (exist) Object.assign(exist, snap);
  else list.push(Object.assign({ id: `sf-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name }, snap));
  persistSavedFilters(list);
  if (inp) inp.value = "";
  toggleSaveRow(false);
  renderTagMenuContent();
}

/* ---------- 当前筛选条（v0.55）：已选 chips + 标签层 且/或 + 排除模式 + 保存 / 清空 ---------- */
function renderTagFilterBar() {
  const bar = document.getElementById("tagFilterBar");
  const snap = filterSnapshot();
  if (bar) bar.hidden = filterCount(snap) === 0 && !filterNegMode; // 没条件又不在排除模式 → 整条收起
  const opBtn = document.getElementById("tfbTagOp");
  if (opBtn) {
    opBtn.hidden = FILTER.tags.size < 2; // 只有 1 个标签时「且/或」没有意义
    opBtn.textContent = FILTER.tagOp === "and" ? t("且", "AND") : t("或", "OR");
    opBtn.classList.toggle("on", FILTER.tagOp === "and");
  }
  const negBtn = document.getElementById("tfbNeg");
  if (negBtn) {
    negBtn.textContent = t("排除", "Exclude");
    negBtn.classList.toggle("on", filterNegMode);
  }
  const chips = document.getElementById("tfbChips");
  if (!chips) return;
  const chip = (kind, val, label, color, neg) =>
    `<span class="tfb-chip${neg ? " neg" : ""}" data-chip="${escAttr(`${kind}:${val}`)}" data-neg="${neg ? "1" : "0"}" title="${neg ? t("点击取消排除", "Click to un-exclude") : t("点击移除", "Click to remove")}">
      ${color ? `<i class="dot" style="--tg:${color}"></i>` : ""}${esc(label)}<b>✕</b></span>`;
  const out = [];
  if (FILTER.rating) {
    out.push(chip("rating", FILTER.rating, RATING_LABEL[FILTER.rating] || FILTER.rating, RATING_COLOR[FILTER.rating], false));
  }
  FILTER.cats.forEach((c) => {
    const cc = c === "__none" ? null : sortedCategories().find((x) => x.name === c);
    out.push(chip("cat", c, c === "__none" ? t("未分类", "Uncategorized") : c, cc ? (cc.color || null) : "#8e8e93", false));
  });
  FILTER.groups.forEach((gid) => {
    const g = TAGS.groups.find((x) => x.id === gid);
    out.push(chip("group", gid, g ? g.name : gid, g && g.color, false));
  });
  FILTER.tags.forEach((name) => {
    const tt = tagByName(name);
    out.push(chip("tag", name, name, tt ? (tt.color || tagGroupColor(tt.group)) : null, false));
  });
  // 选中与排除互斥（见 toggleCond），所以排除项单独列一遍即可
  FILTER.not.forEach((key) => {
    const i = key.indexOf(":");
    out.push(chip(i < 0 ? "tag" : key.slice(0, i), i < 0 ? key : key.slice(i + 1), notKeyLabel(key), null, true));
  });
  chips.innerHTML = out.join("");
}

function tagRowHTML(t, counts) {
  const c = t.color || tagGroupColor(t.group);
  const on = FILTER.tags.has(t.name);
  const neg = FILTER.not.has(`tag:${t.name}`);
  return `<button class="tag-menu-item${on ? " active" : ""}${neg ? " neg" : ""}" data-tag="${escAttr(t.name)}">
    <span class="nm"><i class="dot"${c ? ` style="--tg:${c}"` : ""}></i>${esc(t.name)}</span>
    <span class="cnt">${counts[t.name] || 0}</span></button>`;
}

function renderTagMenuContent() {
  const list = document.getElementById("tagMenuList");
  if (!list) return;
  renderTagFilterBar(); // 筛选条与列表同源刷新，避免两处状态漂移
  const searchEl = document.getElementById("tagSearch");
  const q = (searchEl && searchEl.value || "").trim().toLowerCase();

  // 照片中实际出现的标签计数（0 引用的配置标签不参与筛选菜单）
  const counts = {};
  PHOTOS.forEach((p) => p.tags.forEach((t) => { counts[t] = (counts[t] || 0) + 1; }));
  const used = Object.keys(counts);
  const snap = filterSnapshot();

  let html = `<button class="tag-menu-item${filterEmpty(snap) ? " active" : ""}" data-tag="">
      <span class="nm">${t("全部", "All")}</span><span class="cnt">${PHOTOS.length}</span></button>`;

  // 我的筛选（v0.55）：保存过的筛选组合，点一下即用；✕ 删除
  const saved = loadSavedFilters();
  if (saved.length) {
    html += `<div class="tag-group-head saved">⭐ ${t("我的筛选", "My Filters")}</div>`;
    html += saved.map((f) => `<button class="tag-menu-item sf-item${sameFilter(f, snap) ? " active" : ""}" data-sf="${escAttr(f.id)}" title="${escAttr(filterSummary(f))}">
        <span class="nm">${esc(f.name)}<em class="sf-sum">${esc(filterSummary(f))}</em></span>
        <span class="cnt"><span class="sf-del" data-sfdel="${escAttr(f.id)}" title="${t("删除", "Delete")}">✕</span></span></button>`).join("");
  }

  /* 分级区（v0.57）：三档单选。只列出**有图的档位** —— 观光 / 整理模式本来就只看得到大众级，
     非管理员自然只会看到一行，不需要额外判权。三档图片共用同一套标签库，分级只是并列维度。 */
  const ratingCounts = { general: 0, r16: 0, r18: 0 };
  PHOTOS.forEach((p) => { const r = ratingOf(p); ratingCounts[r] = (ratingCounts[r] || 0) + 1; });
  if (!q) {
    const rows = RATINGS.filter((r) => ratingCounts[r] > 0);
    if (rows.length > 1) { // 只有一档有图时这个区没有意义
      html += `<div class="tag-group-head cat">${t("分级", "Rating")}</div>` + rows.map((r) =>
        `<button class="tag-menu-item${FILTER.rating === r ? " active" : ""}" data-rating="${r}" title="${t("只看法", "Only")}${RATING_LABEL[r]}">
          <span class="nm"><i class="dot" style="--tg:${RATING_COLOR[r]}"></i>${RATING_LABEL[r]}</span><span class="cnt">${ratingCounts[r]}</span></button>`).join("");
    }
  }

  // 主分类区（v0.15）：可选的内容大类（多选，与标签体系并行叠加）；搜索标签词时隐藏聚焦结果
  const catCounts = { __none: 0 };
  PHOTOS.forEach((p) => {
    const cs = catsOf(p);
    if (!cs.length) catCounts.__none = (catCounts.__none || 0) + 1;
    cs.forEach((c) => { catCounts[c] = (catCounts[c] || 0) + 1; }); // 多选：一张图计入多个分类
  });
  const catLines = [];
  if (!q) {
    sortedCategories().forEach((c) => {
      const n = catCounts[c.name] || 0;
      if (!n) return;
      catLines.push(`<button class="tag-menu-item${FILTER.cats.has(c.name) ? " active" : ""}${FILTER.not.has(`cat:${c.name}`) ? " neg" : ""}" data-catf="${escAttr(c.name)}" title="只看「${esc(c.name)}」">
        <span class="nm"><i class="dot" style="--tg:${c.color || "var(--accent)"}"></i>${esc(c.name)}</span><span class="cnt">${n}</span></button>`);
    });
    if (catCounts.__none) {
      catLines.push(`<button class="tag-menu-item${FILTER.cats.has("__none") ? " active" : ""}${FILTER.not.has("cat:__none") ? " neg" : ""}" data-catf="__none" title="${t("还没有主分类的照片", "Photos without a category")}">
        <span class="nm"><i class="dot" style="--tg:#8e8e93"></i>${t("未分类", "Uncategorized")}</span><span class="cnt">${catCounts.__none}</span></button>`);
    }
  }
  if (catLines.length) {
    html += `<div class="tag-group-head cat">${t("主分类", "Category")}</div>` + catLines.join("");
  }

  // v0.56：相册区已移除（手动相册退场，浏览页用「全部图片 / 收藏夹 / 主分类集合」代替）

  const kwHit = (t) => tagQueryMatch(t, q);

  if (used.length) {
    const groups = [...TAGS.groups].sort((a, b) => ((a.sort || 0) - (b.sort || 0)) || a.name.localeCompare(b.name, "zh"));
    // v0.23 性能：首次渲染把已有组全部折叠，避免几百行标签一次性塞进 DOM（输入搜索时自动展开命中组）
    if (!window.__menuCollapsedInit && groups.length) {
      groups.forEach((g) => collapsedGroups.add(g.id));
      window.__menuCollapsedInit = true;
    }
    for (const g of groups) {
      const all = TAGS.tags.filter((t) => t.group === g.id);
      const items = all
        .filter((t) => counts[t.name] > 0 && kwHit(t))
        .sort((a, b) => ((a.sort || 0) - (b.sort || 0)) || a.name.localeCompare(b.name, "zh"));
      // 整组命中计数（v0.16）：组内任一标签命中该照片即算，用于「作品级」筛选
      const wholeHit = groupHitCount(all);
      if (!items.length && !(wholeHit && !q)) continue; // 搜索标签词时只显示有命中的组
      const col = g.color || null;
      const gOn = FILTER.groups.has(g.id);
      const gNeg = FILTER.not.has(`group:${g.id}`);
      const collapsed = collapsedGroups.has(g.id) && !gOn && !q; // 正在整组筛选 / 搜索时强制展开
      html += `<div class="tag-group-head${collapsed ? " collapsed" : ""}${gOn ? " active" : ""}${gNeg ? " neg" : ""}" data-gid="${escAttr(g.id)}">
        <i class="dot"${col ? ` style="--tg:${col}"` : ""}></i>${esc(g.name)}
        ${wholeHit ? `<button class="gfilter${gOn ? " on" : ""}" data-gfilter="${escAttr(g.id)}" title="${t("按整组筛选：该组任一标签命中即可（作品级兜底）", "Filter the whole group")}">${t("整组", "group")} ${wholeHit}</button>` : ""}
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

    // 无任何可筛选项时的空态提示
    const noFilterable = !groups.some((g) => TAGS.tags.some((t) => t.group === g.id && counts[t.name] > 0)) && !freeList.length;
    if (noFilterable) {
      html += `<div class="tag-suggest ts-empty" style="margin:6px 8px">${t("没有匹配的标签", "No matching tags")}</div>`;
    }
  }
  // 查重入口（v0.42）：扫描库内完全相同 / 相似的图片（不受当前筛选影响；v0.49 仅管理员可用）
  if (isAdmin()) {
    html += `<button class="tag-menu-item dup-entry" data-dupopen="1" title="${t("扫描库内完全相同 / 相似的图片", "Scan for duplicate / similar photos")}">
      <span class="nm">🔍 ${t("查找重复 / 相似图片", "Find duplicates")}</span><span class="cnt">›</span></button>`;
  }
  list.innerHTML = html;
}

/* ---------- 图库墙页 ---------- */
function initGallery() {
  const grid = document.getElementById("grid");
  const lightbox = document.getElementById("lightbox");
  const lbImg = document.getElementById("lbImg");
  let sentinel = null; // 滚动加载哨兵（v0.25 引入；v0.26 修复：声明提前，避免渲染时未初始化）

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
    const dupOpen = e.target.closest("[data-dupopen]");
    if (dupOpen) { // v0.42：筛选项底部的查重入口
      if (tagFlyout) tagFlyout.close();
      openDupFinder();
      return;
    }
    // 我的筛选（v0.55）：✕ 删除 / 主体应用
    const sfDel = e.target.closest("[data-sfdel]");
    if (sfDel) {
      persistSavedFilters(loadSavedFilters().filter((f) => f.id !== sfDel.dataset.sfdel));
      renderTagMenuContent();
      return;
    }
    const sf = e.target.closest("[data-sf]");
    if (sf) {
      const f = loadSavedFilters().find((x) => x.id === sf.dataset.sf);
      if (f) { applyFilterSnapshot(f); renderTagMenuContent(); }
      return;
    }
    const rt = e.target.closest("[data-rating]");
    if (rt) {
      setRatingFilter(rt.dataset.rating); // v0.57：分级（单选，再点取消）
      if (tagSearch) { tagSearch.value = ""; if (tagSearchClear) tagSearchClear.classList.remove("on"); }
      renderTagMenuContent();
      return;
    }
    const catf = e.target.closest("[data-catf]");
    if (catf) {
      toggleCond("cat", catf.dataset.catf);
      if (tagSearch) { tagSearch.value = ""; if (tagSearchClear) tagSearchClear.classList.remove("on"); }
      renderTagMenuContent();
      return;
    }
    const gf = e.target.closest("[data-gfilter]");
    if (gf) {
      toggleCond("group", gf.dataset.gfilter); // v0.16 整组（作品级）筛选
      if (tagSearch) { tagSearch.value = ""; if (tagSearchClear) tagSearchClear.classList.remove("on"); }
      renderTagMenuContent();
      return;
    }
    const row = e.target.closest(".tag-menu-item");
    if (row && row.dataset.tag !== undefined) {
      const name = row.dataset.tag; // "" = 「全部」
      if (name) toggleCond("tag", name);
      else clearFilter(); // 点「全部」= 清空所有条件（含排除）
      if (tagSearch) { tagSearch.value = ""; if (tagSearchClear) tagSearchClear.classList.remove("on"); }
      renderTagMenuContent();
      if (!name && tagFlyout) tagFlyout.close();
      return;
    }
    // 组头折叠：v0.23 起「默认全折叠」的组在渲染时就**不输出**标签行，
    // 所以这里必须重渲染把行补回来 —— 原来只 toggle is-hidden，
    // 对默认折叠的组点一下像没反应（行根本不在 DOM 里）。v0.55 改为统一重渲染。
    const gh = e.target.closest(".tag-group-head");
    if (gh && gh.dataset.gid) {
      const gid = gh.dataset.gid;
      if (collapsedGroups.has(gid)) collapsedGroups.delete(gid);
      else collapsedGroups.add(gid);
      renderTagMenuContent();
    }
  });

  /* 当前筛选条（v0.55）：chips 移除 / 且或切换 / 排除模式 / 保存 / 清空 */
  const filterBar = document.getElementById("tagFilterBar");
  if (filterBar) {
    filterBar.addEventListener("click", (e) => {
      const chip = e.target.closest("[data-chip]");
      if (chip) {
        const key = chip.dataset.chip || "";
        const i = key.indexOf(":");
        const kind = i < 0 ? "tag" : key.slice(0, i);
        const val = i < 0 ? key : key.slice(i + 1);
        if (chip.dataset.neg === "1") FILTER.not.delete(key);
        else if (kind === "rating") FILTER.rating = null;
        else (kind === "cat" ? FILTER.cats : kind === "group" ? FILTER.groups : FILTER.tags).delete(val);
        updateFabDot();
        renderTagMenuContent();
        applyFilter();
        return;
      }
      const btn = e.target.closest("button");
      if (!btn) return;
      if (btn.id === "tfbTagOp") {
        FILTER.tagOp = FILTER.tagOp === "and" ? "or" : "and";
        renderTagMenuContent();
        applyFilter();
      } else if (btn.id === "tfbNeg") {
        filterNegMode = !filterNegMode;
        renderTagMenuContent();
      } else if (btn.id === "tfbClear") {
        clearFilter();
        renderTagMenuContent();
      } else if (btn.id === "tfbSave") {
        toggleSaveRow(true);
      } else if (btn.id === "tfbSaveOk") {
        saveCurrentFilter();
      } else if (btn.id === "tfbSaveCancel") {
        toggleSaveRow(false);
      }
    });
  }
  const saveNameInput = document.getElementById("tfbName");
  if (saveNameInput) {
    saveNameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); saveCurrentFilter(); }
      else if (e.key === "Escape") { e.preventDefault(); toggleSaveRow(false); }
    });
  }
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

  /* v0.55：统一的条件开关（kind: tag | group | cat）——
     普通模式点击 = 加入 / 取消该条件；排除模式点击 = 加入「排除」（与选中互斥）。 */
  function toggleCond(kind, value) {
    const set = kind === "cat" ? FILTER.cats : (kind === "group" ? FILTER.groups : FILTER.tags);
    const key = `${kind}:${value}`;
    if (filterNegMode) {
      if (FILTER.not.has(key)) FILTER.not.delete(key);
      else { FILTER.not.add(key); set.delete(value); }
    } else if (set.has(value)) {
      set.delete(value);
    } else {
      set.add(value);
      FILTER.not.delete(key);
    }
    updateFabDot();
    applyFilter();
  }
  function clearFilter() {
    FILTER.cats.clear();
    FILTER.groups.clear();
    FILTER.tags.clear();
    FILTER.not.clear();
    FILTER.rating = null;
    updateFabDot();
    applyFilter();
  }
  /* v0.57：分级筛选（单选，再点同一档 = 取消） */
  function setRatingFilter(v) {
    FILTER.rating = FILTER.rating === v ? null : normRating(v);
    updateFabDot();
    applyFilter();
  }
  window.__setRatingFilter = setRatingFilter;
  // 兼容旧钩子（外部脚本 / 测试）：设置单个标签筛选
  window.__setTagFilter = (name) => {
    FILTER.tags.clear();
    FILTER.groups.clear();
    FILTER.not.clear();
    if (name) FILTER.tags.add(name);
    updateFabDot();
    applyFilter();
  };
  // 测试钩子：直接读写筛选状态 / 触发重绘
  window.__filterState = filterSnapshot;
  window.__toggleCond = toggleCond;
  window.__clearFilter = clearFilter;
  function updateFabDot() {
    fabDot.classList.toggle("on", filterCount(filterSnapshot()) > 0);
  }
  window.__updateFabDot = updateFabDot;

  /* 筛选判定（v0.8.6 → v0.55：多选 / 且或 / 排除；v0.57：加分级层）
       五层叠加，层内组合、层间 AND：
       1) 分级层：单选（general / r16 / r18）
       2) 主分类层：多选 OR（"__none" = 未分类）
       3) 整组层：任一选中组命中即可（组内 OR，作品级兜底）
       4) 标签层：tagOp = or 命中任一 / and 全部命中
       5) 排除层：命中任意一条即出局
     v0.50：R18 密钥机制已移除，R18 图片正常参与筛选（观光模式由 adultHidden 统一隐藏） */
  function basePred(p) {
    const tags = p.tags || [];
    if (FILTER.rating && ratingOf(p) !== FILTER.rating) return false;
    if (FILTER.cats.size) {
      const cats = catsOf(p);
      const hit = [...FILTER.cats].some((c) => (c === "__none" ? !cats.length : cats.includes(c)));
      if (!hit) return false;
    }
    if (FILTER.groups.size) {
      const hit = [...FILTER.groups].some((gid) => {
        const names = groupTagNames(gid);
        return names.size > 0 && tags.some((n) => names.has(n));
      });
      if (!hit) return false;
    }
    if (FILTER.tags.size) {
      const sel = [...FILTER.tags];
      if (FILTER.tagOp === "and") {
        if (!sel.every((n) => tags.includes(n))) return false;
      } else if (!sel.some((n) => tags.includes(n))) {
        return false;
      }
    }
    for (const key of FILTER.not) {
      const i = key.indexOf(":");
      const kind = i < 0 ? "tag" : key.slice(0, i);
      const val = i < 0 ? key : key.slice(i + 1);
      if (kind === "tag" && tags.includes(val)) return false;
      if (kind === "cat" && catsOf(p).includes(val)) return false;
      if (kind === "group") {
        const names = groupTagNames(val);
        if (names.size > 0 && tags.some((n) => names.has(n))) return false;
      }
    }
    return true;
  }
  function applyFilter() {
    shown = 0;
    filtered = sortPhotos(PHOTOS.filter((p) => basePred(p)));
    render();
  }
  window.__applyFilter = applyFilter;

  /* v0.54：方格模式 + 按时间排序时，按日期分段（像手机相册那样分区）。
     时间取「拍摄时间」优先、缺失时回退上传时间（与卡片上显示的日期保持一致）。
     其他排序（大小 / 标题）下分段没有意义，自动退回连续网格。 */
  const dayKeyOf = (p) => {
    const ts = Date.parse(photoTimeOf(p));
    if (!Number.isFinite(ts)) return "";
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  function dayLabelOf(key) {
    if (!key) return t("未知时间", "Unknown");
    const [y, m, d] = key.split("-").map(Number);
    const now = new Date();
    const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    const dt = new Date(y, m - 1, d);
    if (sameDay(dt, now)) return t("今天", "Today");
    const yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (sameDay(dt, yest)) return t("昨天", "Yesterday");
    if (y === now.getFullYear()) return `${m} 月 ${d} 日`;
    return `${y} 年 ${m} 月 ${d} 日`;
  }
  function groupingByDay() {
    return typeof layoutMode === "function" && layoutMode() === "square" && (SORT_MODE === "newest" || SORT_MODE === "oldest");
  }
  /* 生成「日期分组头 + 卡片」序列；prevKey 传上一段最后一天，追加时分段不会断开 */
  function itemsHTML(list, prevKey, allForCount) {
    if (!groupingByDay()) return list.map(cardHTML).join("");
    const counts = {};
    if (allForCount) allForCount.forEach((p) => { const k = dayKeyOf(p); if (k) counts[k] = (counts[k] || 0) + 1; });
    let last = prevKey || null;
    return list.map((p) => {
      const key = dayKeyOf(p);
      let head = "";
      if (key && key !== last) {
        const n = counts[key];
        head = `<div class="grid-group">${esc(dayLabelOf(key))}${n ? `<span class="cnt">${n} ${t("张", "photos")}</span>` : ""}</div>`;
        last = key;
      }
      return head + cardHTML(p);
    }).join("");
  }

  function cardHTML(p) {
    // 卡片比例：服务端已记录宽高，渲染时就写死 aspect-ratio（CSS 瀑布流不会因图片懒加载完成而重排）
    // 老数据缺尺寸时不写，退回原来的自然高度
    const ratio = (p.width > 0 && p.height > 0) ? ` style="aspect-ratio:${p.width} / ${p.height}"` : "";
    const favorite = favOf(p);
    return `<div class="card${selected.has(p.id) ? " sel" : ""}${favorite ? " fav" : ""}" data-id="${p.id}" draggable="${isAdmin()}" title="单击看大图 · 双击编辑"${ratio}>
      <img loading="lazy" decoding="async" draggable="false" src="${cardImgSrc(p)}" data-orig="${p.url}" alt="${escAttr(p.title)}" onerror="this.onerror=null;this.src=this.dataset.orig">
      <button class="pick" title="选中">✓</button>
      ${manageAllowed() ? `<button class="fv" data-fav="${p.id}" title="${favorite ? "取消收藏" : "收藏"}">${favorite ? "♥" : "♡"}</button>` : ""}
      ${ratingBadge(p)}
      <div class="card__content">
        <div class="card__tags">${catChipsOf(p, 2)}${p.tags.slice(0, catsOf(p).length ? 2 : 3).map(tagChip).join("")}</div>
        <p class="card__meta">${fmtDate(p.takenAt)} · ${fmtSize(p.size)}</p>
      </div>
    </div>`;
  }

  function updateLoadMore() {
    const lm = document.getElementById("loadMore");
    if (!lm) return;
    lm.style.display = shown < filtered.length ? "block" : "none";
    let text = shown < filtered.length
      ? t("已加载", "Loaded") + ` ${shown} / ${filtered.length} · ${t("滚动加载更多…", "scroll for more…")}`
      : t("已全部加载", "All loaded") + `（${filtered.length} ${t("张", "photos")}）`;
    if (filtered.length > 800) text += t("　· 数据较多，用筛选或搜索能更快定位", "　· many items, try filters or search");
    lm.querySelector("span").textContent = text;
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
    grid.innerHTML = itemsHTML(slice, null, filtered);
    shown = slice.length;
    updateLoadMore();
    // 视口出现动画（仅首次整批；滚动加载的新卡直接可见，避免闪屏）
    initReveal(grid, ".card");
    initImgRelease(); // v0.25：性能模式下回收屏外卡片图片
    scheduleFill(); // v0.26：渲染后补足视口（首屏一次没填满就继续追加）
  }
  window.__renderGallery = () => render();
  // v0.24：后台补齐照片后，把新数据纳入当前筛选；显示数量不多时直接重建列表（保留已显示张数）
  window.__photosGrown = () => {
    renderTagMenuContent();
    filtered = sortPhotos(PHOTOS.filter((p) => basePred(p)));
    if (shown <= 300) render();
    else updateLoadMore();
  };

  /* 增量追加一页（v0.13.2 增量而非重建；v0.25 抽成函数供哨兵复用） */
  let scrollBusy = false;
  function appendMore() {
    if (scrollBusy || shown >= filtered.length) return;
    scrollBusy = true;
    const start = grid.querySelectorAll(".card").length;
    shown = Math.min(shown + PAGE, filtered.length);
    const more = filtered.slice(start, shown);
    if (more.length) {
      const prev = start > 0 ? dayKeyOf(filtered[start - 1]) : null;
      grid.insertAdjacentHTML("beforeend", itemsHTML(more, prev, filtered));
      const newCards = [...grid.querySelectorAll(".card")].slice(start);
      newCards.forEach((c) => c.classList.add("visible"));
      if (window.__observeNewCards) window.__observeNewCards(newCards);
    }
    updateLoadMore();
    scrollBusy = false;
    scheduleFill(); // 追加后继续补足视口（可能一次追加还不够填满）
  }
  window.__appendMore = appendMore; // 调试/测试钩子：手动触发追加
  window.__galleryState = () => ({
    shown, filtered: filtered.length, total: PHOTOS.length, busy: scrollBusy,
    filter: filterSnapshot(), // v0.55：当前筛选状态（测试 / 调试用）
    sentinel: sentinel ? { connected: sentinel.isConnected, top: Math.round(sentinel.getBoundingClientRect().top) } : null,
  });

  /* v0.26 修复滚动加载失效：
     IntersectionObserver 只在「交叉状态变化」时回调，而首屏 observe 时数据还没加载
     （appendMore 空转返回），哨兵此后一直停在"已交叉"状态 —— 于是滚动再也不触发回调。
     因此增加「主动补足」：只要哨兵还在视口 + 800px 缓冲范围内，就继续追加，
     直到填满视口或数据加载完；滚动时也用 rAF 节流兜底一次。 */
  function maybeFillViewport() {
    if (!sentinel || !sentinel.isConnected) return;
    if (scrollBusy || shown >= filtered.length) return;
    const r = sentinel.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    if (r.top - 800 < vh) appendMore(); // 800 与观察器 rootMargin 保持一致
  }
  function scheduleFill() {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(maybeFillViewport);
    else setTimeout(maybeFillViewport, 16);
  }
  window.__fillViewport = maybeFillViewport; // v0.46：切换正方形网格后把视口补满
  let fillQueued = false;
  window.addEventListener("scroll", () => {
    if (fillQueued) return;
    fillQueued = true;
    requestAnimationFrame(() => { fillQueued = false; maybeFillViewport(); });
  }, { passive: true });

  /* 无限滚动（v0.25：改用 IntersectionObserver 哨兵。
     原先监听 scroll 事件并每次读 document.body.offsetHeight，会强制同步布局，
     卡片多时滚动明显掉帧；哨兵方案的判断成本几乎为零 */
  const sentinelEl = document.createElement("div");
  sentinelEl.id = "gridSentinel";
  sentinelEl.setAttribute("aria-hidden", "true");
  sentinelEl.style.cssText = "height:1px;width:100%;pointer-events:none";
  const oldSentinel = document.getElementById("gridSentinel"); // 幂等：重复初始化时先移除旧的
  if (oldSentinel && oldSentinel !== sentinelEl) oldSentinel.remove();
  grid.parentNode.insertBefore(sentinelEl, grid.nextSibling);
  sentinel = sentinelEl; // v0.26：观察器只负责"滚动时触发"，首屏补足交给 maybeFillViewport()
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) appendMore();
    }, { rootMargin: "800px 0px" }).observe(sentinelEl);
  }

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
    const card = e.target.closest(".card");
    if (!card) return;
    const id = card.dataset.id;
    // v0.56：卡片右上角爱心（收藏）—— 优先于多选与灯箱
    const favBtn = e.target.closest("[data-fav]");
    if (favBtn) {
      e.stopPropagation();
      if (guestBlocked("收藏")) return;
      setFav(favBtn.dataset.fav);
      return;
    }
    if (selectMode) {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      card.classList.toggle("sel", selected.has(id));
      updateBatchUI();
      return;
    }
    // v0.37：双击卡片 = 直接编辑该图（v0.38 灯箱右下角工具条也有「编辑」）
    if (e.detail >= 2) { openEditModal(id); return; }
    openLightbox(id);
  });

  // 灯箱（全局实现 openLightboxById；←→ / 点图片左右半边 / 左右滑动 按当前筛选视图顺序切换）
  const openLightbox = openLightboxById;
  const step = (d) => lbStep(d); // v0.38：切图逻辑抽到全局，灯箱悬浮工具条 / 幻灯片共用
  window.__lbStepList = () => (filtered.length && filtered.some((x) => x.id === lightbox.dataset.cur) ? filtered : PHOTOS);
  document.addEventListener("keydown", (e) => {
    if (!lightbox.classList.contains("open")) return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return; // v0.52：别抢输入框的方向键
    if (e.key === "ArrowLeft") step(-1);
    if (e.key === "ArrowRight") step(1);
  });

  render();

  // 供上传/导入/清空/编辑后刷新图库：保留当前筛选与排序
  window.__refreshGallery = () => {
    shown = 0;
    filtered = sortPhotos(PHOTOS.filter((p) => basePred(p)));
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
  // 仅外部文件拖入时高亮/放行
  const isFileDrag = (e) => !!(e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files"));
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => {
    if (isFileDrag(e)) { e.preventDefault(); dz.classList.add("drag"); }
  }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));
  fileInput.addEventListener("change", () => addFiles(fileInput.files));

  /* v0.22：把队列项移除（✕ 按钮与相似提醒的「删除这张新图」共用） */
  function removeUqItem(it) {
    const idx = files.indexOf(it);
    if (idx >= 0) files.splice(idx, 1);
    if (it.row) it.row.remove();
    btnUpload.disabled = !files.length;
  }

  /* v0.54：队列预览图改为有限并发读取 —— 原来 12 张同时 readAsDataURL，
     每张都要多驻留一份 base64（比原文件大 33%），移动端容易 OOM 白屏。
     这里最多同时读 2 张，读完即释放 FileReader。 */
  const previewQueue = [];
  let previewBusy = 0;
  function readPreview(file, img) {
    previewQueue.push({ file, img });
    pumpPreview();
  }
  function pumpPreview() {
    while (previewBusy < 2 && previewQueue.length) {
      const job = previewQueue.shift();
      previewBusy++;
      const reader = new FileReader();
      const done = () => { previewBusy--; pumpPreview(); };
      reader.onload = (e) => { try { job.img.src = e.target.result; } catch (err) { /* ignore */ } done(); };
      reader.onerror = done;
      reader.onabort = done;
      reader.readAsDataURL(job.file);
    }
  }

  function addFiles(list) {
    [...list].slice(0, 12 - files.length).forEach((f) => {
      const item = { f, status: "ready", pct: 0 };
      files.push(item);
      const row = document.createElement("div");
      row.className = "uq-item";
      row.innerHTML = `
        <img class="thumb" alt="" draggable="false">
        <i class="uq-dot"></i>
        <button class="u-del" title="从队列移除">×</button>
        <div class="progress"><div class="bar"></div></div>`;
      const img = row.querySelector("img");
      readPreview(f, img); // v0.54：有限并发读预览（见上面的 readPreview）
      item.row = row;
      queue.appendChild(row);
      row.__item = item;
      setUqRowHint(row, `${f.name} · ${fmtSize(f.size)} · 待上传`); // 悬停可看文件名等信息
      row.querySelector(".u-del").onclick = (e) => { e.stopPropagation(); removeUqItem(item); };
      // v0.21：本地算 dHash → 与库里 / 本批其他照片比对，行上给出「相似图片」提醒
      dhashOfFile(f).then((dh) => {
        item.dhash = dh;
        item.similar = { lib: findSimilarInLibrary(dh), queue: findSimilarInQueue(item, files) };
        if (item.similar.lib.length || item.similar.queue.length) updateUqSimilarBadge(item);
      });
    });
    const upHintFresh = document.getElementById("upHint");
    if (upHintFresh) upHintFresh.innerHTML = `已加入 <b>${files.length}</b> 张，点「开始上传」开始`;
    btnUpload.disabled = !files.length;
    btnUpload.textContent = "开始上传";
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
      const setSub = (t) => { setUqRowHint(row, t); }; // v0.54：提示统一进 title
      const setPct = (p) => { const bar = row.querySelector(".bar"); if (bar) bar.style.width = p + "%"; };
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
                  row.classList.add("ok");
                  setSub("重复，已跳过");
                  resolve();
                  return;
                }
              }
            } catch (e) { /* 查重失败不阻塞上传 */ }
          }
          // v0.21/v0.22：相似图片提醒（可仍然上传 / 删除新图 / 用新图替换库中旧图）
          if (!it.dhash) it.dhash = await dhashOfFile(it.f);
          const sim = findSimilarInLibrary(it.dhash);
          if (sim.length) {
            const target = sim[0];
            const choice = await askChoice(
              "发现相似图片",
              `这张与库中「${target.photo.title}」${sim.length > 1 ? ` 等 ${sim.length} 张` : ""}相似（差异 ${target.distance}/64）。怎么处理？`,
              [
                { value: "replace", label: "用新图替换旧图", kind: "danger" },
                { value: "upload", label: "仍然上传", kind: "primary" },
                { value: "drop", label: "删除这张新图" },
              ]
            );
            if (choice === "drop") {
              removeUqItem(it);
              setUqStatus(`已删除新图（库中保留「${esc(target.photo.title)}」）`);
              resolve();
              return;
            }
            if (choice === null) { // 取消 = 跳过这张，保留在队列里
              row.classList.add("ok");
              setSub(`相似，已跳过（库中「${target.photo.title}」）`);
              resolve();
              return;
            }
            if (choice === "replace") {
              try {
                await apiFetch(`/api/photos/${target.photo.id}`, { method: "DELETE" });
                const bi = PHOTOS.findIndex((x) => x.id === target.photo.id);
                if (bi >= 0) PHOTOS.splice(bi, 1);
                if (window.__renderGallery) window.__renderGallery();
                setSub(`已替换库中「${target.photo.title}」`);
              } catch (e) {
                setSub("替换失败，仍按新图上传");
              }
            }
          }
          setSub("上传中…");
          const xhr = new XMLHttpRequest();
          it.xhr = xhr; // v0.54：关闭上传窗口时用于中断
          xhr.open("POST", "/api/photos");
          for (const [k, v] of Object.entries(apiHeaders())) xhr.setRequestHeader(k, v);
          xhr.setRequestHeader("Content-Type", "application/json");
          xhr.timeout = 120000; // v0.54：2 分钟超时（大图 + 冷启动），原来是无限等
          xhr.ontimeout = () => {
            row.classList.add("err");
            setSub("上传超时，请重试");
            reject(new Error("上传超时"));
          };
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) setPct(Math.round((e.loaded / e.total) * 100));
          };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              row.classList.add("ok", "done");
              setSub("已上传");
              pushRecentTags(rowSendTags(it)); // v0.16：上传用过的标签进「最近使用」
              resolve();
            } else {
              let msg = "上传失败";
              try { msg = JSON.parse(xhr.responseText).error || msg; } catch (e) { /* ignore */ }
              row.classList.add("err");
              setSub(msg);
              reject(new Error(msg));
            }
          };
          xhr.onerror = () => {
            row.classList.add("err");
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
            tags,
          }));
        })
        .catch((e) => {
          row.classList.add("err");
          setSub("转换失败");
          reject(e);
        });
    });
  }

  // 上传队列（v0.54：手动点「开始上传」，拖入不再自动上传）
  function startUpload() {
    const items = files.filter((it) => it.status === "ready");
    if (!items.length) return;
    const upHintEl = document.getElementById("upHint");
    if (upHintEl) upHintEl.innerHTML = `正在上传… (0/${items.length})`;
    btnUpload.disabled = true;
    btnUpload.textContent = `处理中… (0/${items.length})`;
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
        done++;
        if (done === items.length) {
          btnUpload.disabled = true;
          btnUpload.textContent = "全部完成";
          if (upHintEl) upHintEl.innerHTML = "全部完成 ✓ 可继续拖入图片";
          if (USE_API) {
            await loadData();
            if (window.__refreshGallery) window.__refreshGallery();
          }
        } else {
          btnUpload.textContent = `处理中… (${done}/${items.length})`;
          if (upHintEl) upHintEl.innerHTML = `正在上传… (${done}/${items.length})`;
        }
      }
    })();
  }
  btnUpload.addEventListener("click", startUpload);

  /* v0.54：清空上传列表（关闭上传窗口时调用）——
     还在传的请求一并中断；中止后的回调写的是已脱离文档的行节点，不会报错 */
  function clearUploadQueue() {
    files.forEach((it) => { try { if (it.xhr) it.xhr.abort(); } catch (e) { /* ignore */ } });
    files.length = 0;
    queue.innerHTML = "";
    btnUpload.disabled = true;
    btnUpload.textContent = "开始上传";
    const h = document.getElementById("upHint");
    if (h) h.innerHTML = "拖入图片后点「开始上传」；关闭本窗口会清空列表";
  }
  /* 还有多少张没传完（关闭窗口时提醒用） */
  function uploadPendingCount() {
    return files.filter((it) => it.status !== "ok").length;
  }
  window.__clearUploadQueue = clearUploadQueue;
  window.__uploadPendingCount = uploadPendingCount;
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
  renderCatPicks(document.getElementById("btCats"), null); // v0.15 批量主分类（默认不修改）
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
    const catSel = selCatsOf(document.getElementById("btCats")); // [] = 不改主分类（v0.19 多选）
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
        body: JSON.stringify({ tags: next, ...(catSel.length ? { categories: catSel } : {}) }),
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
/* ---------- 单张编辑弹窗（v0.11.2：标签 / 删除；v0.41 描述已移除） ---------- */
let editTargetId = null;
function openEditModal(id) {
  if (guestBlocked("编辑图片")) return; // v0.49 观光模式只能看图
  const p = PHOTOS.find((x) => x.id === id);
  if (!p) return;
  editTargetId = id;
  renderCatPicks(document.getElementById("edCats"), catsOf(p)); // v0.19 主分类（多选）
  const box = document.getElementById("edTagBox");
  box.querySelectorAll(".t").forEach((el) => el.remove());
  (p.tags || []).forEach((t) => addTagChip(box, t));
  const r18Box = document.getElementById("edRating");
  if (r18Box) renderRatingPicks(r18Box, ratingOf(p)); // v0.57：三档分级（替代原来的 R18 勾选）
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
        categories: selCatsOf(document.getElementById("edCats")), // v0.19 主分类（多选数组）
        tags: tagsOfBox(document.getElementById("edTagBox")),
        rating: ratingPicksValue(document.getElementById("edRating")), // v0.57 分级（三档）
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
    // v0.38：图片已删除 → 关灯箱（顺带停幻灯片、收工具条）
    if (lbIsOpen()) closeLightbox();
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
  bindCatPicks(document.getElementById("edCats")); // v0.15 主分类单选
  bindRatingPicks(document.getElementById("edRating")); // v0.57 分级三档
  const btSeg = document.getElementById("btMode");
  if (btSeg) btSeg.querySelectorAll(".seg-btn").forEach((b) => b.addEventListener("click", () => setBtMode(b.dataset.mode)));
  bindTagSuggest(document.getElementById("btTagInput"), document.getElementById("btTagSuggest"), document.getElementById("btTagBox"));
  bindCatPicks(document.getElementById("btCats")); // v0.15 批量主分类
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
      const tags = []; // v0.54：URL 导入不再附带标签
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

/* ============================================================
   集合（v0.56：手动相册退场）
   相册要「手动挑选 + 手动维护」，而它表达的往往就是「某一类图」——
   那正是主分类能派生的东西。于是浏览页只剩三类集合，零维护：
     __all        全部图片
     __fav        收藏夹（照片字段 meta.fav）
     cat:<名称>   某个主分类（cat:__none = 未分类）
   旧数据不删：albums-config 仍在 Blobs 里、/api/albums 接口照旧，只是前端不再使用。
   ============================================================ */
const SET_ALL = "__all";
const SET_FAV = "__fav";
const ALB_PAGE = 200;     // 二级每批渲染多少张（上千张一次性进 DOM 会卡）
let albLevel = "list";    // list 一级 | set 二级（某个集合）
let albCurrentKey = null; // 二级正在看的集合 key
let albShown = 0;

/* 集合 → 照片 id 列表（顺序跟随 PHOTOS：新 → 旧） */
function setPhotoIds(key) {
  if (key === SET_ALL) return PHOTOS.map((p) => p.id);
  if (key === SET_FAV) return PHOTOS.filter((p) => favOf(p)).map((p) => p.id);
  if (key && key.startsWith("cat:")) {
    const c = key.slice(4);
    if (c === "__none") return PHOTOS.filter((p) => !catsOf(p).length).map((p) => p.id);
    return PHOTOS.filter((p) => catsOf(p).includes(c)).map((p) => p.id);
  }
  return [];
}
function setTitle(key) {
  if (key === SET_ALL) return t("全部图片", "All Photos");
  if (key === SET_FAV) return t("收藏夹", "Favorites");
  if (key && key.startsWith("cat:")) {
    const c = key.slice(4);
    return c === "__none" ? t("未分类", "Uncategorized") : c;
  }
  return t("浏览", "Browse");
}
/* 集合封面：取集合内第一张图 */
function setCover(key) {
  const id = setPhotoIds(key)[0];
  return id ? PHOTOS.find((p) => p.id === id) : null;
}

/* ---------- 浏览页（v0.34 独立整页 / v0.56 改为集合） ----------
   一级 = 全部图片 / 收藏夹 / 主分类集合；二级 = 某个集合的照片网格
   进入/返回走左右滑动动画（FAB 按钮进入；页面右滑返回，二级先回一级） */
let albOpenFlag = false;

function openAlbumPage() {
  const page = document.getElementById("albumPage");
  if (!page) return;
  albLevel = "list";
  albCurrentKey = null;
  renderAlbumsView();
  page.classList.add("open");
  page.setAttribute("aria-hidden", "false");
  document.body.classList.add("album-open");
  albOpenFlag = true;
}
function closeAlbumPage() {
  const page = document.getElementById("albumPage");
  if (!page) return;
  if (albLevel === "set") { // 二级先退回一级（iOS 的返回层级）
    albLevel = "list";
    albCurrentKey = null;
    renderAlbumsView();
    return;
  }
  page.classList.remove("open");
  page.setAttribute("aria-hidden", "true");
  document.body.classList.remove("album-open");
  albOpenFlag = false;
}

function renderAlbumsView() {
  const body = document.getElementById("albumBody");
  if (!body) return;
  const titleEl = document.getElementById("albNavTitle");
  const backLabel = document.getElementById("albBackLabel");
  if (titleEl) titleEl.textContent = albLevel === "set" ? setTitle(albCurrentKey) : t("浏览", "Browse");
  if (backLabel) backLabel.textContent = albLevel === "set" ? t("浏览", "Browse") : t("图库", "Gallery");

  if (albLevel === "list") {
    const cats = sortedCategories();
    const noneIds = setPhotoIds("cat:__none");
    const card = (key, name, n, cls) => {
      const cover = setCover(key);
      const ph = cls.includes("alb-fav") ? "♥" : "🖼";
      return `<button class="alb-cover${cls ? " " + cls : ""}" data-set="${escAttr(key)}" type="button" title="${escAttr(name)}">
          <span class="cv">${cover ? `<img loading="lazy" decoding="async" src="${cardImgSrc(cover)}" alt="">` : `<span class="ph">${ph}</span>`}</span>
          <span class="nm">${esc(name)}</span>
          <span class="ct">${n} 张</span>
        </button>`;
    };
    body.innerHTML = `
      <div class="alb-largetitle">${t("浏览", "Browse")}<span class="cnt">${PHOTOS.length} 张 · ${cats.length} 个主分类</span></div>
      <div class="alb-cover-grid">
        ${card(SET_ALL, t("全部图片", "All Photos"), PHOTOS.length, "alb-special")}
        ${card(SET_FAV, t("收藏夹", "Favorites"), setPhotoIds(SET_FAV).length, "alb-special alb-fav")}
      </div>
      <div class="alb-group-head">${t("主分类", "Category")}</div>
      <div class="alb-cover-grid">
        ${cats.map((c) => card(`cat:${c.name}`, c.name, setPhotoIds(`cat:${c.name}`).length, "")).join("")}
        ${noneIds.length ? card("cat:__none", t("未分类", "Uncategorized"), noneIds.length, "") : ""}
      </div>`;
    return;
  }

  /* 二级：某个集合的内容（分批渲染，避免上千张一次性进 DOM） */
  const ids = setPhotoIds(albCurrentKey);
  const title = esc(setTitle(albCurrentKey));
  if (!ids.length) {
    body.innerHTML = `<div class="alb-largetitle">${title}<span class="cnt">0 张</span></div>
      <div class="alb-empty">${albCurrentKey === SET_FAV
        ? "还没有收藏的图片<br><span class=\"sub\">在图库里点卡片右上角的 ♡，或用灯箱工具条的「收藏」</span>"
        : "这里还没有图片"}</div>`;
    return;
  }
  albShown = Math.min(Math.max(albShown || ALB_PAGE, ALB_PAGE), ids.length);
  body.innerHTML = `
    <div class="alb-largetitle">${title}<span class="cnt">${ids.length} 张</span></div>
    <div class="alb-subbar"><span class="hint">点图片看大图${albCurrentKey === SET_FAV ? " · 收藏可在灯箱里取消" : ""}</span></div>
    <div class="alb-photo-grid">${ids.slice(0, albShown).map((id) => {
      const p = PHOTOS.find((x) => x.id === id);
      if (!p) return "";
      const f = favOf(p);
      return `<div class="alb-photo${f ? " fav" : ""}" data-id="${escAttr(id)}" title="${escAttr(p.title || "")}">
        <img loading="lazy" decoding="async" src="${cardImgSrc(p)}" alt="">
        ${f ? `<span class="alb-heart">♥</span>` : ""}
      </div>`;
    }).join("")}</div>
    ${albShown < ids.length ? `<button class="btn ghost alb-more" id="albMore" type="button">加载更多（还有 ${ids.length - albShown} 张）</button>` : ""}`;
}

function initAlbumPage() {
  const page = document.getElementById("albumPage");
  const body = document.getElementById("albumBody");
  if (!page || !body || page.dataset.bound) return;
  page.dataset.bound = "1";
  // v0.56：一级是派生的集合，没有「新建 / 重命名 / 删除」。
  // 返回键按层级退（二级 → 一级 → 图库），closeAlbumPage 内部已处理
  document.getElementById("albBack").addEventListener("click", closeAlbumPage);

  /* 点击委托：集合卡片进二级 / 二级里点图片开灯箱 / 「加载更多」追加下一批 */
  body.addEventListener("click", (e) => {
    if (e.target.closest("#albMore")) {
      albShown += ALB_PAGE;
      renderAlbumsView();
      return;
    }
    const setCard = e.target.closest("[data-set]");
    if (setCard) {
      albCurrentKey = setCard.dataset.set;
      albLevel = "set";
      albShown = ALB_PAGE;
      renderAlbumsView();
      return;
    }
    const photo = e.target.closest(".alb-photo");
    if (photo) openLightboxById(photo.dataset.id);
  });

  /* 触摸手势（iOS 风格）：
     相册页内右滑 → 二级回一级 / 一级退出回图库；
     图库页右边缘左滑 → 进入相册页（限定从边缘起手，避免和卡片拖拽冲突） */
  const SWIPE = 60;
  let sx = 0, sy = 0, tracking = false;
  page.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; tracking = true;
  }, { passive: true });
  page.addEventListener("touchend", (e) => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (dx > SWIPE && Math.abs(dx) > Math.abs(dy) * 1.6) closeAlbumPage(); // 右滑返回
  }, { passive: true });

  let gx = 0, gy = 0, gtrack = false;
  document.addEventListener("touchstart", (e) => {
    // v0.43：灯箱打开时手势归灯箱（左右滑动切图），不要同时触发「左滑进相册」
    if (albOpenFlag || lbIsOpen() || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (window.innerWidth - t.clientX > 60) return; // 仅右边缘 60px 内起手
    gx = t.clientX; gy = t.clientY; gtrack = true;
  }, { passive: true });
  document.addEventListener("touchend", (e) => {
    if (!gtrack) return;
    gtrack = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - gx, dy = t.clientY - gy;
    if (dx < -SWIPE && Math.abs(dx) > Math.abs(dy) * 1.6) openAlbumPage(); // 左滑进入相册
  }, { passive: true });

  // 桌面端：Esc 返回上一级
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !albOpenFlag) return;
    if (document.querySelector(".lightbox.open")) return; // 灯箱自己处理
    closeAlbumPage();
  });

  renderAlbumsView();
}
/* 调试 / 测试钩子（与项目里 __refreshGallery 等一致） */
window.__albumsState = () => ({
  level: albLevel, key: albCurrentKey, open: albOpenFlag,
  ids: albLevel === "set" ? setPhotoIds(albCurrentKey) : [],
});
window.__setPhotoIds = setPhotoIds; // 集合派生规则（测试 / 调试用）
window.__openAlbumPage = openAlbumPage;
window.__closeAlbumPage = closeAlbumPage;

/* v0.56：批量条上的「♥ 收藏」（原「＋ 入相册」的位置） */
function initBatchFav() {
  const btn = document.getElementById("batchFav");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (!selected.size) return;
    if (guestBlocked("收藏")) return;
    const ids = [...selected];
    const allFav = ids.every((id) => favOf(PHOTOS.find((p) => p.id === id)));
    await setFavMany(ids, !allFav);
    btn.textContent = allFav ? "♥ 收藏" : "♥ 取消收藏";
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
  "外观": "Appearance", "图库统计": "Library Stats", "快捷键": "Shortcuts",
  "标签管理": "Tag Manager", "水印": "Watermark", "数据维护": "Maintenance", "危险操作": "Danger Zone",
  "主题": "Theme", "浅色": "Light", "深色": "Dark", "跟随系统": "Auto",
  "瀑布流列宽": "Column Width", "窄 180": "Narrow", "标准 240": "Standard", "宽 320": "Wide",
  "图片加载": "Image Quality", "高画质": "High", "平衡": "Balanced", "省流": "Low Data", "语言": "Language",
  "图片数量": "Photos", "已用空间": "Used Space",
  "导出元数据": "Export Metadata", "操作日志": "Activity Log", "清空整个图库": "Erase Library",
  "返回图库": "Back", "上传": "Upload",
  "打开搜索窗口": "Open search window", "灯箱中切换上一张 / 下一张": "Prev / next in lightbox",
  "关闭灯箱 / 弹窗 / 悬浮菜单": "Close lightbox / dialogs / menus",
  "幻灯片间隔": "Slideshow interval", "灯箱中开始 / 暂停幻灯片放映": "Start / pause slideshow in lightbox",
  "标签筛选": "Filter by tag", "搜索标签 / 别名…": "Search tags / aliases…",
  "已选": "Selected", "排除": "Exclude", "保存": "Save", "清空": "Clear",
  "且": "AND", "或": "OR", "我的筛选": "My Filters", "未分类": "Uncategorized",
  "给这组筛选起个名字…": "Name this filter…", "空筛选": "Empty filter",
  "浏览": "Browse", "全部图片": "All Photos", "收藏夹": "Favorites", "收藏": "Favorite",
  "或从 URL 导入（每行一个图片链接）": "Or import from URLs (one per line)", "导入": "Import",
  "拖拽图片到这里，或点击选择": "Drop images here, or click to select",
  "标签（输入时从标签库选择，回车可自定义）": "Tags (type to pick, Enter for custom)",
  "输入后按回车…": "Type & press Enter…", "输入后回车添加…": "Type & press Enter…",
  "开始上传": "Upload now",
  "取消": "Cancel", "关闭": "Close", "保存": "Save", "应用": "Apply", "删除": "Delete", "确认": "Confirm",
  "确认删除": "Delete", "清空": "Clear", "清空日志": "Clear logs",
  "加标签": "Add Tags", "入相册": "Add to Album", "全部": "All",
  "最新上传": "Newest", "最早上传": "Oldest", "标题 A–Z": "Title A–Z", "文件大小": "Size",
  "标题": "Title", "标签": "Tags",
  "加入相册": "Add to Album", "新建相册名称…": "New album name…", "＋ 新建并加入": "Create & add",
  "编辑待上传项": "Edit upload item", "编辑图片信息": "Edit photo",
  "留空则使用文件名": "Empty = use file name", "留空则跟随上方全局标签": "Empty = use global tags",
  "图片编辑": "Edit", "操作日志": "Activity Log", "暂无操作记录": "No activity yet",
  "水印图": "Watermark image", "上传时加图片水印": "Add watermark on upload",
  "建议使用透明底 PNG；水印将等比缩放到图片宽度的 18%，置于右下角。仅作用于启用后新上传的图片。": "Use transparent PNG; watermark scales to 18% width, bottom-right. Applies to new uploads only.",
  "进入": "Enter", "私人图库": "Private Gallery", "输入访问密码以继续": "Enter password to continue", "访问密码": "Password",

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
/* v0.37：幻灯片放映随灯箱工具条一起移除（原 initSlideSetting 一并删除） */

/* ---------- 拼音匹配（v0.13；v0.54 改为按需加载拼音库） ----------
   pinyin-pro 有 316KB（gzip 约 142KB），却只在「搜索框里输入纯字母」时才会用到，
   原来写死在 index.html 里跟着首屏一起下载。现在首次真正需要时才注入 <script>。
   注意：库没就绪时 pinyinOf 返回空结果但**不写缓存** —— 否则那次的空白拼音会被永久缓存，
   之后即使库加载完成，搜索依然匹配不上。 */
const PINYIN_SRC = "assets/pinyin-pro.min.js?v=20261015";
const pinyinCache = new Map();
let pinyinLoading = false;
let pinyinReady = typeof window !== "undefined" && !!window.pinyinPro; // 兼容仍预加载的场景
function loadPinyinLib() {
  if (pinyinReady || pinyinLoading || typeof document === "undefined") return;
  pinyinLoading = true;
  const s = document.createElement("script");
  s.src = PINYIN_SRC;
  s.onload = () => {
    pinyinLoading = false;
    pinyinReady = !!window.pinyinPro;
    pinyinCache.clear(); // 丢掉加载前算出的空结果
    if (!pinyinReady) return;
    // 用户可能正停在搜索框里：重放一次 input，让刚算不出的那次过滤用上拼音
    const el = document.activeElement;
    if (el && el.tagName === "INPUT" && typeof el.value === "string" && el.value.trim()) {
      try { el.dispatchEvent(new Event("input", { bubbles: true })); } catch (e) { /* ignore */ }
    }
  };
  s.onerror = () => { pinyinLoading = false; }; // 离线：保持降级，只按文本匹配
  document.head.appendChild(s);
}
function pinyinOf(text) {
  const key = String(text).toLowerCase();
  if (pinyinCache.has(key)) return pinyinCache.get(key);
  const r = { full: "", first: "" };
  if (!pinyinReady) {
    if (window.pinyinPro) pinyinReady = true;
    else { loadPinyinLib(); return r; } // 未就绪：直接返回且不缓存
  }
  try {
    r.full = window.pinyinPro.pinyin(text, { pattern: "pinyin", toneType: "none", type: "array", nonZh: "consecutive" }).join("").toLowerCase();
    r.first = window.pinyinPro.pinyin(text, { pattern: "first", toneType: "none", type: "array", nonZh: "consecutive" }).join("").toLowerCase();
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

/* ---------- 上传队列逐张编辑（v0.13：标签；v0.41 描述已移除） ---------- */
let uqTarget = null;
function openUqEdit(it) {
  uqTarget = it;
  const m = document.getElementById("uqModal");
  if (!m) return;
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
  const tags = tagsOfBox(document.getElementById("uqTagBox"));
  it.tags = tags.length ? tags : undefined; // undefined → 跟随全局标签
  const nameRow = it.row && it.row.querySelector(".uq-name-row");
  if (nameRow) {
    const edited = !!it.tags;
    nameRow.innerHTML = `<span class="name">${esc(it.f.name)}</span>` + (edited ? `<span class="edited-mark">已编辑</span>` : "");
  }
  document.getElementById("uqModal").classList.remove("open");
  renderUqRowTags(it);
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

/* ---------- 主分类管理块（v0.15：分组视图顶部） ---------- */
function catMgrBlockHTML() {
  const catUsed = {};
  PHOTOS.forEach((p) => {
    const cs = catsOf(p);
    cs.forEach((c) => { catUsed[c] = (catUsed[c] || 0) + 1; }); // 多选：一张图计入多个分类
  });
  const cats = sortedCategories();
  return `<div class="tmgr-block">
    <div class="tmgr-head">
      <i class="dot" style="--tg:var(--accent)"></i>${t("主分类", "Category")} <span class="req-mark">${t("可选", "optional")}</span>
      <span class="cnt">${cats.length} 个</span>
    </div>
    <div class="tmgr-pills">` + cats.map((c) => {
      const n = catUsed[c.name] || 0;
      return `<span class="tmgr-pill cat" style="--tg:${c.color || "var(--accent)"}">
        <i class="dot"></i>${esc(c.name)}
        <span class="cnt">${n} 张</span>
        <button class="act" data-cact="edit" data-cname="${escAttr(c.name)}" title="编辑 / 改名">✎</button>
        <button class="act danger" data-cact="remove" data-cname="${escAttr(c.name)}" title="删除">×</button>
      </span>`;
    }).join("") + `</div></div>`;
}

const TMGR_VIEW_KEY = "rn_tmgr_view";
/* ---------- 分组视图：标签组折叠（v0.29） ----------
   标签多的组（> TMGR_AUTO_FOLD）默认折叠，避免一次铺开几百个标签 pill；
   用户手动展开 / 折叠过的组会记进 localStorage，刷新后保持。 */
const TMGR_FOLD_KEY = "rn_tmgr_fold";
const TMGR_AUTO_FOLD = 20;
let tmgrFold = null; // 元素形如 "open:组id" / "fold:组id"（未分组用 __free）
function loadTmgrFold() {
  try {
    const a = JSON.parse(localStorage.getItem(TMGR_FOLD_KEY) || "null");
    tmgrFold = Array.isArray(a) ? new Set(a) : null;
  } catch (e) { tmgrFold = null; }
}
function saveTmgrFold() {
  try { localStorage.setItem(TMGR_FOLD_KEY, JSON.stringify([...(tmgrFold || [])])); } catch (e) { /* ignore */ }
}
function isTmgrFolded(key, count) {
  if (tmgrFold) {
    if (tmgrFold.has("open:" + key)) return false; // 用户显式展开过
    if (tmgrFold.has("fold:" + key)) return true;  // 用户显式折叠过
  }
  return count > TMGR_AUTO_FOLD; // 默认：标签多的组折叠
}
function toggleTmgrFold(key, count) {
  const folded = isTmgrFolded(key, count);
  tmgrFold = tmgrFold || new Set();
  tmgrFold.delete("open:" + key);
  tmgrFold.delete("fold:" + key);
  tmgrFold.add((folded ? "open:" : "fold:") + key);
  saveTmgrFold();
  refreshTagManager();
}
function setAllTmgrFold(fold) {
  tmgrFold = tmgrFold || new Set();
  [...(TAGS.groups || []).map((g) => g.id), "__free"].forEach((k) => {
    tmgrFold.delete("open:" + k);
    tmgrFold.delete("fold:" + k);
    tmgrFold.add((fold ? "fold:" : "open:") + k);
  });
  saveTmgrFold();
  refreshTagManager();
}
/* ---------- 分类工作台状态（v0.14.4：统计视图 → 两栏拖拽分类） ---------- */
let cwFilter = "all";        // all | loose（只显示未入库分类的图片）
let cwShown = 40;            // 左栏一次性渲染张数
let cwList = [];             // 当前筛选后的图片列表
const cwSel = new Set();     // 左栏点选（再拖任意一张 = 整批归类）
const cwExtraSlots = new Set(); // 面板内临时自定义分类（不回写标签库）
const cwOpenGroups = new Set(); // v0.20：分类工作台里展开的作品组（手风琴）
let cwSlotQuery = "";           // v0.20：分类槽搜索关键词
let cwOpenInited = false;
function refreshTagManager() {
  const root = document.getElementById("tagMgrRoot");
  if (!root) return;
  if (tmgrFold === null) loadTmgrFold(); // v0.29：首次读取标签组折叠状态
  const counts = tagCounts();
  const used = Object.keys(counts);
  const savedView = localStorage.getItem(TMGR_VIEW_KEY);
  let view = savedView === "group" ? "group" : (savedView === "review" ? "review" : "classify");
  if (isTagger()) view = "review"; // v0.51 整理模式：只给「整理」视图（其余视图是管理功能）
  // v0.20：离开「整理」视图时摘掉键盘监听（v0.23 起同时管理分类工作台的数字键）
  if (view !== "review" && window.__rvKey) {
    document.removeEventListener("keydown", window.__rvKey, true);
    window.__rvKey = null;
  }
  if (view !== "classify" && window.__cwKey) {
    document.removeEventListener("keydown", window.__cwKey, true);
    window.__cwKey = null;
  }

  let html = `<div class="tmgr-seg">
      <div class="seg" id="tmgrViewSeg" role="group" aria-label="视图">
        ${isTagger() ? "" : `<button class="seg-btn${view === "group" ? " on" : ""}" data-view="group">分组</button>
        <button class="seg-btn${view === "classify" ? " on" : ""}" data-view="classify">分类</button>`}
        <button class="seg-btn${view === "review" ? " on" : ""}" data-view="review" title="一次只处理一张图，键盘流快速分类">整理</button>
      </div>
      ${view === "group" ? `<span class="tmgr-fold-actions">
        <button class="mini-link" id="tmgrFoldAll" type="button" title="折叠所有标签组">全部折叠</button>
        <button class="mini-link" id="tmgrOpenAll" type="button" title="展开所有标签组">全部展开</button>
      </span>` : ""}
    </div>`;

  if (view === "group") {
    html += `<div class="tag-mgr-hint">${t("主分类 = 内容大类（可选，一张图可以没有，也可以多选）；标签组 = 作品 / 来源（如 原神），组内标签 = 该作品的角色。改名 / 删除会同步所有图片。",
      "Category is optional (zero or more per photo); tag groups act as series/source (e.g. Genshin), with character tags inside them.")}</div>`;
    html += catMgrBlockHTML(); // v0.15 主分类管理（顶部固定区）
    if (!used.length && !TAGS.tags.length) {
      html += `<div class="tag-mgr-empty" style="padding:4px 2px 2px">图库中还没有标签。上传图片时填写标签，即可在此分组管理。</div>`;
    } else {
      const groups = [...TAGS.groups].sort((a, b) => ((a.sort || 0) - (b.sort || 0)) || a.name.localeCompare(b.name, "zh"));
      if (groups.length) {
        for (const g of groups) {
          const items = TAGS.tags
            .filter((t) => t.group === g.id)
            .sort((a, b) => ((a.sort || 0) - (b.sort || 0)) || a.name.localeCompare(b.name, "zh"));
          const folded = isTmgrFolded(g.id, items.length); // v0.29：标签多的组默认折叠
          html += `<div class="tmgr-head foldable${folded ? " folded" : ""}" data-gfold="${escAttr(g.id)}" data-gcount="${items.length}" style="margin-top:6px" title="${folded ? "点击展开" : "点击折叠"}">
            <span class="caret">▾</span>
            <i class="dot" style="--tg:${g.color || "#ff9f0a"}"></i>${esc(g.name)}
            <span class="cnt">${items.length} 个标签</span>
            <button class="act" data-gnew="${escAttr(g.id)}" title="在「${escAttr(g.name)}」组新建标签">＋</button>
            <button class="act" data-gact="edit" data-gid="${escAttr(g.id)}" title="编辑组">✎</button>
          </div>`;
          if (!folded) html += mgrPills(items, counts);
        }
      }
      // v0.31：未分组区同时展示「库里但未归组」的标签与「照片里有但库里没有」的游离标签
      // （此前只显示游离标签，导致新建的未分组标签在分组视图里看不到）
      const libLoose = TAGS.tags
        .filter((t) => !t.group)
        .sort((a, b) => ((a.sort || 0) - (b.sort || 0)) || a.name.localeCompare(b.name, "zh"));
      const looseFree = used.filter((n) => !tagByName(n));
      const looseItems = [
        ...libLoose,
        ...looseFree.map((n) => ({ name: n, color: null, group: "" })),
      ];
      if (looseItems.length) {
        const foldedFree = isTmgrFolded("__free", looseItems.length);
        html += `<div class="tmgr-head foldable${foldedFree ? " folded" : ""}" data-gfold="__free" data-gcount="${looseItems.length}" style="margin-top:6px" title="${foldedFree ? "点击展开" : "点击折叠"}">
          <span class="caret">▾</span>
          <i class="dot"></i>未分组 · 待整理<span class="cnt">${looseItems.length}</span>
          <button class="act" data-gnew="" title="新建「未分组」标签">＋</button>
        </div>`;
        if (!foldedFree) html += mgrPills(looseItems, counts);
      }
    }
  } else if (view === "classify") {
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
          <div class="uq-panel-title">主分类 <span class="req">点一下 = 设置到选中图片</span>
            <button class="mini-link" id="cwNewCat" type="button" title="新建主分类">＋ 新建</button>
          </div>
          <div class="uq-panel-sub">选中左侧图片后点分类名即可加上；已全部包含时再点 = 取消。也可把图片直接拖到分类名上；点分类名里的 ✎ 可改名 / 改色 / 删除</div>
          <div class="uq-cats" id="cwCats" data-multi="1" data-can-edit="1"></div>
        </div>
        <div class="uq-panel">
          <div class="uq-panel-title">标签（作品 / 角色）</div>
          <div class="uq-panel-sub">点左侧图片选中 → 点标签槽即打标（也可拖拽）；组头可折叠，一次只展开一个作品组</div>
          <div class="rv-help" style="margin:2px 0 6px">快捷键：选中图片后按 <b>1-9</b> = 直接打「最近使用」里的标签，可连续按</div>
          <input type="text" id="cwSlotSearch" class="uq-slot-search" placeholder="搜角色 / 作品（支持拼音，如 ht）" autocomplete="off">
          <div class="uq-panel-status" id="cwSelStatus"></div>
          <div class="uq-slots" id="cwSlots"></div>
          <div class="uq-new-slot">
            <input type="text" id="cwNewSlotInput" placeholder="+ 新标签，回车创建" autocomplete="off">
          </div>
        </div>
      </div>
    </div>`;
  } else if (view === "review") {
    // v0.20 逐张整理：一次只面对一张图，主分类可点选、标签可搜索，键盘流推进
    html += `<div class="rv">
      <div class="rv-head">
        <span class="rv-progress" id="rvProgress">…</span>
        <span class="seg rv-filters" id="rvFilters" role="group">
          <button class="seg-btn sm${rvFilter === "todo" ? " on" : ""}" data-rvf="todo" title="缺主分类或还没打过库内标签的图片">待整理</button>
          <button class="seg-btn sm${rvFilter === "nocat" ? " on" : ""}" data-rvf="nocat">未分类</button>
          <button class="seg-btn sm${rvFilter === "notag" ? " on" : ""}" data-rvf="notag">无标签</button>
          <button class="seg-btn sm${rvFilter === "all" ? " on" : ""}" data-rvf="all">全部</button>
        </span>
        <button class="btn ghost sm" id="rvReset" type="button" title="清空整理进度：已应用过的图片会重新回到待整理队列">重置进度</button>
      </div>
      <div class="rv-body">
        <div class="rv-photo">
          <img id="rvImg" alt="">
          <div class="rv-meta" id="rvMeta"></div>
        </div>
        <div class="rv-panel">
          <div class="uq-panel">
            <div class="uq-panel-title">主分类 <span class="req">可多选</span>
              ${isAdmin() ? `<button class="mini-link" id="rvNewCat" type="button" title="新建主分类">＋ 新建</button>` : ""}
            </div>
            <div class="uq-cats" id="rvCats" data-multi="1"${isAdmin() ? ` data-can-edit="1"` : ""}></div>
          </div>
          <div class="uq-panel">
            <div class="uq-panel-title">标签</div>
            <div class="tag-input-wrap">
              <div class="tag-input" id="rvTagBox">
                <input type="text" id="rvTagInput" placeholder="输入搜索 / 回车添加…" autocomplete="off">
              </div>
              <div class="tag-suggest" id="rvTagSuggest" hidden></div>
            </div>
            <div class="quick-pick show" id="rvQuick"></div>
          </div>
          <div class="rv-actions">
            <button class="btn primary" id="rvApply" type="button">应用并下一张 (Enter)</button>
            <button class="btn ghost" id="rvSkip" type="button">跳过 (S)</button>
          </div>
          <div class="rv-help">1-9 = 最近使用标签　｜　Backspace = 删最后一个标签　｜　Esc = 退出整理</div>
          <div class="hint" id="rvHint"></div>
        </div>
      </div>
    </div>`;
  }

  // v0.51：整理模式下不显示这些标签库管理按钮（只能给图片打标签，不能改标签库本身）
  if (isAdmin()) {
    html += `<div class="tag-mgr-actions">
      <button class="btn ghost sm" id="btnNewCategory">＋ ${t("新建主分类", "New category")}</button>
      <button class="btn ghost sm" id="btnNewTag">＋ 新建标签</button>
      <button class="btn ghost sm" id="btnNewGroup">＋ 新建标签组</button>
      <button class="btn ghost sm" id="btnBulkTags">⇪ ${t("批量导入标签", "Bulk import")}</button>
    </div>`;
  }
  root.innerHTML = html;

  const q = (sel) => root.querySelector(sel);
  if (q("#btnNewCategory")) q("#btnNewCategory").addEventListener("click", () => openCatModal("new-category"));
  if (q("#btnNewTag")) q("#btnNewTag").addEventListener("click", () => openTagModal("new-tag"));
  if (q("#btnNewGroup")) q("#btnNewGroup").addEventListener("click", () => openTagModal("new-group"));
  if (q("#btnBulkTags")) q("#btnBulkTags").addEventListener("click", () => openBulkTagModal());
  root.querySelectorAll("[data-cact='edit']").forEach((b) => b.addEventListener("click", () => openCatModal("edit-category", b.dataset.cname)));
  root.querySelectorAll("[data-cact='remove']").forEach((b) => b.addEventListener("click", () => openCatModal("remove-category", b.dataset.cname)));
  const seg = q("#tmgrViewSeg");
  if (seg) {
    seg.querySelectorAll(".seg-btn").forEach((b) => {
      b.addEventListener("click", () => {
        localStorage.setItem(TMGR_VIEW_KEY, b.dataset.view);
        refreshTagManager();
        renderTagMenuContent(); // 整理视图改过标签后，筛选菜单计数同步刷新
      });
    });
  }
  if (view === "classify") initCwView(root);
  if (view === "review") initReviewView(root);
  // v0.29：分组视图的标签组折叠 + 全部折叠 / 展开
  root.querySelectorAll("[data-gfold]").forEach((h) => h.addEventListener("click", (e) => {
    if (e.target.closest("button")) return; // 组头右侧的编辑按钮等不触发折叠
    toggleTmgrFold(h.dataset.gfold, Number(h.dataset.gcount) || 0);
  }));
  const foldAllBtn = q("#tmgrFoldAll");
  if (foldAllBtn) foldAllBtn.addEventListener("click", () => setAllTmgrFold(true));
  const openAllBtn = q("#tmgrOpenAll");
  if (openAllBtn) openAllBtn.addEventListener("click", () => setAllTmgrFold(false));
  root.querySelectorAll("[data-gact='edit']").forEach((b) => b.addEventListener("click", () => openTagModal("edit-group", b.dataset.gid)));
  // v0.30：组头旁的「＋」= 直接在该组新建标签（所属组已预选）
  root.querySelectorAll("[data-gnew]").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation(); // 不要触发组头折叠
    openTagModal("new-tag", null, "", b.dataset.gnew || "");
  }));
  root.querySelectorAll("[data-tact='edit']").forEach((b) => b.addEventListener("click", () => {
    const nm = b.dataset.tname;
    if (tagByName(nm)) openTagModal("edit-tag", nm);
    else openTagModal("new-tag", null, nm); // 游离标签：入库整理（预填名称，同名照片引用自动归属）
  }));
  root.querySelectorAll("[data-tact='remove']").forEach((b) => b.addEventListener("click", () => openTagModal("remove-tag", b.dataset.tname)));
  bindTagDrops(root); // 分组视图标签 pill 仍是拖放目标
}
function refreshTagUI() {
  clearGroupNameCache(); // v0.55：标签 / 组结构变了，整组筛选用的名字集合要重建
  refreshTagManager();
  renderTagMenuContent();
}

/* ---------- 分类工作台视图（v0.14.4） ---------- */
function initCwView(root) {
  cwList = PHOTOS.filter((p) => cwFilter === "all" || !(p.tags || []).some((n) => tagByName(n)));
  renderCwCards();
  renderCwSlots();
  renderCwCats();
  updateCwSelStatus();
  const q = (sel) => root.querySelector(sel);
  // v0.26：主分类面板——点一下给选中图片设置/取消；也支持把图片拖到分类名上
  const cwCatsEl = q("#cwCats");
  if (cwCatsEl) {
    cwCatsEl.addEventListener("click", (e) => {
      // v0.28：点「✎」= 编辑该主分类（不改选中状态）
      const editBtn = e.target.closest(".cat-edit");
      if (editBtn) {
        const host = editBtn.closest(".cat-pick");
        if (host && host.dataset.cat) { e.preventDefault(); e.stopPropagation(); openCatModal("edit-category", host.dataset.cat); }
        return;
      }
      const b = e.target.closest(".cat-pick");
      if (b && b.dataset.cat) cwApplyCategory(b.dataset.cat);
    });
    cwCatsEl.addEventListener("dragover", (e) => {
      const b = e.target.closest(".cat-pick");
      if (!b || !(e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes("text/plain"))) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      cwCatsEl.querySelectorAll(".cat-pick.drop-hover").forEach((x) => { if (x !== b) x.classList.remove("drop-hover"); });
      b.classList.add("drop-hover");
    });
    cwCatsEl.addEventListener("dragleave", (e) => {
      const b = e.target.closest(".cat-pick");
      if (b) b.classList.remove("drop-hover");
    });
    cwCatsEl.addEventListener("drop", async (e) => {
      const b = e.target.closest(".cat-pick");
      if (!b || !b.dataset.cat) return;
      e.preventDefault();
      b.classList.remove("drop-hover");
      let ids = window.__cwDrag && window.__cwDrag.length ? [...window.__cwDrag] : [];
      window.__cwDrag = null;
      if (!ids.length) {
        const id0 = e.dataTransfer.getData("text/plain");
        if (id0 && PHOTOS.some((p) => p.id === id0)) ids = [id0]; // 图库卡片直接拖入
      }
      if (ids.length) await cwApplyCategory(b.dataset.cat, "add", ids);
    });
    const cwNewCatBtn = q("#cwNewCat");
    if (cwNewCatBtn) cwNewCatBtn.addEventListener("click", () => openCatModal("new-category"));
  }
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
  const cwSearchEl = q("#cwSlotSearch");
  if (cwSearchEl) {
    cwSearchEl.value = cwSlotQuery;
    cwSearchEl.addEventListener("input", () => { cwSlotQuery = cwSearchEl.value; renderCwSlots(); });
  }
  if (cardsEl) {
    cardsEl.addEventListener("click", (e) => {
      const card = e.target.closest(".cw-card");
      if (!card) return;
      const id = card.dataset.id;
      if (cwSel.has(id)) cwSel.delete(id);
      else cwSel.add(id);
      card.classList.toggle("sel", cwSel.has(id));
      updateCwSelStatus();
      renderCwCats(); // v0.26：主分类面板跟随选中项高亮
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
        pushRecentTags(tag);
        // v0.23：本地增量更新（不再全量 loadData），拖完可以马上继续拖
        todo.forEach((p) => {
          p.tags = [...new Set([...(p.tags || []), tag])].slice(0, 10);
          updateCwCardBadge(p);
        });
        renderCwSlots();
        updateCwSelStatus(`已给 <span class="cnt">${todo.length}</span> 张加上「${esc(tag)}」· 可继续操作`);
        if (window.__renderGallery) window.__renderGallery();
      } catch (err) { /* 静默 */ }
    });
    // v0.20：点组头折叠 / 点槽给已选图片打标 / 点「最近使用」同样直接打标
    slotsEl.addEventListener("click", (e) => {
      const sec = e.target.closest("[data-sg]");
      if (sec) { toggleCwGroup(sec.dataset.sg); return; }
      const slot = e.target.closest(".uq-slot");
      if (slot && slot.dataset.tag) cwApplyTagToSelection(slot.dataset.tag);
    });
    // v0.23：选中图片后按 1-9 = 直接打「最近使用」里的标签，连续打标不用鼠标
    if (window.__cwKey) document.removeEventListener("keydown", window.__cwKey, true);
    window.__cwKey = (e) => {
      if (localStorage.getItem(TMGR_VIEW_KEY) !== "classify") return;
      if (document.querySelector(".modal-mask.open")) return;
      // v0.52：任何输入框 / 可编辑区域里打字时不抢按键
      if (isTypingTarget(e.target || document.activeElement)) return;
      if (!/^[1-9]$/.test(e.key)) return;
      const name = loadRecentTags()[Number(e.key) - 1];
      if (!name) return;
      e.preventDefault();
      cwApplyTagToSelection(name);
    };
    document.addEventListener("keydown", window.__cwKey, true);
  }
}
/* 主分类面板：高亮「选中图片共有的主分类」（v0.26） */
function cwSelCats() {
  const ids = [...cwSel];
  if (!ids.length) return [];
  const list = ids.map((id) => catsOf(PHOTOS.find((p) => p.id === id) || {}));
  if (!list.length) return [];
  return list.reduce((acc, cur) => acc.filter((c) => cur.includes(c)), list[0]);
}
function renderCwCats() {
  const wrap = document.getElementById("cwCats");
  if (!wrap) return;
  renderCatPicks(wrap, cwSelCats());
}
/* 给选中（或指定）图片设置 / 取消主分类（v0.26）
   mode: "toggle"（默认，全含则取消）| "add" | "remove" */
async function cwApplyCategory(name, mode = "toggle", idsArg) {
  if (!name) return;
  const ids = (idsArg && idsArg.length ? idsArg : [...cwSel]);
  if (!ids.length) { updateCwSelStatus("先在左侧点选图片，再点主分类即可设置（可多选后一次设）"); return; }
  const targets = ids.map((id) => PHOTOS.find((p) => p.id === id)).filter(Boolean);
  if (!targets.length) return;
  const allHave = targets.every((p) => catsOf(p).includes(name));
  const adding = mode === "add" ? true : mode === "remove" ? false : !allHave;
  const todo = targets.filter((p) => (adding ? !catsOf(p).includes(name) : catsOf(p).includes(name)));
  if (!todo.length) {
    updateCwSelStatus(`选中的图片都${adding ? "已经有" : "没有"}「${esc(name)}」主分类`);
    return;
  }
  try {
    await Promise.all(todo.map((p) => {
      const next = adding ? [...catsOf(p), name].slice(0, 6) : catsOf(p).filter((c) => c !== name);
      return apiFetch(`/api/photos/${p.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categories: next }),
      });
    }));
    todo.forEach((p) => {
      p.categories = adding ? [...catsOf(p), name].slice(0, 6) : catsOf(p).filter((c) => c !== name); // 本地同步
      updateCwCardBadge(p);
    });
    renderCwCats();
    updateCwSelStatus(`已${adding ? "设置" : "取消"}主分类「${esc(name)}」：<span class="cnt">${todo.length}</span> 张 · 可继续操作`);
    renderTagMenuContent();
    if (window.__renderGallery) window.__renderGallery();
  } catch (e) {
    updateCwSelStatus("设置主分类失败：" + esc(e.message));
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
  // v0.20：和管理页对齐——组折叠 + 搜索 + 最近使用，避免一次平铺几百个标签
  if (!cwOpenInited) {
    const first = TAGS.tags.find((x) => x.group && (TAGS.groups || []).some((g) => g.id === x.group));
    if (first) cwOpenGroups.add(first.group);
    cwOpenInited = true;
  }
  wrap.innerHTML = slotSectionsHTML((n) => counts[n] || 0, cwExtraSlots,
    "还没有分类。用下方输入框创建临时分类，或先到「分组」页建好标签库再回来。",
    { collapsible: true, openGroups: cwOpenGroups, recent: loadRecentTags(), query: cwSlotQuery });
}
/* 手风琴：展开某作品组时收起其他组 */
function toggleCwGroup(gid) {
  if (!gid) return;
  if (cwOpenGroups.has(gid)) cwOpenGroups.delete(gid);
  else { cwOpenGroups.clear(); cwOpenGroups.add(gid); }
  renderCwSlots();
}
/* 打标后只更新这一张卡片的角标与提示，避免整页重绘（v0.23 性能） */
function updateCwCardBadge(p) {
  const card = document.querySelector(`#cwCards .cw-card[data-id="${p.id}"]`);
  if (!card) return;
  const cats = catsOf(p);
  const tags = p.tags || [];
  const n = tags.length;
  card.classList.toggle("no-cat", cats.length === 0); // v0.26：未设主分类的卡片给个视觉提示
  let badge = card.querySelector(".cw-badge");
  if (!n) {
    if (badge) badge.remove();
  } else {
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "cw-badge";
      card.appendChild(badge);
    }
    badge.textContent = n;
  }
  card.title = [...cats.map((c) => `【${c}】`), ...tags].join(" · ") || "未分类、无标签";
}
/* 点分类槽 = 把该标签打到已选图片上（v0.20；v0.23 改为本地增量更新，可连续打标） */
async function cwApplyTagToSelection(tag) {
  if (!tag) return;
  const ids = [...cwSel];
  if (!ids.length) { updateCwSelStatus("先在左侧点选图片，再点分类槽即可打标（也可多选后一次打）"); return; }
  const todo = ids.map((id) => PHOTOS.find((p) => p.id === id))
    .filter((p) => p && !(p.tags || []).includes(tag));
  if (!todo.length) { updateCwSelStatus(`已选图片都已有「${esc(tag)}」标签`); return; }
  try {
    await Promise.all(todo.map((p) => apiFetch(`/api/photos/${p.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: [...new Set([...(p.tags || []), tag])].slice(0, 10) }),
    })));
    pushRecentTags(tag);
    todo.forEach((p) => {
      p.tags = [...new Set([...(p.tags || []), tag])].slice(0, 10); // 本地同步，不重拉
      updateCwCardBadge(p);
    });
    renderCwSlots(); // 槽上的计数跟着变
    updateCwSelStatus(`已给 <span class="cnt">${todo.length}</span> 张加上「${esc(tag)}」· 可继续点其他标签`);
    if (window.__renderGallery) window.__renderGallery();
  } catch (e) {
    updateCwSelStatus("打标失败：" + esc(e.message));
  }
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
    const cats = catsOf(p);
    const title = [...cats.map((c) => `【${c}】`), ...(p.tags || [])].join(" · ") || "未分类、无标签";
    return `<div class="cw-card${cwSel.has(p.id) ? " sel" : ""}${cats.length ? "" : " no-cat"}" data-id="${p.id}" draggable="true" title="${escAttr(title)}">
      <img loading="lazy" decoding="async" draggable="false" src="${cardImgSrc(p)}" alt="">
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

/* ---------- 逐张整理视图（v0.20）：一次只面对一张图，键盘流快速分类 ---------- */
let rvFilter = "todo"; // todo（缺主分类或没打过库内标签）| nocat | notag | all
let rvIds = [];
let rvIdx = 0;
let rvBusy = false;
/* v0.27：整理进度（localStorage 记已「应用」过的图片 id）
   原先的问题：默认筛选是「缺主分类 或 没有库内标签」，只设了主分类还没打标签的图
   应用后仍然符合条件，刷新后又回到待整理队列。现在「应用」过的会记下来并跳过，
   想重新过一遍可以点「重置进度」。 */
const RV_DONE_KEY = "rn_rv_done";
let rvDone = new Set();
function loadRvDone() {
  try {
    const a = JSON.parse(localStorage.getItem(RV_DONE_KEY) || "[]");
    rvDone = new Set(Array.isArray(a) ? a : []);
  } catch (e) { rvDone = new Set(); }
}
function saveRvDone() {
  try {
    const arr = [...rvDone].slice(-3000); // 上限 3000，超出丢最早的
    localStorage.setItem(RV_DONE_KEY, JSON.stringify(arr));
  } catch (e) { /* ignore */ }
}

function rvPickIds() {
  const hasLibTag = (p) => (p.tags || []).some((n) => tagByName(n));
  return PHOTOS.filter((p) => {
    if (rvFilter !== "all" && rvDone.has(p.id)) return false; // 整理过的先跳过（「全部」除外）
    const hasCat = catsOf(p).length > 0;
    if (rvFilter === "nocat") return !hasCat;
    if (rvFilter === "notag") return !(p.tags || []).length;
    if (rvFilter === "all") return true;
    return !hasCat || !hasLibTag(p);
  }).map((p) => p.id);
}

/* 「最近使用」快捷 chips：点一下加标签，数字键 1-9 同样可用 */
function rvRefreshQuick() {
  const wrap = document.getElementById("rvQuick");
  const box = document.getElementById("rvTagBox");
  if (!wrap || !box) return;
  const recent = loadRecentTags();
  if (!recent.length) {
    wrap.innerHTML = `<div class="qp-empty">最近还没用过标签；整理几张图后这里会出现快捷入口</div>`;
    return;
  }
  const used = new Set(tagsOfBox(box));
  wrap.innerHTML = recent.map((n, i) => `<span class="qp-item${used.has(n) ? " sel" : ""}" data-tag="${escAttr(n)}" title="快捷键 ${i + 1}">
    <span class="qp-num">${i + 1}</span>${esc(n)}</span>`).join("");
  wrap.querySelectorAll(".qp-item").forEach((el) => el.addEventListener("click", () => {
    const n = el.dataset.tag;
    if (used.has(n)) {
      [...box.querySelectorAll(".t")].forEach((c) => { if (c.childNodes[0].textContent.trim() === n) c.remove(); });
    } else addTagChip(box, n);
    rvRefreshQuick();
  }));
}

function rvRender() {
  const img = document.getElementById("rvImg");
  const meta = document.getElementById("rvMeta");
  const prog = document.getElementById("rvProgress");
  const hint = document.getElementById("rvHint");
  const box = document.getElementById("rvTagBox");
  if (!img || !meta || !prog) return;
  const p = PHOTOS.find((x) => x.id === rvIds[rvIdx]);
  if (!p) {
    img.removeAttribute("src");
    img.classList.add("rv-empty-img");
    meta.innerHTML = rvIds.length
      ? `🎉 这一轮 ${rvIds.length} 张都过完了<br><span class="rv-sub">换个筛选条件可以继续；点「分组」或「分类」返回</span>`
      : `这个筛选条件下没有需要整理的图片 🎉<br><span class="rv-sub">试试「全部」或先去上传一些图片</span>`;
    prog.textContent = rvIds.length
      ? `已完成 ${rvIds.length} / ${rvIds.length}${rvDone.size ? ` · 累计已整理 ${rvDone.size} 张` : ""}`
      : (rvDone.size
        ? `这批没有待整理项 · 累计已整理 ${rvDone.size} 张（需要重新过一遍就点右上「重置进度」）`
        : "没有待整理项");
    renderCatPicks(document.getElementById("rvCats"), []);
    if (box) box.querySelectorAll(".t").forEach((el) => el.remove());
    if (hint) hint.textContent = "";
    rvRefreshQuick();
    return;
  }
  img.classList.remove("rv-empty-img");  // v0.23 性能：先用缩略图秒开，再后台换成原图（切换图片不用等大图下载）
  const thumb = p.thumbUrl || p.url;
  img.src = thumb;
  if (p.url && p.url !== thumb) {
    const full = new Image();
    const targetId = p.id;
    full.onload = () => { if (rvIds[rvIdx] === targetId) img.src = p.url; };
    full.src = p.url;
  }
  // 顺手预取下一张的缩略图，切换更跟手
  const nextP = PHOTOS.find((x) => x.id === rvIds[rvIdx + 1]);
  if (nextP) { const pre = new Image(); pre.src = nextP.thumbUrl || nextP.url; }
  const cats = catsOf(p);
  meta.innerHTML = `<b>${esc(p.title || "未命名")}</b> · ${p.width}×${p.height} · ${fmtSize(p.size)} · ${fmtDate(p.uploadedAt)}`
    + (cats.length ? ` · 当前分类：${cats.map((c) => esc(c)).join("、")}` : ` · <span style="color:var(--danger)">当前未分类</span>`);
  prog.textContent = `第 ${rvIdx + 1} / ${rvIds.length} 张 · 还剩 ${rvIds.length - rvIdx} 张`
    + (rvDone.size ? ` · 本轮已整理 ${rvDone.size} 张` : "");
  renderCatPicks(document.getElementById("rvCats"), cats);
  if (box) {
    box.querySelectorAll(".t").forEach((el) => el.remove());
    (p.tags || []).forEach((n) => addTagChip(box, n));
    const inp = document.getElementById("rvTagInput");
    if (inp) inp.value = "";
  }
  if (hint) { hint.textContent = ""; hint.style.color = ""; }
  rvRefreshQuick();
}

async function rvApply() {
  if (rvBusy) return;
  const p = PHOTOS.find((x) => x.id === rvIds[rvIdx]);
  if (!p) return;
  const hint = document.getElementById("rvHint");
  const cats = selCatsOf(document.getElementById("rvCats"));
  const tags = tagsOfBox(document.getElementById("rvTagBox"));
  // v0.58：主分类 / 标签都不是硬性要求 —— 界面里已经预填了这张图原有的值，
  // 所以「空着提交」就是用户显式清空，不再拦。（v0.27 的「必须先选主分类」已撤销）
  rvBusy = true;
  try {
    const r = await apiFetch(`/api/photos/${p.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ categories: cats, tags }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || "保存失败");
    p.categories = cats; // 本地同步，免得每张都重拉全量
    p.tags = tags;
    pushRecentTags(tags.slice(-3));
    rvDone.add(p.id); // v0.27：记下"已整理"，刷新后不再回到待整理队列
    saveRvDone();
    if (window.__refreshGallery) { /* 图库墙下次筛选时用新数据 */ }
    rvIdx++;
    rvRender();
  } catch (e) {
    if (hint) { hint.style.color = "var(--danger)"; hint.textContent = "保存失败：" + e.message; }
  }
  rvBusy = false;
}
function rvSkip() { rvIdx++; rvRender(); }

function initReviewView(root) {
  loadRvDone(); // v0.27：读回整理进度（已应用过的不再重复出现）
  rvIds = rvPickIds();
  rvIdx = 0;
  rvRender();
  window.__rvState = () => ({ ids: [...rvIds], idx: rvIdx, done: [...rvDone], filter: rvFilter }); // 测试钩子
  const q = (sel) => root.querySelector(sel);
  const resetBtn = q("#rvReset");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      rvDone.clear();
      saveRvDone();
      rvIds = rvPickIds();
      rvIdx = 0;
      rvRender();
    });
  }
  const rvNewCatBtn = q("#rvNewCat");
  if (rvNewCatBtn) rvNewCatBtn.addEventListener("click", () => openCatModal("new-category"));
  const filters = q("#rvFilters");
  if (filters) {
    filters.querySelectorAll("[data-rvf]").forEach((b) => b.addEventListener("click", () => {
      rvFilter = b.dataset.rvf;
      refreshTagManager();
    }));
  }
  bindCatPicks(document.getElementById("rvCats"));
  bindTagSuggest(document.getElementById("rvTagInput"), document.getElementById("rvTagSuggest"), document.getElementById("rvTagBox"), rvRefreshQuick);
  const apply = q("#rvApply");
  const skip = q("#rvSkip");
  if (apply) apply.addEventListener("click", rvApply);
  if (skip) skip.addEventListener("click", rvSkip);

  // 键盘流：Enter 应用并下一张 / S 跳过 / 1-9 最近使用 / Esc 退出
  if (window.__rvKey) document.removeEventListener("keydown", window.__rvKey, true);
  window.__rvKey = (e) => {
    if (localStorage.getItem(TMGR_VIEW_KEY) !== "review") return;
    if (document.querySelector(".modal-mask.open")) return;
    // v0.52：焦点在「别的输入框」里时一律不抢按键（原先只排除了自己的输入框，
    // 导致设置页的密码框里打不了数字 / Enter 会被当成"应用并下一张"）
    const ae = document.activeElement;
    const inp = document.getElementById("rvTagInput");
    const inRvInput = !!(inp && ae === inp);
    const typingElsewhere = !inRvInput && isTypingTarget(ae); // v0.52
    if (typingElsewhere) return;
    const typing = inRvInput && inp.value.trim();
    if (e.key === "Enter") { e.preventDefault(); rvApply(); return; }
    if (e.key === "Escape") {
      localStorage.setItem(TMGR_VIEW_KEY, "group");
      document.removeEventListener("keydown", window.__rvKey, true);
      window.__rvKey = null;
      refreshTagManager();
      renderTagMenuContent();
      return;
    }
    if (typing) return;
    if (e.key === "s" || e.key === "S") { e.preventDefault(); rvSkip(); return; }
    if (/^[1-9]$/.test(e.key)) {
      const chips = [...document.querySelectorAll("#rvQuick .qp-item")];
      const el = chips[Number(e.key) - 1];
      if (el && el.dataset.tag) {
        addTagChip(document.getElementById("rvTagBox"), el.dataset.tag);
        rvRefreshQuick();
      }
      e.preventDefault();
    }
  };
  document.addEventListener("keydown", window.__rvKey, true);
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
        // v0.23：本地增量更新，拖完可以马上继续
        p.tags = merged;
        pushRecentTags(tag);
        updateCwCardBadge(p);
        renderCwSlots();
        if (window.__renderGallery) window.__renderGallery();
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
  renderAllUqRowTags();
}

/* 行发送的标签 = 该行自己的标签（v0.54：上传面板的全局标签与分类槽已移除） */
function rowSendTags(it) {
  return [...new Set(it.tags || [])].slice(0, 10);
}
function renderAllUqRowTags() {
  const queue = document.getElementById("queue");
  if (!queue) return;
  queue.querySelectorAll(".uq-item").forEach((rowEl) => {
    if (rowEl.__item) renderUqRowTags(rowEl.__item);
  });
}
/* 行 chips = 该行专属标签；全局标签见右侧输入（v0.54：上传不再选主分类） */
function renderUqRowTags(it) {
  const row = it.row;
  if (!row) return;
  const el = row.querySelector(".uq-tags");
  if (!el) return;
  const tags = it.tags || [];
  el.innerHTML = tags
    .map((n) => `<span class="cls" data-tag="${escAttr(n)}">${esc(n)}<i class="x" title="移除此标签">✕</i></span>`)
    .join("");
  el.querySelectorAll(".cls").forEach((c) => {
    c.addEventListener("click", (e) => {
      e.stopPropagation();
      const nm = c.dataset.tag;
      if (Array.isArray(it.tags)) {
        it.tags = it.tags.filter((x) => x !== nm);
        if (!it.tags.length) it.tags = undefined;
      }
      renderUqRowTags(it);
    });
  });
}
/* ---------- 最近使用标签（v0.16：角色多时的快捷入口，localStorage 记最近 10 个） ---------- */
const RECENT_TAGS_KEY = "rn_recent_tags";
function loadRecentTags() {
  try {
    const a = JSON.parse(localStorage.getItem(RECENT_TAGS_KEY) || "[]");
    return Array.isArray(a) ? a.filter(Boolean).slice(0, 10) : [];
  } catch (e) { return []; }
}
function pushRecentTags(names) {
  const list = (Array.isArray(names) ? names : [names]).filter(Boolean);
  if (!list.length) return;
  const cur = loadRecentTags().filter((n) => !list.includes(n));
  try { localStorage.setItem(RECENT_TAGS_KEY, JSON.stringify([...list, ...cur].slice(0, 10))); } catch (e) { /* ignore */ }
}
/* 槽列表 HTML（标签分类工作台用）：标签库按组 + 临时自定义槽 */
function slotSectionsHTML(countOf, extraSet, emptyTip, opts = {}) {
  const { collapsible = false, openGroups = null, recent = null, query = "" } = opts;
  const gmap = new Map();
  (TAGS.groups || []).forEach((g) => gmap.set(g.id, g));
  const grouped = new Map();
  TAGS.tags.forEach((t) => {
    const g = t.group && gmap.has(t.group) ? gmap.get(t.group) : null;
    const key = g ? g.id : "__none";
    if (!grouped.has(key)) grouped.set(key, { gid: g ? g.id : null, g, items: [] });
    grouped.get(key).items.push(t);
  });
  const sections = [];
  grouped.forEach(({ gid, g, items }) => sections.push({ gid, title: g ? g.name : "", color: g ? g.color : null, items }));
  const extras = extraSet && extraSet.size ? [...extraSet].map((n) => ({ name: n, extra: true, group: "" })) : [];
  if (extras.length) sections.push({ gid: null, title: "", color: null, items: extras });
  if (!sections.length) return `<div class="uq-empty-tip">${emptyTip || "还没有分类。"}</div>`;

  /* 单个槽：点一下 = 加到选中/全部待上传；也可拖图片进来 */
  const slotEl = (t, secColor, groupName) => {
    const c = t.color || secColor || "";
    const ct = countOf(t.name);
    return `<div class="uq-slot" data-tag="${escAttr(t.name)}" title="点一下 = 加到选中（未选则全部待上传）；也可把图片拖进来">
      ${c ? `<i class="dot" style="--tg:${c}"></i>` : `<i class="dot"></i>`}
      <span class="nm">${esc(t.name)}</span>${groupName ? `<span class="gsrc">${esc(groupName)}</span>` : ""}
      <span class="ct${ct ? " hot" : ""}">${ct || ""}</span>
    </div>`;
  };

  // 搜索模式：忽略折叠，扁平列出命中项（含拼音匹配），并标注所属组
  const kw = String(query || "").trim().toLowerCase();
  if (kw) {
    const hits = TAGS.tags.filter((t) => tagQueryMatch(t, kw));
    const extraHits = extras.filter((t) => t.name.toLowerCase().includes(kw));
    if (!hits.length && !extraHits.length) return `<div class="uq-empty-tip">没有匹配「${esc(query)}」的标签</div>`;
    return hits.map((t) => {
      const g = t.group ? gmap.get(t.group) : null;
      return slotEl(t, g ? g.color : null, g ? g.name : "");
    }).join("") + extraHits.map((t) => slotEl(t, null, "")).join("");
  }

  const parts = [];
  if (recent && recent.length) {
    parts.push(`<div class="uq-sec static"><i class="dot" style="--tg:var(--accent)"></i>${t("最近使用", "Recent")}</div>`);
    parts.push(recent.map((n) => slotEl({ name: n }, null, "")).join(""));
  }
  sections.forEach((sec) => {
    const head = sec.title
      ? `<div class="uq-sec${collapsible && sec.gid ? " clickable" : ""}${sec.gid && openGroups && openGroups.has(sec.gid) ? " open" : ""}"${collapsible && sec.gid ? ` data-sg="${escAttr(sec.gid)}" title="展开 / 收起该作品组"` : ""}>
          ${sec.color ? `<i class="dot" style="--tg:${sec.color}"></i>` : ""}${esc(sec.title)}
          ${collapsible && sec.gid ? `<span class="gcount">${sec.items.length}</span><span class="caret">▸</span>` : ""}
        </div>`
      : "";
    const open = !collapsible || !sec.gid || (openGroups && openGroups.has(sec.gid));
    parts.push(head + (open ? sec.items.map((it) => slotEl(it, sec.color, "")).join("") : ""));
  });
  return parts.join("");
}
/* 上传面板状态提示（v0.54：原分类槽状态行已移除，提示统一显示在底部 hint） */
function setUqStatus(msg) {
  const el = document.getElementById("upHint");
  if (el && msg) el.innerHTML = msg;
}
window.__refreshQuickPick = refreshQuickPickAll;


function closeTagModal() {
  const m = document.getElementById("tagModal");
  if (m) m.classList.remove("open");
}

/* ---------- 主分类弹窗（v0.15：新建 / 改名 / 删除，改名同步照片 category） ---------- */
function openCatModal(mode, payload) {
  const modal = document.getElementById("tagModal");
  const body = document.getElementById("tagModalBody");
  if (!modal || !body) return;

  /* ---- 删除确认 ---- */
  if (mode === "remove-category") {
    const name = payload;
    const n = PHOTOS.filter((p) => catsOf(p).includes(name)).length;
    body.innerHTML = `
      <h3>删除主分类「${esc(name)}」？</h3>
      <p>将把引用该分类的图片主分类<b>清空（变为未分类）</b>${n ? `（本次列表可见 ${n} 张）` : ""}。此操作不可恢复。</p>
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
        // v0.39：先本地删（界面立即响应），服务端失败则回滚
        removeCategoryLocally(name);
        refreshTagUI();
        if (window.__renderGallery) window.__renderGallery();
        try {
          await apiRemoveCategory(name);
        } catch (e) {
          await loadTags();
          refreshTagUI();
          if (window.__renderGallery) window.__renderGallery();
          throw e;
        }
        await apiSaveTags();         // v0.33：用本地配置覆盖服务端
        refreshTagUI();
        if (window.__renderGallery) window.__renderGallery();
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

  /* ---- 新建 / 改名表单 ---- */
  const target = mode === "edit-category" ? catByName(payload) : null;
  if (mode === "edit-category" && !target) return closeTagModal();
  const title = target ? "编辑主分类" : "新建主分类";
  const selColor = target ? target.color : null;
  body.innerHTML = `
    <h3>${title}</h3>
    <form class="tag-form" id="fForm" onsubmit="return false">
      <div class="field">
        <label>名称</label>
        <input type="text" id="fName" value="${escAttr(target ? target.name : "")}" maxlength="20" placeholder="如：像素 / 摄影">
        <div class="hint">${target ? "改名会同步更新所有图片的主分类" : "主分类是内容大类：可选、可多选，一张图也可以没有"}</div>
      </div>
      <div class="field">
        <label>颜色</label>${swatchHTML(selColor)}
      </div>
      <div class="m-actions">
        <button class="btn ghost" id="fCancel" type="button">取消</button>
        <button class="btn primary" id="fSave" type="button">保存</button>
      </div>
    </form>
    ${target ? `<div class="tag-modal-danger">
      <button class="btn danger sm" id="fDel" type="button">删除主分类</button>
    </div>` : ""}
    <div class="hint" id="fErr" style="color:var(--danger);display:none;margin-top:12px"></div>`;
  modal.classList.add("open");

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
  const fDelEl = body.querySelector("#fDel");
  if (fDelEl) fDelEl.onclick = () => openCatModal("remove-category", target.name);

  fSave.onclick = async () => {
    const name = fName.value.trim();
    if (!name) return showErr("名称不能为空");
    if (name === "未分类") return showErr("「未分类」是系统保留名，不能用作主分类");
    if (isReservedNameUI(name)) return showErr(`「${name}」是图库分级档位（大众级 / R16 / R18），不能用作主分类`);
    busy(fSave, "保存中…");
    try {
      if (target) {
        if (name !== target.name) {
          if (catByName(name)) { busy(fSave, null); return showErr(`主分类「${name}」已存在`); }
          const from = target.name;
          // v0.39：先本地改名并立即刷新界面（不再等服务端），失败则回滚
          renameCategoryLocally(from, name);
          const nt0 = catByName(name);
          if (nt0) nt0.color = color;
          refreshTagUI();
          if (window.__renderGallery) window.__renderGallery();
          try {
            await apiRenameCategory(from, name); // 后端同步照片
          } catch (e) {
            renameCategoryLocally(name, from);
            refreshTagUI();
            if (window.__renderGallery) window.__renderGallery();
            throw e;
          }
          const nt = catByName(name);
          if (nt) nt.color = color;
        } else {
          target.color = color;
        }
        await apiSaveTags();
        refreshTagUI();
        if (window.__renderGallery) window.__renderGallery();
      } else {
        if (catByName(name)) { busy(fSave, null); return showErr(`主分类「${name}」已存在`); }
        TAGS.categories.push({ id: "", name, color, sort: TAGS.categories.length });
        await apiSaveTags();
        refreshTagUI();
      }
      closeTagModal();
    } catch (err) {
      busy(fSave, null);
      showErr(err.message);
    }
  };
}

function swatchHTML(sel) {
  return `<div class="tag-swatches" id="fSwatches">
    <button type="button" class="tag-swatch none${!sel ? " on" : ""}" data-v="" title="默认"></button>
    ${SWATCHES.map((c) => `<button type="button" class="tag-swatch${sel === c ? " on" : ""}" data-v="${c}" style="background:${c}" title="${c}"></button>`).join("")}
  </div>`;
}

/* ---------- 批量导入标签（v0.16：粘贴名单一次建到指定组，如一次录入原神全部角色） ---------- */
function parseBulkTagLines(text) {
  const out = [];
  const seen = new Set();
  String(text || "").split(/\r?\n/).forEach((line) => {
    const parts = line.split(/[,，|｜]/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    const name = parts[0].slice(0, 30);
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ name, aliases: parts.slice(1, 21) });
  });
  return out;
}

function openBulkTagModal() {
  const modal = document.getElementById("tagModal");
  const body = document.getElementById("tagModalBody");
  if (!modal || !body) return;
  const defaultGroup = TAGS.groups.length ? TAGS.groups[0].id : "";
  body.innerHTML = `
    <h3>批量导入标签</h3>
    <form class="tag-form" id="fForm" onsubmit="return false">
      <div class="field">
        <label>导入到哪个组（角色请先建好作品组，如「原神」）</label>
        ${groupSelectHTML(defaultGroup)}
      </div>
      <div class="field">
        <label>标签名单（每行一个；可用逗号 / 竖线带别名）</label>
        <textarea id="biText" rows="9" placeholder="胡桃, 核桃, hutao&#10;甘雨, 椰羊&#10;纳西妲"></textarea>
        <div class="hint">首项为标签名，其余为别名（搜索与拼音匹配都会用上）；已存在的标签自动跳过。</div>
      </div>
      <div class="m-actions">
        <button class="btn ghost" id="fCancel" type="button">取消</button>
        <button class="btn primary" id="fSave" type="button">导入</button>
      </div>
    </form>
    <div class="hint" id="fErr" style="color:var(--danger);display:none;margin-top:12px"></div>`;
  modal.classList.add("open");
  body.querySelector("#fCancel").onclick = closeTagModal;
  const err = body.querySelector("#fErr");
  body.querySelector("#fSave").onclick = async () => {
    const btn = body.querySelector("#fSave");
    const rows = parseBulkTagLines(body.querySelector("#biText").value);
    if (!rows.length) {
      err.style.display = "block";
      err.style.color = "var(--danger)";
      err.textContent = "没有解析到标签：请每行写一个标签名";
      return;
    }
    const gid = body.querySelector("#fGroup").value || "";
    btn.disabled = true;
    btn.textContent = "导入中…";
    try {
      const exist = new Set(TAGS.tags.map((t) => t.name));
      let skipped = 0;
      let added = 0;
      rows.forEach((r) => {
        if (exist.has(r.name)) { skipped++; return; }
        exist.add(r.name);
        TAGS.tags.push({ id: "", name: r.name, aliases: r.aliases, group: gid, color: null, sort: TAGS.tags.length });
        added++;
      });
      await apiSaveTags();
      refreshTagUI();
      btn.disabled = false;
      btn.textContent = "导入";
      if (!added) {
        err.style.display = "block";
        err.style.color = "var(--text-faint)";
        err.textContent = `这 ${skipped} 个标签都已存在，无需导入`;
        return;
      }
      const g = TAGS.groups.find((x) => x.id === gid);
      closeTagModal();
      alert(`已导入 ${added} 个标签${g ? `到「${g.name}」组` : "（未分组）"}${skipped ? `，跳过 ${skipped} 个已存在的` : ""}`);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "导入";
      err.style.display = "block";
      err.style.color = "var(--danger)";
      err.textContent = e.message;
    }
  };
}

function groupSelectHTML(sel) {
  return `<select id="fGroup">
    <option value=""${!sel ? " selected" : ""}>未分组</option>
    ${TAGS.groups.map((g) => `<option value="${escAttr(g.id)}"${g.id === sel ? " selected" : ""}>${esc(g.name)}</option>`).join("")}
  </select>`;
}

/* 标签 / 标签组编辑弹窗。payload：标签名或组 id
   v0.30：新增 presetGroup —— 从某个组头旁的「＋」进来时，直接把所属组预选好 */
function openTagModal(mode, payload, presetName, presetGroup) {
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
        // v0.39：先本地删（界面立即响应），服务端失败则回滚
        removeTagLocally(name);
        refreshTagUI();
        if (window.__renderGallery) window.__renderGallery();
        try {
          await apiRemoveTag(name);
        } catch (e) {
          await loadTags(); // 回滚：拉回服务端真实配置
          refreshTagUI();
          if (window.__renderGallery) window.__renderGallery();
          throw e;
        }
        await apiSaveTags();    // v0.33：用本地（已删）的完整配置覆盖服务端，避免读延迟把标签带回来
        refreshTagUI();
        if (window.__renderGallery) window.__renderGallery();
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
  const selGroup = target ? (target.group || "") : (presetGroup || "");
  const presetGroupName = presetGroup ? ((TAGS.groups.find((g) => g.id === presetGroup) || {}).name || "") : "";
  const selColor = target ? (target.color || (target.group ? tagGroupColor(target.group) : null)) : null;
  const title = (isGroup ? (target ? "编辑标签组" : "新建标签组") : (target ? "编辑标签" : "新建标签"))
    + (!target && presetGroupName ? `　→　「${presetGroupName}」组` : ""); // v0.30：从组头「＋」进来时标明目标组

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
    // v0.57：r18 / r16 是图库分级档位，别在标签库里建同名标签（组名不受影响，不拦）
    if (!isGroup && isReservedNameUI(name)) {
      return showErr(`「${name}」是图库分级档位（大众级 / R16 / R18），不能作为标签名 —— 分级请在图片编辑里设置`);
    }
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
            const from = target.name;
            // v0.39：先本地改名并立即刷新界面（不再等服务端），失败则回滚
            renameTagLocally(from, name);
            const nt0 = tagByName(name);
            if (nt0) { nt0.color = color; nt0.group = gid; nt0.aliases = aliases; }
            refreshTagUI();
            if (window.__renderGallery) window.__renderGallery();
            try {
              await apiRenameTag(from, name); // 后端同步照片引用（名称即引用键）
            } catch (e) {
              renameTagLocally(name, from); // 回滚本地改名
              refreshTagUI();
              if (window.__renderGallery) window.__renderGallery();
              throw e;
            }
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
      // v0.31：改名 / 删除一律本地即时刷新，不再 loadData 重读（避开 Blobs 写后读延迟）
      refreshTagUI();
      if (window.__renderGallery) window.__renderGallery();
      closeTagModal();
    } catch (err) {
      busy(fSave, null);
      showErr(err.message);
    }
  };
}

/* ---------- 外观设置（v0.11.1）：主题（浅/深/跟随系统） + 瀑布流列宽 ---------- */
const THEME_KEY = "rn_theme";
/* v0.23 性能模式：关掉毛玻璃（backdrop-filter）与大部分过渡动画。
   图库很大或设备较弱时，这是最见效的一档开关；尽早生效避免首屏闪烁 */
const PERF_KEY = "rn_perf_lite";
function applyPerfLite(on) {
  document.body.classList.toggle("perf-lite", !!on);
  if (on) document.documentElement.setAttribute("data-perf", "lite");
  else document.documentElement.removeAttribute("data-perf");
  if (on) setTimeout(() => { try { initImgRelease(); } catch (e) { /* ignore */ } }, 0); // v0.25 回收屏外图片
}
try { if (localStorage.getItem(PERF_KEY) === "1") applyPerfLite(true); } catch (e) { /* ignore */ }
const COLS_KEY = "rn_cols";

/* ---------- 展示方式：瀑布流 / 正方形网格（v0.46） ----------
   正方形模式给 #grid 加 .grid-square，CSS 把多列瀑布流换成等比方格网格
   （像手机相册那样排列）；选择记在 localStorage，刷新后保持。 */
const LAYOUT_KEY = "rn_layout";
function layoutMode() {
  try { return localStorage.getItem(LAYOUT_KEY) === "square" ? "square" : "masonry"; } catch (e) { return "masonry"; }
}
function applyLayout() {
  const grid = document.getElementById("grid");
  const square = layoutMode() === "square";
  if (grid) grid.classList.toggle("grid-square", square);
  const btn = document.getElementById("fabLayoutBtn");
  if (btn) {
    btn.title = square ? "切换为瀑布流展示" : "切换为正方形网格展示";
    btn.classList.toggle("on", square);
    const g = btn.querySelector(".ico-square");
    const m = btn.querySelector(".ico-masonry");
    if (g) g.style.display = square ? "" : "none";
    if (m) m.style.display = square ? "none" : "";
  }
  // 方格一屏能放更多张 → 让图库把视口补满（沿用 v0.26 的补足逻辑）
  if (window.__fillViewport) window.__fillViewport();
}
function initLayoutSwitch() {
  const btn = document.getElementById("fabLayoutBtn");
  if (btn && btn.dataset.bound !== "1") {
    btn.dataset.bound = "1";
    btn.addEventListener("click", (e) => {
      e.stopPropagation(); // 别让 FAB 主按钮把分支收起来
      try { localStorage.setItem(LAYOUT_KEY, layoutMode() === "square" ? "masonry" : "square"); } catch (err) { /* ignore */ }
      applyLayout();
      // v0.54：日期分段只在方格模式出现 → 切换布局后必须重渲染，否则分组头会残留 / 缺失
      if (window.__renderGallery) window.__renderGallery();
    });
  }
  applyLayout();
}

function applyTheme(pref) {
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  const resolved = pref === "auto" ? (mq.matches ? "light" : "dark") : pref;
  document.documentElement.setAttribute("data-theme", resolved);
  document.documentElement.style.colorScheme = resolved;
  return resolved;
}

function initAppearance() {
  // 性能模式开关（v0.23）
  const perfBox = document.getElementById("perfLite");
  const perfOn = localStorage.getItem(PERF_KEY) === "1";
  applyPerfLite(perfOn);
  if (perfBox) {
    perfBox.checked = perfOn;
    perfBox.addEventListener("change", () => {
      localStorage.setItem(PERF_KEY, perfBox.checked ? "1" : "0");
      applyPerfLite(perfBox.checked);
    });
  }

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

  /* ---------- 图库统计（v0.54：真实总占用 + 明细 + 配额条） ---------- */
  const fmtBytes = (b) => {
    if (!b) return "0 KB";
    if (b >= 1e9) return (b / 1e9).toFixed(2) + " GB";
    if (b >= 1e6) return (b / 1e6).toFixed(1) + " MB";
    return Math.round(b / 1e3) + " KB";
  };
  function renderStats(d) {
    const count = (d && d.count) || 0;
    const bytes = (d && d.bytes) || 0;
    const quota = (d && d.quota) || 0;
    stPhotos.textContent = count + " 张";
    stUsed.textContent = fmtBytes(bytes) + (d && d.keys ? `（${d.keys} 个文件）` : "");
    // 明细：原图 / 缩略图 / 数据与配置
    const bd = document.getElementById("stBreakdown");
    if (bd) {
      const k = (d && d.byKind) || {};
      const parts = [];
      if (k.img) parts.push(`原图 ${fmtBytes(k.img)}`);
      if (k.thumb) parts.push(`缩略图 ${fmtBytes(k.thumb)}`);
      const rest = (k.meta || 0) + (k.idx || 0) + (k.other || 0);
      if (rest) parts.push(`数据/其他 ${fmtBytes(rest)}`);
      bd.textContent = parts.length ? parts.join(" · ") : "—";
    }
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
    txt.textContent = `${fmtBytes(bytes)} / ${(quota / 1e9).toFixed(2)} GB · ${pct.toFixed(2)}%`;
  }
  async function refreshStats() {
    // v0.54：直接请求 API（不再看 USE_API —— 那个标志在首屏数据到位前是 false，
    // 会让「先打开设置页」的人一直看到 0 张 / 0 KB）；只有 API 不可用才回退本地统计
    try {
      const res = await apiFetch("/api/meta/stats");
      const d = await res.json();
      renderStats(d);
      return;
    } catch (e) { /* API 不可用 → 回退本地统计 */ }
    const total = PHOTOS.reduce((s, p) => s + (p.size || 0), 0);
    renderStats({ count: PHOTOS.length, bytes: total, keys: PHOTOS.length, byKind: { img: total }, quota: 0 });
  }
  window.__refreshStats = refreshStats; // 打开设置页时刷新用
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
      if (catsOf(p).some((c) => String(c).toLowerCase().includes(keyword))) return true; // 主分类可搜（v0.15 / v0.19 多选）
      if (String(p.title || "").toLowerCase().includes(keyword)) return true;
      return p.tags.some((t) => t.toLowerCase().includes(keyword) || aliasNames.has(t));
    });
    count.hidden = false;
    count.textContent = `${t("找到", "Found")} ${list.length} ${t("张", "photos")}`;
    if (!list.length) {
      results.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="big"><svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg></div>没有找到与「${esc(q)}」相关的图片</div>`;
      return;
    }
    results.innerHTML = list.map((p) => `
      <div class="search-card" data-id="${p.id}">
        <img loading="lazy" decoding="async" src="${cardImgSrc(p)}" data-orig="${p.url}" alt="${escAttr(p.title)}" onerror="this.onerror=null;this.src=this.dataset.orig">
        <div class="t">${catChipsOf(p, 2)}${p.tags.length ? p.tags.slice(0, 2).map(tagChip).join(" / ") : ""}</div>
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
  /* 访问密码门禁（v0.16）：启用了密码且本机没有凭证时，先登录、不加载任何数据 */
  const __auth = await fetchAuthState();
  if (__auth.gate && !gateToken() && !guestVisiting()) { showGate(); return; }
  // v0.49：观光访客（没输密码点了「以观光模式浏览」）→ 固定为观光模式
  if (__auth.gate && !gateToken() && guestVisiting()) {
    try { localStorage.setItem(MODE_KEY, "guest"); } catch (e) { /* ignore */ }
  }
  initMode();          // v0.49：观光 / 管理员模式（必须在加载数据前定好，观光模式要过滤成人向图片）
  initModeModal();
  initPageSwitch();
  initGallery();
  initLayoutSwitch(); // v0.46：瀑布流 / 正方形网格切换（图库初始化后立即应用，避免闪一下）
  initSearch();
  initUpload();
  initSettings();
  initAuthSettings();
  initAppearance();
  initSelection();
  initSortMenu();
  initEditModal();
  initLightboxTools(); // v0.38：灯箱右下角悬浮工具条 + 幻灯片
  initLightboxNav();   // v0.43：点击左右区域 / 左右滑动切换
  initSlideSetting();
  initDupFinder(); // v0.42：库内重复 / 相似图片扫描
  initUqModal();
  initImportUrl();
  initBatchFav();
  initAlbumPage(); // v0.34：相册整页（FAB 相册按钮 / 右边缘左滑进入）
  initLogsUI();
  initWmSettings();
  initLang();
  initFabHold();

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
  await Promise.all([loadData(), loadTags()]);
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
    // v0.49 观光模式：上传 / 标签管理 / 设置都不给开（搜索只读，放行）
    // v0.51 整理模式：额外允许打开标签管理（窗口内部只会显示「整理」视图）
    const allowed = isAdmin() || (isTagger() && page === "tags") || page === "search";
    if (!allowed) {
      guestBlocked(page === "upload" ? "上传图片" : page === "tags" ? "管理标签" : "打开设置");
      return;
    }
    // v0.51：标签管理按当前模式重新渲染（整理模式只显示「整理」视图）
    if (page === "tags" && window.__refreshTagManager) window.__refreshTagManager();
    // v0.54：每次打开设置页都刷新一次图库统计（否则只在初始化时拉过一次，数据一变就过期）
    if (page === "settings" && window.__refreshStats) window.__refreshStats();
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
    // v0.54：上传窗口里还有没传完的图片 → 先提醒一句，用户取消就不关
    if (page === "upload") {
      const pending = window.__uploadPendingCount ? window.__uploadPendingCount() : 0;
      if (pending && !window.confirm(`还有 ${pending} 张图片没有上传完成，关闭窗口会清空列表并取消上传，确定关闭吗？`)) return;
      if (window.__clearUploadQueue) window.__clearUploadQueue();
    }
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
  // v0.34：FAB 上方的相册按钮 —— 打开独立相册整页（左滑进入的页面）
  const fabAlbumsBtn = document.getElementById("fabAlbumsBtn");
  if (fabAlbumsBtn) {
    fabAlbumsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (selectMode) exitSelectMode();
      const tm = document.getElementById("tagMenu");
      const fb = document.getElementById("fabBtn");
      if (tm) tm.classList.remove("open");
      if (fb) fb.classList.remove("open");
      pageMenu.classList.remove("open");
      fabPageBtn.classList.remove("open");
      flyoutOpenCount = 0;
      syncFabGroup();
      openAlbumPage();
    });
  }

  // 返回按钮与红点关闭
  Object.entries(panels).forEach(([id]) => {
    btnBack[id].addEventListener("click", () => closeWindow(id));
    btnClose[id].addEventListener("click", () => closeWindow(id));
  });

  // ===== 交通灯 macOS 语义（v0.14.7）：红=关闭（上方已绑）黄=最小化 绿=全屏 =====
  const minimized = new Set();
  const dockMeta = {
    upload: { label: "上传图片", color: "#ff9f0a" },
    settings: { label: "设置", color: "#0a84ff" },
    search: { label: "搜索", color: "#30d158" },
    tags: { label: "标签管理", color: "#bf5af2" },
  };
  const dockBar = document.getElementById("dockBar");
  function renderDock() {
    if (!dockBar) return;
    if (!minimized.size) { dockBar.hidden = true; dockBar.innerHTML = ""; return; }
    dockBar.hidden = false;
    dockBar.innerHTML = [...minimized].map((p) => {
      const m = dockMeta[p] || { label: p, color: "#8e8e93" };
      return `<button class="dock-item" data-page="${p}" style="--dcol:${m.color}" title="恢复「${m.label}」">${esc(m.label)}</button>`;
    }).join("");
    dockBar.querySelectorAll(".dock-item").forEach((b) => b.addEventListener("click", () => openWindow(b.dataset.page)));
  }
  // 菜单 / 快捷键直接打开已最小化窗口时：解除最小化
  const baseOpenWindow = openWindow;
  openWindow = (page) => {
    if (minimized.has(page)) { minimized.delete(page); renderDock(); }
    baseOpenWindow(page);
  };
  window.__openWindow = openWindow;
  // 黄点 = 最小化到 Dock（最小化时若处于全屏先还原为普通窗口）
  document.querySelectorAll(".page-panel .traffic .yellow").forEach((yel) => {
    yel.style.cursor = "pointer";
    yel.title = "最小化（收到底部 Dock）";
    yel.addEventListener("click", () => {
      const found = Object.entries(panels).find(([, el]) => el === yel.closest(".page-panel"));
      if (!found || !openStack.includes(found[0])) return;
      const id = found[0];
      if (minimized.has(id)) return;
      panels[id].classList.remove("maximized");
      minimized.add(id);
      renderDock();
      closeWindow(id);
    });
  });
  // 绿点 = 全屏（铺满整个页面）/ 还原
  document.querySelectorAll(".page-panel .traffic .green").forEach((gre) => {
    gre.style.cursor = "pointer";
    gre.title = "全屏（铺满页面）";
    gre.addEventListener("click", () => {
      const panel = gre.closest(".page-panel");
      if (!panel) return;
      const on = panel.classList.toggle("maximized");
      gre.title = on ? "退出全屏" : "全屏（铺满页面）";
    });
  });
}
