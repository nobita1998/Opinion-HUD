# Opinion HUD Backend (Data Pipeline)

## 目标

从 Opinion Markets API 拉取市场数据，并生成供前端匹配用的 `data.json`：
- 以 “Event（父事件）” 为主键聚合市场
- 使用 LLM（`GLM-4.6`）为每个 event 生成 `keywords` 与 `entityGroups`
- 构建倒排索引 `eventIndex`（关键词/实体 -> eventId 列表）

输出文件默认写入：`backend/data.json`

## 环境准备

```bash
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r backend/requirements.txt
```

## 运行方式

### 默认（只新增 + 用 LLM）

脚本默认会读取本地 `backend/data.json`，并且：
- 已存在的 event/market **不会被修改**
- 只对新增的 event 通过 LLM 生成 `keywords`/`entityGroups` 并追加

（`ZHIPU_KEY` 需在你的系统环境变量中）

```bash
python3 backend/build_index.py
```

### 全量重刷（重新生成所有 event）

```bash
ALL_REFRESH=1 python3 backend/build_index.py
```

### 增量模式（默认：尽量复用旧数据）

如需强制不调用 LLM（只复用旧数据），可启用 `INCREMENTAL_ONLY=1`：

```bash
INCREMENTAL_ONLY=1 python3 backend/build_index.py
```

## Polymarket（Gamma API）生成数据

新增脚本：`backend/build_poly_gamma.py`，用于从官方 Gamma Markets API 拉取 Polymarket 的 event/market 元数据并生成 `polymarket-data.json`（用于前端本地匹配与展示）。

### 运行（生产）

```bash
ZHIPU_KEY=... python3 backend/build_poly_gamma.py
```

默认输出：`backend/polymarket-data.json`

### 运行（测试：限制生成数量）

只生成前 N 个事件（会触发 N 次 AI 调用，并在终端打印每次调用的 start/done 日志）：

```bash
MAX_EVENT=20 python3 backend/build_poly_gamma.py
```

### 运行（无 LLM / 调试）

```bash
SKIP_AI=1 POLY_MAX_EVENTS=200 POLY_MIN_VOLUME_NUM=0 POLY_MIN_MINUTES_TO_EXPIRY=0 python3 backend/build_poly_gamma.py
```

### Polymarket 关键环境变量

- `POLY_GAMMA_API_BASE`：默认 `https://gamma-api.polymarket.com`
- `POLY_FRONTEND_BASE_URL`：默认 `https://polymarket.com`
- `OUTPUT_PATH`：输出路径（默认 `backend/polymarket-data.json`）
- `POLY_EXCLUDE_UPDOWN`：默认 `1`；过滤掉 `xxx-updown-5m/15m/...` 这类短周期 Up/Down 市场（设为 `0` 可包含）
- `POLY_EVENTS_PAGE_LIMIT`：分页大小（默认 `100`）
- `POLY_MAX_EVENTS`：调试用采样上限（不设则拉全量）
- `POLY_MIN_VOLUME_NUM`：最低成交量阈值（默认 `10000`，按 Gamma 的 `volume/volumeNum`）
- `POLY_MIN_MINUTES_TO_EXPIRY`：最短到期时间（默认 `60`，用于剔除 5m/15m 等短期市场；如要全量包含可设为 `0`）
- `POLY_MIN_MINUTES_TO_EXPIRY` 之外，脚本也会强制过滤 `endDate <= now` 的已结束 event/market
- `ZHIPU_KEY` / `SKIP_AI` / `INCREMENTAL_ONLY` / `PREVIOUS_DATA_URL` / `DEBUG`：与 `build_index.py` 相同语义

## 关键环境变量

- `OPINION_API_URL`：市场 API，默认 `http://opinion.api.predictscan.dev:10001/api/markets`
- `OUTPUT_PATH`：输出路径（默认 `backend/data.json`）
- `ZHIPU_KEY`：LLM API key（当 `INCREMENTAL_ONLY=0` 且 `SKIP_AI=0` 时必填）
- `INCREMENTAL_ONLY`：默认 `1`；开启后不调用 LLM，尽量复用旧输出
- `DISABLE_INCREMENTAL`：默认 `0`；开启后不读取旧 `data.json`
- `ALLOW_LEGACY_REUSE`：默认 `1`；允许在缺少签名字段时按 title 复用旧结果（全量重刷建议设为 `0`）
- `SKIP_AI`：默认 `0`；开启后用 fallback 关键词生成（不会生成 entityGroups）
- `PREVIOUS_DATA_URL`：可从远端拉取旧 `data.json` 用于增量复用
- `MAX_MARKET_NODES` / `MAX_MARKETS` / `MAX_EVENTS` / `MAX_EVENT`：调试用采样上限
- `SLEEP_SECONDS`：LLM 调用间隔（默认 `0.2`）
- `DEBUG`：打印更多日志

## 输出数据结构（概要）

`backend/data.json` 主要字段：
- `meta`：生成时间、数据源、模型名、统计信息
- `events[eventId]`：event 聚合对象（`title`、`keywords`、`entityGroups`、`bestMarketId` 等）
- `markets[eventId]`：前端兼容字段（当前实现将 event 也作为 market 输出）
- `eventIndex`：倒排索引（关键词/实体 -> eventId 列表）

> 注意：`eventId` 通常对应 “父事件 marketId / parentEventId”，不是具体子选项 marketId。前端会用 `/api/markets/wrap-events` 去拿子选项。

## 关于 URL 字段

`data.json` 里的 `url` 默认是 `https://opinion.trade/market/<eventId>?ref=opinion_hud`（历史跳转格式）。当前扩展实际跳转使用 `https://app.opinion.trade/detail`（见 `DEVELOPMENT.md`），因此该字段主要用于兼容与外部工具。
