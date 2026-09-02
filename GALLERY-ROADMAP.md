# 留影 Gallery · 完整功能规划文档

> 本文档用于指导 AI 编码助手（DeepSeek V4 Flash）逐步实现图库功能。
> 每个功能包含：需求描述、数据结构、实现要点、涉及文件。

---

## 项目概览

- **项目名**：留影 Gallery（私人图库）
- **技术栈**：纯前端 HTML/CSS/JS + Netlify Functions（Node.js）+ Netlify Blobs（存储）
- **无构建工具**：直接引用 `public/assets/app.js` 和 `public/assets/style.css`
- **本地开发**：`npm run dev` 启动 `scripts/dev-server.js`，内存模拟 Blobs，端口 8787
- **部署**：Netlify 自动部署，Functions 目录 `netlify/functions/`

### 文件结构

```
public/
  index.html          ← 单页应用，所有 HTML 结构
  assets/
    app.js            ← 所有前端逻辑（约 900 行）
    style.css         ← 所有样式（约 2000 行）
netlify/
  functions/
    photos.js         ← API 处理（增删改查图片）
    _lib.js           ← 共享工具函数
```

### 现有 API 路由（photos.js）

- `GET /api/photos` — 获取图片列表（支持 ?limit=&cursor= 分页）
- `POST /api/photos` — 上传图片（multipart/form-data）
- `DELETE /api/photos` — 清空图库
- `GET /api/photos/:id/raw` — 获取原图
- `GET /api/meta/stats` — 获取统计信息（张数、字节数）
- `GET /api/export` — 导出元数据 JSON

### 现有前端关键变量（app.js）

- `PHOTOS` — 图片数组，每项 `{ id, title, tags[], size, width, height, mime, takenAt, url }`
- `USE_API` — 是否使用真实 API（本地开发为 true）
- `apiHeaders()` — 返回请求头（含 token）

---

## 功能一：设置页扩展

### 需求

在设置面板中增加更多配置项。当前设置页是 Apple iOS 风格的分组列表（`settings-section` + `settings-group` + `settings-row`）。

### 新增设置项

#### 1.1 外观设置

```
settings-section: "外观"
├── 主题切换（浅色/深色/跟随系统）
│   └── 实现：CSS 变量 + data-theme 属性 + transition 过渡
├── 瀑布流列宽（窄 180px / 标准 240px / 宽 320px）
│   └── 实现：修改 .masonry 的 columns 属性
└── 语言（中文/English）— 可选，优先级低
```

**主题切换实现要点：**
- `:root` 和 `[data-theme="light"]` 定义两套 CSS 变量
- `body` 上加 `transition: background-color 0.4s, color 0.4s`
- `localStorage` 存储用户偏好
- `@media (prefers-reduced-motion: reduce)` 时禁用过渡

#### 1.2 AI 助手设置

```
settings-section: "AI 助手"
├── 开关（启用/禁用）
│   └── localStorage 存储，禁用时隐藏所有 AI 相关入口
├── API Key（质谱 AI BigModel）
│   └── type="password"，localStorage 存储，显示/隐藏切换
├── 人设（System Prompt）
│   └── textarea，默认值："你是一个可爱的猫娘图库助手，说话带喵~"
├── 温度（Temperature）
│   └── range 滑块，0.0-1.0，默认 0.7
└── 测试对话按钮
    └── 发送 "你好" 验证 API Key 是否有效
```

**质谱 AI 调用方式：**
- API 地址：`https://open.bigmodel.cn/api/paas/v4/chat/completions`
- 模型：`glm-4-flash`（免费）
- 请求格式：OpenAI 兼容
- 通过 Netlify Function 代理调用（避免前端暴露 Key）

---

## 功能二：标签体系重构

### 需求

当前标签是简单字符串数组。需要重构为支持分组、别名、搜索的完整体系。

### 数据结构

**Netlify Blobs 中存储标签配置（key: `tags-config`）：**

```json
{
  "groups": [
    {
      "id": "game-char",
      "name": "游戏角色",
      "color": "#ff9f0a",
      "sort": 0
    },
    {
      "id": "scene",
      "name": "场景",
      "color": "#58a6ff",
      "sort": 1
    }
  ],
  "tags": [
    {
      "id": "hutao",
      "name": "胡桃",
      "group": "game-char",
      "aliases": ["核桃", "Hu Tao", "hu tao"],
      "color": null
    },
    {
      "id": "ganyu",
      "name": "甘雨",
      "group": "game-char",
      "aliases": ["椰羊"]
    }
  ]
}
```

**图片元数据中的 tags 字段改为 tag ID 数组：**
```json
{
  "id": "photo-xxx",
  "tags": ["hutao", "ganyu", "inazuma"]
}
```

### API 新增路由

- `GET /api/tags` — 获取标签配置（groups + tags）
- `PUT /api/tags` — 更新标签配置（整体替换）
- `POST /api/tags` — 新增标签
- `DELETE /api/tags/:id` — 删除标签

### 前端实现要点

- 标签筛选菜单：显示标签组 → 点击展开该组下标签
- 标签搜索：输入框支持模糊匹配标签名和别名
- 上传时打标签：下拉选择或搜索，显示所属组
- 标签管理（设置页）：可增删改标签组和标签，支持拖拽排序

---

## 功能三：AI 标签助手

### 需求

利用质谱 AI（GLM-4-Flash 免费模型）辅助标签管理，不直接分析图片内容。

### 功能点

#### 3.1 智能标签搜索
- 用户在标签筛选输入框输入自然语言（如「原神角色」）
- 调用 AI 返回相关标签 ID 列表
- 前端按返回的标签过滤图片

#### 3.2 自然语言筛选
- 搜索框支持自然语言（如「找所有稻妻相关的图」）
- AI 解析为标签组合 `{ tags: ["inazuma", "kazuha", ...], match: "any" }`
- 前端执行筛选

#### 3.3 上传时标签建议
- 用户输入图片描述或文件名
- AI 根据现有标签库推荐应打的标签
- 用户确认后应用

#### 3.4 标签整理建议
- 扫描所有标签，AI 建议：
  - 合并相似标签（「核桃」→「胡桃」）
  - 归类未分组标签
  - 删除无引用标签

### Netlify Function：ai-proxy.js

```javascript
// netlify/functions/ai-proxy.js
// 路由：POST /api/ai/chat
// 请求体：{ messages: [...], temperature: 0.7 }
// 从环境变量或请求头获取 API Key
// 代理转发到质谱 API

export default async (req) => {
  const { messages, temperature } = await req.json();
  const apiKey = req.headers.get("x-ai-key") || process.env.ZHIPU_API_KEY;
  
  const res = await fetch("https://open.bigmodel.cn/api/paas/v4/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "glm-4-flash",
      messages: [
        { role: "system", content: "你是一个图库标签助手..." },
        ...messages
      ],
      temperature: temperature || 0.7
    })
  });
  
  const data = await res.json();
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" }
  });
};
```

### 前端调用示例

```javascript
async function aiTagSearch(query) {
  const tagsConfig = await fetch("/api/tags").then(r => r.json());
  const tagList = tagsConfig.tags.map(t => `${t.name}(${t.aliases.join(",")})`).join("、");
  
  const res = await fetch("/api/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "system", content: `你是标签助手。现有标签：${tagList}。用户查询时，返回匹配的标签ID数组，格式：["id1","id2"]` },
        { role: "user", content: query }
      ]
    })
  });
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content); // ["hutao", "ganyu"]
}
```

---

## 功能四：图片浏览增强

### 4.1 图片信息浮层

- 灯箱（lightbox）右上角加 `i` 按钮
- 点击后从右侧滑出信息面板（半透明毛玻璃）
- 内容：尺寸、格式、文件大小、拍摄时间
- EXIF 信息可选展示（需要解析 EXIF，优先级低）
- 默认隐藏，不打扰浏览

### 4.2 收藏功能

- 存储：`localStorage.setItem("favorites", JSON.stringify(["id1", "id2"]))`
- 灯箱和卡片上加星标按钮
- 标签筛选菜单加「收藏」快捷筛选
- 无需登录，单设备生效

### 4.3 图片下载

- 灯箱加下载按钮
- 使用 `<a download>` 触发下载
- 批量下载：选中多张后打包 ZIP（需要 JSZip 库，可选）

### 4.4 幻灯片放映

- 灯箱加播放按钮
- 自动切换下一张（间隔 3/5/10 秒可调）
- 全屏模式 + 自动隐藏控件
- 按空格暂停/继续

---

## 功能五：上传增强

### 5.1 上传前预览

- 拖拽/选择文件后显示预览队列
- 每张可编辑：重命名、添加描述、选择标签
- 支持删除队列中的单张

### 5.2 URL 导入

- 输入框粘贴图片 URL
- Netlify Function 下载图片并存入 Blobs
- 路由：`POST /api/photos/import` `{ url: "https://..." }`

### 5.3 重复检测

- 上传前计算文件 hash（MD5/SHA-256）
- 与已有图片比对，提示重复
- 可选跳过或强制上传

---

## 功能六：存储与性能

### 6.1 存储用量进度条

- 设置页图库统计区域加进度条
- 假设总配额 1GB（可配置）
- 进度条颜色：<70% 正常色，70-90% 橙色，>90% 红色
- 显示：已用 / 总量

### 6.2 缩略图

- 上传时自动生成缩略图（Netlify Function 中处理）
- 缩略图存为单独的 Blob key：`thumb-{id}`
- 列表页加载缩略图，灯箱加载原图
- 需要 sharp 或 jimp 库（在 Function 中使用）

---

## 样式规范

- 主色调：`--accent: #ff9f0a`（橙色）
- 背景：深色 `--bg: #08090d`
- 毛玻璃：`backdrop-filter: blur(40px) saturate(160%)`
- 圆角：`--radius: 18px`（大卡片），`--radius-sm: 12px`（小元素）
- 字体：SF Pro / PingFang SC / Microsoft YaHei
- 动画：`cubic-bezier(0.16, 1, 0.3, 1)` 缓出
- Apple 风格：分组列表、交通灯按钮、液态玻璃效果

---

## 开发顺序建议

1. **标签体系重构**（基础，其他功能依赖）
2. **设置页扩展**（主题 + AI 设置）
3. **AI 标签助手**（依赖标签体系 + 设置页）
4. **收藏功能**（独立，可随时做）
5. **图片信息浮层**（独立）
6. **上传增强**（依赖标签体系）
7. **存储可视化**（独立）
8. **幻灯片/下载**（独立）

---

## 注意事项

- 所有新增 API 路由写在 `netlify/functions/photos.js` 中（或新建文件）
- 前端所有逻辑在 `app.js` 中，样式在 `style.css` 中
- 不引入构建工具，不使用 npm 前端框架
- 可以引入 CDN 库（如 JSZip、sharp 等）
- localStorage 用于用户偏好存储（主题、收藏、AI 配置）
- Netlify Blobs 用于服务端数据（图片、元数据、标签配置）
- 环境变量：`ZHIPU_API_KEY`（质谱 AI Key，可选，用户也可在设置页输入）

---

## 已完成 ✅

- [x] 设置页 Apple 风格重写（settings-section + settings-group + settings-row 分组列表）
- [x] 移除管理员登录，所有功能直接可用
- [x] 图库统计（图片数量、已用空间）
- [x] 标签管理（设置页展示已有标签，支持删除）
- [x] 数据维护 - 导出元数据 JSON
- [x] 危险操作 - 清空整个图库（带确认弹窗）
- [x] 标签筛选菜单（悬浮弹出，按标签过滤图片）
- [x] 标签搜索（输入框模糊匹配）
- [x] 搜索窗口（独立界面，搜索标题/标签/描述）
- [x] 上传功能（拖拽 + 点击选择，支持多张，标签输入）
- [x] 灯箱浏览（大图查看，左右切换，键盘快捷键）
- [x] 瀑布流布局（自适应列数，列宽 240px）
- [x] 翻转卡片悬停效果（hover 从底部翻转显示标题/标签/日期）
- [x] 仓鼠跑轮加载动画
- [x] FAB 悬浮按钮组（主按钮 + 标签筛选 + 页面切换）
- [x] 页面切换菜单（图库/搜索/上传/设置）
- [x] 悬浮窗口系统（上传/设置/搜索独立窗口，可层叠，Genie 动画）
- [x] 无限滚动加载
- [x] 视口出现动画（卡片交错淡入）
- [x] **标签体系 v0.11**（2026-09-02，校准后补录）：
  - 标签组 / 别名 / 颜色：配置存 Blobs key `tags-config`（`{ groups:[{id,name,color,sort}], tags:[{id,name,aliases,group,color,sort}] }`）
  - API：`GET /api/tags`、`PUT /api/tags`、`POST /api/tags/rename`（改名/合并并同步照片引用）、`POST /api/tags/remove`（删除并同步照片）
  - 照片 `meta.tags` 仍存标签名（名称即引用键，旧数据零迁移）
  - 筛选菜单按组分开展示 + 折叠 + 搜索（匹配名称与别名）
  - 卡片 / 灯箱 / 搜索结果标签 chip 按组着色
  - 上传输入框实时标签库建议（显示所属组）
  - 设置页标签管理：组与标签增删改、别名、色板、改名同步照片
  - 清空图库时保留 `tags-config`；顺带修复页面菜单点击 ReferenceError 回归

---

## 实施批次计划（2026-09-02 校准版）

> 依据**当前实际代码**（v0.9.24 登录体系 + 标签体系 v0.11）规划。
> 每批独立可验收，做完一批汇报一批；本表同步维护状态。

### 批次 1 · 设置页 · 外观与快捷键（纯前端）✅ 已完成（2026-09-02）
- 主题切换：浅色 / 深色 / 跟随系统
  - CSS 变量两套（`:root` 深色 + `[data-theme="light"]`），`<html data-theme>`，localStorage 记忆，body 过渡 0.4s，`prefers-reduced-motion` 时禁用
- 瀑布流列宽：窄 180px / 标准 240px / 宽 320px（localStorage，改 `.masonry` column 宽度）
- 快捷键说明：设置页「快捷键」分组列出 `/`（搜索）、`Esc`（关闭）、`←→`（灯箱切换）等
- 图片加载质量：并入批次 3（依赖服务端缩略图）
- 语言切换：推迟到最后一批（等全部 UI 定型后一次翻译，避免每批双份文案）
- 涉及文件：`index.html`（设置页外观分组）、`app.js`、`style.css`

### 批次 2 · 图片浏览与管理 ✅ 已实施（2026-09-02，待验收）
- 灯箱信息面板：标题 / 描述 / 尺寸 / 格式 / 大小 / 时间 / 标签；`i` 按钮可收起（`no-info`），看图区自动占满
- 收藏：卡片悬停星标 + 灯箱星标，localStorage `rn_favs`；筛选菜单「收藏」行快捷筛选
- 图片下载：灯箱下载按钮（原图，标题命名）
- 图片旋转：灯箱旋转按钮 = 顺时针 90° 保存（前端 canvas 重编码 → `POST /api/photos/:id/image` 覆盖原图，服务端更新尺寸/大小/时间；绕过 immutable 缓存刷新展示）
- 编辑弹窗：标题 / 描述 / 标签（标签库建议输入），`PATCH /api/photos/:id`；弹窗内可删除当前图片（确认）
- 批量操作：FAB「选择」进入多选模式 → 卡片勾选 → 底部操作条（删除 / 加标签），Esc 或取消退出；打开窗口自动退出
- 图片排序：FAB「排序」菜单：最新上传 / 最早上传 / 标题 A–Z / 文件大小（localStorage `rn_sort`，与筛选叠加）
- 灯箱 ←→ 切换按当前筛选排序视图顺序；搜索打开灯箱时回退全图顺序
- 后端新增：`POST /api/photos/:id/image`（替换原图字节并更新元数据）

### 批次 3 · 存储与上传 ✅ 已实施（2026-09-02，待验收）
- 存储用量进度条：统计区配额进度条（默认 1GB，`QUOTA_BYTES` 可配），<70% 绿 / 70-90% 橙 / >90% 红
- 缩略图：**前端生成** 480px 缩略图随上传/旋转一并保存（零原生依赖，webp 兼容），新路由 `GET /api/photos/:id/thumb`；图片加载质量三档：高画质=原图 / 平衡=列表缩略图 / 省流=灯箱也用缩略图；老图与导入图自动回退原图
- URL 导入：上传页链接列表 → `POST /api/import`（逐条反馈成功/失败）
- 重复检测：内容 sha1 存 meta，`GET /api/photos/check?hash=` 预检，重复时确认「跳过 / 仍然上传」

### 批次 4 · AI 助手（质谱 GLM-4-Flash）✅ 已实施（2026-09-02，待验收）
- ai-proxy.js（POST /api/ai/chat，Key 取 X-AI-Key 头或 ZHIPU_API_KEY）已联调真实 Key 通过；智能标签搜索 / 自然语言筛选 prompt 已实测；整理建议=本地规则（别名冲突合并、无引用删除）+ AI 补充并做合法性过滤
- 设置页「AI 助手」分组：开关 / API Key（password，localStorage）/ 人设 / 温度 / 测试对话
- 新 Function `netlify/functions/ai-proxy.js`：`POST /api/ai/chat` 代理转发（key 取请求头或环境变量 `ZHIPU_API_KEY`），config.path 注册
- 功能：智能标签搜索（自然语言 → 标签列表）、自然语言筛选（→ 标签组合）、上传时标签建议、标签整理建议（合并 / 归类 / 删无引用）
- 无 Key 时入口自动隐藏
- 涉及文件：`ai-proxy.js`、`photos.js`（config.path）、`index.html`、`app.js`、`style.css`

### 批次 5 · 相册 / 安全 / 语言（收尾）
- 相册：`albums-config` Blob（相册列表 + 照片 id 集合），图库页相册视图与切换、相册管理（新建/重命名/删除/加入移除照片）
- 访客密码：全站访问密码 gate（`VIEW_TOKEN` 环境变量；登录弹窗区分「访客 / 管理员」，与现有 ADMIN_TOKEN 体系共存）
- 操作日志：写操作记录（时间 / 动作 / 对象 / IP）存 Blob `logs`，设置页查看与清空
- 图片水印：上传时可选烧入（右侧 PNG 水印文件上传到设置页，jimp 合成到缩略图/原图）
- 语言切换 zh/en：全部 UI 文案收尾翻译（`lang` 字典 + localStorage）
- 涉及文件：全局

### 不在当前范围（明确不做）
- EXIF 解析展示（灯箱信息面板仅展示现有字段）
- 拖拽排序标签（管理页不做 DnD，以 sort 顺序为准）
- 音乐 / 视频等非图片文件支持

---

### 批次 6 · 收尾补全（v0.13，2026-09-02）✅
- 幻灯片放映：灯箱播放/暂停按钮、间隔 3/5/10 秒（设置页）、空格键播放暂停、播放中控件自动隐藏、关闭/Esc/换图自动停止
- 标签拼音搜索：pinyin-pro（CDN，离线自动降级）支持全拼/首字母匹配标签名与别名（菜单、上传与编辑建议、搜索窗口）
- 上传前逐张编辑：队列 hover 出现 ✎（标题/描述/标签，留空回退全局）与 ✕ 移除；自动上传延迟 3 秒留出编辑时间
- 语言切换完善：动态文案双语（筛选菜单行 / 批量条 / 排序 / 搜索计数 / 加载提示），骨架词典扩充（弹窗按钮、上传、水印、访客门禁等）