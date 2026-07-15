# 字幕播放器 开发日志（DEVLOG）

> 本文件记录 `subtitle_video_player` 项目的关键决策、背景与未来方向。
> 聊天上下文会丢失，这里是沉淀下来的「硬资产」——决策为什么这么定、有哪些约束、以后往哪走。
> **新增内容请往后追加（带日期），旧条目保留作参考，不要删。**

---

## 2026-06-16

### 1. 发布渠道：GitHub Release（已落地，commit `aaa1c18`）

- **背景**：构建产物（单文件 HTML）需要分发出去。原本只通过 GitHub Action 推送到 DUFS。
- **决策**：在 workflow 里、DUFS 步骤**之前**增加发布到 GitHub Release。
  - 滚动单一 Release：固定 tag `subtitle-player-latest`、固定资产名 `subtitle_video_player.single.html` → **直链永不变**。
  - 每次构建删旧建新（`gh release delete --cleanup-tag --yes` 再 `gh release create`）。
  - 不保留历史版本（只要最新版）。
  - **去掉了 Artifact**：Artifact 占 Actions 存储配额，而产物有几十兆，会很快烧完配额；对外分发只靠 Release 即可。
- **意义**：Release 又快又稳（GitHub CDN，96MB 约 2 分钟传完），且排在慢吞吞的 DUFS 之前——所以即使 DUFS 上传失败，产物也早已可靠发布。
- 直链：`https://github.com/leolulu/macbookair-files/releases/download/subtitle-player-latest/subtitle_video_player.single.html`

### 2. DUFS / frp 上传约束（已知现状，接受不改）

- DUFS 通过 **frp** 暴露到公网；frp 中转服务器**带宽本身很低（~15 KB/s）**，连接很稳定，但这是物理上限，配置改不动。
- 96MB 的文件经 frp 上传需 ~2 小时，实测常在 **~82 分钟 / 75%** 处被掐断（`curl: (52) Empty reply from server`）。重传无用——每次重头来又是 2 小时。
- **决策**：**不动 DUFS / server 端**。本项目只管项目内的事，不碰服务器。push 到 DUFS 视为「尽力而为」，可靠渠道是 Release（见上）。
- 偶尔也能成功（如 run #33），所以保留现状即可。
- （可选，尚未做）给 DUFS 步骤加 `continue-on-error: true`，让它失败时整个 run 不标红。

### 3. OCR 体积解耦（进行中）

- **问题**：单文件膨胀到 ~96–100MB，**完全是因为构建脚本把 OCR 的模型/库 base64 内联**进了 HTML。
- **体积构成**（原始大小）：

  | 资产 | 大小 | 说明 |
  |---|---|---|
  | 4× ORT `*.wasm` | 40.7M | 运行时只用 1 个变体，却全打进来了 |
  | `ppocr_rec.onnx` + `ppocr_det.onnx` | 15.6M | 识别 / 检测模型 |
  | `opencv.js` | 9.6M | 图像预处理 |
  | `ort.min.js` | 0.5M | ONNX 运行时 |
  | `esearch-ocr.js` + 字典 | ~0.2M | OCR 封装 |
  | **播放器本体** | **~1–2M** | 真正要留下的部分 |

- **关键认知**：**运行时本来就是懒加载**——worker 只在加载 `.sup` 图像字幕、真正触发 OCR 时，才在 `paddle_ocr_worker.js` 的 `ensureReady()` 里去 `importScripts`/`fetch` 这些库和模型。100MB 是构建内联造成的，**不是运行时逻辑问题**。
- **使用背景（为什么这么设计）**：
  1. OCR 只用于**图像字幕（SUP / PGS）**；99% 场景是 SRT / JSON 字幕，根本不碰 OCR。
  2. OCR 开销大：一部电影的 SUP 字幕可能几千条，跑起来 CPU 满载，**户外 / 电池场景基本不可行**（撑不住）。
  3. OCR 有缓存（`js/cache/sup_ocr_cache.js`，机制待最终确认）：同一字幕跑过一次，下次直接读缓存。→ 可以**在家先跑一遍，在外面直接加载缓存**，无需现跑。
- **方案**：把重资产从单文件里拆出去，让 worker 在触发 OCR 时从 **jsDelivr（镜像本仓库文件、自带 CORS）按需下载**（浏览器自动缓存，二次秒开）。基础单文件降到 ~1–2MB（实测 668KB），SRT/JSON 全程不碰网络、不下任何模型。<br>（最初定的是 GitHub Release，后因 Release 无 CORS 改为 jsDelivr，详见下方 2026-06-16 续。）
- **决策记录**：
  - **托管在 jsDelivr（镜像本仓库、自带 `access-control-allow-origin: *`），不放 GitHub Release / DUFS**：GitHub Release 资产**不带 CORS 头**，浏览器里 worker `fetch()` 会被拦（已实测，见下方续）；DUFS 带宽太低。jsDelivr 走 CDN 又快又带 CORS，且直接镜像仓库文件，连发布资源包都省了。
  - **路径写死**，不做成用户可配置——要改是我们改代码，不该让用户操心。
  - **自动注入 commit SHA（不手动维护）**：构建时从 `GITHUB_SHA`（CI）或 `git rev-parse HEAD`（本地）取当前 commit，拼成 `@<SHA>` 基址。配合 workflow 对 `assets/**` 的触发：更新模型 + push → 自动重建并自动钉到新 commit，**没有任何要手动改的 SHA**，漏不了、也不会版本不一致。
  - **wasm 无需手动砍**：ORT 运行时只 fetch 它需要的那 1 个变体，仓库里 4 个 wasm 不会被全下，下载量天然最小。
  - **缓存**：先靠浏览器 HTTP 缓存，不上 Cache API。
  - **彻底替换**：只出轻量版，**不再保留**「全内联、可离线 OCR」的完整版（因为有缓存 + 在家预跑，离线完整版没必要）。
- **改动落点**：① `scripts/build_single-html.js`（停止内联重资产、注入基址、repoint worker 的 `resolveUrl` 与 `ort.env.wasm.wasmPaths`）；② `subtitle_video_player.html` 删掉主线程 eager 加载 `ort.min.js`/`opencv.js` 的死标签（已确认主线程未使用）。
- **红利**：本体降到 1–2MB 后，**第 2 节的 DUFS 上传难题基本自动消失**（每次只传 1–2MB，又快又稳）；那个几十兆的大包只需一次性传到 Release。

### 待确认 / 持续关注

- [x] **CORS（已验证 2026-06-16）**：GitHub Release 资产**无** CORS → 不可用；改用 **jsDelivr**（`access-control-allow-origin: *`）。worker 需要的 8 个资产在 `@<SHA>` 上全部可达且带 CORS。
- [ ] **OCR 缓存的确切机制**（`sup_ocr_cache.js`）：缓存键怎么算、是否持久化、换设备/清缓存是否复用。
- [ ] 将来确认 ORT 实际请求的 wasm 文件名后，可把 wasm 进一步砍到 1 个。

---

<!-- 新条目从这里往下追加，格式：## 日期 + ### 主题 -->

## 2026-06-16（续）

### OCR 解耦已落地；主机从 GitHub Release 改为 jsDelivr

- **为什么不是 GitHub Release**：实测 Release 资产 CDN（`release-assets.githubusercontent.com`）响应**没有 `access-control-allow-origin`**。浏览器里"点击下载"是顶层下载、不受 CORS 限制（所以平时下得动），但 worker 里 `fetch()` 读字节属于跨域程序化请求，会被浏览器直接拦——与下载速度无关。故 Release 这条路在浏览器里走不通。
- **改用 jsDelivr**：`cdn.jsdelivr.net/gh/<user>/<repo>@<SHA>/...` 直接镜像仓库文件，带 `access-control-allow-origin: *`，无大文件限制（11M 模型正常 206）。资产就是仓库里已有那份，**不用再发布资源包**。
- **实测（本机）**：11M 文件 ~1.1–1.4 MB/s；首次触发 OCR 总下载 ~37MB ≈ **~30 秒一次性**，之后浏览器缓存。对比 DUFS ~15KB/s（光一个 11M 模型就要 ~12 分钟）。
- **运行时去险**：worker 将来要拉的 8 个资产（`ort.min.js`、`opencv.js`、`esearch-ocr.js`、字典、`ppocr_det/rec.onnx`、2 个 wasm）在 `@<SHA>` 上**全部确认可达 + 带 CORS**。⚠️ 真实 OCR 推理（加载 `.sup`）尚未端到端跑过，建议用真实 `.sup` 文件做一次冒烟。
- **改动**：`scripts/build_single-html.js` 注入 `OCR_BASE_URL`（jsDelivr@SHA）、把 worker 的 `resolveUrl` 基址指向其镜像位置（保留 `../../assets/...` 目录结构，`wasmPaths` 随之正确）；删掉 HTML 主线程 eager 加载 `ort.min.js`/`opencv.js` 的死标签（已确认主线程未用 `cv`/`ort`）。
- **结果**：单文件 **~100MB → 668KB**。SRT/JSON/ASS 零网络；OCR 按需。
- **DUFS 红利**：本体只剩 668KB，第 2 节的 DUFS 上传难题自然消失——以后每次只传几百 KB。
- **维护（零手工）**：基址不再写死，构建时自动注入当前 commit SHA（`GITHUB_SHA` / `git rev-parse HEAD`）。更新 `assets/` 下模型/库并 push 即可——workflow 因 `assets/**` 触发，自动重建并自动钉到新 commit。⚠️ 唯一注意：jsDelivr 只能镜像**已 push 到 GitHub** 的 commit，所以本地"已提交但未 push"时若重新构建，OCR 资产会临时 404，push 后即恢复（Action 始终在 push 之后构建，不受影响）。

## 2026-07-14

### AI 对话功能（基于字幕上下文的 AI 问答）

- **功能**：选项区新增「AI对话」按钮，打开可拖动/缩放的浮动聊天窗；字幕全文（带时间轴）作为 system prompt，多轮流式对话。后端依赖 [doubao_backend](https://github.com/leolulu/doubao_backend) 的 `/stream` SSE 接口（POST，`fetch`+`ReadableStream` 手动解析，`EventSource` 不支持 POST）。
- **关键决策**：
  - **浮窗零布局侵入**：全部 `position: fixed` 挂 body，不动 CSS Grid，横/竖 × 正常/反转四种布局变体天然免疫；位置/大小存 localStorage（开合状态**不**持久化，新开/刷新页面默认关闭，要用再点按钮）；视口 ≤700px 自动近全屏。消息区底部有约一半可视高度的滚动缓冲（编辑器式），自动吸底锚定在"最新内容贴底边"，缓冲区留给手动上滚。
  - **每轮重发 system_message**（后端为替换语义，无副作用）：① 后端会话在进程内存里，服务重启后至多丢聊天记忆、字幕背景不丢；② 防剧透开关、超长截断窗口（15 万字符、以当前播放位置为中心滑动）每轮即时生效。
  - **会话 id 前端生成**（`svp-<ts>-<rand>`）+ 每轮 `preserve=true`；后端无清历史接口，「新对话」=换新 id。
  - **防剧透 = 全量字幕 + 提示语约束**（不做硬截断）：模型必须掌握全貌才有能力判断"什么算剧透"；提示语要求不透露当前位置之后的情节、用户明确接受剧透后才可展开。默认开。
  - **杀手级体验——位置注入**：每轮提问自动前缀 `[当前播放到 h:mm:ss，当前字幕:"…"]`，"这句什么意思"类问题免复述（可关）。
  - **时间点闭环**：system prompt 要求 AI 引用字幕时标注 `[h:mm:ss]`，前端正则转成可点击链接直接 seek（经 `getShiftedSubtitleTime` 换算 offset）。
  - **划选字幕气泡**：在字幕区划选文字弹出「查词 / 问AI…」。查词=免打字直发（语境释义模板，含出处句和时间点）；问AI=拉起浮窗+引用条（chip，不污染输入框）。窗口关着也能划选直达，观影流不中断。
  - **字幕更换自动新会话**：不侵入各字幕加载路径，改为发送时对比字幕指纹（条数+首末句），变了自动换会话 id + 提示。
  - **停止语义**与后端对齐：`preserve=true` 只在流正常完成后写历史，客户端 abort 的残缺回答不进上下文；UI 标注"已停止，本轮未计入对话记忆"并回填原问题。
  - **AI 文本渲染安全**：一律 textContent 构建 DOM，不走 innerHTML。
- **顺手修的老 bug**：全局倍速热键 `[` `]` `\` 原先不避让输入框（焦点在输入框打这些字符会变速）；字幕区划选松手会误触 click-to-seek（新增捕获阶段守卫：有选区时拦截字幕区所有点击跳转）。
- **联调工具**：`scripts/mock_ai_backend.py`（纯标准库），模拟 `/stream` SSE 协议，提问包含"触发错误"/"触发500"可测错误分支；`uv run python scripts/mock_ai_backend.py` 默认 11301 端口。
- **已知边界**：video 原生全屏时浮窗不可见（元素全屏遮蔽页面其余部分），不解；页面若以 https 承载而后端为 http 会被 Mixed Content 拦（本地 file:// / http 使用不受影响）。
