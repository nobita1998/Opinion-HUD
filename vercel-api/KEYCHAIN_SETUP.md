# macOS Keychain 配置指南

## 概述

Opinion HUD API 支持两种方式存储和读取 API Key:

1. **macOS Keychain** (推荐用于本地开发)
   - ✅ 安全存储
   - ✅ 不需要 .env 文件
   - ✅ 系统级加密
   - ❌ 仅限 macOS

2. **环境变量** (Vercel 生产环境)
   - ✅ 跨平台
   - ✅ Vercel 原生支持
   - ⚠️ 需要手动管理

## API Key 读取优先级

代码会按以下顺序尝试获取 API Key:

```
1. 环境变量 OPINION_API_KEY (Vercel 生产环境)
     ↓ (如果不存在)
2. macOS Keychain (本地开发)
     ↓ (如果都不存在)
3. 返回错误
```

## 方法 1: 使用 macOS Keychain (推荐)

### 自动设置 (推荐)

运行设置脚本:

```bash
cd vercel-api
npm run setup
```

按提示输入您的 Opinion.Trade API Key。

### 手动设置

使用 `security` 命令直接添加:

```bash
security add-generic-password \
  -s "opinion-hud-api" \
  -a "OPINION_API_KEY" \
  -w "your_actual_api_key_here"
```

### 验证 Keychain 中的密钥

```bash
# 查看密钥（需要授权）
security find-generic-password \
  -s "opinion-hud-api" \
  -a "OPINION_API_KEY" \
  -w
```

### 删除 Keychain 中的密钥

```bash
security delete-generic-password \
  -s "opinion-hud-api" \
  -a "OPINION_API_KEY"
```

### 更新 Keychain 中的密钥

```bash
# 方法 1: 重新运行设置脚本
npm run setup

# 方法 2: 手动删除后重新添加
security delete-generic-password -s "opinion-hud-api" -a "OPINION_API_KEY"
security add-generic-password -s "opinion-hud-api" -a "OPINION_API_KEY" -w "new_api_key"
```

## 方法 2: 使用环境变量

### 本地开发 (.env 文件)

1. 复制模板:
```bash
cp .env.example .env
```

2. 编辑 `.env`:
```bash
OPINION_API_KEY=your_api_key_here
```

3. 启动开发服务器:
```bash
npm run dev
```

### Vercel 生产环境

#### 通过 Dashboard

1. 进入 Vercel 项目设置
2. Environment Variables
3. 添加:
   - Name: `OPINION_API_KEY`
   - Value: 你的 API key
   - Environment: Production, Preview, Development

#### 通过 CLI

```bash
vercel env add OPINION_API_KEY
```

## 本地开发工作流

### 场景 1: 使用 Keychain (推荐)

```bash
# 1. 设置 Keychain (只需一次)
npm run setup

# 2. 启动开发服务器
npm run dev

# 3. 测试
curl http://localhost:3000/api/token/68227038457866748595233145251243944054564947305383894629176574093714476769147
```

### 场景 2: 使用 .env 文件

```bash
# 1. 创建 .env
cp .env.example .env
# 编辑 .env，添加 OPINION_API_KEY

# 2. 启动开发服务器
npm run dev

# 3. 测试
curl http://localhost:3000/api/token/68227038457866748595233145251243944054564947305383894629176574093714476769147
```

## 代码实现

### 读取 API Key

`lib/keychain.js` 中的 `getOpinionApiKey()` 函数:

```javascript
async function getOpinionApiKey() {
  // 1. 优先尝试环境变量
  const envKey = process.env.OPINION_API_KEY;
  if (envKey) {
    return envKey;
  }

  // 2. 尝试从 macOS Keychain 读取
  const keychainKey = await getKeyFromKeychain();
  if (keychainKey) {
    return keychainKey;
  }

  // 3. 都没找到
  return null;
}
```

### 在 API 中使用

`api/token/[tokenId].js`:

```javascript
const { getOpinionApiKey } = require('../../lib/keychain');

module.exports = async (req, res) => {
  // 自动从环境变量或 Keychain 读取
  const apiKey = await getOpinionApiKey();

  if (!apiKey) {
    return res.status(500).json({
      success: false,
      error: 'Server configuration error'
    });
  }

  // 使用 apiKey 调用 Opinion API
  // ...
};
```

## 安全性

### Keychain 安全优势

1. ✅ **系统级加密**: macOS 使用硬件加密
2. ✅ **访问控制**: 需要用户授权才能读取
3. ✅ **审计日志**: macOS 记录所有 Keychain 访问
4. ✅ **不在代码中**: 永远不会意外提交到 Git

### 最佳实践

1. **永远不要硬编码 API Key**
```javascript
// ❌ 错误
const apiKey = 'sk_xxxxxxxxx';

// ✅ 正确
const apiKey = await getOpinionApiKey();
```

2. **不要提交 .env 到 Git**
```bash
# .gitignore 已包含
.env
.env.local
.env.production
```

3. **定期轮换 API Key**
```bash
# 每 3-6 个月更新一次
npm run setup
```

## 故障排除

### 问题 1: Keychain 读取失败

**错误信息**:
```
[keychain] Failed to read from Keychain: Command failed
```

**解决方案**:
1. 检查 Keychain Access 应用，确认密钥存在
2. 重新运行 `npm run setup`
3. 授权终端访问 Keychain

### 问题 2: API 返回 500 错误

**错误信息**:
```json
{
  "success": false,
  "error": "Server configuration error"
}
```

**解决方案**:
```bash
# 检查环境变量
echo $OPINION_API_KEY

# 检查 Keychain
security find-generic-password -s "opinion-hud-api" -a "OPINION_API_KEY" -w

# 重新设置
npm run setup
```

### 问题 3: Vercel 部署后无法读取 Keychain

**原因**: Vercel 服务器不是 macOS，无法访问 Keychain

**解决方案**: 在 Vercel Dashboard 中设置环境变量
```bash
vercel env add OPINION_API_KEY
```

### 问题 4: keytar 安装失败

**错误信息**:
```
gyp ERR! build error
```

**解决方案**: keytar 是可选依赖，可以使用 `security` 命令作为备用
```bash
# 忽略 keytar 安装错误，代码会自动降级到 security 命令
npm install --legacy-peer-deps
```

## 不同环境配置

| 环境 | API Key 来源 | 配置方法 |
|------|-------------|----------|
| 本地开发 (macOS) | Keychain | `npm run setup` |
| 本地开发 (其他系统) | .env | `cp .env.example .env` |
| Vercel 生产环境 | 环境变量 | Vercel Dashboard |
| Vercel 预览环境 | 环境变量 | Vercel Dashboard |

## 迁移指南

### 从 .env 迁移到 Keychain

```bash
# 1. 读取当前 .env 中的 key
cat .env | grep OPINION_API_KEY

# 2. 运行设置脚本，输入同样的 key
npm run setup

# 3. 删除 .env（可选）
rm .env

# 4. 测试
npm run dev
```

### 从 Keychain 迁移到 .env

```bash
# 1. 读取 Keychain 中的 key
security find-generic-password -s "opinion-hud-api" -a "OPINION_API_KEY" -w

# 2. 创建 .env 并添加 key
echo "OPINION_API_KEY=your_key_here" > .env

# 3. 删除 Keychain 中的 key（可选）
security delete-generic-password -s "opinion-hud-api" -a "OPINION_API_KEY"
```

## 总结

- ✅ **本地开发**: 使用 macOS Keychain (`npm run setup`)
- ✅ **Vercel 部署**: 使用环境变量 (Dashboard 或 CLI)
- ✅ **代码自动处理**: 无需修改代码，自动选择最佳方式
- ✅ **安全第一**: 永远不要硬编码或提交 API Key

## 相关文件

- `lib/keychain.js` - Keychain 读取逻辑
- `scripts/setup-keychain.js` - Keychain 设置工具
- `api/token/[tokenId].js` - API 端点（使用 Keychain）
- `.env.example` - 环境变量模板
- `.gitignore` - 保护 .env 不被提交
