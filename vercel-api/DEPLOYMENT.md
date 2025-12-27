# Opinion HUD API - 部署指南

## 快速开始

### 1. 获取 Opinion.Trade API Key

你需要从 Opinion.Trade 获取 API key。具体方法：

1. 访问 Opinion.Trade 官网
2. 注册/登录账号
3. 进入 Developer Settings
4. 生成 API Key

> ⚠️ **注意**: Opinion.Trade OpenAPI 目前可能还未公开，你可能需要联系官方获取访问权限。

### 2. 部署到 Vercel (推荐)

#### 方式 A: 使用 Vercel Dashboard (最简单)

1. **Fork 项目到 GitHub**
   ```bash
   # 如果还没有推送到 GitHub，先创建仓库
   cd /Users/nobita/projects/coins/Opinion-HUD
   git add vercel-api/
   git commit -m "feat: add Vercel API for Opinion HUD"
   git push
   ```

2. **导入到 Vercel**
   - 访问 https://vercel.com/new
   - 选择你的 GitHub 仓库
   - Root Directory: 选择 `vercel-api`
   - 点击 Deploy

3. **配置环境变量**
   - 在 Vercel 项目设置中，找到 "Environment Variables"
   - 添加:
     - Name: `OPINION_API_KEY`
     - Value: `你的_API_Key`
     - Environment: `Production`, `Preview`, `Development` (全选)

4. **设置部署区域**
   - Settings → Functions
   - Region: 选择 `Tokyo, Japan (hnd1)`

5. **重新部署**
   - Deployments → 最新部署 → Redeploy

#### 方式 B: 使用 Vercel CLI

```bash
# 1. 安装 Vercel CLI (如果还没有)
npm install -g vercel

# 2. 进入项目目录
cd vercel-api

# 3. 登录 Vercel
vercel login

# 4. 首次部署（会进入交互式配置）
vercel

# 按照提示操作:
# - Set up and deploy "vercel-api"? Y
# - Which scope? 选择你的账号
# - Link to existing project? N
# - What's your project's name? opinion-hud-api
# - In which directory is your code located? ./
# - Want to override the settings? N

# 5. 添加环境变量
vercel env add OPINION_API_KEY

# 输入你的 API key，选择 Production, Preview, Development

# 6. 部署到生产环境
vercel --prod
```

### 3. 验证部署

部署成功后，你会得到一个 URL，例如: `https://opinion-hud-api.vercel.app`

测试 API:

```bash
# 替换为你的域名和实际的 tokenId
curl "https://opinion-hud-api.vercel.app/api/token/68227038457866748595233145251243944054564947305383894629176574093714476769147"
```

期望返回:
```json
{
  "success": true,
  "data": {
    "tokenId": "682270...",
    "price": 0.15,
    ...
  },
  "cachedUntil": 1703123516000
}
```

或者在浏览器访问:
```
https://opinion-hud-api.vercel.app/test.html
```

## 本地开发与测试

### 1. 安装依赖

```bash
cd vercel-api
npm install
```

### 2. 配置环境变量

```bash
# 复制环境变量模板
cp .env.example .env

# 编辑 .env 文件，填入你的 API key
# OPINION_API_KEY=your_actual_api_key_here
```

### 3. 启动开发服务器

```bash
# 使用 Vercel CLI 启动本地开发服务器
vercel dev
```

或使用 npm script:
```bash
npm run dev
```

服务器将在 `http://localhost:3000` 启动。

### 4. 测试 API

#### 方法 1: 使用测试页面

访问: http://localhost:3000/test.html

在页面中输入 Token ID 并点击测试。

#### 方法 2: 使用 curl

```bash
# 测试 Market 3062 (Trump) - YES token
curl "http://localhost:3000/api/token/68227038457866748595233145251243944054564947305383894629176574093714476769147"

# 测试 Market 3062 (Trump) - NO token
curl "http://localhost:3000/api/token/23295406450705254064374249781739843340364170407721892525550504746101807113177"

# 测试 Market 217 (Pikachu >$5m) - YES token
curl "http://localhost:3000/api/token/113485738141713319431123088732645191218832539669273333341350183815439329436948"
```

#### 方法 3: 使用 JavaScript (浏览器控制台)

```javascript
fetch('http://localhost:3000/api/token/68227038457866748595233145251243944054564947305383894629176574093714476769147')
  .then(r => r.json())
  .then(data => console.log(data));
```

## 更新 Chrome 扩展配置

部署完成后，需要更新 Chrome 扩展中的 API 地址。

编辑 `extension/contentScript.js` 或配置文件:

```javascript
const API_BASE_URL = 'https://your-vercel-app.vercel.app';

// 获取价格
async function getTokenPrice(tokenId) {
  const response = await fetch(`${API_BASE_URL}/api/token/${tokenId}`);
  const data = await response.json();
  return data;
}
```

## 监控与调试

### 查看日志

在 Vercel Dashboard:
1. 进入你的项目
2. 点击 "Functions"
3. 选择具体的函数执行记录
4. 查看 Logs

### 常见错误

#### 1. 500 错误 - "Server configuration error"

**原因**: 环境变量未设置

**解决**:
```bash
vercel env add OPINION_API_KEY
# 或在 Vercel Dashboard 中添加
```

#### 2. CORS 错误

**原因**: 跨域配置问题

**解决**: 检查 `vercel.json` 中的 headers 配置是否正确。

#### 3. Opinion API 401 Unauthorized

**原因**: API Key 无效或过期

**解决**:
- 检查 API Key 是否正确
- 联系 Opinion.Trade 确认 API 访问权限

#### 4. Timeout 错误

**原因**: Opinion API 响应慢或不可达

**解决**:
- 检查网络连接
- 确认部署在日本区域 (hnd1)
- 调整 `vercel.json` 中的 `maxDuration`

## 性能优化

### 缓存策略

当前配置:
- **Token 价格**: 60秒 (1分钟)
- **CDN**: Vercel Edge Network
- **Stale-while-revalidate**: 120秒

如需调整，编辑 `api/token/[tokenId].js`:

```javascript
const CACHE_MAX_AGE = 60; // 改为你想要的秒数
```

### 监控请求量

在 Vercel Dashboard:
- Analytics → 查看请求数、带宽使用
- 免费版: 100GB 带宽/月

## 安全最佳实践

1. ✅ **永远不要提交 `.env` 到 Git**
   ```bash
   # 已在 .gitignore 中配置
   ```

2. ✅ **使用 Vercel Environment Variables**
   - 通过 Dashboard 或 CLI 管理
   - 不同环境使用不同的 key

3. ✅ **定期轮换 API Key**
   - 每 3-6 个月更换一次

4. ⚠️ **考虑添加速率限制**
   - 防止滥用
   - 可使用 Vercel Rate Limiting (Pro plan)

## 费用估算

### Vercel 免费计划 (Hobby)

- ✅ 100GB 带宽/月
- ✅ 100,000 Edge Requests/天
- ✅ 无限部署
- ✅ 所有 Edge Functions

**估算**:
- 假设每个请求 ~5KB 响应
- 100GB = ~20M 请求/月
- 对于 Chrome 扩展，足够使用

### 如需升级 (Pro Plan: $20/月)

- 1TB 带宽
- 无限 Edge Requests
- 高级分析
- 团队协作

## 故障转移

如果 Vercel API 不可用，可以考虑:

1. **部署到多个平台**
   - Cloudflare Workers
   - AWS Lambda
   - Railway

2. **在扩展中配置备用 API**
   ```javascript
   const API_URLS = [
     'https://primary.vercel.app',
     'https://backup.vercel.app'
   ];
   ```

## 下一步

1. ✅ 部署 API 到 Vercel
2. ⏭️ 修改 Chrome 扩展，使用新的 API
3. ⏭️ 测试端到端流程
4. ⏭️ 发布新版本扩展

## 相关资源

- [Vercel 文档](https://vercel.com/docs)
- [Vercel CLI 文档](https://vercel.com/docs/cli)
- [Opinion.Trade](https://opinion.trade)
- [项目 README](./README.md)
