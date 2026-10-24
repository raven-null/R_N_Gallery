# 留影 Gallery · 全项目优化审查报告

> 审查范围：全部源码与配置（public/、netlify/functions/、scripts/、netlify.toml、package.json、文档）。
> 方式：只读分析，**未修改任何项目文件**。行号基于当前工作区（git 提交 `d247197`，v0.53）。
> 自查结果：10 个 JS 文件 `node --check` 全部通过；工作区 `git status` 干净。
> 首屏体积实测（本地 gzip Optimal）：`index.html` 10.9KB + `style.css` 26.2KB + `app.js` 77.3KB + `pinyin-pro.min.js` 141.9KB = **约 256KB(gzip)**；若把拼音库改为按需加载并清掉死代码，可降到 **约 112KB（−56%）**。

---

## 附：v0.54 已修复项（本轮实改）

| 关联条目 | 改动 | 验证结果 |
|---|---|---|
| P0-1 清空图库误删密码 | `photos.js:691-722` 改为**白名单删除**（只删 `img/`、`thumb-`、`meta/`），保留 auth / albums / tags / logs；顺带 `await logAction` | dev-server 端到端：设置整理密码 → 上传 3 张 → 清空 → `auth/state` 仍为 `hasTagger:true` ✓（修复前会被清成 false） |
| P0-4 AI 代理无鉴权 | `ai-proxy.js` 接入 `checkAuth`，并修正 Key 优先级为「个人 Key 优先、环境变量兜底」（**后续该功能已按用户要求整体移除**，见文末「移除 AI 功能」） | 无 token → **401**；带 token → 400「未配置 API Key」（门禁通过且未调用外部 API）✓ |
| P2-11 / P2-12 部署与响应头 | `netlify.toml` 加 `external_node_modules = ["sharp"]`；新增 `[[headers]]`（`/*` 安全头 + `/assets/*` immutable 长缓存） | 配置已逐行核对；**部署后需实测一次 `/api/photos/:id/thumb`** |
| P3-21 文档不一致 | README 全面重写（目录 `public/`、三级访问模型、20 条 API 表、blob key、dev-server 路由注意项、缓存版本号提醒）；`package.json` 版本 → `0.54.0` | 已与 `photos.js:200-224` 的 `config.path` 路由表逐条对照 ✓ |
| 新发现（P2-19 同源） | `scripts/dom-smoke-test.js:721` 的挂载探针 `POST /api/auth/tagger` 带空 body —— 后端语义是「空串即清除整理密码」，测试会**顺手清掉整理密码**；改为传无效值只验路由 | 重跑冒烟测试：93 项 92 通过（唯一失败项是「存在标签数 >20 的组」，需先跑 `import-chars.js`，属数据不足），且测试后 `hasTagger` 仍为 true ✓ |
| P0-2 索引并发丢更新（一并解决 P1-9） | 索引从「单个 Blob 整表读改写」改为**一条一 key**：`idx/<13 位倒序时间戳>-<id>.json`，字典序即「最新在前」。上传 / 编辑 / 删除 / 懒生成缩略图只写自己那一条，彻底消除竞态与写放大；列表的管理员路径按 Blobs 游标分页，观光 / 整理模式仍**分页前过滤**（安全语义不变）；**老库首次访问自动迁移**（`indexHeal`：`idx/` 为空但 meta 存在时重建一次），旧的单 Blob 索引在重建 / 清空时清理 —— 部署后无需手动跑 reindex | 并发上传 5 张 → 列表与 total 都是 5 ✓（旧实现在此场景会丢索引项）；`limit=2` 翻页 2+2+1 无重无漏 ✓；R18：管理员 5 张 / 观光 4 张、观光取原图 401 ✓；PATCH、删除、reindex、统计、清空后归零全部同步 ✓；模拟老库（仅 `photos-index` + meta）首次请求即自动重建、旧 blob 被清理、排序正确 ✓；空库 / 有数据 / 清空后三种 `total` 分支 ✓；**冒烟测试与改动前基线逐项一致**（同为 91 项 3 项失败，失败项全部指向「标签库为空，需先跑 `import-chars.js`」）✓ |
| P0-3 `importStatic` 的 SSRF | 新增 `assertImportableUrl` / `fetchRemoteImage`：只允许 http(s)、拦内网与本机（IPv4 字面量 + `localhost`/`.internal`/`.local` + IPv6 本机与 ULA）、**再解析一次域名挡内网 DNS**、`redirect:"manual"` 逐跳校验、15s 超时、15MB 上限；单次导入上限 300 → 50（每项都要抓取 + 缩略图 + dhash，300 项必然超时） | `file://`、`169.254.169.254`、`127.0.0.1`、`localhost` 四种都被拒 ✓ |
| P1-8 查重 O(N²) + 服务端不查重 | 新增 `hash/<sha1>` 反查键（`PREFIX_HASH`）：上传 / 导入时写入、删除与覆盖原图时同步清理与更新、清空时一并清掉；`checkHash` 改为先查键（**O(1)**），老库没有键时回退线性扫描并**惰性补键**；上传响应新增 `duplicate` 字段（指向同内容的已有照片），重复上传额外记「上传重复图片」日志。注意：**没有硬拒绝重复上传** —— 前端「仍然上传」选项需要能通过 | 8 组端到端全 PASS：不同图 `duplicate=null` ✓、重复上传返回既有 id ✓、接口查重 true/false ✓、删掉最新那张重复图后**回退找到另一张** ✓、全删后 false ✓、覆盖原图后旧 hash 查不到 / 新 hash 查到 ✓、清空后键被清理 ✓ |
| P1-10 `logAction` 未 await | 16 处调用点全部改为 `await`（原 15 处是 fire-and-forget，Netlify 函数返回后运行时可能被冻结 → 日志静默丢失） | 清空 / 替换 / 删除 / 重复上传后 `/api/meta/logs` 均能查到对应记录 ✓ |
| P1-7（前半）上传队列预览内存 | 队列预览图从「12 张同时 `readAsDataURL`」改为**最多 2 并发**（`readPreview` + 泵函数），每张读完即释放 FileReader；不再同时驻留 12 份 base64 副本。注：改 `FormData` 上传（彻底去掉 base64 往返）仍是后半段未做 | jsdom 实测：一次入队 6 张 → 6 行全部创建、**6/6 预览就绪**（限流下最终全部读到）、删除行无异常 ✓；冒烟测试无回归 ✓ |
| P2-18 请求无超时 / 无防覆盖 | `fetchPhotosPage` 与 `apiFetch` 加 20s 超时（`AbortSignal.timeout`，旧浏览器自动退化为不设超时）；上传 XHR 加 120s 超时 + `ontimeout` 文案；`loadData` 加请求序号，旧响应后到时直接丢弃 | 冒烟测试无回归 ✓。注：jsdom 的 `AbortSignal` 不是 Node fetch 认的实例，已在测试 stub 里丢掉 signal（浏览器里两者同源，无此问题） |
| P2-19 dev-server 不校验线上路由 | dev-server 启动时读取各函数的 `exports.config.path`，请求的路由不在声明里就打印醒目警告（默认放行）；`STRICT_ROUTES=1` 时按线上行为返回 404 | 已声明路由零误报、`/api/nope` 正确警告、`STRICT_ROUTES=1` 下未声明路由 404 而已声明路由仍 200 ✓。过程中实测发现并修正：`config` 挂在**模块导出**上，不在 `default` 函数上 |
| P1-5 首屏白下 323KB 拼音库 + 缓存污染 | `index.html` 移除写死的 `pinyin-pro.min.js`，改由 `loadPinyinLib()` 在**首次真正需要拼音匹配时**注入（离线自动降级）；`app.js` 给自身脚本加 `defer`。同时修掉缓存污染：库未就绪时 `pinyinOf` 返回空结果但**不写缓存**，加载完成后清缓存并**重放当前输入**让过滤重算。首屏脚本载荷从约 256KB(gzip) 降到 **约 114KB**（-142KB） | jsdom 实测：首屏 script 清单只剩 `app.js` ✓；库未就绪时搜 `ceshi` 无结果且**成功注入**拼音库 ✓；模拟加载完成后同一搜索**命中「测试」标签** ✓（也证明空结果没被缓存）；冒烟测试 93 项仅 1 项失败（比基线还好，因库里这次有标签组）✓ |
| 新发现（P3）未分组标签在筛选菜单里不可见 | 通过 API `PUT /api/tags` 创建标签时若不指定 `group`（`group=""`），该标签在筛选菜单里**既不属于任何组、又被「游离标签」逻辑排除**（`app.js:1865`：`used.filter(n => !tagByName(n))`），于是完全不显示。前端 UI 创建标签不会触发，但脚本/API 直接写入时会 | 实测复现（未分组标签搜索前后都不可见）；把标签挂到组后正常显示 ✓ |
| P2-14（部分）CSS 死代码清理 | 删掉 191 行零引用样式：**详情页整段**（`.detail-wrap/.detail-stage/.detail-panel/.detail-actions/.kv/.nav-btn` 等，v0.37 移除信息面板后遗留）、`.page-head` 一族（含移动端覆盖）、`.tag-mgr-list/.tag-pill/.tag-count/.tag-remove`、`.qp-toggle`、`.side-drawer`、`.form-grid`、`.tag-mgr-root`、`.tmgr-loose`、`.tag-group-head .gcnt`、`.ts-item.hl`、`@keyframes slidebadge`。保留 `.skeleton`/`shimmer`（留作骨架屏）、`.taglist`、`.qp-empty`、`@keyframes rise/card-in`（仍在用） | 删除前后各跑一次冒烟测试：**逐项一致**（同为 91 项 4 项失败，失败项由示例数据形态导致），确认无回归 ✓；花括号配平 814/814 ✓。另：`index.html` 的 `?v=` 版本号已从 `20261022` 提到 `20261101`（因为 `/assets/*` 现在有 immutable 长缓存） |
| 上传面板改为单栏（用户要求） | 删掉整个右栏 `#upRight`：「全局标签」（`#tagListUpload` / `#tagInputUpload` / `#tagSuggest` / `#upQuickPick`）与「分类（作品 / 角色）」槽（`#uqSlots` / `#uqSlotSearch` / `#uqSelStatus` / `#uqNewSlotInput`）；`app.js` 去掉槽渲染与事件（`refreshUqSlots` / `toggleUqGroup` / `uqSlotCount` / `uqSlotQuery` / `uqOpenGroups`）、全局标签（`uqGlobalTags` / `window.__upTagList`）、行列多选与拖拽归类（`uqSelSet` / `applyTagsToItems` / `__uqDragItems`）；`rowSendTags` 简化为只发该行自己的标签，URL 导入不再附带标签；CSS 把 `.up-split` 改为单栏并删掉 `.up-right`、`.uq-item.sel`、`.uq-item.dragging` 与拖拽光标 | 右栏 9 个元素全部不存在 ✓；加入图片后队列 / 提示文案 / 上传按钮 / 行内 ✎✕ 均正常 ✓；冒烟测试 **97 项仅 1 项失败**（仍需先跑 `import-chars.js`）✓；CSS 配平 762/762 ✓。**保留**：单行 ✎ 弹窗仍可给该张图打标签；分类工作台（`#cwSlots` 等共用 `slotSectionsHTML`）与标签管理不受影响 |
| P2-15 用量统计不准（用户反馈"没有用"） | ①后端 `stats()` 改为**真实遍历所有 Blob key** 累加字节并按用途分类（`img` / `thumb` / `meta` / `idx` / `other`），不再只算原图 `size`；`QUOTA_BYTES` 仍可覆盖配额。②前端 `renderStats` 改收整个对象并显示明细，设置页新增「其中」一行。③**修掉更关键的问题**：`refreshStats` 原来先判断 `USE_API`（首屏数据到位前是 `false`），先打开设置页的人会一直看到「0 张 / 0 KB」；而且它只在初始化时拉过一次，数据变化后不再更新 —— 现在直接请求 API，并在**每次打开设置页时刷新** | dev-server 实测 `/api/meta/stats`：`count=16`、`keys=82`（16 原图 + 16 缩略图 + 16 meta + 16 idx + 18 其他）、`bytes=786660`、`byKind={"img":725748,"thumb":44166,"meta":6168,"idx":5864,"other":4714}` ✓；设置页显示「16 张 / 787 KB（82 个文件）/ 原图 726 KB · 缩略图 44 KB · 数据/其他 18 KB / 787 KB / 1.07 GB · 0.07%」✓（旧算法只算原图 → 708 KB，少 8%）。冒烟测试 106 项 5 项失败，均为示例数据形态（照片都已有分类标签、标签库只有 5 个标签、无 >20 标签的组）所致 |
| 方格模式按上传日期分段（用户要求，新功能） | 新增 `itemsHTML()`：**方格模式 + 按时间排序**时在卡片流里插入 `.grid-group` 日期分组头（今天 / 昨天 / X 月 X 日 / X 年 X 月 X 日，并显示当天张数）；`render()` 与 `appendMore()` 都改走它，追加时用上一段最后一天作 `prevKey`，分段不会断开；按大小 / 标题排序或瀑布流模式下自动退回连续网格。CSS 新增 `.masonry.grid-square .grid-group`（`grid-column: 1 / -1` 横跨整行） | jsdom 实测（mock 多天数据：今天 2 张 / 昨天 1 张 / 去年 1 张）：方格模式生成 3 个分组头「今天 2 张 / 昨天 1 张 / 2025 年 9 月 11 日 1 张」✓；切回瀑布流分组头归 0 且卡片仍是 4 张 ✓；再切回方格恢复 3 组 ✓；冒烟测试无回归 ✓ |
| 时间线统一为「拍摄时间优先」+ 切换布局重渲染（跟上面配套修的两个问题） | ①排序与分段都改用 `photoTimeOf()`（takenAt 优先、回退 uploadedAt），否则两套顺序不一致会出现「今天」分组重复；②`initLayoutSwitch` 的点击处理补上 `__renderGallery()` —— 原来只切 CSS class，从方格切回瀑布流时已生成的分组头会以裸文字**残留在页面上** | 真实数据（17 张摊到 6 个日期）：方格 6 段分组、无重复、从新到旧 ✓；切「最早优先」首组变 `2025 年 11 月 30 日`（顺序完全反转）✓；点 FAB 切瀑布流 → 分组头 0 且无残留日期文字、17 张卡片完整 ✓；再切回方格 → 6 段恢复 ✓；冒烟测试 **97 项仅 1 项失败**（仍需 `import-chars.js`）✓ |
| 队列卡片缩成小图方块 + 状态点（用户要求） | 队列改为**网格小方块**（`minmax(78px,1fr)` + `aspect-ratio:1`），卡片里只剩缩略图：去掉文件名 / 大小 / 状态文字 / ✎ 编辑按钮，改为**悬停才出现**一个圆形 × 删除键；左上角新增状态点（待上传=黄 `#ffd60a`、成功=绿 `#30d158`、失败=橙黄 `#ff9f0a`，失败时卡片加红色内描边）；进度条贴到卡片底部。文件名 / 状态 / 相似图提醒统一写进 `title`（悬停可见）；`updateUqSimilarBadge` 改为写 `dataset.sim` 并刷新 title，不再依赖 `.uq-name-row` | jsdom 实测：卡片只含 `.thumb`/`.uq-dot`/`.u-del`/`.progress`，`.info`/`.name`/`.size`/`.sub`/`.status`/`.uq-ops`/`.u-edit`/`.uq-tags` 全部不存在 ✓；`title` 含文件名与大小 ✓；CSS 规则逐条核对（默认黄 / ok 绿 / err 橙黄 / `:hover` 显示删除键 / 网格 + 正方形）✓；冒烟测试 **97 项仅 1 项失败**（仍需 `import-chars.js`）✓。注：上传项编辑弹窗（`#uqModal`）随 ✎ 按钮一起失去入口，函数暂留未删 |
| 上传面板：手动上传 + 关闭提醒 + 顶部并排（用户要求） | 恢复「开始上传」按钮：`addFiles` 只更新按钮状态与提示（「已加入 N 张，点开始上传」），**拖入不再自动上传**；`startUpload` / `clearUploadQueue` / `removeUqItem` 全部恢复按钮状态联动。拖拽区与 URL 导入改为**并排**（新增 `.up-top` 弹性布局，窄屏回退单列）。关闭上传窗口时若还有未传完的图片，先 `confirm` 提醒一句，取消则不关；同意后清空列表并 `abort()` 在传请求（新暴露 `window.__uploadPendingCount` / `__clearUploadQueue`） | jsdom 实测 5 组全 PASS：`.up-top` 并排结构 ✓；拖入后**不自动上传**且提示与按钮状态正确、pending=1 ✓；关闭时弹出提醒且点取消后窗口与队列都保留 ✓；点按钮后提示变「正在上传… (0/1)」✓；同意关闭后队列清空、按钮与提示复位 ✓。冒烟测试 **97 项仅 1 项失败**（仍需 `import-chars.js`）✓、CSS 配平 767/767 ✓ |
| 移除 AI 功能（用户要求） | 删除 `netlify/functions/ai-proxy.js` 整个函数；`app.js` 去掉 AI 设置、语义筛选（`aiFilter`）、「一键让 AI 解析标签」、快捷对话气泡及其 i18n 词条（整块 -250 行 + 十余处零散引用）；`index.html` 去掉设置页 AI 区块与聊天框（-61 行）；`style.css` 去掉 AI 样式（-184 行，含已无使用者的 `range` 滑块样式；`.switch` 因性能模式 / 水印 / R18 三处仍在用而保留）；`dev-server.js` 去掉多函数分发；`README.md` 去掉 4 处 AI 说明 | 代码里 AI 引用清零（仅剩 `data-aid` 这类误匹配）✓；`POST /api/ai/chat` → 404 ✓；冒烟测试与移除前**逐项一致**（91 项 4 项失败，均为示例数据形态所致）✓。注：`GALLERY-ROADMAP.md` 里还有 58 处 AI 历史/规划条目未动（它混合了变更日志，删历史条目会让文档对不上早前提交） |
| 上传不再选主分类（用户要求） | `index.html` 删掉上传面板的「主分类（必选 · 可多选）」区块与 `#upCats`、上传项编辑弹窗的 `#uqCatPick`；`app.js` 去掉「每张至少一个主分类」校验、全局主分类选择与行内覆盖逻辑（`uqRowCats` / `rowSendCats` / `window.__upCats` / `__refreshUpCatPicks`），上传请求不再发送 `categories`；顺手删掉因此变成死代码的 `.cat-pick.needs-attention` 与 `@keyframes catPulse` | 上传面板右栏只剩「全局标签」与标签槽 ✓；`#upCats` / `#uqCatPick` 已不存在、编辑弹窗只剩标签字段 ✓；不带 `categories` 上传 → HTTP 201 且 `categories: []`（照片记为未分类，之后仍可在编辑弹窗里补）✓；冒烟测试 **97 项仅 1 项失败**（唯一失败项仍需先跑 `import-chars.js`）✓。**保留**：已有照片的分类数据、筛选菜单的分类区、标签管理里的主分类管理、编辑 / 批量 / 整理视图里的主分类设置 —— 只改了上传这一环 |

**尚未改动（建议下一批）**：P1-7 后半段（上传改 `FormData`，彻底去掉 base64 往返）、P2-13 CSS 动画瘦身（`transition: all` / 动画 blur / 常驻光斑）、P2-14 死代码清理（约 26 个零引用 class + `style.css:1602-1745` 详情页整段 + 已废弃路由）、P2-15 用量统计漏算缩略图、P2-20 脚本护栏（`upload-batch.js` dry-run / 生产域名护栏）。

---

## 一、P0 · 会造成数据丢失或安全问题（建议优先处理）

### 1. 「清空图库」会连带删掉访问密码与相册配置
- 证据：`netlify/functions/photos.js:692-710`。`clearAll()` 用无 prefix 的 `s.list()` 遍历**全部** key，只跳过 `tags-config` 与 `logs`，其余一律 `delete` —— 其中包括 `auth-config`（`netlify/functions/_lib.js:198`）和 `albums-config`（`photos.js:33`）。
- 后果：清空图库后访问密码消失。此时 `checkAuth()` 走「未设访问密码 = 门禁关闭」分支，并把所有匿名请求当作 **admin**（`_lib.js:240-243`）→ 站点彻底开放（可上传/删除/清库）；若环境变量 `ADMIN_TOKEN` 仍在，密码会被重置成它。
- 改法：保留名单加上 `KEY_AUTH` / `KEY_ALBUMS` / `KEY_INDEX`；更稳妥的做法是只删除 `img/`、`thumb-`、`meta/` 三种前缀。

### 2. 列表索引是无锁「整表读改写」，并发上传必丢图
- 证据：`photos.js:371`（`indexSet` 整表序列化写回）、`photos.js:394-404`（`indexUpsert` 先整表读再改再写）、`photos.js:638`（上传时调用；此前还要 `await` sharp 生成缩略图，窗口很大）。
- 后果：两张图并发上传时，后写的索引覆盖先写的 → 照片在列表里消失但 meta/原图仍在（这正是 `reindex` 接口存在的原因）。索引 blob 越大，丢更新概率与成本越高。
- 改法（由轻到重）：
  1. 上传后不整表重写，改写一条独立的 `idx/<id>.json`，列表用 `list({prefix:"idx/"})` + 游标分页（改动最小、彻底消除竞态）；
  2. 分片 `idx/0..n.json`，每片 500 条；
  3. 保留现方案但加重读-比对-重试。

### 3. `/api/import` 的远程抓取是 SSRF
- 证据：`photos.js:764-766`：`await fetch(src)` 对协议、主机、体积、超时、重定向**均无校验**，抓到的内容直接进 Blobs。
- 后果：在内网/云环境可探测 `169.254.169.254` 等元数据地址，或把任意大文件写进图库撑爆配额（默认 quota 1GB，`photos.js:724`）。
- 改法：只允许 `http/https` 且主机命中白名单；加 15MB 上限、10s 超时（`AbortSignal.timeout`）、`redirect: "manual"` 或限制跳转次数；失败时记日志。

### 4. AI 代理完全无鉴权，且 Key 优先级与注释相反
- 证据：`netlify/functions/ai-proxy.js:10-23`：从不调用 `_lib.checkAuth()`；`process.env.ZHIPU_API_KEY || header` 实际是**环境变量优先**，但文件头注释写的是「后者优先（个人 Key）」；无速率限制。
- 后果：只要部署端配了 `ZHIPU_API_KEY`，任何人不带凭证即可白嫖额度；用户自带 Key 也永远用不上。
- 改法：加 `checkAuth` 门禁（观光模式可另给更低配额）；把 Key 取值改成 `req.headers.get("x-ai-key") || process.env.ZHIPU_API_KEY`；按 IP 做简单限流（Blobs 计数即可）。

---

## 二、P1 · 明显影响体验或可靠性

### 5. 首屏白下 323KB 拼音库，而且加载顺序是反的
- 证据：`public/index.html:844`（`pinyin-pro.min.js`，316KB raw / 约 142KB gzip，带 `defer`）与 `:845`（`app.js`，**无** `defer`）。普通脚本先执行，`defer` 脚本在文档解析完后才执行 → `app.js` 初始化时 `window.pinyinPro` 必为 `undefined`。
- 连带 bug：`app.js:3556-3567` 的 `pinyinOf()` 会把空结果写进 `pinyinCache` 并长期复用。若用户在拼音库下载完成前输入过拼音搜索，这次的空结果会一直被缓存，之后搜索仍失败。
- 改法：`pinyin-pro` 改成「首次触发拼音搜索时动态插入 `<script>`」（同时省掉首屏 142KB gzip）；或最低限度给 `app.js` 也加 `defer` 并让拼音库排在前面；`pinyinOf` 应在 `window.pinyinPro` 缺失时**不写缓存**。

### 6. 未配置访问密码 = 全站开放（部署注意事项）
- 证据：`_lib.js:240-243`（设计如此）。配合第 1 条，风险被放大。
- 建议：README 明确「必须设 `ADMIN_TOKEN`」；或在 `photos.js` 启动路径加一个「无密码时拒绝写操作」的环境开关（如 `GALLERY_REQUIRE_AUTH=1`）。

### 7. 前端上传的内存放大
- 证据：`app.js:2330-2353`（`File → readAsDataURL → Image → canvas → dataUrl`）、`2363-2369`（再生成缩略图 dataUrl）、`2462-2469`（整份 base64 塞进 JSON body）；队列中多张图的 `readAsDataURL` 几乎同时发起。
- 后果：单张图同时驻留 4~5 份副本；base64 还额外膨胀 33%，移动端大图容易 OOM 或长时间卡顿。
- 改法：队列并发限 1~2；改用 `createImageBitmap` + `canvas.toBlob` + `FormData` 上传（后端同时支持 multipart），彻底去掉 base64 往返；压缩参数（0.85 / WebP）抽成常量便于调优。

### 8. 每次上传都要全库扫一遍查重
- 证据：`photos.js:544-560` 的 `checkHash()` 遍历所有 meta 比对 sha1；前端每张上传前都调一次（`app.js:2369-2372`）→ 上传 N 张图合计 O(N²) 次读取。
- 改法：上传成功时写一条 `hash/<sha1> → id` 反查键（删除时同步删），查重变成一次 `get`。
- 附带说明：前端指纹取自**压缩后**的 WebP 字节，前后端口径一致，逻辑本身没问题；但压缩产物受浏览器编码影响，同一原图在不同环境下未必算出同一哈希 —— 真正的兜底是已有的 dHash 相似检测。
- 另：查重**只在前端做**，服务端上传路径（`photos.js:598-641`）从不调用 `checkHash` → 直接 curl 或改脚本就能无限重复上传同一张图，把 1GB 配额刷满。建议上传前服务端查一次（配合上面的 `hash/<sha1>` 反查键，成本极低）。

### 9. 缩略图懒生成会重写整个索引
- 证据：`photos.js:517-531`：命中不到缩略图时生成并 `indexUpsert` → 又是整表读改写。老库首次滚动会触发几十次全表读写。
- 改法：与第 2 条一起改成按条/分片写入，或懒生成后只更新一个轻量标记。

### 10. 操作日志可能静默丢失
- 证据：`photos.js:261 / 639 / 708 / 798` 等约 16 处 `logAction(...)` **都没有 `await`**；函数返回 Response 后运行时可能被冻结，Promise 未必跑完。日志本身是「读整份 500 条数组 → unshift → 整写」。
- 改法：改为 `await`（或 `context.waitUntil`）；日志按天分片 `logs/YYYY-MM-DD` 并只保留 30 天。

---

## 三、P2 · 性能、健壮性与可维护性

### 11. esbuild 打包了原生模块 sharp
- 证据：`photos.js:28` `require("sharp")`；`netlify.toml:5-7` 只有 `node_bundler = "esbuild"`，未声明 `external_node_modules`。
- 现状：线上目前**大概率正常**（缩略图/查重功能已在生产使用过），但这是靠 Netlify 构建镜像的隐式依赖，换镜像或升级 sharp 就可能报 `Could not load the "sharp" module using the linux-x64 runtime`。
- 改法：`netlify.toml` 加 `external_node_modules = ["sharp"]`，部署后验证一次缩略图接口。

### 12. 静态资源没有缓存头与安全头
- 证据：`netlify.toml` 全篇没有 `[[headers]]`；`index.html:9 / 845` 靠手写 `?v=20261022` 参数击穿缓存（容易忘记更新，一旦忘就更就是「改了没生效」）。
- 改法：加 `[[headers]]`：`/assets/*` → `Cache-Control: public, max-age=31536000, immutable`（配合内容哈希或保留 `?v=`），`/*` → `Cache-Control: no-cache` 用于 HTML；并补 `Content-Security-Policy`、`X-Content-Type-Options: nosniff`、`Referrer-Policy`、`X-Frame-Options: DENY`、`Permissions-Policy`。缩略图接口已正确设置 immutable（`photos.js:537`），可作为参照。

### 13. CSS 运行时代价偏高（苹果玻璃风的代价）
- 证据：`public/assets/style.css:908`（`.card { transition: all 0.6s }`）、`912 / 917`（动画化 `filter: blur()`）、`1262`（在 `@keyframes` 内动画 `backdrop-filter`）、`116-137`（两个常驻 `blur(140px)` 光斑）。
- 改法：只动画 `transform` / `opacity`；光斑改为静态图或减小半径；把这些重效果纳入已有的 `perf-lite` 开关（`app.js:5351 / 5401`）。`transition: all` 换成明确属性列表也能顺带避免意料外的布局动画。

### 14. 死代码可以清掉一批
- 实测：`style.css` 中 354 个唯一定义的 class 里，**26 个**在 `index.html` + `app.js` 中零引用，多为历史遗骸：灯箱信息面板 `detail-panel / detail-wrap / detail-stage / detail-actions / lb-title`（v0.37 已移除信息面板）、旧导航 `nav-btn / nav-prev / nav-next`、`skeleton / tag-pill / tk-mgr-*` 等；`style.css:1602-1745` 整段详情页样式可删。
- JS 侧残留：`app.js:841` 的 `R18_KEY_STORE`（v0.50 已删除该机制）、`2834` 的旧排序键清理分支。
- 注意：删前用类名全仓搜索复核（少数类名由字符串拼接生成，建议逐个确认）。

### 15. 后端已废弃路由建议删除
- `POST /api/photos/:id/image`（`photos.js:471` 起）：v0.45「旋转仅为预览」之后前端已无任何调用（全仓搜索无 `/image` 请求）；它还带「覆盖原图但返回 `immutable` 一年缓存」的隐患（`photos.js:465`），删掉即可一并解决。
- `POST /api/photos/reindex` / `reindex-dhash`：前端无入口，属运维接口，建议保留但加注释说明，或收进 `/api/meta/*` 分组。

### 16. 路由匹配过宽
- 证据：`photos.js:164 / 183 / 187` 等使用 `path.endsWith("/api/photos")`，形如 `/x/api/photos` 也会命中**破坏性**分支（DELETE 清库）；`photos.js:182` 会把 `GET /api/photos/reindex` 当成 id 去查。
- 改法：`path === "/api/photos"`，并把 `/api/photos/:id`、`/:id/raw`、`/:id/thumb` 收成一个正则 `^/api/photos/([\w.-]+)(?:/(raw|thumb))?$` 再分发方法。

### 17. 前端渲染重复劳动
- 证据：`app.js:1775 / 1783 / 1844`（`renderTagMenuContent` 每次 3~4 遍全量扫描，组循环内重复 `filter`）、`505-514`（后台补齐每页都重建标签菜单）、初始化触发 2~3 次全量渲染；`__photosGrown` 在 `shown ≤ 300` 时整屏 `innerHTML` 重建，视觉上会闪。
- 改法：一次扫描建索引（Map: 组 → 标签列表）、按需重渲染、追加时用 `DocumentFragment` 只插新增项。
- 好的一面：滚动链路本身没问题 —— `IntersectionObserver` + rAF 兜底，没有布局抖动。

### 18. 请求层缺超时与取消
- 证据：`loadData` 无请求序号（旧响应可能覆盖新数据）；`apiFetch`/XHR 无 timeout；`fetchAuthState` 把网络失败静默当成「无门禁」（`app.js`，只影响 UI 提示，后端仍会拦写操作）。
- 改法：加 `AbortController` + 序号校验；给写操作用户可见的错误态而不是静默降级。

### 19. dev-server 与线上行为不一致（已真实踩坑）
- 证据：`scripts/dev-server.js:87-97` 只按 `/api/` 前缀分发，**不校验** `photos.js:200-224` 的 `config.path` 白名单 → 漏加路由时本地一切正常、线上直接 404（v0.53 的 `/api/auth/tagger` 就是这么踩的，见 `photos.js:222` 的注释）。
- 另：本地内存模拟的游标是**数字偏移**（`dev-server.js:43-46`、`_lib.js:61-63`），真实 Netlify Blobs 的 cursor 语义不同 —— 「边列边删」（如 `clearAll`）在本地会漏删、在线上行为不确定。
- 改法：dev-server 复用一个从 `photos.js` 导出的路径白名单，命中不了就返回 404 并打印提示；`clearAll` 改为「先收集全部 key，再统一删除」，不依赖游标语义。

### 20. 脚本的危险默认值
- `scripts/upload-batch.js:16`：硬编码生产站点 `https://r-gallery.netlify.app`（与 package.json 名 `r-n-gallery` 也不一致），无 `--dry-run`、无重试、失败无重跑清单、逐张串行。
- `scripts/migrate-photos.js`：dry-run 不是默认行为。
- `scripts/dom-smoke-test.js`：用 `GALLERY_URL` + `GALLERY_TOKEN` 可直连生产（`:303` 以「没有 TOKEN」判定为本地），且测试内容含创建/改名/删除标签、整份 `PUT /api/tags`（`:488-539`、`:607-620`）。
- 改法：加「目标非 localhost 时必须显式 `--prod --yes`」护栏；上传脚本默认 dry-run、支持重试与 `failed.txt` 重跑；`package.json` 补 `upload`、`reindex` 等入口脚本。

---

## 四、P3 · 锦上添花

21. **文档不一致（README）**：目录结构写的是根下的 `index.html`/`assets/`（实际在 `public/`）；提到 `DESIGN.md`（实际是 `GALLERY-ROADMAP.md`）；「已移除登录/鉴权」与 `_lib.js:235-248` 的完整门禁 + 观光/整理模式矛盾；API 表缺 `/api/auth/*`、`/api/export`、`/api/import`、`/api/tags/category-rename|remove`、`/api/photos/reindex*`；版本号 `0.9.4` / `0.13.6` 与 `package.json` 的 `0.9.0`、git 的 `v0.53` 都不一致。
22. **`GALLERY-ROADMAP.md`（91KB）**建议拆分：`docs/roadmap.md`（规划）+ `docs/changelog.md`（变更日志），并补 v0.53 条目、删除已废弃的 R18 密钥等过期内容；文中「app.js 约 900 行 / style.css 约 2000 行」也早已失真（现为 5,984 / 3,998 行）。
23. **仓库卫生**：`scripts/data/` 下有 16 个 `backup-*.json`（100.7KB，`.gitignore` 已覆盖但磁盘仍在）→ 可直接清理；其中那份含 104 张照片元数据的备份建议移到仓库外保存。
24. **工程化缺口**：无 lint / format / CI / 测试入口。贴合「零构建」约束的最小方案：加 Biome（单文件二进制、无需配置即可 `biome check`）+ `npm run lint/format` + 一个 `npm run verify`（`node --check` 全文件 + 启动 dev-server 跑 `dom-smoke-test.js`）；有 GitHub 再用 Actions 串起来即可。
25. **无障碍**：弹窗缺 `role="dialog"` / `aria-modal` / 焦点管理；交通灯关闭键是 `<span>`，键盘不可达；`--text-faint` 在玻璃面板上对比度约 3.3:1（低于 4.5:1）。
26. **图片尺寸解析边界**：`_lib.js:136-181` 的 VP8L / VP8X 分支长度校验不足（按 24 字节判断，实际需 25/30），截断文件可能算出 `NaN` 尺寸；建议补长度守卫并统一用 `Number.isFinite` 校验。
27. **小瑕疵**：data URL 正则缺 `i` 标志（`photos.js:128`、`:481`，浏览器总是输出小写 `base64`，暂无实际影响）；上传 15MB 上限在 base64 解码**之后**才判断（`photos.js` 约 605-608），峰值内存放大到 ~55MB；`parseThumb` 的上限 3MB 同理。
28. **删除的孤儿风险**：`photos.js:682-684` 依赖 `meta.thumbKey` 自述来删缩略图，若并发懒生成刚写好 thumb 就会被漏删 → 无条件 `delete(thumbKeyOf(id))` 更稳。
29. **用量统计偏低**：`photos.js:713-726` 的 `stats()` 只累加原图 `size`，缩略图（每张约 30~80KB，占比可达 20%+）、meta、索引、日志都没算 → 显示的「已用空间」明显小于实际；`quota` 直接硬编码 1GB（`:724`），与套餐无关。建议把缩略图字节记进 meta 后一并统计，quota 从环境变量读并标注默认值来源。
30. **写入字段缺长度/合法性校验**：`title` 无上限（`photos.js:620/775`，整库导出会被撑大）、`tags` 未去重也未校验是否存在于标签配置（`:622`）、`takenAt` 完全信任客户端（`:623/670`）。建议 `title.slice(0,200)`、tags 去重 + 白名单、`takenAt` 用 `Date.parse` 兜底。
31. **id 生成用 `Math.random`**：`_lib.js:127-131` 的 `nanoid` 基于 `Math.random`（8 位）。观光模式下 raw/thumb 是匿名可访问的，id 就是唯一的「门票」，建议换成 `crypto.randomBytes` / `randomUUID().slice(0,12)`，零成本。
32. **本地文件存储的路径校验不严**：`_lib.js:20-24` 的 `safe()` 用 `p.startsWith(dir)` 判断，未加尾部分隔符 → 形如 `../photos2/x` 的同前缀兄弟目录可绕过。当前 key 由服务端生成、URL 中的 id 未解码（`%2F` 不会被还原），**暂不可利用**，属加固项：改用 `path.relative(dir, p)` 并校验不以 `..` 开头。
33. **运行时与文档小项**：`package.json` 的 `engines: ">=20"` 建议钉死为 `"20"` 或 `"22"`，避免 Netlify 解析到意外版本；`netlify.toml` 的 `publish = "public"` 与 README 写的 `publish = "."` 也对不上（README 过期，见第 21 条）。
34. **缩略图失败会整屏改拉原图**：`app.js:2058 / 5614 / 4368 / 3189` 把 `data-orig="${p.url}"` 写进每张卡片，`onerror` 回退直接换全尺寸原图 → 缩略图路由一旦 404/403，整屏卡片会同时下载原图（流量与内存双爆）。回退应指向占位图或带尺寸参数的降级缩略图，并限制重试次数。
35. **high 画质模式下网格直接拉原图**：`cardImgSrc` 在 high 模式返回原图 URL，与「缩略图够用」的策略冲突 → 一屏 30 张卡片就是 30 张全尺寸图。建议网格视图恒用 thumb（480px 足够），只在灯箱用原图；或给网格加 `srcset` 按容器宽度选。
36. **图片内存回收默认关闭**：`app.js:1688-1709` 的 `initImgRelease` 只在 `perf-lite` 开启时生效（`:1689`），默认体验是「滚过几屏后几十张全尺寸图常驻内存」。观察器已复用，成本极低，建议默认开启，仅在 high 画质下保守。
37. **搜索无防抖**：`app.js:5581-5585` 的 `input` 事件直接全库 `filter` + `innerHTML` 重建（`:5612`），并且逐项绑 `onclick`。建议 150ms 防抖 + 结果容器事件委托。
38. **错误条会把堆栈暴露给访客**：`app.js:9-21` 的 `#debugErr` 在生产环境也直接 `appendChild` 到 body，含 `error.stack` 前几行。建议加 `location.hostname === "localhost"` 判定或环境开关。
39. **监听器重复注册与全局钩子过多**：`initGallery` 若执行两次，`window.addEventListener("scroll")`（`app.js:2151`）与 `document.addEventListener("keydown")`（`:2208`）会重复注册且无法移除（只有 sentinel 做了幂等）；另有约 50 个 `window.__*` 可变钩子同时充当跨模块共享状态与测试钩子。建议注册前先 `removeEventListener`，或收进一个注册表。
40. **相册成员上限无提示**：前端 `photoIds` 只用 `includes` 判断（`app.js:1817`），后端写入时会 `slice(0, 2000)` 截断（`photos.js:317-318`）→ 大相册在前端看起来成员更多。建议前端同样提示上限。
41. **首次渲染的动效定时器**：`app.js:1716-1746` 给每张卡写 `transitionDelay` 并为每张卡建一个 `setTimeout` 清 delay（一次 120 张 = 120 个定时器）。改用 CSS（`:nth-child(-n+12)` / `animation-delay`）或一次批量清理。
42. **可维护性：约 270KB 单文件的渐进拆分路线**（保持零构建、每步可独立回滚）：① 纯函数 → `assets/js/util.js`（`esc/escAttr/fmtSize/hammingHex/sortPhotos` 等，无 DOM 无状态）；② 状态与常量 → `state.js` + `constants.js`（`PHOTOS/TAGS/ALBUMS/SORT_MODE` 与全部 `rn_*` key 集中，顺手统一「两套折叠持久化」不一致）；③ 网络层 → `api.js`（统一超时、`res.ok` 校验、请求序号防覆盖，一次解决第 18 条与 `fetchAuthState` 降级问题）；④ 渲染器 → `render/*.js`（含 `renderTagMenuContent` 单趟扫描版）；⑤ 交互控制器 → `features/*.js`。过渡方式：先多个 `<script defer>` 共享 `window.RNG` 命名空间，验证一轮后再切 `type="module"` + `import`。
43. **浅色主题可能只切了一半（建议实测）**：`style.css:6-99` 定义了 37 个编号式深色 `--s01`~`--s37`，而浅色主题（`style.css:2391-2403`）**只覆盖 13 个变量**（`--bg/--text/--text-dim/--text-faint/--shadow*/--accent-*`），所有 `--s*` 面板底色不随主题变化。若浅色模式下确有面板仍是深色，根因就在这里；根治办法是把 37 个编号色收敛成语义 token（`--surface-1/2/3`、`--line`）只留 4~6 个。
44. **13 个 CSS 自定义属性全站零引用**：`--s01 --s02 --s05 --s19 --s35 --w060 --accent-soft --accent-glow --blur-light --col-w --ease-bounce --shadow-lg --glass-border-strong`（`style.css:78-97` 区块）。其中 `--accent-soft` / `--accent-glow` 本可用来收掉散落的 `rgba(255,159,10,*)` 硬编码（约 20 处，如 `style.css:921/982/983`）——建议「保留变量、替换硬编码」，而不是直接删变量。
45. **首屏空窗没有占位**：`index.html:62` 的 `#grid` 初始为空，`#loadMore` 却常驻显示「加载中…」，等待 `/api/photos` 期间是纯黑屏。好消息是 `style.css:992-1002` 的 `.skeleton` + `@keyframes shimmer` **已经写好但全站零引用**，直接复用即可（这也让第 14 条的死代码清单少一项）。
46. **几处动画的是布局属性**：`style.css:1595 transition: width`、`2973 transition: width 0.6s`、`3145 transition: max-height` → 每帧触发 layout。宽度类改 `transform: scaleX(var(--p))`，折叠面板改 `grid-template-rows: 0fr/1fr`。另外 `style.css:439-443` 与 `:450` 是同一个 `.search-card:hover` 的重复声明（后者覆盖前者），`:1102` 与 `:1242` 的 `.lightbox` 也是二次重启同选择器，建议合并；`style.css:877` 的 `aspect-ratio !important` 根因是宽高比写在内联 style（`app.js:2058`），改成 `--ar` 自定义属性 + `.grid-square .card{--ar:1}` 就能去掉 `!important`。
47. **脚本上传的照片没有缩略图**：`scripts/upload-batch.js:53` 只发 `{dataBase64, title, tags}`，从不带 `thumbBase64`。虽然后端会懒生成（`photos.js:517-528`），但首次浏览每张都要现算 → 与第 35 条叠加后，脚本批量导入的图在网格里最容易变成「拉原图」。建议脚本端也生成并上传缩略图。
48. **行尾混用且无 `.gitattributes`**：`netlify/functions/photos.js`（1083 行）与 `public/assets/app.js`（5984 行）是 **CRLF**，其余 22 个文件是 LF。建议加 `.gitattributes`（`* text=auto eol=lf`，单独一次提交做全量 renormalize）+ `.editorconfig`（`charset=utf-8 / indent=2 / lf`）。
49. **测试依赖未声明，缓存目录膨胀**：`scripts/dom-smoke-test.js:19-23` 要求手工 `npm install --no-save --cache .npm-cache jsdom`，`package.json` 里没有 jsdom → 这是 `.npm-cache/` 涨到 **366MB** 的直接原因。建议把 `jsdom` 与 `@biomejs/biome` 放进 `devDependencies`，并用 `npm ci` 复现。
50. **脚本间重复实现，容易分叉**：分页拉取在 `migrate-photos.js:67-84` 与 `find-duplicates.js:38-56` 几乎逐行重复；`parseArgs` 写了 3 份且行为不一致（`find-duplicates.js:21-36` 无 `--help`、静默吞未知参数）；dHash 有两份实现且注释互相要求「保持一致」（`photos.js:85` vs `find-duplicates.js:60-78`）。建议抽 `scripts/lib/api.js`（fetch/headers/分页/参数解析）与 `scripts/lib/dhash.js`。
51. **`import-chars.js --reset` 会清空全部标签组**（`import-chars.js:182-186`，之后整份 PUT；好在有本地备份兜底 `:203-208`）—— 与 `upload-batch.js`、`migrate-photos.js` 一起，都应加「非本地目标必须显式确认」的护栏（见第 20 条）。
52. **历史体积**：`.git` 的 36MB 里约 **34.6MB** 是 v0.9.4 删除前 `image/` 目录的 243 个 blob，当前跟踪文件最大只有 323KB（`pinyin-pro.min.js`，属第三方 vendored，建议在文件头补版本与 license 说明）。若在意克隆体积，可用 `git filter-repo --path image --invert-paths` 重写历史（需重新 push，谨慎）。附带一条好消息：仓库已配置 remote `git@github.com:raven-null/R_N_Gallery.git`，**CI 是可以直接上的** —— 一个 workflow 跑 `npm ci → npm run check → npm run lint → npm test` 即可。

---

## 五、核实后排除的疑点（避免被误导）

- 「前端 sha1 查重口径与后端不一致」——**不成立**：`app.js:2463` 上传的就是 `app.js:2369` 算哈希用的同一个压缩后 dataUrl，前后端口径一致，查重逻辑有效（真正的弱点是「以压缩产物为指纹」）。
- **但 dHash 这条确实口径不同（待验证）**：前端 `dhashOfFile`（`app.js:2390`）对**原始 File** 缩放算感知哈希，服务端 `genDHash(buf)`（`photos.js:631`）对**压缩后 WebP** 算。前端「相似图片提醒」是拿本地算的值去比库中服务端算的值 —— dHash 对轻微压缩通常鲁棒，但建议实测几张已知相似图确认阈值 8 是否仍然有效。
- 「`POST /api/photos/reindex-dhash` 永远到不了」——**不成立**：`endsWith("/api/photos")` 对 `/api/photos/reindex-dhash` 为 false，该路由可达；只有 `GET /api/photos/reindex` 会被当成 id（第 16 条已收）。
- 观光模式的隐藏逻辑设计是**完整**的：列表分页前过滤 + `raw`/`thumb` 二次校验（`photos.js:420`、`:458`、`:514`），不是只藏列表。

---

## 六、建议动手顺序

1. **今天就能做完（低风险、收益高）**：修 `clearAll` 保留名单（P0-1）→ 给 `ai-proxy` 加门禁并修正 Key 优先级（P0-4）→ `netlify.toml` 加 `external_node_modules` + `[[headers]]`（P2-11/12）→ 清理 `scripts/data` 备份、修 README（P3-21/23）。
2. **这个迭代做**：索引改为按条写入（P0-2 + P1-9）→ `checkHash` 加 `hash/<sha1>` 反查（P1-8）→ 上传链路改 `FormData`/并发限流（P1-7）→ `importStatic` 加白名单与超时（P0-3）。
3. **有空再做**：拼音库懒加载 + 修缓存污染（P1-5）→ 死代码清理（P2-14/15）→ CSS 动画瘦身（P2-13）→ 脚本护栏与 `npm run verify`（P2-20 / P3-24）。
