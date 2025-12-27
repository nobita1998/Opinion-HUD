# Opinion HUD v1.1.0 - 前端 API 迁移方案 PRD

## 文档版本
- **版本**: 1.0
- **日期**: 2025-12-27
- **状态**: Draft
- **对应需求**: prd_v.1_1_0.md 第3点

## 目标

**仅针对前端插件**：将 YES/NO 价格的 API 调用从第三方 `opinionanalytics.xyz` 迁移到自建 Vercel 服务（`opinionhud.xyz`）中转官方 Opinion.Trade OpenAPI，以提高稳定性和可控性。

**明确范围**：
- ✅ 前端 Extension 的价格 API 调用
- ✅ 优化：在 `data.json` 中直接包含市场的 tokenId 和子市场信息，减少运行时 API 调用
- ❌ 后端 GitHub Action 构建的 API 来源（保持使用第三方 API）

**优化收益**：
- 🚀 **性能提升**：运行时 API 调用从 3 个减少到 1 个
- 💰 **成本降低**：减少 67% 的 Vercel 函数调用和缓存使用
- ⚡ **响应更快**：市场结构信息本地加载，无需等待网络请求
- 🔧 **代码简化**：删除 `getMarketsIndex()` 和 `getWrapEventsIndex()` 等复杂逻辑

---

## 一、现状分析

### 1.1 前端当前使用的第三方API

| API 端点 | 用途 | 调用位置 | 缓存TTL | 并发控制 |
|---------|------|---------|---------|---------|
| `https://opinionanalytics.xyz/api/markets` | 获取 `marketId → {yesTokenId, noTokenId}` 映射 | `extension/contentScript.js:303` | 10分钟 | 通过limiter |
| `https://opinionanalytics.xyz/api/markets/wrap-events` | 获取多选市场的子市场列表 | `extension/contentScript.js:327` | 10分钟 | Promise去重 |
| `https://opinionanalytics.xyz/api/orders/by-asset/:assetId?page=1&pageSize=1&filter=all` | 获取代币最新成交价（概率） | `extension/contentScript.js:367` | 60秒 | 最多4并发 |

### 1.2 当前 data.json 缺失的信息

当前 `data.json` 只包含：
- ✅ 市场标题、URL、关键词
- ✅ yesLabel / noLabel
- ❌ **缺失：yesTokenId / noTokenId**（导致前端需要调用 `/api/markets`）
- ❌ **缺失：子市场列表**（导致前端需要调用 `/api/markets/wrap-events`）

### 1.3 第三方API的问题

1. **稳定性无保证**：第三方服务可能随时下线或更改API结构
2. **缺乏控制**：无法自定义缓存策略、限流策略、错误处理
3. **无法监控**：无法获取服务端日志和性能指标
4. **不必要的运行时调用**：市场结构信息在构建时就能获取，不需要运行时请求

---

## 二、官方API能力分析

### 2.1 官方API基础信息

- **Base URL**: `https://proxy.opinion.trade:8443/openapi`
- **认证方式**: HTTP Header `apikey: {your_api_key}`
- **限流策略**: 15 requests/second per API key
- **最大分页**: 20 items/page
- **区域限制**: 仅限日韩区访问
- **区块链**: BNB Chain (Chain ID: 56)

### 2.2 官方API端点映射

#### Market API

| 官方端点 | 方法 | 功能 | 认证 |
|---------|------|------|------|
| `/openapi/market` | GET | 获取市场列表（支持分页、筛选、排序） | ✅ Required |
| `/openapi/market/{marketId}` | GET | 获取二元市场详情 | ✅ Required |
| `/openapi/market/categorical/{marketId}` | GET | 获取分类市场详情（包含子市场） | ✅ Required |

**查询参数**:
- `page` (int): 页码，默认1
- `limit` (int): 每页数量，最大20，默认10
- `status` (string): 市场状态 `activated` | `resolved`
- `marketType` (int): 0=Binary, 1=Categorical, 2=All，默认0
- `sortBy` (int): 1=新建, 2=即将结束, 3-8=成交量排序
- `chainId` (int): 链ID筛选

**返回字段**（每个市场）:
```json
{
  "marketId": "int64",
  "marketTitle": "string",
  "status": "string",
  "statusEnum": "int",
  "yesLabel": "string",
  "noLabel": "string",
  "yesTokenId": "string",
  "noTokenId": "string",
  "conditionId": "string",
  "resultTokenId": "string",
  "volume": "string",
  "volume24h": "string",
  "volume7d": "string",
  "quoteToken": "string",
  "chainId": "int",
  "questionId": "int",
  "createdAt": "int64",
  "cutoffAt": "int64",
  "resolvedAt": "int64",
  "childMarkets": [...]  // 仅分类市场
}
```

#### Token API

| 官方端点 | 方法 | 功能 | 认证 |
|---------|------|------|------|
| `/openapi/token/latest-price?token_id={tokenId}` | GET | 获取代币最新价格 | ✅ Required |
| `/openapi/token/orderbook?token_id={tokenId}` | GET | 获取订单簿 | ✅ Required |
| `/openapi/token/price-history?token_id={tokenId}&interval={1m/1h/1d/1w/max}` | GET | 获取历史价格 | ✅ Required |

**`/openapi/token/latest-price` 返回**:
```json
{
  "tokenId": "string",
  "price": "string",
  "side": "string",
  "size": "string",
  "timestamp": "int64"
}
```

### 2.3 官方API响应格式

所有官方API统一响应格式：
```json
{
  "code": 0,           // 0=成功, 非0=错误
  "msg": "success",    // 消息
  "result": { ... }    // 实际数据
}
```

**错误码**:
- `0`: 成功
- `400`: 请求参数错误
- `401`: 未授权（API Key无效）
- `404`: 资源不存在
- `429`: 超出限流（15 req/s）
- `500`: 服务器错误

---

## 三、优化后的迁移方案设计

### 3.1 核心优化思路

**问题**：前端需要 3 个API调用才能显示价格
1. 获取 marketId → tokenId 映射
2. 获取子市场列表
3. 获取价格

**优化方案**：
- ✅ **后端构建时**：在 `data.json` 中直接包含 `yesTokenId`、`noTokenId` 和子市场信息
- ✅ **前端运行时**：只需调用 1 个价格 API：`/api/token/latest-price/:tokenId`
- ✅ **减少运行时 API 调用**：从 3 个减少到 1 个

### 3.2 架构设计

```
┌─────────────────────────────────────────────────────────────────┐
│                    Chrome Extension (全球用户)                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ extension/contentScript.js                                │  │
│  │                                                           │  │
│  │  1. 加载 data.json (包含 tokenId 和子市场)               │  │
│  │  2. 匹配关键词 → 获取市场信息                            │  │
│  │  3. 仅调用价格 API：                                      │  │
│  │     opinionhud.xyz/api/token/latest-price/:tokenId       │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    opinionhud.xyz Server (日本)                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ 中转API层 (无状态云函数/Vercel)                           │  │
│  │  - GET /api/token/latest-price/:tokenId                  │  │
│  │                                                           │  │
│  │ 特性：                                                    │  │
│  │  ✓ 服务端缓存（Vercel KV，TTL=1分钟）                     │  │
│  │  ✓ API Key管理（环境变量）                                │  │
│  │  ✓ 限流保护（15 req/s → 智能批处理）                      │  │
│  │  ✓ 错误重试（指数退避）                                   │  │
│  │  ✓ 响应格式转换（官方格式 → 兼容旧格式）                  │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│         Opinion.Trade Official API (日韩区限制)                 │
│  proxy.opinion.trade:8443/openapi/token/latest-price           │
└─────────────────────────────────────────────────────────────────┘
```

### 3.3 data.json 增强方案

#### 需要新增的字段

**二元市场** (`markets` 对象)：
```json
{
  "214": {
    "title": "Will BTC reach $100k?",
    "url": "https://opinion.trade/market/214?ref=opinion_hud",
    "yesTokenId": "0xabc...",  // 新增
    "noTokenId": "0xdef...",   // 新增
    "labels": {
      "yesLabel": "YES",
      "noLabel": "NO"
    },
    "keywords": [...]
  }
}
```

**多选市场** (`markets` 对象)：
```json
{
  "789": {
    "title": "Which candidate will win?",
    "url": "https://opinion.trade/market/789?ref=opinion_hud",
    "type": "multi",            // 新增：标识为多选市场
    "subMarkets": [             // 新增：子市场列表
      {
        "marketId": "789-1",
        "title": "Candidate A",
        "yesTokenId": "0x111...",
        "noTokenId": "0x222..."
      },
      {
        "marketId": "789-2",
        "title": "Candidate B",
        "yesTokenId": "0x333...",
        "noTokenId": "0x444..."
      }
    ],
    "labels": {
      "yesLabel": "",
      "noLabel": ""
    },
    "keywords": [...]
  }
}
```

---

### 3.4 中转API设计

#### `/api/token/latest-price/:tokenId` - 获取代币最新价格（前端用）

**用途**: 替代 `https://opinionanalytics.xyz/api/orders/by-asset/:assetId`

**实现逻辑**:
1. 调用 `/openapi/token/latest-price?token_id={tokenId}`
2. 转换为兼容格式
3. 缓存1分钟（60秒）

**请求**:
```
GET https://opinionhud.xyz/api/token/latest-price/:tokenId
```

**响应**:
```json
{
  "success": true,
  "data": [
    {
      "price": "0.45",
      "timestamp": 1703721600
    }
  ]
}
```

**缓存策略**:
- TTL: 1分钟（60秒）
- 缓存键: `token:price:{tokenId}`

**错误处理**:
- 返回 `{"success": false, "data": []}` 而非抛出异常
- 前端已有处理逻辑（显示 "—"）

---

### 3.5 前端 API 对比表

| 功能 | 旧方案 | 新方案 |
|------|--------|--------|
| 获取市场结构信息 | 运行时调用 API<br>`/api/markets`<br>`/api/markets/wrap-events` | ✅ **构建时写入 data.json**<br>无需运行时API |
| 获取代币价格 | `/api/orders/by-asset/:id` | `/api/token/latest-price/:tokenId` |
| **运行时API调用数** | **3个** | **1个** ✅ |

---

## 四、前端改动方案

### 4.1 文件修改清单

#### `extension/contentScript.js`

**修改点1**: 更新 `OPINION_API_BASE`
```javascript
// 旧代码 (第108行)
const OPINION_API_BASE = "https://opinionanalytics.xyz/api";

// 新代码
const OPINION_API_BASE = "https://opinionhud.xyz/api";
```

**修改点2**: ❌ 删除 `getMarketsIndex()` 和 `getWrapEventsIndex()` 函数
```javascript
// 删除第298-315行的 getMarketsIndex()
// 删除第322-343行的 getWrapEventsIndex()
// 删除相关的缓存变量和TTL常量
```

**修改点3**: 从 data.json 读取 tokenId 和子市场信息
```javascript
// 修改 hydrateBinaryMarketPrices() 函数
async function hydrateBinaryMarketPrices(row, signal) {
  const marketId = row.marketId;

  // 新逻辑：直接从 data.json 的 market 对象获取 tokenId
  const market = dataIndex.markets[marketId];
  if (!market) return;

  const { yesTokenId, noTokenId } = market;
  if (!yesTokenId || !noTokenId) return;

  // 调用价格API
  const [yesPrice, noPrice] = await Promise.all([
    getLatestAssetPrice(yesTokenId, signal),
    getLatestAssetPrice(noTokenId, signal)
  ]);

  row.yesPrice = yesPrice;
  row.noPrice = noPrice;
}

// 修改 renderWrapEventGroup() 函数
async function renderWrapEventGroup(eventId, signal) {
  const event = dataIndex.events[eventId];
  const market = dataIndex.markets[event.bestMarketId];

  // 新逻辑：直接从 market.subMarkets 获取子市场列表
  const subMarkets = market.subMarkets || [];

  // 渲染每个子市场
  for (const subMarket of subMarkets) {
    const yesPrice = await getLatestAssetPrice(subMarket.yesTokenId, signal);
    // 渲染...
  }
}
```

**修改点4**: 更新 `getLatestAssetPrice()` API路径
```javascript
// 旧代码 (第367行)
const path = `/orders/by-asset/${encodeURIComponent(key)}?page=1&pageSize=1&filter=all`;

// 新代码
const path = `/token/latest-price/${encodeURIComponent(key)}`;
```

---

#### `extension/background.js`

**修改点**: 更新白名单域名
```javascript
// 旧代码 (第2行)
const OPINION_API_ORIGINS = new Set(["https://opinionanalytics.xyz"]);

// 新代码
const OPINION_API_ORIGINS = new Set(["https://opinionhud.xyz"]);
```

---

#### `extension/manifest.json`

**修改点**: 更新 `host_permissions`
```json
// 旧代码 (第14行)
"host_permissions": [
  "https://opinionanalytics.xyz/*"
],

// 新代码
"host_permissions": [
  "https://opinionhud.xyz/*"
]
```

---

## 五、后端 data.json 构建改动

### 5.1 需要修改的文件

虽然后端 GitHub Action 的 API 来源保持不变（仍使用第三方 API），但需要在构建 `data.json` 时添加新字段。

#### `backend/build_index.py`

**修改点1**: 从API响应中提取 tokenId
```python
# 在处理每个市场时，提取 yesTokenId 和 noTokenId
for market in markets_data:
    market_obj = {
        "title": market["marketTitle"],
        "url": f"https://opinion.trade/market/{market['marketId']}?ref=opinion_hud",
        "yesTokenId": market.get("yesTokenId"),  # 新增
        "noTokenId": market.get("noTokenId"),    # 新增
        "labels": {
            "yesLabel": market.get("yesLabel", "YES"),
            "noLabel": market.get("noLabel", "NO")
        },
        "keywords": [...],
        "entities": [],
        "entityGroups": []
    }
```

**修改点2**: 处理多选市场的子市场
```python
# 对于多选市场，从 wrap-events API 获取子市场信息
if market_type == "categorical":
    # 调用 wrap-events API 获取子市场
    wrap_event = fetch_wrap_event(market_id)

    market_obj["type"] = "multi"  # 新增
    market_obj["subMarkets"] = [  # 新增
        {
            "marketId": sub["marketId"],
            "title": sub["title"],
            "yesTokenId": sub["yesTokenId"],
            "noTokenId": sub.get("noTokenId")  # 可选
        }
        for sub in wrap_event.get("markets", [])
    ]
```

**修改点3**: 确保字段完整性验证
```python
# 构建完成后验证数据完整性
for market_id, market in output["markets"].items():
    # 二元市场必须有 tokenId
    if market.get("type") != "multi":
        assert "yesTokenId" in market, f"Market {market_id} missing yesTokenId"
        assert "noTokenId" in market, f"Market {market_id} missing noTokenId"

    # 多选市场必须有 subMarkets
    else:
        assert "subMarkets" in market, f"Market {market_id} missing subMarkets"
        for sub in market["subMarkets"]:
            assert "yesTokenId" in sub, f"SubMarket {sub['marketId']} missing yesTokenId"
```

---

## 六、中转服务器实现方案

### 6.1 技术栈选择

**推荐**: Vercel Serverless Functions (Node.js)

**优势**:
- ✅ 自动扩展，无需管理服务器
- ✅ 全球CDN加速
- ✅ 日本节点可用（绕过区域限制）
- ✅ 免费额度充足（100GB流量/月，1000万次请求）
- ✅ 内置环境变量管理
- ✅ 支持Edge Cache API

**替代方案**:
- Cloudflare Workers (更快，但缓存受限)
- Railway / Render (传统Node.js服务，需要管理Redis)

---

### 6.2 项目结构（简化版）

```
opinionhud-api/
├── api/
│   └── token/
│       └── latest-price/
│           └── [tokenId].js    # GET /api/token/latest-price/:tokenId
├── lib/
│   ├── cache.js                # 缓存层（Vercel KV）
│   └── opinionApi.js           # 官方API客户端（简化版）
├── package.json
├── vercel.json
└── .env.local
    └── OPINION_API_KEY=your-api-key-here
```

---

### 6.3 核心代码示例

#### `lib/opinionApi.js` - 官方API客户端（简化版）

```javascript
const OPINION_BASE_URL = 'https://proxy.opinion.trade:8443/openapi';
const API_KEY = process.env.OPINION_API_KEY;

if (!API_KEY) {
  throw new Error('OPINION_API_KEY is not set');
}

async function fetchOpinionApi(path, params = {}) {
  const url = new URL(path, OPINION_BASE_URL);
  Object.entries(params).forEach(([key, val]) => {
    if (val !== undefined && val !== null) {
      url.searchParams.set(key, val);
    }
  });

  const response = await fetch(url.toString(), {
    headers: {
      'apikey': API_KEY,
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Opinion API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  if (data.code !== 0) {
    throw new Error(`Opinion API returned error code ${data.code}: ${data.msg}`);
  }

  return data.result;
}

// 获取代币最新价格
async function getTokenLatestPrice(tokenId) {
  return await fetchOpinionApi('/token/latest-price', { token_id: tokenId });
}

module.exports = {
  getTokenLatestPrice
};
```

---

#### `lib/cache.js` - 缓存层

```javascript
// 使用 Vercel KV (基于 Upstash Redis)
import { kv } from '@vercel/kv';

const CACHE_PREFIXES = {
  TOKEN_PRICE: 'token:price'
};

const CACHE_TTL = {
  TOKEN_PRICE: 60  // 1分钟
};

async function getCached(key) {
  try {
    return await kv.get(key);
  } catch (err) {
    console.error('Cache get error:', err);
    return null;
  }
}

async function setCached(key, value, ttl) {
  try {
    await kv.set(key, value, { ex: ttl });
  } catch (err) {
    console.error('Cache set error:', err);
  }
}

async function getOrFetch(key, ttl, fetchFn) {
  const cached = await getCached(key);
  if (cached) {
    return cached;
  }

  const fresh = await fetchFn();
  await setCached(key, fresh, ttl);
  return fresh;
}

module.exports = {
  CACHE_PREFIXES,
  CACHE_TTL,
  getCached,
  setCached,
  getOrFetch
};
```

---

#### `api/token/latest-price/[tokenId].js` - 获取代币价格（唯一需要的API）

```javascript
const { getTokenLatestPrice } = require('../../../lib/opinionApi');
const { getOrFetch, CACHE_PREFIXES, CACHE_TTL } = require('../../../lib/cache');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { tokenId } = req.query;

  if (!tokenId) {
    return res.status(400).json({ error: 'tokenId is required' });
  }

  try {
    const priceData = await getOrFetch(
      `${CACHE_PREFIXES.TOKEN_PRICE}:${tokenId}`,
      CACHE_TTL.TOKEN_PRICE,
      () => getTokenLatestPrice(tokenId)
    );

    // 转换为兼容格式（模拟旧API）
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
    res.status(200).json({
      success: true,
      data: [
        {
          price: priceData.price,
          timestamp: priceData.timestamp
        }
      ]
    });
  } catch (err) {
    console.error(`Error fetching price for token ${tokenId}:`, err);

    // 返回兼容的错误格式
    res.status(200).json({
      success: false,
      data: []
    });
  }
};
```

---

#### `vercel.json` - 部署配置

```json
{
  "regions": ["hnd1"],
  "env": {
    "OPINION_API_KEY": "@opinion-api-key"
  },
  "headers": [
    {
      "source": "/api/(.*)",
      "headers": [
        {
          "key": "Access-Control-Allow-Origin",
          "value": "*"
        },
        {
          "key": "Access-Control-Allow-Methods",
          "value": "GET, OPTIONS"
        },
        {
          "key": "Access-Control-Allow-Headers",
          "value": "Content-Type"
        }
      ]
    }
  ]
}
```

**说明**:
- `"regions": ["hnd1"]` - 强制部署到东京节点（日本）
- CORS 头允许前端跨域访问
- 环境变量通过 Vercel CLI 添加：`vercel env add OPINION_API_KEY`

---

## 七、部署步骤

### 7.1 服务器部署

1. **申请 Opinion API Key**
   - 访问 Opinion.Trade 文档，填写申请表单
   - 获取 API Key

2. **创建 Vercel 项目**
   ```bash
   npm install -g vercel
   git clone <opinionhud-api-repo>
   cd opinionhud-api
   vercel login
   vercel
   ```

3. **配置环境变量**
   ```bash
   vercel env add OPINION_API_KEY production
   # 输入你的 API Key
   ```

4. **配置 Vercel KV**
   ```bash
   # 在 Vercel Dashboard 中创建 KV 数据库
   # 连接到项目
   ```

5. **部署**
   ```bash
   vercel --prod
   ```

6. **配置域名**
   - 在 Vercel Dashboard 中添加自定义域名 `opinionhud.xyz`
   - 更新 DNS 记录指向 Vercel

---

### 7.2 前端部署

1. **更新代码**
   ```bash
   cd Opinion-HUD
   git checkout -b feature/api-migration
   # 按照"四、前端改动方案"修改代码
   git commit -m "feat: migrate to official Opinion API via opinionhud.xyz"
   ```

2. **本地测试**
   ```bash
   cd extension
   # 在 Chrome 中加载未打包的扩展
   # 测试所有功能
   ```

3. **构建并发布**
   ```bash
   # 更新版本号
   cd extension
   # 修改 manifest.json version 为 1.1.0

   # 打包
   zip -r opinion-hud-v1.1.0.zip extension/ -x "*.DS_Store"

   # 上传到 Chrome Web Store
   ```

---

## 八、测试计划

### 8.1 API功能测试

| 测试项 | 端点 | 预期结果 |
|--------|------|---------|
| 获取代币价格 | `GET /api/token/latest-price/0xabc...` | 返回最新价格 |
| 缓存命中 | 连续请求同一 tokenId | 第二次请求应从缓存返回（1分钟内） |
| 限流保护 | 16次/秒请求 | 应有合理的排队或错误提示 |
| 错误处理 | 请求不存在的 tokenId | 返回 `{success: false, data: []}` |

---

### 8.2 data.json 数据完整性测试

| 测试项 | 检查内容 | 预期结果 |
|--------|---------|---------|
| 二元市场字段 | `yesTokenId` / `noTokenId` 存在 | 所有二元市场都包含这两个字段 |
| 多选市场字段 | `type` = "multi" 且 `subMarkets` 数组存在 | 所有多选市场都包含子市场列表 |
| 子市场字段 | 每个子市场包含 `marketId`, `title`, `yesTokenId` | 所有子市场字段完整 |
| tokenId 格式 | 以 "0x" 开头的有效地址 | 所有 tokenId 格式正确 |

---

### 8.3 前端集成测试

| 测试项 | 操作 | 预期结果 |
|--------|------|---------|
| 二元市场显示 | 悬停匹配的推文 | 从 data.json 读取 tokenId，调用价格API，显示YES/NO价格 |
| 多选市场显示 | 悬停多选市场推文 | 从 data.json 读取 subMarkets，调用价格API，显示所有子市场及价格 |
| 无API调用市场结构 | 检查网络请求 | 不应调用 `/api/markets` 或 `/api/markets/categorical` |
| 缓存生效 | 短时间内重复打开HUD | 价格数据应从缓存加载 |
| 超时处理 | 模拟API延迟 | 8秒后超时，显示错误 |
| 跳转链接 | 点击市场标题 | 正确跳转到 app.opinion.trade |

---

### 8.4 性能测试

| 指标 | 目标 | 测试方法 |
|------|------|---------|
| API响应时间 | < 500ms (缓存命中), < 2s (缓存未命中) | Artillery/K6 压测 |
| 前端HUD渲染 | < 1s | Chrome DevTools Performance |
| 缓存命中率 | > 80% | Vercel Analytics |
| data.json 加载时间 | < 2s | Chrome DevTools Network |

---

## 九、回滚计划

### 9.1 快速回滚

如果新API出现问题，快速回滚步骤：

**前端回滚**:
```bash
# 在 Chrome Web Store 中恢复到 v1.0.x
# 或在代码中回退 OPINION_API_BASE
const OPINION_API_BASE = "https://opinionanalytics.xyz/api"; // 旧API
```

---

### 9.2 灰度发布

建议采用分阶段发布：

1. **阶段1**（10%用户）: 发布 beta 版本，使用新API
2. **阶段2**（50%用户）: 监控1周，无问题后扩大范围
3. **阶段3**（100%用户）: 全量发布

---

## 十、监控与告警

### 10.1 监控指标

| 指标 | 工具 | 阈值 |
|------|------|------|
| API 可用性 | Vercel Analytics | > 99.5% |
| API 响应时间 | Vercel Analytics | P95 < 2s |
| 错误率 | Vercel Logs | < 1% |
| 缓存命中率 | Vercel KV | > 80% |
| 官方API限流 | 自定义日志 | < 5次/天触发429 |

### 10.2 告警设置

**Vercel 告警**:
- 5xx 错误率 > 5% 持续5分钟 → Email/Slack
- 响应时间 P95 > 5s 持续10分钟 → Email

**自定义告警** (Sentry / LogRocket):
- 前端API调用失败率 > 10%
- 前端HUD渲染错误 > 5次/小时

---

## 十一、风险评估

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|---------|
| 官方API限流 | 中 | 高 | 服务端缓存 + 批处理请求 |
| 官方API区域限制变化 | 低 | 高 | 监控 + 备用节点（新加坡） |
| Vercel KV 故障 | 低 | 中 | 降级为无缓存模式，直接请求官方API |
| API Key 泄露 | 低 | 高 | 环境变量管理 + 定期轮换 |
| 数据格式变化 | 中 | 中 | 版本化API + 单元测试覆盖 |
| 前端兼容性问题 | 低 | 中 | 充分测试 + 灰度发布 |

---

## 十二、时间线（参考）

| 阶段 | 任务 | 负责人 | 依赖 |
|------|------|--------|------|
| Week 1 | 申请 Opinion API Key | 开发者 | - |
| Week 1 | 实现中转API服务器 | 开发者 | API Key |
| Week 1 | 部署到 Vercel（测试环境） | 开发者 | 中转API |
| Week 2 | 修改前端代码 | 开发者 | - |
| Week 2 | 本地测试 + 集成测试 | 开发者 | 前端代码 |
| Week 3 | 部署到生产环境 | 开发者 | 测试通过 |
| Week 3 | 灰度发布（10% → 50%） | 开发者 | 生产环境稳定 |
| Week 4 | 全量发布 | 开发者 | 监控数据正常 |
| Week 4+ | 监控与优化 | 开发者 | - |

---

## 十三、附录

### 13.1 官方API文档链接

- Overview: https://docs.opinion.trade/developer-guide/opinion-open-api/overview
- Market API: https://docs.opinion.trade/developer-guide/opinion-open-api/market
- Token API: https://docs.opinion.trade/developer-guide/opinion-open-api/token

### 13.2 相关资源

- Vercel Serverless Functions: https://vercel.com/docs/functions
- Vercel KV (Upstash Redis): https://vercel.com/docs/storage/vercel-kv
- Opinion.Trade 官网: https://app.opinion.trade

### 13.3 术语表

- **二元市场 (Binary Market)**: YES/NO 两个选项的市场
- **分类市场 (Categorical Market)**: 多选市场（Multi-choice）
- **Wrapped Event**: 分类市场的父事件（parent event）
- **cutoffAt**: 市场截止时间（Unix 时间戳）
- **yesTokenId / noTokenId**: 代表YES/NO的ERC-1155代币ID
- **TTL (Time To Live)**: 缓存过期时间
- **Limiter**: 并发限流器

---

## 变更记录

| 版本 | 日期 | 作者 | 变更内容 |
|------|------|------|---------|
| 1.0 | 2025-12-27 | Claude | 初始版本，完整API迁移方案 |

---

**文档结束**
