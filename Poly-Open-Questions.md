# Polymarket 对接问题清单（待确认）

目标：在 Opinion HUD 中接入 Polymarket，并实现与当前 Opinion 版本一致的体验（匹配 + 展示实时赔率/概率 + 一键打开主市场页）。

说明：如果采用官方 `https://gamma-api.polymarket.com`（Gamma Markets API），很多“待确认项”可以直接落地或降级处理（尤其是 slug、event 聚合、HTTPS）。体育类也能支持，但跳转建议走统一入口而非硬拼 `/sports/...`。

## A. 网页跳转（最关键）

1. **（Gamma 已解决）非体育类跳转**
   - Gamma 的 `GET /events` / `GET /markets` 都提供 `slug`
   - 非体育类可直接打开：`https://polymarket.com/event/<event-slug>`

2. **体育类市场的网页路径规则（Gamma 可支持）**
   - 你已验证体育类会走：
     - `https://polymarket.com/sports/nba/games/week/.../nba-...`
     - `https://polymarket.com/sports/laliga/games/week/.../lal-...`
   - Gamma 提供 `GET https://gamma-api.polymarket.com/sports`（包含每个 sport 的 tag IDs），可用于“识别/过滤/分组体育市场”
   - 跳转推荐：直接打开 `https://polymarket.com/event/<event-slug>`，体育会 307 到正确的 `/sports/...`（浏览器自动跟随）
   - 如果一定要生成 `/sports/...`：还需要 sport/league code + week 等字段规则；不同联赛不统一，容易拼错（不建议）

3. **非体育类是否稳定为 `/event/<slug>`**
   - 实测（且符合当前站点路由）：大部分非体育走 `/event/<slug>`
   - 保险起见：如果打开失败，可降级到搜索页

4. **如果 API 不提供可用 URL 的降级方案**
   - 方案 A：打开搜索页 `https://polymarket.com/search?q=<title>`（保证可用，但非直达）
   - 方案 B：不提供跳转，仅展示赔率（最保守）

## B. Multi / Event 聚合与展开

5. **（Gamma 已解决）Event 与子 market 展开（体育同样适用）**
   - `GET https://gamma-api.polymarket.com/events` 的每个 event 里自带 `markets[]`
   - 因此不需要 `wrap-events`，也不需要再纠结 key 对应关系

6. **multi 的“主市场”定义**
   - 建议统一跳 event 页面：`https://polymarket.com/event/<event-slug>`
   - 子 market 行只展示概率即可（不强制每行都有 Trade 跳转）

## C. 赔率/概率（价格）口径

7. **`outcomePrices` 的量纲与含义（Gamma）**
   - Gamma 的 market 返回 `outcomes`/`outcomePrices`（通常为 `0~1`）
   - 待确认：`outcomePrices` 是否可视为你要展示的“现价/概率”（以及它更像 AMM mark 还是 CLOB mid）

8. **“现价”口径选择**
   - Gamma 还提供 `bestBid`/`bestAsk`/`lastTradePrice`（二元市场可用）
   - 如果你坚持“最新成交价”：用 `lastTradePrice`
   - 如果你想更稳定：用 `outcomePrices`
   - 待定：HUD 最终采用哪一个作为默认（以及 multi 的展示口径）

9. **实时更新策略（可选）**
   - Gamma 本身是 REST；如果要更实时（尤其是多 market 同时展示），建议后续再对接 Polymarket CLOB API 的价格/推送能力
   - MVP 可先用 Gamma 的价格字段 + 低频刷新

## D. 数据源与 CORS/HTTPS

10. **是否允许浏览器端跨域请求（CORS）**
    - Chrome 扩展发起请求通常不受页面 CORS 限制，但仍建议确认服务端响应头与稳定性。

11. **HTTPS Base URL（Gamma 已解决）**
    - Gamma API 是 HTTPS：`https://gamma-api.polymarket.com`

## E. 后端构建 data.json 的字段完整性

12. **筛选字段是否可靠（Gamma）**
    - 建议以 `closed=false` + `endDate` 做有效期筛选
    - 用 `volumeNum` 做最低成交量阈值
    - 不做体育：用 `include_tag=true` + `/sports` 的 tag IDs 做排除

13. **token/outcome 映射（仍建议确认一次）**
    - Gamma 返回 `outcomes` / `outcomePrices` / `clobTokenIds` 都是 JSON 字符串数组
    - 待确认：这三者的顺序是否永远严格对齐（尤其是非 Yes/No 的市场）
