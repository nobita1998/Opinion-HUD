# Opinion-HUD

Opinion HUD 是一个 Chrome 扩展（Manifest V3），用于在 **X 网页端**浏览推文时快速发现匹配的 Opinion 预测市场，并在页面内展示市场列表与实时概率（本地渲染 + 轻量 API 拉取）。

核心特性：
- 本地优先：推文内容只在本地匹配，不上传服务器
- 后端预处理：用 LLM（`glm-4.5-air`）为市场生成 `keywords` + `entityGroups`
- 前端极速匹配：`MutationObserver` + 倒排索引 + entity gate（AND-of-OR）
- HUD 展示：展示市场/选项，概率从 Opinion Analytics API 拉取并带 loading

## 目录结构

- `extension/`：Chrome 扩展（content script + service worker + options）
- `backend/`：Python 数据管道（抓取市场、LLM 生成实体/关键词、构建 `data.json`）
- `DEVELOPMENT.md`：完整开发文档（架构与设计细节）

## 快速开始（开发）

### 1) 生成 `data.json`（backend）

```bash
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r backend/requirements.txt

# 全量重刷（会调用 LLM）
FULL_AI_REFRESH=1 ZHIPU_KEY=xxx python3 backend/build_index.py
```

输出默认写入项目根目录 `data.json`（可用 `OUTPUT_PATH` 修改）。

### 2) 加载扩展（extension）

1. 打开 `chrome://extensions`，开启 Developer mode
2. 点击 “Load unpacked”，选择 `extension/`
3. 打开扩展 Options 页面，点击 “Refresh Data Now”

## 文档入口

- 前端（扩展）文档：`extension/README.md`
- 后端（数据管道）文档：`backend/README.md`
- 全量开发文档（架构/设计/数据结构）：`DEVELOPMENT.md`
- 隐私政策（上架用）：`PRIVACY_POLICY.md`（静态页：`privacy.html`）
