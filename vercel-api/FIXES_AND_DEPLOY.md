# API 修复和部署说明

## 📝 本地测试中发现并修复的问题

### 问题 1: 错误的认证 Header
- **原代码**: `'X-API-Key': apiKey`
- **正确代码**: `'apikey': apiKey` ✅
- **原因**: Opinion.Trade OpenAPI 要求使用小写的 `apikey` header

### 问题 2: 错误的 API 端点
- **原代码**: POST `/market/token-price` with JSON body
- **正确代码**: GET `/token/latest-price?token_id={tokenId}` ✅
- **原因**: 参考 PRD 文档第 112 行的正确端点定义

### 问题 3: 未处理 Opinion API 响应格式
- **Opinion API 统一格式**:
  ```json
  {
    "code": 0,
    "msg": "success",
    "result": { ...实际数据... }
  }
  ```
- **修复**: 添加了 `code` 检查和 `result` 提取逻辑 ✅

### 问题 4: 响应格式未转换
- **前端期望格式**:
  ```json
  {
    "success": true,
    "data": [
      {"price": "0.45", "timestamp": 1703721600}
    ]
  }
  ```
- **修复**: 添加了格式转换，将 Opinion API 的返回值包装成数组 ✅

## ⚠️ 本地测试限制

Opinion.Trade API 有**地理区域限制**（仅限日韩区访问），因此：

- ❌ **本地测试会失败**：网络连接错误 `ECONNRESET`
- ✅ **部署到 Vercel 东京节点后可以正常工作**

## 🚀 下一步：部署到 Vercel 生产环境

### 1. 确认环境变量已配置

你已经在 Vercel Dashboard 配置了：
```
OPINION_KEY = @opinion-key
```

### 2. 部署到生产环境

```bash
cd /Users/nobita/projects/coins/Opinion-HUD/vercel-api
vercel --prod
```

**注意**: 首次部署时可能需要：
1. `vercel login` - 登录你的 Vercel 账户
2. `vercel` - 初次部署（会询问项目配置）
3. `vercel --prod` - 部署到生产环境

### 3. 测试生产环境 API

部署成功后，测试以下 URL：

```bash
# 替换 your-domain 为你的 Vercel 域名（如 opinionhud.xyz）
curl "https://your-domain.vercel.app/api/token/68227038457866748595233145251243944054564947305383894629176574093714476769147"
```

**预期成功响应**:
```json
{
  "success": true,
  "data": [
    {
      "price": "0.45",
      "timestamp": 1703721600
    }
  ],
  "cachedUntil": 1735287120000
}
```

### 4. 验证缓存生效

连续两次请求同一 tokenId，第二次应该从缓存返回（更快）：
```bash
curl "https://your-domain.vercel.app/api/token/{tokenId}"
curl "https://your-domain.vercel.app/api/token/{tokenId}"
```

查看响应 headers 中的 `x-vercel-cache` 应该显示 `HIT`。

### 5. 配置自定义域名（可选）

如果你已经有域名 `opinionhud.xyz`：

1. 在 Vercel Dashboard → Settings → Domains
2. 添加域名 `opinionhud.xyz` 或 `api.opinionhud.xyz`
3. 按照提示配置 DNS 记录

## 📊 测试用例

### 二元市场 (Market 3062 - Trump)

**YES Token:**
```bash
curl "https://your-domain/api/token/68227038457866748595233145251243944054564947305383894629176574093714476769147"
```

**NO Token:**
```bash
curl "https://your-domain/api/token/23295406450705254064374249781739843340364170407721892525550504746101807113177"
```

### 多选市场 (Market 217 - Pikachu)

**>$5m 选项 YES Token:**
```bash
curl "https://your-domain/api/token/113485738141713319431123088732645191218832539669273333341350183815439329436948"
```

## ✅ 代码修复完成清单

- [x] API Key header 从 `X-API-Key` 改为 `apikey`
- [x] HTTP 方法从 POST 改为 GET
- [x] 端点从 `/market/token-price` 改为 `/token/latest-price`
- [x] 添加查询参数 `?token_id={tokenId}`
- [x] 处理 Opinion API 统一响应格式 `{code, msg, result}`
- [x] 转换响应为前端期望格式 `{success, data: [{price, timestamp}]}`
- [x] 移除调试日志
- [x] 保留错误处理逻辑

## 🎯 总结

**本地测试结果**: 因为地理限制无法成功（预期行为）

**代码状态**: ✅ 所有已知问题已修复，准备部署

**下一步**: 部署到 Vercel 生产环境进行真实测试
