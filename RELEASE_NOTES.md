# Release Notes

## v1.0.1 (2024-12-24)

### 📋 核心功能改进

#### 1. **CORS 和网络请求优化** ✨
- **新增 `background.js` 代理机制**：通过 service worker 代理 `opinionanalytics.xyz` API 请求，避免 CORS 问题
- **新增权限**：`manifest.json` 中添加了 `https://opinionanalytics.xyz/*` 到 `host_permissions`
- **请求重试机制**：使用 `fetchOpinionApiJsonWithRetry` 自动重试失败的请求（最多 3 次）
- **超时控制**：添加 8 秒超时，避免请求长时间挂起

#### 2. **价格获取错误处理** 🛡️
- **优雅降级**：当 `/api/orders/by-asset/` 返回 502 错误时，不再崩溃，而是显示 `—`
- **错误缓存**：将失败的请求结果缓存，避免重复请求已知失败的端点
- **静默失败**：不在控制台抛出错误，保持用户体验流畅

#### 3. **图标定位改进** 📍
- **更智能的 selector**：支持更多 X.com 的 UI 变体（`tweetActionOverflow`、`overflow` 等）
- **更好的回退逻辑**：移除了 action bar 回退方案，确保图标始终放在 "…" 按钮旁边
- **位置检查优化**：新增 `isIconPlacedNextToMoreButton()` 检查，避免重复注入

#### 4. **性能优化** ⚡
- **预加载 wrap-events**：启动时预先获取 wrap-events 索引，HUD 展开更快
- **更高效的 API 调用**：使用统一的 `fetchOpinionApiJson` 辅助函数

### 📄 文件变化

| 文件 | v1.0.0 | v1.0.1 | 变化 |
|------|--------|--------|------|
| `contentScript.js` | 52KB | 57KB | +5KB (新增重试、代理、错误处理) |
| `background.js` | 3.9KB | 5.4KB | +1.5KB (新增 API 代理功能) |
| `manifest.json` | 685B | 731B | +46B (新增权限) |

### 🐛 修复的问题

1. ✅ 修复了 CORS 导致的 API 请求失败
2. ✅ 修复了 502 错误导致 HUD 无法显示的问题
3. ✅ 修复了图标在某些 X.com UI 布局中找不到位置的问题
4. ✅ 修复了重复注入图标的问题

---

## v1.0.0 (2024-12-20)

### 🎉 首次发布

- 基础的推文匹配功能
- HUD 面板展示市场信息
- 价格实时获取
- 跳转到 Opinion Trade 交易页面
