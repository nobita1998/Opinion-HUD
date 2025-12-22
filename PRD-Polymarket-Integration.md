# PRD：Opinion HUD 接入 Polymarket（Gamma API）并双平台并行展示

## 1. 背景与目的

Opinion HUD 的核心价值是：当用户在 X（`x.com`）阅读推文时，能快速看到“与当前话题相关的预测市场”，并一键跳转查看/交易。

接入 Polymarket 的目的不是替换 Opinion，而是提供**概率来源的多样性**：
- 同一话题，两个平台往往给出不同的概率/流动性结构；
- 用户可在同一位置对比两边市场，从而更快形成判断。

## 2. 目标（Goals）

1. **匹配即展示**：只要 Opinion 或 Polymarket 任一平台匹配到市场/事件，即在推文旁显示 HUD 按钮。
2. **双平台并行**：若两个平台都匹配到，则在面板右侧**平行展示两个平台的市场列表**（并列两列）。
3. **实时概率**：面板打开时补全并展示每个平台的“当前概率/赔率”（按平台最合适的口径）。
4. **支持体育**：Polymarket 体育市场在 UI 中可正常展示与跳转（不要求客户端拼 `/sports/...` 路由）。
5. **性能可控**：对 X 页面滚动/大量推文场景不产生明显卡顿；请求有缓存与并发限制。

## 3. 非目标（Non-goals）

- 不做跨平台“同一市场”的强绑定/合并（例如自动判定两个平台市场完全等价并合并为一条）。
- 不在面板解释“为什么匹配”（保持当前产品哲学）。
- 不做交易下单能力（仍然只是跳转到平台官网/详情页）。

## 4. 术语

- **Provider**：市场平台来源（`opinion` / `polymarket`）。
- **Topic**：用于匹配的“话题单元”，可能是 Market 或 Event（multi）。
- **Binary**：二元 YES/NO 市场。
- **Multi**：
  - **GMP**：一个 Event 下有多个二元 Market（体育比赛常见的 3-way：主胜/平/客胜会拆成多个二元或多个市场组合）。
  - **Single-market multi-outcome**：单个 market 有多个 outcomes（若出现，作为 Phase 2）。

## 5. 用户故事（User Stories）

1. 用户刷到一条推文，右侧出现 HUD 图标；点击后看到“Opinion / Polymarket”两列候选市场。
2. 用户只看到单个平台命中（例如只有 Polymarket 有相关市场），仍然可以打开面板并查看概率。
3. 当 Polymarket 命中体育市场时，行为与其他市场一致：正常展示并可点击跳转到对应页面。

## 6. 产品交互与 UI 规格

### 6.1 触发与按钮显示

- 默认：当任一 provider 命中 ≥ 1 个结果，显示 HUD 图标/按钮。
- 若两边都无命中：不显示 HUD。
- Quote retweet：沿用现有逻辑（外层 `<article>` 聚合文本匹配，只显示一个图标）。

### 6.2 面板布局

#### A) 仅单平台命中

- 面板标题：`Markets Found`
- 内容区：单列列表（占满面板宽度）
- 顶部 badge：显示来源（`Opinion` 或 `Polymarket`）

#### B) 双平台均命中（核心）

- 面板标题：`Markets Found`
- 内容区：两列并行
  - 左列：Opinion markets
  - 右列：Polymarket markets
- 两列各自独立滚动或共享一个滚动容器（实现上二选一；优先共享滚动以减少滚动冲突）

### 6.3 列表项（Market Card）

每条 market/event 展示字段（按可用性降级）：
- 标题（event title 或 market question）
- 概率（见 8.1/8.2）
- 截止时间/开赛时间（`endDate` / `cutoffAt` / `gameStartTime`）
- 流动性/成交量（`volume`/`volumeNum`）
- 跳转按钮：`View` / `Trade`（保持现有命名风格即可）

Multi（Event）：
- 顶部显示 event 标题 + 一个跳转入口（跳 event 主页面）
- 子选项行：只显示 `YES xx.x%`（对齐现有 multi UI），并支持 `View all (N)`

### 6.4 排序与数量

- 每个 provider 默认最多展示 `N=3` 个结果（与现有一致）；可在 options 中配置。
- 排序建议（每个 provider 内部）：
  - 先按匹配分数（来自本地匹配）
  - 再按 `volumeNum`（或 volume）降序
  - 再按到期时间（更近优先）

### 6.5 体育展示策略（Polymarket）

- 体育市场可展示，但建议在卡片上增加轻量标记（例如 tag 文本：`Sports` / `NBA` / `Soccer`），用于降低噪声。
- 不强制把体育与非体育分栏（先跟随匹配与排序）；如噪声较大，再在 options 增加“体育单独分组”开关。

## 7. 数据架构与流程

### 7.1 本地匹配索引（data.json）

目标：每个 provider 都有一份“用于本地匹配”的索引，content script 不需要远程搜索接口即可完成匹配。

建议方案（二选一）：

**方案 A（推荐）：两份独立数据**
- `opinion-data.json`
- `polymarket-data.json`

**方案 B：合并为一份数据**
- `data.json` 中 `providers` 分区（结构更复杂，但只需一次下载）

匹配输出统一成：
```json
{
  "providers": {
    "opinion": { "matches": [...] },
    "polymarket": { "matches": [...] }
  }
}
```

### 7.2 后端构建（Polymarket）

数据源：Polymarket **Gamma Markets API**（HTTPS）
- Markets：`GET https://gamma-api.polymarket.com/markets`
- Events：`GET https://gamma-api.polymarket.com/events`
- Sports tags：`GET https://gamma-api.polymarket.com/sports`（用于识别/标记体育）

过滤（默认建议）：
- `closed=false`
- 过滤极短期：例如 `endDate - now < 60min` 直接跳过（避免 15 分钟到期市场；同时不至于把体育全过滤掉）
- 最低成交量：`volumeNum >= MIN_VOLUME`（例如 10k，可配置）

聚合：
- 优先按 `events[0].id` / `events[0].slug` 聚合为 event；event 下挂多个 markets 视为 multi/GMP。

LLM 处理：
- 对每个 event 生成 `keywords/entities/entityGroups`（与 Opinion 现有 pipeline 对齐）
- 输出倒排索引，用于 content script 本地匹配

### 7.3 扩展拉取与缓存

- `extension/background.js` 定时拉取：
  - Opinion：现有 data 源（保持不变）
  - Polymarket：新增 data 源
- 缓存到 `chrome.storage.local`，content script 读取后本地匹配。
- 失败降级：保留上一次成功缓存。

## 8. 实时概率（打开面板时补全）

### 8.1 Opinion 概率（现有）

沿用现有实现：
- `GET https://opinionanalytics.xyz/api/markets/wrap-events`
- `GET https://opinionanalytics.xyz/api/orders/by-asset/:assetId?page=1&pageSize=1&filter=all`

### 8.2 Polymarket 概率（MVP：Gamma 直出）

MVP 口径：
- 优先用 `outcomePrices`（通常 `0~1`）作为概率展示
- binary：YES=`outcomePrices[0]`，NO=`outcomePrices[1]`

实时刷新方式（打开面板时按需拉取）：
- 单 market：`GET https://gamma-api.polymarket.com/markets/slug/<market-slug>`
- event/multi：`GET https://gamma-api.polymarket.com/events/slug/<event-slug>`（返回 `markets[]`，每个 market 带 `outcomePrices`）

缓存与并发（建议与 Opinion 对齐）：
- price TTL：60s
- 并发上限：4
- 失败展示：`—`

> Phase 2：如需更实时/更贴近 orderbook，可用 `clobTokenIds` 对接 CLOB API 获取 bid/ask/mid。

## 9. 跳转规则（Trade/View）

### 9.1 Opinion

沿用现有：
- Event（multi）：`https://app.opinion.trade/detail?topicId=<eventId>&type=multi`
- Market：`https://app.opinion.trade/detail?topicId=<marketId>`

### 9.2 Polymarket（关键：体育）

统一入口（推荐且已验证可用）：
- 打开：`https://polymarket.com/event/<event-slug>`
  - 非体育：通常直接 200
  - 体育：通常 307 重定向到实际 `/sports/...` 路径（浏览器自动跟随）

说明：
- 不要求扩展自行拼 `/sports/<league>/games/week/<n>/<slug>`，避免联赛编码不统一导致跳转错误。

## 10. 配置项（Options）

建议新增配置（默认值可调整）：
- Providers：
  - `Enable Opinion`（默认 on）
  - `Enable Polymarket`（默认 on）
- 展示：
  - `Max results per provider`（默认 3）
  - `Show two columns when both match`（默认 on）
- Polymarket 过滤：
  - `Min volume (volumeNum)`（默认 10000）
  - `Min time to expiry (minutes)`（默认 60）
  - `Include sports`（默认 on）
  - `Sports badge`（默认 on）

## 11. 监控与指标（Success Metrics）

- 点击率：HUD icon CTR、各 provider 的跳转 CTR
- 覆盖率：有匹配的推文占比（整体/分 provider）
- 双命中率：Opinion 与 Polymarket 同时命中的比例
- 性能：面板打开到概率填充的 P95 延迟；请求失败率

## 12. 边界情况与降级

- Polymarket event/market 缺少 `slug`：降级到 `https://polymarket.com/search?q=<title>`
- `restricted=true`：仍展示，但可在卡片上标记（避免用户点开后不可访问造成困惑）
- multi 类型不一致：
  - GMP（event 下多个 market）：MVP 支持
  - single-market multi-outcome：Phase 2（或先用 outcomes/outcomePrices 在卡片内渲染）

## 13. 里程碑（Milestones）

Phase 1（MVP）
- 拉取并缓存 Polymarket 索引
- 本地匹配：任一 provider 命中即显示按钮
- 面板：双命中两列并行；概率补全（Opinion 走现有，Polymarket 走 Gamma）
- Polymarket 跳转：统一 `/event/<event-slug>`

Phase 2
- single-market multi-outcome UI
- 更实时价格（CLOB）
- 体育专属分组/过滤优化

## 14. 手动 QA Checklist（X Web）

- 任一平台命中：显示 HUD 图标；打开面板后正常渲染列表
- 双平台命中：两列并行展示；各自概率能加载；滚动不互相干扰
- Polymarket 体育：点击跳转到比赛页（允许 307 自动跳转）
- 弱网/失败：概率显示 `—`；不影响面板交互；不重复狂刷请求
