# Opinion HUD API - 快速开始指南

## 🚀 5 分钟上手

### 第一步：安装依赖

```bash
cd vercel-api
npm install
```

### 第二步：配置 API Key

#### 选项 A：macOS Keychain (推荐，仅 macOS)

```bash
npm run setup
```

按提示输入你的 Opinion.Trade API Key。

#### 选项 B：环境变量 (.env 文件)

```bash
cp .env.example .env
```

编辑 `.env` 文件，添加：
```
OPINION_API_KEY=你的_API_Key
```

### 第三步：验证配置

```bash
npm run test-key
```

期望输出：
```
✅ 成功获取 API Key!
   sk_**********************xyz
📊 来源判断:
   🔐 macOS Keychain
```

### 第四步：启动开发服务器

```bash
npm run dev
```

服务器启动在: `http://localhost:3000`

### 第五步：测试 API

#### 方法 1：使用测试页面

在浏览器打开:
```
http://localhost:3000/test.html
```

#### 方法 2：使用 curl

```bash
curl "http://localhost:3000/api/token/68227038457866748595233145251243944054564947305383894629176574093714476769147"
```

期望响应：
```json
{
  "success": true,
  "data": {
    "tokenId": "682270...",
    "price": 0.15,
    ...
  }
}
```

## 📋 常用命令

| 命令 | 说明 |
|------|------|
| `npm install` | 安装依赖 |
| `npm run setup` | 配置 Keychain (macOS) |
| `npm run test-key` | 测试 API Key 配置 |
| `npm run dev` | 启动开发服务器 |
| `npm run deploy` | 部署到 Vercel 生产环境 |

## 🔧 故障排除

### 问题：API 返回 500 错误

**检查 API Key 配置：**
```bash
npm run test-key
```

**如果显示未找到 API Key：**
```bash
# 重新设置
npm run setup
```

### 问题：Keychain 访问被拒绝

**授权终端访问 Keychain：**
1. 打开 Keychain Access.app
2. 找到 "opinion-hud-api" 项
3. 双击 → Access Control
4. 添加 Terminal.app 到允许列表

### 问题：端口 3000 被占用

**使用其他端口：**
```bash
PORT=3001 npm run dev
```

## 📚 下一步

- ✅ 阅读 [KEYCHAIN_SETUP.md](./KEYCHAIN_SETUP.md) - Keychain 详细配置
- ✅ 阅读 [DEPLOYMENT.md](./DEPLOYMENT.md) - Vercel 部署指南
- ✅ 阅读 [README.md](./README.md) - 完整项目文档

## 🎯 部署到 Vercel

### 简化步骤

```bash
# 1. 登录 Vercel
vercel login

# 2. 部署
vercel --prod

# 3. 配置环境变量
vercel env add OPINION_API_KEY
# 输入你的 API key
# 选择 Production, Preview, Development

# 4. 测试生产环境
curl "https://your-app.vercel.app/api/token/68227038457866748595233145251243944054564947305383894629176574093714476769147"
```

完成！🎉
