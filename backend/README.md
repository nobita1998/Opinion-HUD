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

### 全量重刷（推荐：重新调用 LLM）

```bash
INCREMENTAL_ONLY=0 DISABLE_INCREMENTAL=1 ALLOW_LEGACY_REUSE=0 ZHIPU_KEY=xxx python3 backend/build_index.py
```

### 增量模式（默认：尽量复用旧数据）

默认 `INCREMENTAL_ONLY=1`：复用已有 `backend/data.json` 的 event 结果，不调用 LLM。

```bash
python3 backend/build_index.py
```

## 关键环境变量

- `OPINION_API_URL`：市场 API，默认 `http://opinion.api.predictscan.dev:10001/api/markets`
- `OUTPUT_PATH`：输出路径（默认 `backend/data.json`）
- `ZHIPU_KEY`：LLM API key（当 `INCREMENTAL_ONLY=0` 且 `SKIP_AI=0` 时必填）
- `INCREMENTAL_ONLY`：默认 `1`；开启后不调用 LLM，尽量复用旧输出
- `DISABLE_INCREMENTAL`：默认 `0`；开启后不读取旧 `data.json`
- `ALLOW_LEGACY_REUSE`：默认 `1`；允许在缺少签名字段时按 title 复用旧结果（全量重刷建议设为 `0`）
- `SKIP_AI`：默认 `0`；开启后用 fallback 关键词生成（不会生成 entityGroups）
- `PREVIOUS_DATA_URL`：可从远端拉取旧 `data.json` 用于增量复用
- `MAX_MARKET_NODES` / `MAX_MARKETS` / `MAX_EVENTS`：调试用采样上限
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
