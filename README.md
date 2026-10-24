# R_N_Gallery · 基于 Netlify Blobs 的私人图库

纯静态前端 + Netlify Functions + Netlify Blobs 的零数据库私人图库。
苹果液态玻璃（黑色毛玻璃）风格，多窗口层叠交互，Genie 动画。

> 当前版本 **v0.57**（版本号跟随 git 提交记录，`package.json` 的 `version` 仅作参考）。

## 功能

- 瀑布流 / 方形网格图库（真实图片 + 无限滚动 + 视口交错出现动画）
- **循环滚动**：双击 FAB 主按钮切换 —— 瀑布流下一次渲染全部结果，**无缝循环**（首尾复本 + 滚动位置平移，感觉不到回到开头）
- 批量选择：FAB「选择」按钮，或**长按卡片**进入多选（触屏，或鼠标按住 600ms）；可加标签 / 收藏 / 删除
- 灯箱：适应视口不变形、滚轮缩放、放大后拖拽平移、旋转（仅预览）
- **三档分级**：大众级 / R16 / R18（照片字段 `rating`，与标签库并列而非混在标签里）
- 标签筛选：**多选组合（标签层可切「且 / 或」）+ 排除 + 一键保存为「我的筛选」** + 主分类 · 分级叠加
- 标签管理（分组 / 主分类 / 批量导入）· 独立搜索窗口（`/` 快捷键）
- 浏览页：**全部图片 / 收藏夹 / 按主分类派生的集合**（点进去连续翻看，分批加载）
- 收藏：照片字段 `fav`（跟图走），卡片爱心 / 灯箱工具条 / 批量条三个入口
- 查重：内容 sha1 完全相同 + dHash 感知哈希相似（差异 ≤ 8）
- 上传：浏览器端 canvas 压缩 → base64 → Blobs，支持批量队列与逐张编辑标签
- **主分类与标签都是可选的**：一张图可以没有分类、没有标签（上传时什么都不选也能传）
- 设置：用量统计 / 导出元数据 / 清空图库
- 两级访问模式：管理员（全部功能 + R16/R18）/ 观光模式（只读，自动隐藏 R16·R18）

## 目录结构

```
public/
  index.html              前端主壳（SPA）
  assets/
    app.js                前端全部逻辑
    style.css             样式
    pinyin-pro.min.js     拼音搜索库（第三方，本地内嵌；v0.54 起改为按需加载，不进首屏）
netlify/
  functions/
    _lib.js               共享库（Blobs store / 鉴权 / 尺寸解析 / id 生成）
    photos.js             统一 API 入口（全部 /api/* 路由）
scripts/
  dev-server.js           本地开发服务器（内存 Blobs 模拟）
  dom-smoke-test.js       jsdom 冒烟测试
  seed-local.js           给本地服务灌可控测试数据（冒烟测试前置）
  api-guard-test.js       服务端守卫测试（分级保留名 / 观光边界，需带 ADMIN_TOKEN 起服务）
  find-duplicates.js      本地查重扫描
  import-chars.js         角色数据 → 标签库
  migrate-photos.js       批量迁移标签 / 主分类
  migrate-rating.js       把 r18 / r16 从标签 / 主分类 / 老字段收敛成三档分级（v0.57）
  upload-batch.js         批量上传图片
  data/                   角色数据与历史备份（备份 json 已在 .gitignore 中）
netlify.toml              构建 / 函数打包 / 响应头配置
GALLERY-ROADMAP.md        功能规划与变更日志（91KB，含历史批次）
```

## 本地开发

```bash
npm install          # 安装依赖（@netlify/blobs、sharp）
npm run dev          # 启动本地开发服务器 → http://localhost:8787
```

> `dev` 使用内置的 `scripts/dev-server.js`（无需 netlify-cli）：静态文件 + `/api/*` 完整路由
> （直接调用 Netlify Function handler），Blobs 以**内存模拟**（重启后数据清空）。
>
> 注意：dev-server 会对照各函数 `exports.config.path` 校验路由 —— 未声明的路由会打印醒目警告后放行，
> 设 `STRICT_ROUTES=1` 则直接返回 404（与线上一致）。新增接口时记得写进
> `netlify/functions/photos.js` 的 `config.path`（v0.53 的 `/api/auth/tagger` 就漏过一次）。

直接双击 `index.html` 只能预览 UI 骨架（无 API 时图库为空），完整功能请用 `npm run dev`。

### 快速自检

```bash
curl http://localhost:8787/api/photos          # 列表（空库返回 {"photos":[]}）
curl http://localhost:8787/api/meta/stats      # 统计
curl -X POST -H "Content-Type: application/json" \
  -d '{"dataBase64":"data:image/png;base64,iVBORw0KGgo="}' \
  http://localhost:8787/api/photos             # 上传
```

### 冒烟测试

`jsdom` 未列入 dependencies，按需临时安装（会写进 `.npm-cache/`）：

```bash
npm run dev                                                  # 终端 A（默认 8787）
npm install --no-save --no-package-lock --cache .npm-cache jsdom

node scripts/seed-local.js --url=http://localhost:8787       # 灌 18 张可控测试数据（会先清空图库）
GALLERY_URL=http://localhost:8787 node scripts/dom-smoke-test.js    # 前端 126 项
```

> dev server 的 Blobs 是**内存**模拟，重启即清空 —— 跑测试前先 `seed-local.js`。
> 它带的两组标签（含一个 24 标签的大组）与各种图片形态（完全重复 / 相似 / R18 / R16 / 待整理）
> 正是断言依赖的数据；不 seed 会有几项因数据不足而失败。

服务端权限与保留名守卫是独立脚本，需要**带 ADMIN_TOKEN 启动**的实例（另开端口，避免互相干扰）：

```bash
# 终端 A（PowerShell：$env:PORT="8789"; $env:ADMIN_TOKEN="dsh-test-admin"; node scripts/dev-server.js）
PORT=8789 ADMIN_TOKEN=dsh-test-admin node scripts/dev-server.js
# 终端 B
node scripts/api-guard-test.js --url=http://localhost:8789 --admin=dsh-test-admin   # 19 项
```

> 两个脚本都会**写数据**：`dom-smoke-test.js` 的 `GALLERY_URL` / `GALLERY_TOKEN` 可指向线上站点，
> 且会对标签配置做写操作 —— **不要**把线上地址和 Token 一起传给它。

## 部署（Netlify）

1. 把仓库推送到 GitHub；
2. Netlify → **Add new site → Import an existing project** → 选择本仓库；
3. 构建配置自动读取 `netlify.toml`（`publish = "public"`，无需构建命令）；
4. 部署完成后即可通过**上传窗口**添加图片（数据直接进入 Blobs）。

> `sharp` 是带平台原生二进制的模块，已在 `netlify.toml` 里通过
> `external_node_modules = ["sharp"]` 声明为外部依赖。改动函数依赖后请部署一次并验证
> `/api/photos/:id/thumb` 能正常出图。
>
> 静态资源（`/assets/*`）带 `?v=` 版本号并配置了 `immutable` 长缓存 —— **改版时记得同步更新
> `public/index.html` 里的 `?v=` 值**，否则浏览器会继续用旧文件。

### 访问权限（v0.53 起的现状；v0.59 移除整理模式）

- **未设置任何密码**：门禁关闭，所有请求按**管理员**处理 —— 等于站点完全公开，请务必设置访问密码。
- **访问密码**：由环境变量 `ADMIN_TOKEN` 在首次启动时初始化（之后可在设置页修改）；持密码者为管理员。
- **观光模式**：未通过门禁时的只读访问，服务端在**分页前**剔除 R16/R18，`raw` / `thumb` 亦二次校验。

### 分级（v0.57）

图库分三档，存在照片自己的字段 `meta.rating` 上：`general`（大众级）/ `r16` / `r18`。
三档**共用同一套标签、标签组与主分类** —— 分级只是并列的一个属性维度，不参与标签体系：

- 只有管理员能改（观光模式的写请求进不来）；
- 观光模式只能看到「大众级」；
- `r18` / `r16` **不能再作为标签或主分类**（新建 / 改名会被拒）；
- 照片写入时若 `tags` / `categories` 里出现它们，会自动折算进 `rating` 并剔除（兼容老脚本的习惯）。

> **从 v0.56 升级到 v0.57 必须跑一次迁移**（老数据的分级还存在标签 / 主分类 / 布尔字段里）：
>
> ```bash
> node scripts/migrate-rating.js --url=https://你的站点 --token=访问密码          # 先预览
> node scripts/migrate-rating.js --url=https://你的站点 --token=访问密码 --write  # 确认后写入
> ```
>
> 脚本会按老规则推导分级、写进 `rating`、把 r18/r16 从标签与主分类里剔除，并清理标签库里的同名条目；
> 写入前自动备份到 `scripts/data/`。**不跑也不会泄漏** —— `ratingOf()` 在迁移期会继续用老规则兜底，
> 只是界面上的标签会带着 r18/r16 这些脏名字。

> `DELETE /api/photos`（清空图库）只删除照片数据（`img/`、`thumb-`、`meta/`），
> 会保留访问密码、相册、标签与日志配置 —— v0.54 修复了旧版连 `auth-config` 一起删除、
> 导致清空后门禁失效（任何人变管理员）的问题。

## API

统一前缀 `/api`，由 `photos.js` 处理：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/photos?limit=&cursor=&safe=` | 元数据分页列表（`safe=1` 时剔除 R18/R16） |
| GET | `/api/photos/:id` | 单张元数据 |
| GET | `/api/photos/:id/raw` | 图片字节（成人向仅管理员可见） |
| GET | `/api/photos/:id/thumb` | 缩略图（缺失时服务端懒生成并缓存） |
| GET | `/api/photos/check?hash=` | 按内容 sha1 查重 |
| POST | `/api/photos` | 上传：`{ dataBase64, thumbBase64?, title?, categories, tags }` |
| PATCH | `/api/photos/:id` | 更新元数据（标题 / 标签 / 主分类 / 分级 `rating` / 收藏 `fav`） |
| DELETE | `/api/photos/:id` | 删除单张 |
| DELETE | `/api/photos` | 清空图库（保留全部配置类数据） |
| POST | `/api/photos/:id/image` | 覆盖原图字节（历史接口，前端已不再调用） |
| POST | `/api/photos/reindex` · `/api/photos/reindex-dhash` | 重建列表索引 / 补算感知哈希 |
| GET | `/api/meta/stats` | 用量统计（含 quota） |
| GET · DELETE | `/api/meta/logs` | 操作日志（查看 / 清空） |
| GET · PUT | `/api/tags` | 标签配置（分组 / 标签 / 主分类） |
| POST | `/api/tags/rename` · `/api/tags/remove` | 标签改名/合并、删除（同步照片） |
| POST | `/api/tags/category-rename` · `/api/tags/category-remove` | 主分类改名、删除 |
| GET · PUT | `/api/albums` | 相册配置（v0.56 起前端不再使用：数据与接口保留，浏览页改用派生集合） |
| GET | `/api/export` | 导出全部元数据 |
| POST | `/api/import` | URL / 批量导入：`{ items: [{ url, tags }] }` |
| GET | `/api/auth/state` | 门禁状态（是否已设置访问密码） |
| POST | `/api/auth/login` | 登录：`{ token }` → `{ role: "admin" }` |

> v0.59：`POST /api/auth/tagger`（设置整理模式密码）已随整理模式一起删除，请求返回 404。

## Blob key 设计

```
img/<id>.<ext>      原图字节（metadata: mime/width/height）
thumb-<id>          缩略图（480px webp，无则服务端懒生成）
meta/<id>.json      元数据（标题 / 标签 / 主分类 / 分级 / 收藏 / 尺寸 / 时间 / 大小 / sha1 / dhash）
photos-index        列表索引（轻量元数据数组，避免列表接口逐个读 meta）
tags-config         标签与主分类配置
albums-config       相册配置（v0.56 起前端不再读取，数据保留）
auth-config         访问密码的 SHA-256 哈希
logs                操作日志（保留最近 500 条）
```
