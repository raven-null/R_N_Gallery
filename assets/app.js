/* ============================================================
   图库设计稿 · 共享脚本（纯前端演示，无后端依赖）
   占位图用内联 SVG 生成，真实部署时替换为 /api/photos 数据源
   ============================================================ */

"use strict";

/* ---------- 假数据 ---------- */

const TITLES = [
  "海边日落", "城市夜景", "老巷咖啡", "山间晨雾", "周末厨房", "雨后的窗",
  "街角书店", "海风与灯塔", "银杏大道", "巷口猫", "深夜面馆", "山顶云海",
  "江边晚风", "夏日冰饮", "老城建筑", "湖畔倒影", "雪后初晴", "旧相机",
  "骑行山道", "阳台多肉", "远方的火车", "夜市灯火", "森林小径", "海边栈道",
  "咖啡馆一角", "黄昏剪影", "野餐时光", "地铁站台", "书桌一角", "花店门口",
  "湖心小舟", "秋日落叶", "清晨集市", "天台远眺", "雨中伞影", "公路尽头",
];

const TAG_POOL = ["风景", "城市", "旅行", "美食", "日常", "夜景", "建筑", "植物"];
const MONTHS = ["2025-01", "2025-02", "2025-03", "2025-04", "2025-05", "2024-12", "2024-11"];

const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (arr) => arr[rnd(0, arr.length - 1)];

function buildSVG(seed, w, h, label) {
  const hue1 = seed * 47 % 360;
  const hue2 = (hue1 + rnd(30, 140)) % 360;
  const shapes = [];
  const n = 3 + (seed % 3);
  for (let i = 0; i < n; i++) {
    const cx = rnd(5, 95), cy = rnd(5, 95), r = rnd(8, 40);
    shapes.push(`<circle cx="${cx}%" cy="${cy}%" r="${r}%" fill="rgba(255,255,255,0.08)"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue1},55%,38%)"/>
      <stop offset="1" stop-color="hsl(${hue2},60%,24%)"/>
    </linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/>
    ${shapes.join("")}
    <text x="50%" y="50%" fill="rgba(255,255,255,0.5)" font-family="sans-serif" font-size="${Math.round(w / 14)}" text-anchor="middle" dominant-baseline="middle">${label}</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const IMAGES = [
  "image/103743220_p0_master1200.webp",
  "image/104715039_p0_master1200.webp",
  "image/106832400_p0_master1200.webp",
  "image/107284494_p0_master1200.webp",
  "image/110880036_p0_master1200.webp",
  "image/112060560_p0_master1200.webp",
  "image/112110860_p0_master1200.webp",
  "image/114080166_p0_master1200.webp",
  "image/114326435_p0_master1200.webp",
  "image/115489667_p0_master1200.webp",
  "image/115490125_p0_master1200.webp",
  "image/115540271_p0_master1200.webp",
  "image/115544568_p0_master1200.webp",
  "image/115577390_p0_master1200.webp",
  "image/115587250_p0_master1200.webp",
  "image/115601436_p0_master1200.webp",
  "image/115644653_p0_master1200.webp",
  "image/115659964_p0_master1200.webp",
  "image/115668587_p0_master1200.webp",
  "image/115675233_p0_master1200.webp",
  "image/115751416_p0_master1200.webp",
  "image/115769965_p0_master1200.webp",
  "image/115878114_p0_master1200.webp",
  "image/115898679_p0_master1200.webp",
  "image/115908961_p0_master1200.webp",
  "image/115952650_p0_master1200.webp",
  "image/115984241_p0_master1200.webp",
  "image/116056187_p0_master1200.webp",
  "image/116168231_p0_master1200.webp",
  "image/116175351_p0_master1200.webp",
  "image/116181131_p0_master1200.webp",
  "image/116215975_p0_master1200.webp",
  "image/116217936_p0_master1200.webp",
  "image/116238756_p0_master1200.webp",
  "image/116238756_p1_master1200.webp",
  "image/116330656_p0_master1200.webp",
  "image/116397559_p0_master1200.webp",
  "image/116466034_p0_master1200.webp",
  "image/116492383_p0_master1200.webp",
  "image/116492383_p1_master1200.webp",
  "image/116496284_p0_master1200.webp",
  "image/116497871_p0_master1200.webp",
  "image/116501438_p0_master1200.webp",
  "image/116525574_p0_master1200.webp",
  "image/116539963_p0_master1200.webp",
  "image/116559973_p0_master1200.webp",
  "image/116567805_p0_master1200.webp",
  "image/116584300_p0_master1200.webp",
  "image/116588422_p0_master1200.webp",
  "image/116603756_p0_master1200.webp",
  "image/116774710_p0_master1200.webp",
  "image/116777017_p0_master1200.webp",
  "image/116790581_p0_master1200.webp",
  "image/116796629_p0_master1200.webp",
  "image/116797937_p0_master1200.webp",
  "image/116800090_p0_master1200.webp",
  "image/116804976_p0_master1200.webp",
  "image/116828226_p0_master1200.webp",
  "image/116829611_p0_master1200.webp",
  "image/116831971_p0_master1200.webp",
  "image/116846172_p0_master1200.webp",
  "image/116854370_p0_master1200.webp",
  "image/116863286_p0_master1200.webp",
  "image/116888989_p0_master1200.webp",
  "image/116895667_p0_master1200.webp",
  "image/116968693_p0_master1200.webp",
  "image/116977464_p0_master1200.webp",
  "image/117047449_p0_master1200.webp",
  "image/117150093_p0_master1200.webp",
  "image/117249612_p0_master1200.webp",
  "image/117281955_p0_master1200.webp",
  "image/117287363_p0_master1200.webp",
  "image/117315975_p0_master1200.webp",
  "image/117421511_p0_master1200.webp",
  "image/117470112_p0_master1200.webp",
  "image/117513133_p0_master1200.webp",
  "image/117730389_p0_master1200.webp",
  "image/117747746_p0_master1200.webp",
  "image/117767872_p0_master1200.webp",
  "image/117779633_p0_master1200.webp",
  "image/117789763_p0_master1200.webp",
  "image/117891340_p0_master1200.webp",
  "image/117957082_p0_master1200.webp",
  "image/117967164_p0_master1200.webp",
  "image/117977916_p0_master1200.webp",
  "image/118051098_p0_master1200.webp",
  "image/118257715_p0_master1200.webp",
  "image/118689658_p0_master1200.webp",
  "image/118761695_p0_master1200.webp",
  "image/118937249_p0_master1200.webp",
  "image/118981245_p0_master1200.webp",
  "image/119042176_p0_master1200.webp",
  "image/119113171_p0_master1200.webp",
  "image/119213080_p0_master1200.webp",
  "image/119581897_p0_master1200.webp",
  "image/119920925_p0_master1200.webp",
  "image/120014999_p0_master1200.webp",
  "image/120260206_p0_master1200.webp",
  "image/120266467_p0_master1200.webp",
  "image/120901470_p0_master1200.webp",
  "image/121015371_p12_master1200.webp",
  "image/121052825_p0_master1200.webp",
  "image/121114329_p0_master1200.webp",
  "image/121140953_p0_master1200.webp",
  "image/121143568_p0_master1200.webp",
  "image/121173581_p0_master1200.webp",
  "image/121225345_p0_master1200.webp",
  "image/121691790_p0_master1200.webp",
  "image/121801936_p0_master1200.webp",
  "image/122368745_p0_master1200.webp",
  "image/122521132_p1_master1200.webp",
  "image/122614610_p0_master1200.webp",
  "image/122614610_p1_master1200.webp",
  "image/122614610_p2_master1200.webp",
  "image/122614610_p3_master1200.webp",
  "image/122614610_p4_master1200.webp",
  "image/122673888_p0_master1200.webp",
  "image/123109218_p0_master1200.webp",
  "image/123205450_p0_master1200.webp",
  "image/123480319_p0_master1200.webp",
  "image/123629759_p0_master1200.webp",
  "image/123696031_p0_master1200.webp",
  "image/123854361_p0_master1200.webp",
  "image/123854588_p0_master1200.webp",
  "image/123898111_p0_master1200.webp",
  "image/123931514_p0_master1200.webp",
  "image/124055136_p0_master1200.webp",
  "image/124329325_p0_master1200.webp",
  "image/124395768_p0_master1200.webp",
  "image/124406455_p0_master1200.webp",
  "image/124453293_p0_master1200.webp",
  "image/124494047_p0_master1200.webp",
  "image/124532264_p0_master1200.webp",
  "image/124556595_p0_master1200.webp",
  "image/124653368_p0_master1200.webp",
  "image/124770810_p0_master1200.webp",
  "image/124806633_p0_master1200 (2).webp",
  "image/124883841_p0_master1200.webp",
  "image/124909249_p0_master1200.webp",
  "image/124942797_p0_master1200.webp",
  "image/124988748_p0_master1200.webp",
  "image/125099803_p0_master1200.webp",
  "image/125155522_p0_master1200.webp",
  "image/125160586_p0_master1200.webp",
  "image/125311062_p0_master1200.webp",
  "image/125481247_p0_master1200.webp",
  "image/125550222_p0_master1200.webp",
  "image/125561141_p0_master1200.webp",
  "image/125679108_p0_master1200.webp",
  "image/125707008_p0_master1200.webp",
  "image/125754413_p0_master1200.webp",
  "image/125851598_p0_master1200.webp",
  "image/125911446_p0_master1200.webp",
  "image/125924741_p0_master1200.webp",
  "image/126071281_p2_master1200.webp",
  "image/126763820_p0_master1200.webp",
  "image/126871938_p0_master1200.webp",
  "image/126903769_p0_master1200.webp",
  "image/126947271_p0_master1200.webp",
  "image/127255874_p0_master1200.webp",
  "image/127329113_p0_master1200.webp",
  "image/128055432_p0_master1200.webp",
  "image/128071866_p0_master1200.webp",
  "image/128090986_p0_master1200.webp",
  "image/128195368_p0_master1200.webp",
  "image/128203650_p0_master1200.webp",
  "image/128325139_p0_master1200.webp",
  "image/128415002_p0_master1200.webp",
  "image/128470704_p0_master1200.webp",
  "image/128489052_p0_master1200.webp",
  "image/128869031_p0_master1200.webp",
  "image/128931173_p0_master1200.webp",
  "image/128942486_p0_master1200.webp",
  "image/128942486_p4_master1200.webp",
  "image/128942486_p5_master1200.webp",
  "image/128991245_p0_master1200.webp",
  "image/129002139_p0_master1200.webp",
  "image/129002139_p1_master1200.webp",
  "image/129131074_p0_master1200.webp",
  "image/129178283_p0_master1200.webp",
  "image/129189814_p0_master1200.webp",
  "image/129318088_p0_master1200.webp",
  "image/129338469_p0_master1200.webp",
  "image/129359297_p1_master1200.webp",
  "image/129464025_p0_master1200.webp",
  "image/129473158_p0_master1200.webp",
  "image/129565090_p0_master1200.webp",
  "image/129604111_p0_master1200.webp",
  "image/129686358_p0_master1200.webp",
  "image/129690227_p1_master1200.webp",
  "image/129691274_p1_master1200.webp",
  "image/129780217_p0_master1200.webp",
  "image/130007092_p0_master1200.webp",
  "image/130115462_p0_master1200.webp",
  "image/130151613_p0_master1200.webp",
  "image/130179977_p0_master1200.webp",
  "image/130243478_p0_master1200.webp",
  "image/130253899_p0_master1200.webp",
  "image/130263598_p1_master1200.webp",
  "image/130331442_p0_master1200.webp",
  "image/130396095_p4_master1200.webp",
  "image/130473468_p0_master1200.webp",
  "image/130821724_p0_master1200.webp",
  "image/130897625_p0_master1200.webp",
  "image/1712731386973.webp",
  "image/1717436233131.webp",
  "image/1741415484991c6164e199d312f0a626025effefb4fdd.webp",
  "image/1741415487461a46d2043c3b78f110ac7c538ac1e4c92.webp",
  "image/174141549031892cfc51be8f7e8b91fccf8753dedac7b.webp",
  "image/174141549204676e7b99c8d73fafc3e228d880028f210.webp",
  "image/17462886854960475b6d0f2f3a6ed5ad9d89918ed45b0980265843097ad0673563681ffe8fc90.0.webp",
  "image/1748407863540.webp",
  "image/1748407878857.webp",
  "image/20240506173111239523.webp",
  "image/92758904_p0_master1200.webp",
  "image/95351785_p0_master1200.webp",
  "image/98552343_p0_master1200.webp",
  "image/mmexport01de5757ddad05ebe3357e6f4b1fcc0f_1735.webp",
  "image/mmexport10191eb54b261097704241ca0881100b_1734.webp",
  "image/mmexport1981c3c819a6e5e5eeec5c1ac1b02a03_1734.webp",
  "image/mmexport29a4b521afce8acfd48226755d5462fe_1735.webp",
  "image/mmexport42076ac490d5d38a72407d8f458af6e7_1734.webp",
  "image/mmexport4e6ba8ccd0fba8c22675ea2b98063b96_1734.webp",
  "image/mmexport5399b2982e59962ccd9f28b093e7237c_1734.webp",
  "image/mmexport54b52fb5c65a7a99b2c4c7e95c94e822_1734.webp",
  "image/mmexport66497a25e0d5ed0881f7e9be9f10fd43_1733.webp",
  "image/mmexport6930af4003b21651a86ef3cfd5ccbfc8_1734.webp",
  "image/mmexport6d8cfb2618311e4eea37c25ac72f898f_1736.webp",
  "image/mmexport74fe7c86dfbac61febcb1c41d3e449b8_1734.webp",
  "image/mmexport85c1bf33a9bc3ee825a3cd87030ffc2e_1734.webp",
  "image/mmexport899578641df0c6495da3592373c40da5_1734.webp",
  "image/mmexport8e52cb7657cb1670b3735d81f09c38a1_1734.webp",
  "image/mmexporta982930f7721962fb8f87193762f5051_1735.webp",
  "image/mmexportab283236d9d9b66668e0c9ca93011b86_1734.webp",
  "image/mmexportc0823d3638d4dda2991453f72b2a5ab2_1734.webp",
  "image/mmexportc143ab643ec3b550a355a09f2d35916a_1734.webp",
  "image/mmexportc17bd2dbbf164da936f82954c1724fd9_1734.webp",
  "image/mmexportc41b7d68051fcd3ba4e72a5fbcfdfddc_1735.webp",
  "image/mmexportc623cc2d0d4a94a57670a28024271c5a_1734.webp",
  "image/mmexportd94e3cc6760817576fe16a1bcd806e3d_1734.webp",
  "image/mmexportdbc7480161c6dc4de2914417cfba39e5_1734.webp",
  "image/mmexporte9199566c618311ecb1b7b9479b5affe_1734.webp",
  "image/v2-34f3bb50afbd22088b3971ad5b4460ac_1440w.webp",
  "image/640.png",
  "image/148749850_p0_master1200.jpg",
  "image/143255789_p0_master1200.jpg",
];

/* ============================================================
   数据源（v0.9 整合版）：
   优先从 Netlify Blobs API（/api/photos）加载；API 不可用时
   回退到内置静态图片列表（本地 file:// 预览 / image/ 目录）
   ============================================================ */
let PHOTOS = [];
let USE_API = false;

const STATIC_PHOTOS = IMAGES.map((url, i) => {
  const id = "k" + (i + 1).toString(36) + rnd(100, 999).toString(36);
  const tags = new Set([pick(TAG_POOL), pick(TAG_POOL)]);
  const title = TITLES[i % TITLES.length];
  const month = MONTHS[i % MONTHS.length];
  return {
    id,
    title,
    desc: `${title} · 一组随手记录的生活片段`,
    tags: [...tags],
    takenAt: `${month}-${String(rnd(1, 28)).padStart(2, "0")}T${String(rnd(7, 21)).padStart(2, "0")}:${String(rnd(0, 59)).padStart(2, "0")}:00`,
    uploadedAt: `${month}-20T10:00:00Z`,
    size: rnd(900, 6200) * 1000,
    width: 800,
    height: rnd(420, 1000),
    mime: "image/jpeg",
    url,
  };
}).sort((a, b) => b.takenAt.localeCompare(a.takenAt));

async function loadData() {
  try {
    const res = await fetch("/api/photos?limit=200", { headers: apiHeaders() });
    if (!res.ok) throw new Error("api unavailable");
    const data = await res.json();
    if (data.photos && data.photos.length) {
      PHOTOS = data.photos.map((p) => ({ ...p, url: `/api/photos/${p.id}/raw` }));
      USE_API = true;
      return;
    }
  } catch (e) { /* 回退静态 */ }
  PHOTOS = [...STATIC_PHOTOS];
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

/* ---------- 通用：键盘快捷键 ---------- */
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement.tagName !== "INPUT") {
    // 打开搜索窗口并聚焦输入框
    e.preventDefault();
    if (window.__openWindow) window.__openWindow("search");
    setTimeout(() => document.getElementById("searchInput")?.focus(), 250);
  }
  if (e.key === "Escape") document.querySelectorAll(".lightbox.open, .modal-mask.open").forEach((el) => el.classList.remove("open"));
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
function openLightboxById(id) {
  const p = PHOTOS.find((x) => x.id === id);
  if (!p) return;
  document.getElementById("lbImg").src = p.url;
  document.getElementById("lbTitle").textContent = p.title;
  document.getElementById("lbDate").textContent = fmtDate(p.takenAt);
  document.getElementById("lbSize").textContent = fmtSize(p.size);
  document.getElementById("lbDims").textContent = `${p.width} × ${p.height}`;
  document.getElementById("lbFormat").textContent = p.mime.replace("image/", "").toUpperCase();
  document.getElementById("lbTags").innerHTML = p.tags.map((t) => `<span>${t}</span>`).join("");
  const lb = document.getElementById("lightbox");
  lb.classList.add("open");
  lb.dataset.cur = id;
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

/* ---------- 图库墙页 ---------- */
function initGallery() {
  const grid = document.getElementById("grid");
  const lightbox = document.getElementById("lightbox");
  const lbImg = document.getElementById("lbImg");

  // 标签弹出菜单（v0.8.4/0.8.6）：仅主要标签
  const fabBtn = document.getElementById("fabBtn");
  const fabDot = document.getElementById("fabDot");
  const tagMenu = document.getElementById("tagMenu");
  const tagMenuList = document.getElementById("tagMenuList");
  const tagFlyout = initFlyout(fabBtn, tagMenu);

  let activeTag = null;
  let shown = 0;
  const PAGE = 12;
  let filtered = [...PHOTOS];

  // 标签统计与列表：只渲染主要标签（数量 Top 8）+「全部」行
  const counts = {};
  PHOTOS.forEach((p) => p.tags.forEach((t) => { counts[t] = (counts[t] || 0) + 1; }));
  const topTags = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);

  const rowAll = document.createElement("button");
  rowAll.className = "tag-menu-item active";
  rowAll.innerHTML = `<span class="nm">全部</span><span class="cnt">${PHOTOS.length}</span>`;
  rowAll.onclick = () => {
    activeTag = null;
    [...tagMenuList.children].forEach((x) => x.classList.remove("active"));
    rowAll.classList.add("active");
    applyFilter();
    if (tagFlyout) tagFlyout.close();
  };
  tagMenuList.appendChild(rowAll);
  topTags.forEach(([tag, c]) => {
    const row = document.createElement("button");
    row.className = "tag-menu-item";
    row.innerHTML = `<span class="nm">${tag}</span><span class="cnt">${c}</span>`;
    row.onclick = () => {
      activeTag = activeTag === tag ? null : tag;
      [...tagMenuList.children].forEach((x) => x.classList.remove("active"));
      (activeTag ? row : rowAll).classList.add("active");
      applyFilter();
      if (tagFlyout) tagFlyout.close();
    };
    tagMenuList.appendChild(row);
  });

  // 标签筛选：点击标签过滤图库（搜索已独立为窗口，v0.8.6）
  function applyFilter() {
    shown = 0;
    filtered = PHOTOS.filter((p) => !activeTag || p.tags.includes(activeTag));
    fabDot.classList.toggle("on", !!activeTag);
    render();
  }

  function cardHTML(p) {
    return `<div class="card" data-id="${p.id}">
      <div class="tags">${p.tags.slice(0, 2).map((t) => `<span>${t}</span>`).join("")}</div>
      <img loading="lazy" src="${p.url}" alt="${p.title}">
      <div class="meta"><div class="t">${p.title}</div><div class="d">${fmtDate(p.takenAt)} · ${fmtSize(p.size)}</div></div>
    </div>`;
  }

  function render() {
    grid.innerHTML = "";
    const slice = filtered.slice(0, shown || PAGE);
    if (!slice.length) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="big">🖼️</div>没有匹配的图片<br>换个关键词试试</div>`;
      document.getElementById("loadMore").style.display = "none";
      return;
    }
    grid.innerHTML = slice.map(cardHTML).join("");
    shown = slice.length;
    document.getElementById("loadMore").style.display =
      shown < filtered.length ? "block" : "none";
    document.getElementById("loadMore").querySelector("span").textContent =
      shown < filtered.length ? `已加载 ${shown} / ${filtered.length}，滚动加载更多…` : `已全部加载（共 ${filtered.length} 张）`;
    grid.querySelectorAll(".card").forEach((c) => {
      c.onclick = () => openLightbox(c.dataset.id);
    });
    // 视口出现动画（刷新交错浮现 / 滚动触发）
    initReveal(grid, ".card");
  }

  // 无限滚动
  window.addEventListener("scroll", () => {
    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 300) {
      if (shown < filtered.length) { shown = Math.min(shown + PAGE, filtered.length); render(); }
    }
  });

  // 灯箱（全局实现 openLightboxById）
  const openLightbox = openLightboxById;
  document.querySelector(".lb-close").onclick = () => lightbox.classList.remove("open");
  document.querySelector(".lb-prev").onclick = () => step(-1);
  document.querySelector(".lb-next").onclick = () => step(1);
  function step(d) {
    const cur = lightbox.dataset.cur;
    const i = PHOTOS.findIndex((x) => x.id === cur);
    const next = PHOTOS[(i + d + PHOTOS.length) % PHOTOS.length];
    openLightbox(next.id);
  }
  document.addEventListener("keydown", (e) => {
    if (!lightbox.classList.contains("open")) return;
    if (e.key === "ArrowLeft") step(-1);
    if (e.key === "ArrowRight") step(1);
  });

  render();

  // 供上传/导入/清空后刷新图库（v0.9）
  window.__refreshGallery = () => {
    shown = 0;
    filtered = [...PHOTOS];
    render();
  };
}

/* ---------- 上传页 ---------- */
function initUpload() {
  const dz = document.getElementById("dz");
  const fileInput = document.getElementById("fileInput");
  const queue = document.getElementById("queue");
  const btnUpload = document.getElementById("btnUpload");
  const titleInput = document.getElementById("uploadTitle");
  const files = [];

  dz.addEventListener("click", () => fileInput.click());
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
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
        <img class="thumb" alt="">
        <div class="info">
          <div class="name">${f.name}</div>
          <div class="size">${fmtSize(f.size)} · ${f.type || "未知格式"}</div>
          <div class="sub">待上传 · 将自动压缩为 JPEG</div>
          <div class="progress"><div class="bar"></div></div>
        </div>
        <div class="status">待上传</div>`;
      const img = row.querySelector("img");
      const reader = new FileReader();
      reader.onload = (e) => { img.src = e.target.result; };
      reader.readAsDataURL(f);
      item.row = row;
      queue.appendChild(row);
    });
    btnUpload.disabled = !files.length;
  }

  // 浏览器端压缩：最长边 2048、JPEG 质量 0.85
  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, 2048 / Math.max(img.width, img.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve({ dataUrl: canvas.toDataURL("image/jpeg", 0.85), width: canvas.width, height: canvas.height });
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // 单张真实上传（v0.9：canvas 压缩 → XHR 带进度 → Blobs）
  function uploadOne(it) {
    return new Promise((resolve, reject) => {
      const row = it.row;
      const setSub = (t) => { row.querySelector(".sub").textContent = t; };
      const setPct = (p) => { row.querySelector(".bar").style.width = p + "%"; row.querySelector(".status").textContent = p + "%"; };
      setSub("客户端压缩中…");
      compressImage(it.f)
        .then(({ dataUrl }) => {
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
              setSub("已存入 Netlify Blobs");
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
          const tags = [...tagList.querySelectorAll(".t")].map((el) => el.childNodes[0].textContent.trim()).filter(Boolean);
          xhr.send(JSON.stringify({
            dataBase64: dataUrl,
            title: (titleInput && titleInput.value.trim()) || undefined,
            tags,
          }));
        })
        .catch((e) => {
          row.querySelector(".status").className = "status err";
          setSub("压缩失败");
          reject(e);
        });
    });
  }

  btnUpload.addEventListener("click", () => {
    btnUpload.disabled = true;
    const items = files.filter((it) => it.status === "ready");
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
          if (USE_API) {
            await loadData();
            if (window.__refreshGallery) window.__refreshGallery();
          }
        }
      }
    })();
  });

  // 标签输入
  const tagBox = document.getElementById("tagInputUpload");
  const tagList = document.getElementById("tagListUpload");
  tagBox.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && tagBox.value.trim()) {
      e.preventDefault();
      const t = tagBox.value.trim();
      const dup = [...tagList.querySelectorAll(".t")].some((el) => el.childNodes[0].textContent.trim() === t);
      if (!dup) {
        const el = document.createElement("span");
        el.className = "t";
        el.innerHTML = `${t}<button type="button" title="移除">×</button>`;
        el.querySelector("button").onclick = () => el.remove();
        tagList.insertBefore(el, tagBox);
      }
      tagBox.value = "";
    }
  });
}

/* ---------- 设置页（v0.9：接入真实 API） ---------- */
function initSettings() {
  // 访问令牌（存 localStorage，API 请求自动携带）
  const tokenInput = document.getElementById("tokenInput");
  if (tokenInput) {
    tokenInput.value = localStorage.getItem("rn_token") || "";
    tokenInput.addEventListener("change", () => {
      localStorage.setItem("rn_token", tokenInput.value.trim());
      tokenInput.value = tokenInput.value.trim();
    });
  }

  const usageBar = document.getElementById("usageBar");
  const usagePct = document.getElementById("usagePct");
  const stPhotos = document.getElementById("stPhotos");
  const stUsed = document.getElementById("stUsed");
  const stQuota = document.getElementById("stQuota");
  const monthBars = document.getElementById("monthBars");

  function renderStats(count, bytes, byMonth) {
    usageBar.style.width = "100%";
    usagePct.textContent = `${count} 张`;
    stPhotos.innerHTML = `<b>${count}</b>张图片`;
    stUsed.innerHTML = `<b>${(bytes / 1e6).toFixed(0)}</b>MB 已用`;
    stQuota.innerHTML = `<b>${USE_API ? "Blobs" : "本地"}</b>${USE_API ? "" : "演示"}数据源`;
    const entries = Object.entries(byMonth || {}).sort((a, b) => b[0].localeCompare(a[0]));
    const max = Math.max(1, ...entries.map(([, c]) => c));
    monthBars.innerHTML = entries.length
      ? entries.map(([m, c]) => `<div class="mb"><span>${m}</span><div class="track"><i style="width:${(c / max) * 100}%"></i></div><span class="cnt">${c} 张</span></div>`).join("")
      : "";
  }

  async function refreshStats() {
    if (USE_API) {
      try {
        const res = await apiFetch("/api/meta/stats");
        const d = await res.json();
        renderStats(d.count, d.bytes || 0, d.byMonth || {});
        return;
      } catch (e) { /* 回退本地统计 */ }
    }
    const total = PHOTOS.reduce((s, p) => s + (p.size || 0), 0);
    const byMonth = {};
    PHOTOS.forEach((p) => { const m = (p.takenAt || "").slice(0, 7); byMonth[m] = (byMonth[m] || 0) + 1; });
    renderStats(PHOTOS.length, total, byMonth);
  }
  refreshStats();

  // 标签管理（演示：本地统计）
  const counts = {};
  PHOTOS.forEach((p) => p.tags.forEach((t) => { counts[t] = (counts[t] || 0) + 1; }));
  const tagMgr = document.getElementById("tagMgr");
  tagMgr.innerHTML = Object.entries(counts).map(([t, c]) => `
    <span class="badge accent" style="margin:0 6px 8px 0;padding:5px 12px">${t} · ${c}
      <button onclick="this.parentElement.remove()" style="background:none;border:none;color:inherit;margin-left:6px;cursor:pointer">×</button>
    </span>`).join("");

  // 导入静态图片到 Blobs（v0.9）
  const btnImport = document.getElementById("btnImport");
  if (btnImport) {
    btnImport.onclick = async function () {
      const old = this.textContent;
      this.disabled = true;
      this.textContent = "导入中…";
      try {
        const res = await apiFetch("/api/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ files: IMAGES.map((f) => f.replace(/^image\//, "")) }),
        });
        const d = await res.json();
        this.textContent = `✓ 已导入 ${d.imported} 张${d.errors && d.errors.length ? `（失败 ${d.errors.length}）` : ""}`;
        if (d.imported) {
          await loadData();
          if (window.__refreshGallery) window.__refreshGallery();
          refreshStats();
        }
      } catch (e) {
        this.textContent = `✗ ${e.message}`;
      }
      setTimeout(() => { this.textContent = old; this.disabled = false; }, 2600);
    };
  }

  // 清空图库（真实调用）
  const modal = document.getElementById("wipeModal");
  document.getElementById("btnWipe").onclick = () => modal.classList.add("open");
  document.getElementById("btnConfirmWipe").onclick = async () => {
    modal.classList.remove("open");
    const b = document.getElementById("btnWipe");
    const old = b.textContent;
    b.disabled = true;
    b.textContent = "清空中…";
    if (USE_API) {
      try {
        const res = await apiFetch("/api/photos", { method: "DELETE" });
        const d = await res.json();
        b.textContent = `✓ 已清空 ${d.deleted || 0} 个 key`;
        await loadData();
        if (window.__refreshGallery) window.__refreshGallery();
        refreshStats();
      } catch (e) {
        b.textContent = `✗ ${e.message}`;
      }
      setTimeout(() => { b.textContent = old; b.disabled = false; }, 2600);
    } else {
      b.textContent = "✓ 本地模式无可清空";
      setTimeout(() => { b.textContent = old; b.disabled = false; }, 1600);
    }
  };
  document.getElementById("btnCancelWipe").onclick = () => modal.classList.remove("open");
  document.querySelectorAll(".modal .btn.ghost").forEach((x) => {
    x.onclick = () => x.closest(".modal-mask").classList.remove("open");
  });

  // 导出元数据（真实下载）
  document.getElementById("btnExport").onclick = async function () {
    const old = this.textContent;
    this.disabled = true;
    this.textContent = "导出中…";
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
      this.textContent = "✓ 已导出 export.json";
    } catch (e) {
      this.textContent = `✗ ${e.message}`;
    }
    setTimeout(() => { this.textContent = old; this.disabled = false; }, 2200);
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
    const list = PHOTOS.filter((p) =>
      (p.title + p.desc + p.tags.join("")).toLowerCase().includes(keyword)
    );
    count.hidden = false;
    count.textContent = `找到 ${list.length} 张`;
    if (!list.length) {
      results.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="big">🔍</div>没有找到与「${q}」相关的图片</div>`;
      return;
    }
    results.innerHTML = list.map((p) => `
      <div class="search-card" data-id="${p.id}">
        <img loading="lazy" src="${p.url}" alt="${p.title}">
        <div class="t">${p.title} · ${p.tags.slice(0, 2).join(" / ")}</div>
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

/* ---------- 分发（v0.9：先加载数据源再初始化） ---------- */
document.addEventListener("DOMContentLoaded", async () => {
  await loadData();
  initPageSwitch();
  initGallery();
  initSearch();
  initUpload();
  initSettings();
});

/* ---------- 页面窗口（v0.8）· 上传/设置以独立窗口层叠悬浮于图库上方 ---------- */
function initPageSwitch() {
  const fabPageBtn = document.getElementById("fabPageBtn");
  const pageMenu = document.getElementById("pageMenu");
  const panels = {
    upload: document.getElementById("panelUpload"),
    settings: document.getElementById("panelSettings"),
    search: document.getElementById("panelSearch"),
  };
  const btnBack = {
    upload: document.getElementById("btnBackUpload"),
    settings: document.getElementById("btnBackSettings"),
    search: document.getElementById("btnBackSearch"),
  };
  const btnClose = {
    upload: document.getElementById("closeUpload"),
    settings: document.getElementById("closeSettings"),
    search: document.getElementById("closeSearch"),
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

  // 页面菜单点击
  menuItems.forEach((item) => {
    item.addEventListener("click", () => {
      pageMenu.classList.remove("open");
      fabPageBtn.classList.remove("open");
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
