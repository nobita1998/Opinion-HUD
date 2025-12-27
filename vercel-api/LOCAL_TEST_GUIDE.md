# 本地测试指南

## 前置要求检查

在终端中运行：

```bash
# 1. 检查 Node.js 是否安装
node --version
# 期望输出: v18.x.x 或更高

# 2. 检查 npm 是否安装
npm --version
# 期望输出: 9.x.x 或更高
```

如果没有安装，请先安装 Node.js：
- 访问 https://nodejs.org/
- 下载 LTS 版本
- 安装后重启终端

---

## 第一步：进入项目目录

```bash
cd /Users/nobita/projects/coins/Opinion-HUD/vercel-api
```

---

## 第二步：安装依赖

```bash
npm install
```

期望输出：
```
added XX packages in XXs
```

---

## 第三步：测试 API Key 配置

```bash
npm run test-key
```

### 成功的输出示例：

**如果从环境变量读取：**
```
╔══════════════════════════════════════════════════════════╗
║     Opinion HUD API - Keychain Test Tool                ║
╚══════════════════════════════════════════════════════════╝

🔍 检查 API Key 来源...

✅ 环境变量 OPINION_KEY:
   sk_**********************xyz

📱 操作系统: darwin

🔑 尝试获取 API Key...

✅ 成功获取 API Key!
   sk_**********************xyz

📊 来源判断:
   📌 环境变量

✨ API 配置正确，可以启动开发服务器:
   npm run dev
```

**如果从 Keychain 读取：**
```
❌ 环境变量 OPINION_KEY: 未设置

📱 操作系统: darwin

🔑 尝试获取 API Key...

[keychain] Successfully loaded API key from macOS Keychain

✅ 成功获取 API Key!
   sk_**********************xyz

📊 来源判断:
   🔐 macOS Keychain

✨ API 配置正确，可以启动开发服务器:
   npm run dev
```

### 失败的输出示例：

```
❌ 环境变量 OPINION_KEY: 未设置

📱 操作系统: darwin

🔑 尝试获取 API Key...

❌ 未找到 API Key

💡 请使用以下方式之一设置 API Key:

   方式 1 (macOS Keychain):
     npm run setup

   方式 2 (环境变量):
     export OPINION_KEY=your_api_key

   方式 3 (.env 文件):
     cp .env.example .env
     # 编辑 .env，添加 OPINION_KEY
```

**如果失败，执行：**
```bash
# 设置到 Keychain
npm run setup
# 按提示输入你的 API Key

# 或者使用 .env 文件
cp .env.example .env
# 编辑 .env 文件，添加: OPINION_KEY=your_api_key
```

---

## 第四步：启动开发服务器

```bash
npm run dev
```

期望输出：
```
Vercel CLI X.X.X
> Ready! Available at http://localhost:3000
```

**注意**: 服务器会持续运行，保持终端窗口打开。

---

## 第五步：测试 API 端点

### 方法 1：使用浏览器测试页面

在浏览器中打开：
```
http://localhost:3000/test.html
```

操作：
1. API Base URL 应该自动填充为 `http://localhost:3000`
2. Token ID 输入框有示例 Token ID（或点击示例 Token 自动填充）
3. 点击 "🚀 测试 API" 按钮
4. 查看响应结果

**成功响应示例：**
```json
{
  "success": true,
  "data": {
    "tokenId": "68227038457866748595233145251243944054564947305383894629176574093714476769147",
    "price": 0.15,
    "volume": 1234.56,
    "lastUpdated": 1703123456
  },
  "cachedUntil": 1703123516000
}
```

### 方法 2：使用 curl 命令

**打开新的终端窗口**（保持开发服务器运行），执行：

```bash
# 测试 Market 3062 (Trump) - YES token
curl "http://localhost:3000/api/token/68227038457866748595233145251243944054564947305383894629176574093714476769147"
```

**成功响应：**
```json
{
  "success": true,
  "data": { ... },
  "cachedUntil": ...
}
```

**失败响应（API Key 配置错误）：**
```json
{
  "success": false,
  "error": "Server configuration error"
}
```

### 方法 3：使用浏览器直接访问

在浏览器地址栏输入：
```
http://localhost:3000/api/token/68227038457866748595233145251243944054564947305383894629176574093714476769147
```

应该直接显示 JSON 响应。

---

## 第六步：查看开发服务器日志

在运行 `npm run dev` 的终端窗口中，你应该看到：

**成功的日志：**
```
[keychain] Using API key from environment variable
```
或
```
[keychain] Successfully loaded API key from macOS Keychain
```

**失败的日志：**
```
[keychain] API key not found in environment variable or Keychain
```

---

## 故障排除

### 问题 1: npm install 报错

**错误示例：**
```
npm ERR! code ENOENT
```

**解决方案：**
```bash
# 确认在正确的目录
pwd
# 应该输出: /Users/nobita/projects/coins/Opinion-HUD/vercel-api

# 检查 package.json 是否存在
ls package.json
```

### 问题 2: npm run dev 报错

**错误示例：**
```
Error! No vercel.json file was detected
```

**解决方案：**
```bash
# 确认 vercel.json 存在
ls vercel.json

# 重新安装 Vercel CLI
npm install -g vercel
```

### 问题 3: API 返回 500 错误

**错误响应：**
```json
{
  "success": false,
  "error": "Server configuration error"
}
```

**解决方案：**
```bash
# 重新测试 API Key 配置
npm run test-key

# 如果显示未找到，重新设置
npm run setup
```

### 问题 4: 端口 3000 被占用

**错误示例：**
```
Error: Port 3000 is already in use
```

**解决方案：**
```bash
# 方法 1: 使用其他端口
PORT=3001 npm run dev

# 方法 2: 找到并关闭占用端口的进程
lsof -ti:3000 | xargs kill -9
```

---

## 测试用例

### 测试用例 1: 二元市场 (Market 3062 - Trump)

**YES Token:**
```bash
curl "http://localhost:3000/api/token/68227038457866748595233145251243944054564947305383894629176574093714476769147"
```

**NO Token:**
```bash
curl "http://localhost:3000/api/token/23295406450705254064374249781739843340364170407721892525550504746101807113177"
```

### 测试用例 2: 多选市场 (Market 217 - Pikachu)

**>$5m 选项 YES Token:**
```bash
curl "http://localhost:3000/api/token/113485738141713319431123088732645191218832539669273333341350183815439329436948"
```

---

## 成功标志

✅ `npm run test-key` 显示成功获取 API Key
✅ `npm run dev` 启动成功，显示 "Ready! Available at http://localhost:3000"
✅ 访问 `http://localhost:3000/test.html` 可以打开测试页面
✅ API 测试返回 `"success": true`
✅ 开发服务器日志显示成功加载 API Key

全部通过后，本地测试完成！🎉

---

## 下一步

本地测试成功后，可以：
1. 部署到 Vercel 生产环境
2. 修改 Chrome 扩展，集成新的 API
3. 端到端测试

---

## 快速参考

| 命令 | 说明 |
|------|------|
| `npm install` | 安装依赖 |
| `npm run setup` | 设置 API Key 到 Keychain |
| `npm run test-key` | 测试 API Key 配置 |
| `npm run dev` | 启动开发服务器 |
| `npm run deploy` | 部署到 Vercel |

| 测试 URL | 说明 |
|----------|------|
| `http://localhost:3000/test.html` | 测试页面 |
| `http://localhost:3000/api/token/:tokenId` | API 端点 |
