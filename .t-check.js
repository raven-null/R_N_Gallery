const BASE = "https://r-gallery.netlify.app";
(async () => {
  // 1) 首页 HTML：看资源版本号、是否残留 guest gate
  const html = await fetch(BASE + "/").then((r) => r.text());
  const ver = [...html.matchAll(/\?v=(\d+)/g)].map((m) => m[1]);
  console.log("HTML 资源版本:", ver.join(","));
  console.log("HTML 含 guest gate:", html.includes("guestGate"));
  console.log("HTML 引用 pinyin CDN:", html.includes("cdn.jsdelivr.net"));
  // 2) app.js 抓取检查
  const js = await fetch(BASE + "/assets/app.js?v=20260926").then((r) => r.text());
  console.log("app.js 长度:", js.length);
  console.log("app.js 含 guest:", js.includes("guestGate"));
  console.log("app.js 含 initFabHold:", js.includes("initFabHold"));
  // 3) API 快速自检
  const photos = await fetch(BASE + "/api/photos?limit=1").then((r) => r.json());
  console.log("API photos 正常:", photos.photos.length === 1, "|", photos.photos[0] && photos.photos[0].title);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
