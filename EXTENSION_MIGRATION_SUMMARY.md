# Chrome 扩展 API 迁移完成总结

## 📝 修改日期
2025-12-27

## ✅ 完成的修改

### 1. extension/contentScript.js

#### 修改点 1: 更新 API 地址 (第 106-107 行)
```javascript
// 旧代码
const OPINION_API_BASE = "https://opinionanalytics.xyz/api";

// 新代码
const OPINION_API_BASE = "https://api.opinionhud.xyz/api";
```

#### 修改点 2: 删除缓存变量和 TTL 常量 (第 130-135 行)
**删除的内容**:
- `MARKETS_INDEX_TTL_MS` 常量
- `WRAP_EVENTS_INDEX_TTL_MS` 常量
- `marketsIndexCache` 变量
- `wrapEventsIndexCache` 变量
- `wrapEventsIndexInflight` 变量

#### 修改点 3: 删除 API 调用函数
**删除的函数**:
- `getMarketsIndex(signal)` - 原第 292-309 行
- `getWrapEventsIndex(signal)` - 原第 311-338 行

#### 修改点 4: 修改 getMarketAssetIds 从 data.json 读取 (第 292-304 行)
```javascript
// 新代码：从 state.data.markets 直接读取
async function getMarketAssetIds(marketId, signal) {
  const key = String(marketId);
  const cached = getCached(marketAssetCache, key, MARKET_ASSET_CACHE_TTL_MS);
  if (cached) return cached;

  // Read tokenIds directly from data.json (already loaded in state.data)
  const market = state.data?.markets?.[key];
  const yesTokenId = String(market?.yesTokenId || "");
  const noTokenId = String(market?.noTokenId || "");
  const entry = { ts: nowMs(), yesTokenId, noTokenId };
  marketAssetCache.set(key, entry);
  return entry;
}
```

#### 修改点 5: 更新价格 API 路径 (第 312 行)
```javascript
// 旧代码
const path = `/orders/by-asset/${encodeURIComponent(key)}?page=1&pageSize=1&filter=all`;

// 新代码
const path = `/token/${encodeURIComponent(key)}`;
```

#### 修改点 6: 修改 renderWrapEventGroup 从 data.json 读取 subMarkets (第 915-921 行)
```javascript
// 旧代码
const idx = await getWrapEventsIndex(abortController.signal);
if (!isHudAlive()) return;
const wrap = idx.get(String(wrapId)) || null;
const childrenRaw = wrap?.markets;
const children = Array.isArray(childrenRaw) ? childrenRaw : [];

// 新代码
// Read subMarkets directly from data.json (already loaded in state.data)
if (!isHudAlive()) return;
const market = state.data?.markets?.[String(wrapId)];
const childrenRaw = market?.subMarkets;
const children = Array.isArray(childrenRaw) ? childrenRaw : [];
```

#### 修改点 7: 删除 main() 中的预加载调用 (原第 1715-1716 行)
**删除的代码**:
```javascript
// Prefetch wrap-events index early so multi option lists show up immediately on first hover/click.
getWrapEventsIndex().catch(() => {});
```

---

### 2. extension/background.js

#### 修改点: 更新 API 白名单域名 (第 2 行)
```javascript
// 旧代码
const OPINION_API_ORIGINS = new Set(["https://opinionanalytics.xyz"]);

// 新代码
const OPINION_API_ORIGINS = new Set(["https://api.opinionhud.xyz"]);
```

---

### 3. extension/manifest.json

#### 修改点: 更新 host_permissions (第 12-15 行)
```json
// 旧代码
"host_permissions": [
  "https://opinionhud.xyz/*",
  "https://opinionanalytics.xyz/*"
],

// 新代码
"host_permissions": [
  "https://opinionhud.xyz/*",
  "https://api.opinionhud.xyz/*"
]
```

---

## 🚀 运行时 API 调用优化

### 旧方案 (3 个 API 调用)
1. `/api/markets` - 获取 tokenId 映射
2. `/api/markets/wrap-events` - 获取子市场列表
3. `/api/orders/by-asset/:assetId` - 获取价格

### 新方案 (1 个 API 调用)
1. `/api/token/:tokenId` - **仅获取价格**

**优化效果**:
- ✅ **减少 67% 的 API 调用**
- ✅ **更快的响应速度**（市场结构信息本地加载）
- ✅ **降低服务器负载**
- ✅ **简化前端逻辑**

---

## 📊 数据来源变化

### tokenId 和 subMarkets
- **旧方案**: 运行时调用 `/api/markets` 和 `/api/markets/wrap-events`
- **新方案**: 从 `data.json` 预加载（已在 backend/build_index.py 中添加）

### 价格数据
- **旧方案**: `/api/orders/by-asset/:assetId`
- **新方案**: `/api/token/:tokenId` (自建 Vercel API，代理 Opinion.Trade OpenAPI)

---

## 🧪 测试要点

### 1. 二元市场测试
- **市场**: Market 3062 (Trump)
- **期望**: 悬停推文后，HUD 显示 YES/NO 价格
- **验证**: 价格从 `https://api.opinionhud.xyz/api/token/:tokenId` 获取

### 2. 多选市场测试
- **市场**: Market 217 (Pikachu)
- **期望**: 悬停推文后，HUD 显示子市场列表及各自 YES 价格
- **验证**: 子市场列表从 `data.json` 的 `subMarkets` 字段读取

### 3. 网络请求验证
- **工具**: Chrome DevTools → Network tab
- **期望**:
  - ✅ 不应看到 `/api/markets` 请求
  - ✅ 不应看到 `/api/markets/wrap-events` 请求
  - ✅ 只应看到 `/api/token/:tokenId` 价格请求
  - ✅ 所有请求域名为 `api.opinionhud.xyz`

### 4. 缓存验证
- **操作**: 短时间内重复打开同一市场的 HUD
- **期望**: 第二次打开应从缓存加载（60秒 TTL）
- **验证**: Network tab 中不应看到重复的价格请求

### 5. 错误处理
- **操作**: 断开网络，尝试打开 HUD
- **期望**: 价格显示为 "—"，不应崩溃
- **验证**: Console 中无 JavaScript 错误

---

## 🔗 相关文件

### 前端代码
- `/Users/nobita/projects/coins/Opinion-HUD/extension/contentScript.js`
- `/Users/nobita/projects/coins/Opinion-HUD/extension/background.js`
- `/Users/nobita/projects/coins/Opinion-HUD/extension/manifest.json`

### 后端代码 (已完成)
- `/Users/nobita/projects/coins/Opinion-HUD/backend/build_index.py` - 已添加 tokenId 和 subMarkets 字段

### API 代码 (已部署)
- `/Users/nobita/projects/coins/Opinion-HUD/vercel-api/api/token/[tokenId].js`
- **部署 URL**: `https://api.opinionhud.xyz/api/token/:tokenId`

---

## 📈 版本更新

manifest.json 中版本已更新为 `1.1.0`。

---

## 🎯 下一步

1. **在 Chrome 中加载扩展**
2. **访问 X.com 进行实际测试**
3. **验证所有功能正常工作**
4. **如果测试通过，打包发布新版本**

---

**修改完成时间**: 2025-12-27
**API 部署状态**: ✅ 已部署并测试成功
**前端代码状态**: ✅ 修改完成，待测试
