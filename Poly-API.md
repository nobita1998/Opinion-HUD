# Polymarket API 对接清单（实现与当前 Opinion HUD 同等功能）

目标：把 Polymarket 接入后，实现与现在 Opinion 版本相同的体验：

- 后端：构建 `backend/data.json`（市场/事件标题、规则、截止时间、volume，以及 AI 生成的 `keywords/entities/entityGroups` + 倒排索引）。
- 前端：在 X（网页端）展示“Markets Found”面板，并**实时拉取赔率/概率**：
  - binary：显示 `YES/NO` 概率
  - multi：展示子选项列表（每行只显示 `YES` 概率），并支持 “View all” 在面板内展开全部选项并拉取价格

## 基础信息

### 推荐：官方 Gamma Markets API（市场/事件元数据 + 概率）

- Base URL：`https://gamma-api.polymarket.com`
- 文档：
  - `https://docs.polymarket.com/developers/gamma-markets-api/fetch-markets-guide`
  - `https://docs.polymarket.com/developers/gamma-markets-api/get-markets`
  - `https://docs.polymarket.com/developers/gamma-markets-api/get-events`
- 关键收益：
  - 直接提供 `slug`（非体育类可拼 `https://polymarket.com/event/<event-slug>`）
  - 直接提供 `events[].markets[]`（multi/event 展开不需要 `wrap-events`）
  - 直接提供 `outcomePrices`（可直接渲染概率；不必额外按 token 拉价）
  - 提供 `clobTokenIds`（需要更实时/更精细价格时再对接 CLOB）

### 旧方案：Predictscan 代理（当前文档里的 `/api/...`）

- Base URL：`http://polymarket.api.predictscan.dev:10002`
- 数据格式：JSON（通用响应 `{ success, data }`）
- WebSocket：`ws://polymarket.api.predictscan.dev:10002/ws`

注意：
- 该 Base URL 是 HTTP（非 HTTPS）。如果未来要用于 Chrome 插件商店发布，建议优先切到官方 `https://gamma-api.polymarket.com`（HTTPS），或确认代理是否有 HTTPS 入口。

## 前端（扩展）需要用到的 API（推荐：Gamma API）

### 0) 可配置过滤（短期 / 体育）

- 短期过滤（建议保留）：`end_date_min=<ISO>`（例如 `now + 24h/72h`）+ `closed=false`
- 体育开关：
  - 需要排除体育：`GET https://gamma-api.polymarket.com/sports` 拿体育 tag IDs，再用 `GET /markets?...&include_tag=true` 做客户端排除
  - 需要包含体育：不做排除；但建议把 sports 放到单独的 UI 分组/排序策略（数量大、更新快）

### 1) Markets 列表（用于匹配、概率展示、token 映射）

- `GET https://gamma-api.polymarket.com/markets`
  - 推荐参数：
    - `closed=false`
    - `limit` / `offset`（分页）
    - `order` / `ascending`（例如按 `volumeNum` 排序）
    - `end_date_min`（过滤短期）
    - `volume_num_min`（过滤低成交）
    - `include_tag=true`（用于体育过滤）
  - 关键字段：
    - `question`、`description`、`endDate`、`volumeNum`
    - `slug`（market slug）
    - `events[]`（包含 event 的 `id/slug/title/...`）
    - `outcomes` / `outcomePrices`（JSON 字符串数组）
    - `clobTokenIds`（JSON 字符串数组；顺序与 outcomes 对齐）

### 2) Events（用于 multi/event 展开）

- `GET https://gamma-api.polymarket.com/events`（分页；每个 event 里有 `markets[]`）
- `GET https://gamma-api.polymarket.com/events/slug/<event-slug>`（直查）

### 3) 概率/赔率（默认：直接用 `outcomePrices`）

- binary（`outcomes=["Yes","No"]`）：直接渲染 `outcomePrices[0]`（YES）与 `outcomePrices[1]`（NO）
- multi：
  - 若是 “一个 event 里多个二元 market”（GMP）：每个子 market 仍然用 `outcomePrices[0]` 当作该选项的 YES 概率
  - 若是 “单 market 多 outcomes”：需要 UI 额外支持（先可跳过）

### 4) 跳转 URL

- 统一入口（推荐）：直接打开 `https://polymarket.com/event/<event-slug>`（使用 Gamma event 的 `slug`）
  - 非体育：通常直接 200
  - 体育：通常会 307 重定向到实际的 `/sports/...` 路由（浏览器会自动跟随）

> 说明：体育的 `/sports/...` 路由包含 sport/league/week 等信息，不建议客户端硬拼；用 `/event/<slug>` 作为稳定入口更省事。

### 5) 搜索降级（可选）

- `GET https://gamma-api.polymarket.com/public-search?q=<text>`（当 slug/匹配不确定时可用于兜底）

## 前端（扩展）需要用到的 API（旧：Predictscan 代理）

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

## 后端（构建 data.json）需要用到的 API（推荐：Gamma API）

### `GET https://gamma-api.polymarket.com/markets`

用途：获取市场列表（分页），做基础过滤（不短期、非体育、最低成交量），再按 event 聚合，喂给 LLM 生成关键词/实体。

推荐做法：
- 拉取：`closed=false&limit=...&offset=...&include_tag=true&end_date_min=...&volume_num_min=...`
- 聚合：优先用 `events[0].id` / `events[0].slug` 作为 event key（一个 market 可能挂在多个 events 时需定义策略）
- 体育过滤：用 `GET https://gamma-api.polymarket.com/sports` 得到体育 tag IDs，然后过滤 markets 的 `tags[].id`

需要字段（用于筛选/聚合/上下文）：
- 筛选：
  - `closed`
  - `endDate` / `endDateIso`
  - `volumeNum`
  - `tags`（需 `include_tag=true`）
- 聚合：
  - `events[].id`、`events[].slug`、`events[].title`、`events[].description`
- 文本上下文：
  - `question`、`description`

## 后端（构建 data.json）需要用到的 API（旧：Predictscan 代理）

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

如果你走 **Gamma API**：

- `GET https://gamma-api.polymarket.com/markets` 与 `GET https://gamma-api.polymarket.com/events` 都会返回 `slug`，非体育类可直接打开：`https://polymarket.com/event/<event-slug>`。

如果你仍要走 **Predictscan 代理**（`/api/...`），仍需确认（用于构造 `<event-slug>`）：

- `GET /api/markets` 或 `GET /api/markets/wrap-events` 的返回里是否有可直接使用的 `slug` / `eventSlug` / `eventUrl` 字段？
  - 如果 API 不提供 slug/url，则不建议用 `title` 直接 slugify（同名/标点/大小写等会导致打开错误页面）；更稳妥的是让 API 直接返回 `eventUrl`。
- `/api/markets/wrap-events` 中 wrap 的 `marketId` 到底是 `parentEventId` 还是 `parentEvent.eventMarketId`？
  - 这决定了前端应该用哪个 ID 去 `wrap-events` 查子选项列表。
