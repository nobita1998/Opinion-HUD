# Polymarket 对接问题清单（待确认）

目标：在 Opinion HUD 中接入 Polymarket，并实现与当前 Opinion 版本一致的体验（匹配 + 展示实时赔率/概率 + 一键打开主市场页）。

## A. 网页跳转（最关键）

1. **API 是否提供可直接打开的网页 URL？**
   - 是否存在字段：`eventUrl` / `webUrl` / `url` / `slug` / `eventSlug`（在 `GET /api/markets` 或 `GET /api/markets/wrap-events` 中）
   - 如果有：优先直接使用该 URL，避免自行拼接导致打开错误页面。

2. **体育类市场的网页路径规则**
   - 你已验证体育类会走：
     - `https://polymarket.com/sports/nba/games/week/.../nba-...`
     - `https://polymarket.com/sports/laliga/games/week/.../lal-...`
   - 需要确认：API 是否提供构造该 URL 所需信息（例如 league、week、match code 等），或者是否直接提供 `webUrl`。

3. **非体育类是否稳定为 `/event/<slug>`**
   - 需要确认：哪些市场类型走 `/event/<slug>`，哪些走其他路由（例如 `/sports/...`、`/markets/...` 等）。

4. **如果 API 不提供可用 URL 的降级方案**
   - 方案 A：打开搜索页 `https://polymarket.com/search?q=<title>`（保证可用，但非直达）
   - 方案 B：不提供跳转，仅展示赔率（最保守）

## B. Multi / Event 聚合与展开

5. **wrap-events 的 key 对应关系**
   - `GET /api/markets/wrap-events` 返回中的 WrapEvent `marketId` 对应：
     - `parentEventId` 还是 `parentEvent.eventMarketId`？
   - 这决定前端用哪个 ID 去查子选项。

6. **multi 的“主市场”定义**
   - multi/event 的“主市场页”应该跳到：
     - wrap/event 页面？还是某个子 market？
   - 你已要求：跳“主市场页”即可（需要明确主市场页的 URL 字段/规则）。

## C. 赔率/概率（价格）口径

7. **`orders/by-asset` 的 price 量纲**
   - `GET /api/orders/by-asset/:assetId` 的 `data[0].price` 是否恒为 `0~1`？
   - 如果是：展示为 `price * 100` 的百分比（保留 1 位小数）。
   - 如果不是：需要明确换算规则。

8. **“现价”是否应使用最新成交价**
   - 当前实现取“最新成交价”作为赔率展示。
   - 如果 Polymarket 有更合适的“现价”（best bid/ask、mid、mark price），需要确定对应 API。

9. **实时更新策略（可选）**
   - 是否要用 `ws://polymarket.api.predictscan.dev:10002/ws` 订阅 `assetId` 来推送更新，减少轮询？

## D. 数据源与 CORS/HTTPS

10. **是否允许浏览器端跨域请求（CORS）**
    - Chrome 扩展发起请求通常不受页面 CORS 限制，但仍建议确认服务端响应头与稳定性。

11. **是否有 HTTPS Base URL**
    - 当前 Base URL 是 HTTP：`http://polymarket.api.predictscan.dev:10002`
    - 如果要上架 Chrome Web Store，建议确认是否提供 HTTPS（更稳妥，也更容易过审）。

## E. 后端构建 data.json 的字段完整性

12. **可交易市场筛选字段是否可靠**
    - `statusEnum`、`resolvedAt`、`cutoffAt` 的语义在 Polymarket 数据里是否与 Opinion 一致？

13. **体育类/特殊类 market 的 `yesTokenId/noTokenId` 可能为空**
    - 你贴的样例中有市场 `yesTokenId/noTokenId` 为空字符串。
    - 需要确认：这是数据缺失、未上链、还是另一种市场类型？应如何在 UI 中处理（显示 “—” / 不展示 / 跳过）。

