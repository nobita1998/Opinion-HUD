# Opinion HUD 开发文档（架构与设计细节）

本文件是项目的完整开发文档，整合了历史 PRD、匹配策略与前端/后端实现细节。

## 1. 总览

Opinion HUD 的目标是在 **X 网页端**提供一个“上下文交易入口”：
- 后端离线构建匹配索引（`data.json`）
- 前端在浏览器里本地匹配推文文本
- 展示 HUD 面板，帮助用户快速打开对应的 Opinion 市场

关键原则：
- **隐私**：推文内容不上传服务器；匹配完全在本地进行
- **性能**：滚动体验优先；使用标记与去重避免重复扫描

## 2. 架构

### 2.1 数据管道（backend）

入口脚本：`backend/build_index.py`

流程：
1. 拉取市场：`OPINION_API_URL`（默认 `http://opinion.api.predictscan.dev:10001/api/markets`）
2. 扁平化 `childMarkets`（递归）
3. 过滤：
   - `statusEnum == "Activated"`
   - `resolvedAt` 为空或 0
   - `cutoffAt` 为空/0 视为未截止；否则必须 `cutoffAt > now`
4. 以 “父事件” 聚合：
   - 优先 `parentEvent.eventMarketId` / `parentEventId`
   - 无父事件则 `eventId == marketId`
5. 为每个 event 生成：
   - `keywords`：用于召回
   - `entityGroups`：用于精准 gate（AND-of-OR）
6. 构建 `eventIndex` 倒排索引（关键词/实体 -> eventId 列表）
7. 输出：`backend/data.json`

### 2.2 浏览器扩展（extension）

- Service worker：`extension/background.js`
  - 定时拉取 `data.json`（默认每小时一次）
  - 写入 `chrome.storage.local`
- Content script：`extension/contentScript.js`
  - `MutationObserver` 监听 feed 更新
  - 以 `<article>` 为单位扫描（支持 quote retweet）
  - 匹配成功则注入图标，并渲染 HUD

## 3. 数据结构与术语

### 3.1 Event vs Market（在本项目中的含义）

- **eventId / topicId**：用于匹配与跳转的主键（通常是父事件 marketId）
- **child market（选项）**：属于某个 event 的具体可交易子市场（例如 multi 的 `$10B`、`>$8B` 等）

本项目的 `data.json` 以 event 为粒度输出与匹配；HUD 中的“选项”由前端实时从 API 补全。

### 3.2 entityGroups（AND-of-OR）

`entityGroups` 是一个二维数组：
- group 内为 OR（任意命中即可）
- groups 之间为 AND（全部组都要满足）

示例：
```json
{
  "entityGroups": [["microstrategy"], ["bitcoin", "btc"]]
}
```
含义：推文必须同时提到 MicroStrategy 与 Bitcoin/BTC 才算匹配。

## 4. 匹配策略（前端）

### 4.1 召回 + Gate

1. **召回**：用 `eventIndex` 的关键词/短语找到候选 event
2. **Gate**：对每个候选 event 检查 entityGroups 是否满足（AND-of-OR）
3. **排序**：根据关键词命中强度与实体命中打分，取 TopN

### 4.2 Quote retweet 支持

X 的 quote retweet DOM 会嵌套 `<article>`。本实现会找到最外层 `<article>`，合并其下所有 `div[data-testid="tweetText"]` 作为一个文本进行匹配，并只渲染一个图标/面板。

## 5. HUD 展示与交互（前端）

### 5.1 图标位置

优先注入到推文 header 的 “…” 按钮左侧；找不到时回退注入到 action bar 的末尾。

### 5.2 面板位置与尺寸

- 优先在图标右侧与图标同一水平线，避免遮挡正文
- 空间不足时回退到左侧
- 面板有 max-height（随 viewport），列表区域可滚动

### 5.3 概率展示（实时补全）

HUD 的概率来自 Opinion Analytics API（按需请求）：
- `GET https://opinionanalytics.xyz/api/markets/wrap-events`
  - 通过 eventId 找到子市场列表
  - 子市场自带 `yesTokenId/noTokenId`
- `GET https://opinionanalytics.xyz/api/orders/by-asset/:assetId?page=1&pageSize=1&filter=all`
  - 取 `price` 作为概率（显示为 `xx.x%`）

规则：
- 二元市场：显示 `YES/NO`
- multi（多个选项）：每个选项只显示 `YES`
- 加载态：`YES …` / `NO …`，失败/无成交为 `—`

### 5.4 跳转 URL（Trade）

当前前端跳转使用 Opinion Web 的 detail 页：
- Event（multi）：`https://app.opinion.trade/detail?topicId=<eventId>&type=multi`
- 子选项（单个 market）：`https://app.opinion.trade/detail?topicId=<marketId>`

后端 `backend/data.json` 中的 `url` 字段仍会带 `ref=opinion_hud`（历史兼容），但前端目前不依赖该字段生成跳转链接。

## 6. 隐私与安全

- 推文内容仅在本地读取与匹配，不上传
- 仅拉取公开市场数据与公开成交价数据
- 详见：`PRIVACY_POLICY.md`

## 7. 开发与发布建议

- 数据管道建议用定时任务生成 `backend/data.json` 并发布到静态 CDN（如 GitHub Pages）
- 扩展默认从 GitHub Pages 拉取索引；更新索引不需要重新发版扩展
