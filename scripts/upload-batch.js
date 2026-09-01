/* ============================================================
   批量上传图片到部署站点的 Blobs（经 /api/photos）
   用法:
     node scripts/upload-batch.js <图片目录> [--token=xxx]
   说明:
     - 站点默认 https://r-gallery.netlify.app，可用环境变量 RN_SITE 覆盖
     - 站点配置了 ADMIN_TOKEN 时需传 --token（与设置页令牌一致）
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const dir = process.argv[2];
const tokenArg = process.argv.find((a) => a.startsWith("--token="));
const token = tokenArg ? tokenArg.split("=").slice(1).join("=") : process.env.RN_TOKEN || "";
const SITE = process.env.RN_SITE || "https://r-gallery.netlify.app";
const EXTS = [".webp", ".jpg", ".jpeg", ".png", ".gif"];
const MAX_BYTES = 15 * 1024 * 1024;

async function main() {
  if (!dir || !fs.existsSync(dir)) {
    console.error("用法: node scripts/upload-batch.js <图片目录> [--token=xxx]");
    process.exit(1);
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => EXTS.includes(path.extname(f).toLowerCase()))
    .sort();
  if (!files.length) {
    console.error("目录里没有图片（支持 webp/jpg/png/gif）");
    process.exit(1);
  }
  console.log(`发现 ${files.length} 张图片，上传到 ${SITE}/api/photos ...`);
  let ok = 0;
  let fail = 0;
  for (const f of files) {
    const filePath = path.join(dir, f);
    const size = fs.statSync(filePath).size;
    if (size > MAX_BYTES) {
      console.log(`  ✗ ${f}: 超过 15MB 限制`);
      fail++;
      continue;
    }
    const dataBase64 = fs.readFileSync(filePath).toString("base64");
    const title = path.basename(f, path.extname(f));
    try {
      const res = await fetch(`${SITE}/api/photos`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "X-Auth-Token": token } : {}),
        },
        body: JSON.stringify({ dataBase64, title, tags: [] }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        console.log(`  ✓ ${f} -> id=${data.photo.id} (${(data.photo.size / 1024).toFixed(1)}KB, ${data.photo.width}x${data.photo.height})`);
        ok++;
      } else {
        console.log(`  ✗ ${f}: ${data.error || "HTTP " + res.status}`);
        fail++;
      }
    } catch (e) {
      console.log(`  ✗ ${f}: ${e.message}`);
      fail++;
    }
  }
  console.log("");
  console.log(`完成：成功 ${ok}，失败 ${fail}`);
  if (fail) process.exitCode = 1;
}

main();
