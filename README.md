# R_N_Gallery · 基于 Netlify Blobs 的私人图库

纯静态前端 + Netlify Functions + Netlify Blobs 的零数据库私人图库。
苹果液态玻璃（黑色毛玻璃）风格，多窗口层叠交互，Genie 动画。

## 功能

- 瀑布流图库（真实图片 + 无限滚动 + 视口交错出现动画）
- 灯箱（信息面板：标题 / 日期 / 大小 / 分辨率 / 格式 / 标签）
- 标签筛选（主要标签悬浮菜单）· 独立搜索窗口（`/` 快捷键）
- 上传（浏览器端 canvas 压缩 → base64 → Blobs）
- 设置（用量统计 / 导出元数据 / 清空）
- 上传 / 设置 / 搜索以悬浮窗口打开，旋转式文件堆叠
- 数据仅来自 Netlify Blobs API（v0.9.4 起移除本地静态图片与假数据）

## 目录结构

```
├── index.html              前端主壳（SPA）
├── assets/                 样式与脚本
├── scripts/
│   └── dev-server.js       本地开发服务器（内存 Blobs 模拟）
├── netlify/
│   └── functions/
│       ├── _lib.js         共享库（store / 鉴权 / 尺寸解析）
│       └── photos.js       统一 API 入口（全部 /api/* 路由）
├── netlify.toml            构建与重定向配置
├── package.json
└── DESIGN.md               设计文档（含变更日志）
```

## 本地开发

```bash
npm install          # 安装依赖（@netlify/blobs）
npm run dev          # 启动本地开发服务器 → http://localhost:8787
```

> `dev` 使用内置的 `scripts/dev-server.js`（无需 netlify-cli）：
> 静态文件 + `/api/*` 完整路由（直接调用 Netlify Function handler），
> Blobs 以**内存模拟**（重启后数据清空）。浏览器打开
> `http://localhost:8787` 即可完整使用（API 数据源自动生效）。

直接双击 `index.html` 只能预览 UI 骨架（无 API 时图库为空），完整功能请用 `npm run dev`。

### 快速自检

```bash
curl http://localhost:8787/api/photos          # 列表（空库返回 {"photos":[]}）
curl http://localhost:8787/api/meta/stats      # 统计
curl -X POST -H "Content-Type: application/json" \
  -d '{"dataBase64":"data:image/png;base64,iVBORw0KGgo="}' \
  http://localhost:8787/api/photos             # 上传
```

## 部署（Netlify）

1. 把仓库推送到 GitHub（见下）；
2. Netlify → **Add new site → Import an existing project** → 选择 `R_N_Gallery` 仓库；
3. 构建配置自动读取 `netlify.toml`（publish = `.`，无需构建命令）；
4. 部署完成后即可通过**上传窗口**添加图片（数据直接进入 Blobs）；
5. 可选：配置 `ADMIN_TOKEN` 环境变量后，在设置页填写同一值作为访问令牌。

> 注：v0.9.4 起已移除 `image/` 静态目录与「导入静态图片」入口（后端 `/api/import` 保留，如需批量导入可自行调用，需站点存在静态图片源）。

### 环境变量（可选）

| 变量 | 说明 |
|---|---|
| `ADMIN_TOKEN` | 设置后所有 API 请求需携带 `X-Auth-Token` 请求头（前端在设置页填写，存于 localStorage） |
| `UPLOAD_TOKEN` | 写操作（上传/删除/导入）可单独使用此令牌；未设置时与 `ADMIN_TOKEN` 相同 |

> 未配置任何 token 时 API 完全开放（仅建议本地/私有使用）。

## API

统一前缀 `/api`，重定向至 `photos` 函数：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/photos?limit=&cursor=` | 元数据分页列表 |
| GET | `/api/photos/:id` | 单张元数据 |
| GET | `/api/photos/:id/raw` | 图片字节（`Cache-Control: immutable`） |
| POST | `/api/photos` | 上传：`{ dataBase64, title, desc, tags, takenAt }` |
| PATCH | `/api/photos/:id` | 更新元数据 |
| DELETE | `/api/photos/:id` | 删除单张 |
| DELETE | `/api/photos` | 清空图库 |
| GET | `/api/meta/stats` | 用量统计 |
| GET | `/api/export` | 导出全部元数据 |
| POST | `/api/import` | 导入静态 `image/`：`{ files: [...] }` |

## Blob key 设计

```
img/<id>            原图字节（metadata: mime/width/height）
meta/<id>.json      元数据（标题/标签/尺寸/时间/大小等）
```
