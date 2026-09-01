const fs = require("fs");
const src = fs.readFileSync("assets/app.js", "utf8");
const m = src.match(/const IMAGES = \[([\s\S]*?)\];/);
if (!m) { console.log("IMAGES not found"); process.exit(1); }
const files = [...m[1].matchAll(/"((?:image)\/[^"]+)"/g)].map((x) => x[1]);
console.log("IMAGES count:", files.length);
const missing = files.filter((f) => !fs.existsSync(f));
console.log("missing count:", missing.length);
missing.forEach((f) => console.log("  MISSING:", f));
