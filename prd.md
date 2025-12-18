# Product Requirements Document (PRD): Opinion HUD

| **Project Name** | Opinion HUD (Contextual Trading Layer for X) |
| :--- | :--- |
| **Version** | 1.3 (Final Release Candidate) |
| **Status** | **Ready for Development** |
| **Date** | 2023-10-27 |
| **Target Platform** | Google Chrome Extension (Desktop) |
| **Core AI Model** | Zhipu GLM-4.6 (Flash/Plus) |
| **Data Source** | Opinion Markets API (`http://opinion.api.predictscan.dev:10001/api/markets`) |

---

## 1. Executive Summary (项目概述)
**Opinion HUD** 是一款 Chrome 浏览器扩展，旨在消除社交媒体舆情与金融预测市场之间的“执行摩擦”。它采用“本地优先 + AI 预处理”架构，利用 **智谱 GLM-4.6** 的语义推理能力，将 Opinion 平台的预测市场与 X (Twitter) 上的相关推文进行实时匹配。

**核心价值：** 用户无需离开 Timeline，仅需悬停（Hover）即可发现相关市场并一键跳转交易，为 Opinion 输送高意向流量。

---

## 2. User Flow (用户路径)
1.  **Browse:** 用户浏览 X.com 信息流。
2.  **Detect:** 插件后台扫描推文，发现关键词（如 "Trump" 或 "BTC"）。
3.  **Notify:** 推文右下角出现微小的 Opinion Logo 图标。
4.  **Hover:** 用户鼠标悬停图标。
5.  **Display:** 弹出 HUD 卡片，显示市场标题、选项（Yes/No）及交易入口。
6.  **Action:** 用户点击卡片，携带 `ref` 参数跳转至 Opinion 交易页。

---

## 3. Technical Architecture (技术架构)

### 3.1 Architecture Overview
采用 **Zero-Latency Local-First** 架构。所有计算在后端预处理完成，前端仅负责极速匹配。

* **Data Pipeline (GitHub Actions):** Fetch API -> AI Keyword Gen -> Build Index -> Deploy JSON.
* **Client (Extension):** Download JSON -> DOM Observer -> Local Regex Match -> Render UI.

---

## 4. Backend & Data Pipeline (后端与数据处理)

**负责模块：** Python Script (运行于 GitHub Actions)
**运行频率：** 每 30 分钟

### 4.1 数据获取 (Data Fetching)
* **API Endpoint:** `GET http://opinion.api.predictscan.dev:10001/api/markets`
* **Authentication:** 无（全量拉取）
* **Response Structure:** 返回市场数组（部分实现可能包在 `{ "data": [...] }` 内）
* **处理逻辑：**
    1.  **扁平化处理 (Recursion):** 必须检查每个 Market 对象的 `childMarkets` 字段。如果存在子市场，需递归提取，将其视为独立的可交易条目。
    2.  **状态过滤 (Filter):** 仅保留 `statusEnum == "Activated"` 的市场。
    3.  **时间过滤:** 剔除 `cutoffAt` < 当前时间戳（秒）的市场。
    4.  **字段映射:**
        * `id`: `marketId`
        * `title`: 优先取 `marketTitle`，若空则取 `title`。
        * `labels`: 取 `yesLabel` 和 `noLabel` (用于 UI 展示选项)。
        * `volume`: `volume` (用于排序权重)。
        * `url`: 拼接 `https://opinion.trade/market/{marketId}`。

### 4.2 AI 语义扩充 (Semantic Enrichment)
* **Model:** Zhipu AI **GLM-4.6** (优先使用 `glm-4-flash` 以降低成本)。
* **Input:** 市场标题 + `rules` (作为上下文描述)。
* **Prompt 策略:** 要求生成 10-15 个关键词，必须包含：
    * 核心实体 (Entity): e.g., "Bitcoin", "Ethereum".
    * 同义词/代号 (Alias): e.g., "BTC", "ETH".
    * **行业黑话/俚语 (Slang):** e.g., "Orange Man" (Trump), "Corn" (BTC).
* **Output:** 纯 JSON 字符串数组。

### 4.3 索引构建 (Index Building)
* 构建 **倒排索引 (Inverted Index)**：`{ "keyword": ["market_id_1", "market_id_2"] }`。
* **规则：**
    * 所有关键词转为**小写**。
    * 生成的 `data.json` 推送至 CDN / GitHub Pages。

---

## 5. Frontend Logic (前端逻辑)

**负责模块：** Chrome Extension (Manifest V3)

### 5.1 数据同步
* 插件启动时及每 1 小时，请求 `data.json`。
* 对比 `meta.version`，若版本更新则写入 `chrome.storage.local`。

### 5.2 DOM 监听与匹配 (Core Engine)
* **Observer:** 使用 `MutationObserver` 监听 `body` 或 Timeline 容器的变化。
* **Target:** 锁定推文文本节点 `div[data-testid="tweetText"]`。
* **Performance:**
    * 实施 **Debounce (防抖)**：滚动停止后 100ms 再执行扫描。
    * 实施 **Cache**: 已扫描过的推文打上标记 `<div data-opinion-scanned="true">`，避免重复计算。
* **Matching:** 读取文本 -> 转换为小写 -> 本地正则匹配 -> 获取 Market ID。

### 5.3 匹配策略
* **多词优先:** 如果文本同时匹配 "Trump" 和 "Trump wins PA"，优先展示 "Trump wins PA" (更长/更具体的关键词)。
* **去重:** 同一屏幕内，同一市场 ID 的图标最多出现 3 次。

---

## 6. UI/UX Specifications (界面规范)

### 6.1 Trigger Icon (触发图标)
* **位置:** 注入到推文底部 Action Bar (Reply/Retweet/Like) 的最右侧。
* **样式:** 16x16px Opinion Logo。
* **状态:**
    * Default: Opacity 0.5 (灰度)。
    * Hover: Opacity 1.0 (品牌色)。

### 6.2 HUD Overlay (悬浮卡片)
* **触发:** Hover 图标停留 > 300ms。
* **样式:** * 宽度: 280px。
    * 背景: 仿 iOS 毛玻璃效果 (Backdrop-filter: blur)。
    * 适配: 自动检测 X 的 Light/Dim/Lights Out 模式调整文字颜色。
* **内容布局:**
    * **Header:** Opinion Logo + "Market Found".
    * **Body:** 市场标题 (最多 2 行)。
    * **Footer:** * 显示 `yesLabel` / `noLabel` (例如: "Yes / No" 或 "Biden / Trump")。
        * "Trade Now" 按钮 (CTA)。

---

## 7. Analytics & Tracking (数据埋点)

* **Referral Tracking:**
    * 所有跳转 URL 必须携带: `?ref=opinion_hud`。
* **UTM Parameters (Optional):**
    * `utm_source=twitter_extension`
    * `utm_medium=overlay`
    * `utm_term={matched_keyword}` (如果 API 支持，用于分析哪个关键词转化好)。

---

## 8. Non-Functional Requirements (非功能性需求)

* **隐私 (Privacy):** 严禁将用户推文内容上传服务器。所有 NLP 匹配必须在本地完成。
* **性能 (FPS):** 滚动帧率保持 60fps。正则匹配耗时 < 10ms。
* **兼容性:** Chrome v100+, Edge, Brave 浏览器。
* **API 容错:** 若 Opinion API 挂掉或数据为空，插件应静默失败，不报错打扰用户。

---

## 9. Acceptance Criteria (验收标准 - MVP)

| ID | 测试场景 | 预期结果 |
| :--- | :--- | :--- |
| **AC-01** | **复杂市场解析** | 后端脚本能正确解析包含 `childMarkets` 的嵌套结构，并将其扁平化为可索引的市场。 |
| **AC-02** | **精准匹配** | 推文包含 "Corn" (比特币黑话) 时，能弹出 Bitcoin 相关市场；包含 "Apple" (水果) 时不弹出 Apple (股票) 市场 (通过 Prompt 负向约束控制)。 |
| **AC-03** | **UI 注入** | 在 X 页面快速滚动时，图标注入位置准确，不发生偏移或闪烁。 |
| **AC-04** | **跳转归因** | 点击卡片跳转后，地址栏 URL 必须包含 `ref=opinion_hud`。 |

---
*End of Document*
