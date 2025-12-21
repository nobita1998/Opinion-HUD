# Polymarket API 对接清单（实现与当前 Opinion HUD 同等功能）

目标：把 Polymarket 接入后，实现与现在 Opinion 版本相同的体验：

- 后端：构建 `backend/data.json`（市场/事件标题、规则、截止时间、volume，以及 AI 生成的 `keywords/entities/entityGroups` + 倒排索引）。
- 前端：在 X（网页端）展示“Markets Found”面板，并**实时拉取赔率/概率**：
  - binary：显示 `YES/NO` 概率
  - multi：展示子选项列表（每行只显示 `YES` 概率），并支持 “View all” 在面板内展开全部选项并拉取价格

## 基础信息

- Base URL：`http://polymarket.api.predictscan.dev:10002`
- 数据格式：JSON（通用响应 `{ success, data }`）
- WebSocket：`ws://polymarket.api.predictscan.dev:10002/ws`

注意：
- Base URL 是 HTTP（非 HTTPS）。如果未来要用于 Chrome 插件商店发布，建议确认是否有 HTTPS 入口；同时确认是否允许来自扩展的跨域请求（CORS）。

## 前端（扩展）需要用到的 API

### 1) 市场 → Token IDs（用于查价格）

用途：把 `marketId` 映射到 `yesTokenId/noTokenId`，以便后续按 token 拉最新成交价。

你提供的 `/api/markets` 返回片段已验证：
- `marketId` 是 **0x 开头的 hex 字符串**（看起来与 `conditionId/questionId` 一致）。
- 同时也存在 `parentEventId`（字符串数字）和 `parentEvent.eventMarketId`（字符串数字），用于把子市场聚合到 “事件/主市场”。

优先使用（一次拉全量并缓存）：
- `GET /api/markets`
  - 需要字段（每个 market）：
    - `marketId`
    - `yesTokenId`
    - `noTokenId`
    - `parentEventId`、`parentEvent.eventMarketId`（用于 multi/event 聚合与展示主市场）

备选（按需查）：
- `GET /api/markets/asset-ids/:marketId`
  - 返回字段：
    - `data.marketId`
    - `data.yesTokenId`
    - `data.noTokenId`

### 2) multi/event → 子选项列表（用于渲染 multi）

用途：把一个 “event（wrap）” 展开为多个子选项 market，用于 multi UI。

- `GET /api/markets/wrap-events`
  - 需要字段：
    - WrapEvent 的 `marketId`（wrap/event ID）
    - `markets[]`（子市场列表），每个子项：
      - `marketId`
      - `title`
      - `yesTokenId`（multi 每行展示 YES 概率）
      - `noTokenId`（仅在“wrap 只有 1 个子市场”的兼容路径里用于展示 NO）

前端对应 UI 规则（对齐当前实现）：
- event header 保留一个“打开市场页面”的入口（不是每个子选项都有 Trade）。
- 子选项行：只显示 `YES xx.x%`，不显示 Trade。
- “View all (N)”：在面板内展开剩余子选项，并为新增行拉取 YES 价格（带 loading）。

### 3) Token → 最新成交价（概率/赔率）

用途：给定 token（assetId），取最新成交价并展示为概率百分比。

- `GET /api/orders/by-asset/:assetId?page=1&pageSize=1&filter=all`
  - 需要字段：
    - `data[0].price`（字符串，保留三位小数）
  - 处理：
    - 转成 `float`，如果该 `price` 是 `0~1`，则乘 100 变成百分比（保留 1 位小数）。
    - 建议你用 2~3 个已知市场用 `curl` 验证一次价格量纲（通常是 `0~1`）。

可选（更实时）：WebSocket 订阅订单更新
- 连接：`ws://polymarket.api.predictscan.dev:10002/ws`
- 订阅频道：`assetId`（用 tokenId/assetId 订阅）

## 后端（构建 data.json）需要用到的 API

### `GET /api/markets`

用途：获取全量市场列表，筛选可交易市场，并按 `parentEvent` 聚合成 event，再将事件信息喂给 LLM 生成实体/关键词。

需要字段（用于筛选/聚合/上下文）：
- 筛选：
  - `statusEnum`（Activated/Resolved 等）
  - `resolvedAt`
  - `cutoffAt`
- 标识与聚合：
  - `marketId`
  - `childMarkets`（如果存在）
  - `parentEvent.title`
  - `parentEvent.eventMarketId`（用于把子市场聚合到 event）
  - `parentEventId`（可作为 event 聚合的备用字段）
- 标题/规则（用于展示与 LLM 上下文）：
  - `marketTitle` / `title`
  - `rules`
- 排序/权重（可选但建议）：
  - `volume`
- 标签（可选）：
  - `yesLabel`、`noLabel`

## 仍需要你确认的关键信息（用于“打开市场页面”）

API 文档里给的是数据接口，但插件还需要一个“打开 Polymarket 市场页面”的 URL。你已确认网页端主市场页格式如下（跳到主市场页即可）：

- `https://polymarket.com/event/<event-slug>?tid=<timestamp>`
  - 示例：
    - `https://polymarket.com/event/which-company-has-best-ai-model-end-of-2025?tid=...`
    - `https://polymarket.com/event/will-trump-release-epstein-files-by?tid=...`

实现建议：
- `tid` 不是必需参数（用于追踪/防缓存），可直接省略，或在前端用 `Date.now()` 生成一个。

仍需你从 API 文档中确认（用于构造 `<event-slug>`）：

- `GET /api/markets` 或 `GET /api/markets/wrap-events` 的返回里是否有可直接使用的 `slug` / `eventSlug` / `eventUrl` 字段？
  - 你提供的 `/api/markets` 片段里暂时没看到这些字段。
  - 如果 API 不提供 slug/url，则不建议用 `title` 直接 slugify（同名/标点/大小写等会导致打开错误页面）；更稳妥的是让 API 直接返回 `eventUrl`。

另外建议你确认一件实现相关的映射关系（用于 multi 展开）：
- `/api/markets/wrap-events` 中 wrap 的 `marketId` 到底是 `parentEventId` 还是 `parentEvent.eventMarketId`？
  - 这决定了前端应该用哪个 ID 去 `wrap-events` 查子选项列表。
