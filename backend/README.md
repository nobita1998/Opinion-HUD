# Opinion HUD Backend (Data Pipeline)

## 目标

从 Opinion Markets API 拉取市场数据，并生成供前端匹配用的 `data.json`：
- 以 “Event（父事件）” 为主键聚合市场
- 使用 LLM（`glm-4.5-air`）为每个 event 生成 `keywords` 与 `entityGroups`
- 构建倒排索引 `eventIndex`（关键词/实体 -> eventId 列表）

输出文件默认写入：项目根目录的 `data.json`

## 环境准备

```bash
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r backend/requirements.txt
```

## 运行方式

### 默认（只新增 + 用 LLM）

脚本默认会读取本地 `data.json`（项目根目录），并且：
- 已存在的 event/market **不会被修改**
- 只对新增的 event 通过 LLM 生成 `keywords`/`entityGroups` 并追加

（`ZHIPU_KEY` 需在你的系统环境变量中）

```bash
python3 backend/build_index.py
```

### 全量重刷（重新生成所有 event）

```bash
FULL_AI_REFRESH=1 python3 backend/build_index.py
```

## Polymarket（Gamma API）生成数据

新增脚本：`backend/build_poly_gamma.py`，用于从官方 Gamma Markets API 拉取 Polymarket 的 event/market 元数据并生成 `polymarket-data.json`（用于前端本地匹配与展示）。

### 运行（生产）

```bash
ZHIPU_KEY=... python3 backend/build_poly_gamma.py
```

默认输出：`backend/polymarket-data.json`

### 运行（无 LLM / 调试）

```bash
SKIP_AI=1 POLY_MAX_EVENTS=200 POLY_MIN_VOLUME_NUM=0 POLY_MIN_MINUTES_TO_EXPIRY=0 python3 backend/build_poly_gamma.py
```

### Polymarket 关键环境变量

- `POLY_GAMMA_API_BASE`：默认 `https://gamma-api.polymarket.com`
- `POLY_FRONTEND_BASE_URL`：默认 `https://polymarket.com`
- `OUTPUT_PATH`：输出路径（默认 `backend/polymarket-data.json`）
- `POLY_EVENTS_PAGE_LIMIT`：分页大小（默认 `100`）
- `POLY_MAX_EVENTS`：调试用采样上限（不设则拉全量）
- `POLY_MIN_VOLUME_NUM`：最低成交量阈值（默认 `10000`，按 Gamma 的 `volume/volumeNum`）
- `POLY_MIN_MINUTES_TO_EXPIRY`：最短到期时间（默认 `60`，用于剔除 5m/15m 等短期市场；如要全量包含可设为 `0`）
- `POLY_MIN_MINUTES_TO_EXPIRY` 之外，脚本也会强制过滤 `endDate <= now` 的已结束 event/market
- `ZHIPU_KEY` / `SKIP_AI` / `INCREMENTAL_ONLY` / `DEBUG`：脚本自身使用的控制开关

## 关键环境变量

- `OPINION_API_URL`：市场 API，默认 `http://opinion.api.predictscan.dev:10001/api/markets`
- `OUTPUT_PATH`：输出路径（默认项目根目录 `data.json`）
- `ZHIPU_KEY`：LLM API key（不设置时，新 event 会用 fallback 关键词生成）
- `FULL_AI_REFRESH`：默认 `0`；设为 `1` 时对全部 event 重新调用 LLM 重刷
- `MAX_MARKETS` / `MAX_EVENTS`：调试用采样上限
- `SLEEP_SECONDS`：LLM 调用间隔（默认 `0.2`）
- `DEBUG`：打印更多日志

## 输出数据结构（概要）

`data.json` 主要字段：
- `meta`：生成时间、数据源、模型名、统计信息
- `events[eventId]`：event 聚合对象（`title`、`keywords`、`entityGroups`、`bestMarketId` 等）
- `markets[eventId]`：前端兼容字段（当前实现将 event 也作为 market 输出）
- `eventIndex`：倒排索引（关键词/实体 -> eventId 列表）

> 注意：`eventId` 通常对应 “父事件 marketId / parentEventId”，不是具体子选项 marketId。前端会用 `/api/markets/wrap-events` 去拿子选项。

## 关于 URL 字段

`data.json` 里的 `url` 默认是 `https://opinion.trade/market/<eventId>?ref=opinion_hud`（历史跳转格式）。当前扩展实际跳转使用 `https://app.opinion.trade/detail`（见 `DEVELOPMENT.md`），因此该字段主要用于兼容与外部工具。
