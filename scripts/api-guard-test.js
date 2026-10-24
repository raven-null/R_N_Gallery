#!/usr/bin/env node
/* ============================================================
   服务端标签 / 分级守卫测试（v0.57）
   覆盖四件事：
     1) 分级是独立字段：只有管理员能设，整理角色改不动（也写不进 tags）；
     2) 整理角色看不到非大众级：列表过滤 + raw 401；管理员读同一张 200；
     3) 分级与标签解耦后，**打标签再也不能解锁**（v0.55 之前删掉图上的 r18 标签即可解锁）；
     4) r18 / r16 是分级档位而非标签：不能作为标签 / 主分类新建或改名；
        存量写法「打 r18 标签」仍会折算成分级，但不会留在 tags 里。

   需要一个**带 ADMIN_TOKEN 启动**的本地 server（内存 Blobs，端口另开一个）：
     # 另开一个终端
     $env:PORT="8789"; $env:ADMIN_TOKEN="dsh-test-admin"; node scripts/dev-server.js
     node scripts/api-guard-test.js --url=http://localhost:8789 --admin=dsh-test-admin

   脚本自给自足：自己上传两张图、自己收尾（删图 / 清测试标签）。
   ============================================================ */
"use strict";

const sharp = require("sharp");

const argVal = (prefix, def) => {
  const a = process.argv.slice(2).find((x) => x.startsWith(prefix));
  return a ? a.slice(prefix.length) : def;
};
const BASE = argVal("--url=", process.env.GUARD_URL || "http://localhost:8789").replace(/\/+$/, "");
const ADMIN = argVal("--admin=", process.env.GALLERY_TOKEN || "dsh-test-admin");

let failed = 0;
const results = [];
function check(name, ok, extra = "") {
  results.push(ok);
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${name}${extra ? "　" + extra : ""}`);
}
async function req(path, { method = "GET", body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: Object.assign(
      { "Content-Type": "application/json" },
      token ? { "X-Auth-Token": token } : {}
    ),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* 可能是二进制响应 */ }
  return { status: res.status, data };
}
const png = (w, h, bg) => sharp({ create: { width: w, height: h, channels: 3, background: bg } }).png().toBuffer();
const dataUrl = (buf) => `data:image/png;base64,${buf.toString("base64")}`;
const hasR18Tag = (photo) => (photo.tags || []).some((t) => ["r18", "r16"].includes(String(t).trim().toLowerCase()));

(async () => {
  console.log(`\n› 服务端标签 / 分级守卫测试 → ${BASE}\n`);

  /* ---------- 0. 前置 ---------- */
  const login = await req("/api/auth/login", { method: "POST", body: { token: ADMIN } });
  const adminOK = login.status === 200 && login.data && login.data.role === "admin";
  check("管理员登录（role=admin）", adminOK, `HTTP ${login.status}`);
  if (!adminOK) {
    console.error("\n  ✗ 需要带 ADMIN_TOKEN 启动的 server：");
    console.error('    $env:PORT="8789"; $env:ADMIN_TOKEN="dsh-test-admin"; node scripts/dev-server.js\n');
    process.exit(1);
  }
  const adminT = ADMIN;

  // v0.59：整理模式已移除，设置整理密码的接口应当不存在了
  const taggerGone = await req("/api/auth/tagger", { method: "POST", token: adminT, body: { taggerKey: "x" } });
  check("整理密码接口已删除（404）", taggerGone.status === 404, `HTTP ${taggerGone.status}`);

  const upA = await req("/api/photos", {
    method: "POST", token: adminT,
    body: { dataBase64: dataUrl(await png(24, 24, { r: 10, g: 200, b: 90 })), title: "守卫测试 A", tags: ["守卫测试标签"], categories: ["插画"] },
  });
  const idA = upA.data && upA.data.photo && upA.data.photo.id;
  check("上传测试图 A", upA.status === 201 && !!idA, idA ? `id=${idA} rating=${upA.data.photo.rating}` : `HTTP ${upA.status}`);

  const upB = await req("/api/photos", {
    method: "POST", token: adminT,
    body: { dataBase64: dataUrl(await png(28, 20, { r: 200, g: 60, b: 30 })), title: "守卫测试 B", tags: [], categories: ["插画"] },
  });
  const idB = upB.data && upB.data.photo && upB.data.photo.id;
  check("上传测试图 B", upB.status === 201 && !!idB, idB ? `id=${idB}` : `HTTP ${upB.status}`);

  if (!idA || !idB) throw new Error("测试图准备失败");
  check("新上传的图默认是大众级", (upA.data.photo.rating || "") === "general", `rating=${upA.data.photo.rating}`);

  /* ---------- 1. 分级字段（管理员可设，三档） ---------- */
  const toR18 = await req(`/api/photos/${idA}`, { method: "PATCH", token: adminT, body: { rating: "r18" } });
  check("管理员可把图片设为 R18", toR18.status === 200 && toR18.data.photo.rating === "r18", `rating=${toR18.data && toR18.data.photo && toR18.data.photo.rating}`);

  const toR16 = await req(`/api/photos/${idB}`, { method: "PATCH", token: adminT, body: { rating: "r16" } });
  check("管理员可把图片设为 R16", toR16.status === 200 && toR16.data.photo.rating === "r16", `rating=${toR16.data && toR16.data.photo && toR16.data.photo.rating}`);

  const bogus = await req(`/api/photos/${idB}`, { method: "PATCH", token: adminT, body: { rating: "xxx" } });
  check("非法分级值被拒（400）", bogus.status === 400, `HTTP ${bogus.status} ${(bogus.data && bogus.data.error) || ""}`);

  const back = await req(`/api/photos/${idB}`, { method: "PATCH", token: adminT, body: { rating: "general" } });
  check("管理员可把分级降回大众级", back.status === 200 && back.data.photo.rating === "general", `rating=${back.data && back.data.photo && back.data.photo.rating}`);

  /* ---------- 2. 「打 r18 标签」的旧习惯：折算成分级，不进 tags ---------- */
  const legacy = await req(`/api/photos/${idB}`, { method: "PATCH", token: adminT, body: { tags: ["守卫测试标签", "r18"] } });
  check("旧写法「打 r18 标签」仍折算成 R18", legacy.status === 200 && legacy.data.photo.rating === "r18", `rating=${legacy.data && legacy.data.photo && legacy.data.photo.rating}`);
  check("r18 不会留在照片标签里", legacy.status === 200 && !hasR18Tag(legacy.data.photo), JSON.stringify(legacy.data && legacy.data.photo && legacy.data.photo.tags));

  /* ---------- 3. 观光 / 未登录视角 ---------- */
  // v0.59：只剩管理员与观光两种模式，未带凭证的请求一律按观光处理
  const listAnon = await req("/api/photos?limit=100&safe=1");
  check("未带凭证的列表不含非大众级图片", !!listAnon.data && !(listAnon.data.photos || []).some((p) => (p.rating || "general") !== "general"),
    `返回 ${((listAnon.data && listAnon.data.photos) || []).length} 张`);

  const rawAnon = await fetch(`${BASE}/api/photos/${idA}/raw`);
  check("未带凭证看不到 R18 原图（401）", rawAnon.status === 401, `HTTP ${rawAnon.status}`);

  const rawA = await fetch(`${BASE}/api/photos/${idA}/raw`, { headers: { "X-Auth-Token": adminT } });
  check("管理员能看 R18 原图（200）", rawA.status === 200, `HTTP ${rawA.status}`);

  const patchAnon = await req(`/api/photos/${idA}`, { method: "PATCH", body: { tags: ["x"] } });
  check("未带凭证不能写照片（401）", patchAnon.status === 401, `HTTP ${patchAnon.status}`);

  /* ---------- 4. safe=1（观光视角） ---------- */
  const safe = await req("/api/photos?limit=100&safe=1", { token: adminT });
  const safeHasAdult = (safe.data.photos || []).some((p) => (p.rating || "general") !== "general");
  check("safe=1 列表不含 R16 / R18", !safeHasAdult, `返回 ${((safe.data && safe.data.photos) || []).length} 张`);

  /* ---------- 5. r18 / r16 不能作为标签 / 主分类 ---------- */
  const cfg1 = await req("/api/tags", { token: adminT });
  const baseTags = (cfg1.data.tags || []).filter((t) => !/^r18$|^r16$/i.test(t.name));
  const putRes = await req("/api/tags", {
    method: "PUT", token: adminT,
    body: { categories: cfg1.data.categories, groups: cfg1.data.groups, tags: baseTags.concat([{ name: "r18", aliases: [], group: "", color: null, sort: 99 }]) },
  });
  check("r18 不能作为普通标签新建（PUT 400）", putRes.status === 400, `HTTP ${putRes.status} ${(putRes.data && putRes.data.error) || ""}`);

  const renRes = await req("/api/tags/rename", { method: "POST", token: adminT, body: { from: "守卫测试标签", to: "r18" } });
  check("标签不能改名为 r18（400）", renRes.status === 400, `HTTP ${renRes.status}`);

  const catRenRes = await req("/api/tags/category-rename", { method: "POST", token: adminT, body: { from: "插画", to: "r16" } });
  check("主分类不能改名为 r16（400）", catRenRes.status === 400, `HTTP ${catRenRes.status}`);

  /* ---------- 6. 改名保留旧名为别名 / 标签清洗 ---------- */
  const ren2 = await req("/api/tags/rename", { method: "POST", token: adminT, body: { from: "守卫测试标签", to: "守卫测试标签二号" } });
  const cfg2 = await req("/api/tags", { token: adminT });
  const moved = (cfg2.data.tags || []).find((t) => t.name === "守卫测试标签二号");
  check("改名后旧名进入别名（否则按旧名搜不到）", ren2.status === 200 && !!moved && (moved.aliases || []).includes("守卫测试标签"),
    moved ? JSON.stringify(moved.aliases) : `HTTP ${ren2.status}`);

  const clean = await req(`/api/photos/${idB}`, { method: "PATCH", token: adminT, body: { tags: ["重复标签", "重复标签", "b", "b", "  "] } });
  check("照片标签写入自动去重 / 去空", clean.status === 200 && JSON.stringify(clean.data.photo.tags) === JSON.stringify(["重复标签", "b"]), JSON.stringify(clean.data && clean.data.photo && clean.data.photo.tags));

  const longName = "超长".repeat(30);
  const trunc = await req(`/api/photos/${idB}`, { method: "PATCH", token: adminT, body: { tags: [longName] } });
  const gotLen = ((trunc.data && trunc.data.photo.tags) || [""])[0].length;
  check("照片标签单名限长 40", trunc.status === 200 && gotLen === 40, `len=${gotLen}`);

  /* ---------- 7. 收尾 ---------- */
  await req(`/api/photos/${idA}`, { method: "DELETE", token: adminT });
  await req(`/api/photos/${idB}`, { method: "DELETE", token: adminT });
  const cfg3 = await req("/api/tags", { token: adminT });
  await req("/api/tags", {
    method: "PUT", token: adminT,
    body: { categories: cfg3.data.categories, groups: cfg3.data.groups, tags: (cfg3.data.tags || []).filter((t) => !/^守卫测试/.test(t.name)) },
  });
  console.log("› 已收尾：删测试图 / 清守卫测试标签");

  console.log(`\n${failed === 0 ? "✓ 全部通过" : "✗ 有失败项"}（共 ${results.length} 项，失败 ${failed}）\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error(`\n✗ 守卫测试异常：${e.message}\n`);
  process.exit(1);
});
