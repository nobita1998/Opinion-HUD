# Opinion HUD Vercel API

Vercel serverless functions that proxy Opinion.Trade OpenAPI for the Opinion HUD Chrome extension.

## 功能 (Features)

- 🚀 **Token 价格查询**: 获取 ERC-1155 token 的最新价格
- ⚡ **1分钟缓存**: 使用 Vercel Edge Cache 优化性能
- 🌏 **日本区域部署**: 部署在日本节点，突破 Opinion API 地域限制
- 🔒 **安全**: API Key 通过环境变量管理

## API 端点

### GET `/api/token/:tokenId`

获取指定 token 的最新价格

**参数:**
- `tokenId` (path parameter): ERC-1155 token ID (大数字字符串)

**示例请求:**
```bash
curl https://your-vercel-domain.vercel.app/api/token/68227038457866748595233145251243944054564947305383894629176574093714476769147
```

**成功响应:**
```json
{
  "success": true,
  "data": {
    "tokenId": "68227038457866748595233145251243944054564947305383894629176574093714476769147",
    "price": 0.15,
    "lastUpdated": 1703123456
  },
  "cachedUntil": 1703123516000
}
```

**错误响应:**
```json
{
  "success": false,
  "error": "Invalid tokenId format",
  "message": "..."
}
```

## 部署到 Vercel

### 1. 前置要求

- [Vercel 账号](https://vercel.com)
- [Vercel CLI](https://vercel.com/docs/cli) (可选)
- Opinion.Trade API Key

### 2. 获取 Opinion.Trade API Key

访问 [Opinion.Trade](https://opinion.trade) 获取 API key。

### 3. 部署方式

#### 方式 A: 通过 Vercel Dashboard (推荐)

1. Fork 或上传此项目到 GitHub
2. 访问 [Vercel Dashboard](https://vercel.com/dashboard)
3. 点击 "Import Project"
4. 选择你的 GitHub 仓库
5. 设置环境变量:
   - Key: `OPINION_API_KEY`
   - Value: 你的 Opinion API key
6. 在 Settings 中设置 **Region**: `Tokyo, Japan (hnd1)`
7. 点击 "Deploy"

#### 方式 B: 通过 Vercel CLI

```bash
# 1. 安装 Vercel CLI
npm i -g vercel

# 2. 进入项目目录
cd vercel-api

# 3. 安装依赖
npm install

# 4. 登录 Vercel
vercel login

# 5. 设置环境变量
vercel env add OPINION_API_KEY

# 6. 部署到生产环境
vercel --prod
```

### 4. 配置环境变量

**重要**: Vercel 生产环境必须使用环境变量（Keychain 仅限本地 macOS）

在 Vercel Dashboard 中:
1. 进入项目 Settings
2. 选择 Environment Variables
3. 添加以下变量:
   - Key: `OPINION_API_KEY`
   - Value: 你的 Opinion.Trade API key
   - Environments: Production, Preview, Development (全选)

或使用 CLI:
```bash
vercel env add OPINION_API_KEY
# 输入你的 API key
# 选择 Production, Preview, Development
```

### 5. 验证部署

部署完成后，测试 API:

```bash
# 替换为你的 Vercel 域名和实际的 tokenId
curl https://your-app.vercel.app/api/token/68227038457866748595233145251243944054564947305383894629176574093714476769147
```

## 本地开发

### 方式 A: 使用 macOS Keychain (推荐)

```bash
# 1. 安装依赖
cd vercel-api
npm install

# 2. 设置 API Key 到 Keychain (只需一次)
npm run setup
# 按提示输入你的 Opinion.Trade API Key

# 3. 启动开发服务器
npm run dev

# 4. 测试 API
curl http://localhost:3000/api/token/68227038457866748595233145251243944054564947305383894629176574093714476769147
```

### 方式 B: 使用 .env 文件

```bash
# 1. 安装依赖
cd vercel-api
npm install

# 2. 创建 .env 文件
cp .env.example .env
# 编辑 .env 文件，添加你的 OPINION_API_KEY

# 3. 启动开发服务器
npm run dev

# 4. 测试 API
curl http://localhost:3000/api/token/68227038457866748595233145251243944054564947305383894629176574093714476769147
```

> **提示**: API Key 读取优先级: 环境变量 > macOS Keychain
>
> 详细配置指南请查看 [KEYCHAIN_SETUP.md](./KEYCHAIN_SETUP.md)

## 项目结构

```
vercel-api/
├── api/
│   └── token/
│       └── [tokenId].js    # Token 价格 API
├── package.json             # Node.js 依赖
├── vercel.json              # Vercel 配置（区域、缓存等）
├── .env.example             # 环境变量示例
├── .gitignore
└── README.md
```

## 配置说明

### vercel.json

```json
{
  "regions": ["hnd1"],  // 东京（日本）节点
  "functions": {
    "api/**/*.js": {
      "memory": 256,      // 256MB 内存
      "maxDuration": 10   // 最大执行时间 10 秒
    }
  }
}
```

### 缓存策略

- **Cache-Control**: `public, s-maxage=60`
- **缓存时间**: 60 秒（1分钟）
- **CDN**: Vercel Edge Network

## 费用说明

Vercel 免费计划包括:
- ✅ 100GB 带宽/月
- ✅ 100 次函数调用/天（Hobby）
- ✅ 无限部署

如果超出限制，需要升级到 Pro 计划 ($20/月)。

## 故障排除

### API 返回 500 错误

检查环境变量是否正确设置:
```bash
vercel env ls
```

### API 返回 CORS 错误

确认 `vercel.json` 中的 CORS 配置正确。

### Opinion API 返回 401

检查 API key 是否有效。

## 安全注意事项

⚠️ **重要**:
- 永远不要在代码中硬编码 API key
- 使用 Vercel Environment Variables 管理敏感信息
- 不要将 `.env` 文件提交到 Git

## License

MIT

## 相关链接

- [Opinion.Trade](https://opinion.trade)
- [Vercel 文档](https://vercel.com/docs)
- [Opinion HUD Chrome 扩展](https://github.com/yourusername/opinion-hud)
