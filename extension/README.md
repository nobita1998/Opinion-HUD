# Opinion HUD Extension (Frontend)

## 目标

在 **X 网页端（`x.com`）**的推文附近展示 Opinion HUD 图标；当发现匹配市场时，用户可点击/悬停打开面板，查看：
- 匹配到的 Market/Event 列表（最多 3 个）
- 二元市场：`YES/NO` 概率
- Multi（Event 下多个选项）：每个选项只展示 `YES` 概率

> 面板不解释“为什么匹配”，优先帮助用户更快找到市场并打开交易页。

## 安装（本地开发）

1. 打开 `chrome://extensions`，开启 Developer mode
2. 点击 “Load unpacked”，选择 `extension/`
3. 打开扩展 Options 页面（扩展详情 → Options）并点击 “Refresh Data Now”

## 数据来源

### 1) 匹配索引（`data.json`）

- Service worker（`extension/background.js`）每小时拉取一次 `data.json` 并缓存到 `chrome.storage.local`
- 默认 URL：`https://nobita1998.github.io/Opinion-HUD/data.json`
- content script（`extension/contentScript.js`）读取缓存后进行本地匹配

### 2) 概率（实时补全）

HUD 中的概率不是来自 `data.json`，而是打开面板时按需请求：
- `GET https://opinionanalytics.xyz/api/markets/wrap-events`（拿 event 下面的子市场与 `yesTokenId/noTokenId`）
- `GET https://opinionanalytics.xyz/api/orders/by-asset/:assetId?page=1&pageSize=1&filter=all`（取最新成交价作为概率）

体验设计：
- 概率先显示 loading（`YES …` / `NO …`），请求完成后替换为 `xx.x%`
- 内存缓存：price 60s、wrap-events 10min（wrap-events 会在 content script 启动时预取，避免首次打开 multi 还要等待）
- 请求失败/无成交显示 `—`

## UI 行为（当前实现）

- 图标位置：注入到推文 header 的 “…” 按钮左侧（找不到时不显示，避免插错位置）
- 面板位置：优先显示在图标右侧、与图标同一水平线；空间不够则回退到左侧
- 面板高度：自适应 viewport，内容区可滚动（避免多个 multi 叠加撑出屏幕）
- Quote retweet：在外层 tweet item（outer `<article>`）聚合主贴 + 引用贴文本做一次匹配，只显示一个图标
- 交互：点击切换开关；同时支持悬停延迟打开（`HOVER_DELAY_MS`）

## 跳转（Trade）

- Event（multi）：打开 `https://app.opinion.trade/detail?topicId=<eventId>&type=multi`
- 子选项（单个 market）：打开 `https://app.opinion.trade/detail?topicId=<marketId>`

## 手动 QA（X Web）

1. Home / Profile / 单条推文页：有匹配时显示图标（在 “…” 左侧）
2. 点图标打开 HUD：不遮挡推文正文；列表可滚动
3. Quote retweet：引用贴文本也能触发匹配，且只出现一个图标
4. 概率 pill：先 loading，再填充为 `xx.x%`；multi 选项只显示 `YES`

## 测试用推文样本（Batch Test）

仓库内提供了测试推文样本：`backend/test-tweets/`（每行一条推文）。

使用方式：
1. 打开扩展 Options 页面
2. 找到 “Batch Test (Local Only)”
3. 复制 `backend/test-tweets/positive.txt` / `backend/test-tweets/negative.txt` 内容粘贴并运行

## 常见问题

### 看到 “Extension context invalidated”

这通常发生在你 reload 扩展后，旧的 content script 仍在页面里执行。当前实现会尽量捕获并静默停止；建议对 X 页面做一次硬刷新（Cmd+Shift+R）。
