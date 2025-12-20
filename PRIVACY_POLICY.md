# Privacy Policy for Opinion HUD

**Last Updated: December 17, 2024**

## Overview

Opinion HUD ("the Extension") is a Chrome browser extension that helps users discover prediction markets on Opinion.trade while browsing X (formerly Twitter). This Privacy Policy explains how we handle data and protect your privacy.

## Information We Collect

### Data We DO NOT Collect

**Opinion HUD does NOT collect, store, or transmit any personal information, including:**

- Your tweets or browsing activity
- Your X (Twitter) account information
- Your location data
- Any personally identifiable information (PII)
- Analytics or usage statistics

### Data We DO Use (Local Only)

**Market Data from GitHub Pages:**
- The Extension downloads a public JSON file containing prediction market listings from `https://nobita1998.github.io/Opinion-HUD/data.json`
- This data is cached locally in your browser using `chrome.storage.local`
- This data contains only public market information (titles, labels, URLs) - no user data

**Public Market/Order Data (Opinion Analytics API):**
- When you open the HUD panel, the Extension may request public market metadata and recent trade prices from `https://opinionanalytics.xyz/api`
- These requests are used only to display option labels and current probabilities in the HUD
- Tweet content is never sent in these requests

**Local Matching:**
- All text matching and keyword detection happens **entirely on your device**
- Tweet content is **never** sent to any server
- During matching, no tweet content leaves your browser

## How We Use Data

1. **Market Data Download:** Fetched every hour to keep market listings up-to-date
2. **Local Storage:** Market data is cached in your browser for offline access and performance
3. **Pattern Matching:** Tweet text is analyzed locally to detect relevant keywords and display matching markets
4. **HUD Price Display:** When the HUD is opened, the Extension fetches public market/order data to show probabilities

## Third-Party Services

### Opinion.trade
- When you click "Trade" buttons in the Extension, you are redirected to Opinion.trade
- URLs include a referral parameter `?ref=opinion_hud` for attribution
- Opinion.trade has its own privacy policy governing data collected on their platform
- We do not control or have access to data you provide to Opinion.trade

### Opinion Analytics API
- The Extension may call `https://opinionanalytics.xyz/api` to fetch public market metadata and recent trade prices for displaying probabilities
- These calls do not include tweet content

### GitHub Pages
- Market data is hosted on GitHub Pages (a public CDN)
- GitHub may log standard web server information (IP address, user agent) when fetching `data.json`
- See [GitHub Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-privacy-statement)

### X (Twitter)
- The Extension runs as a content script on X.com and Twitter.com
- We do not interact with Twitter's API or access your account
- X's own privacy policy governs data collected on their platform

## Data Security

- **No Server Storage:** We operate a "local-first" architecture with no backend servers
- **No Authentication:** The Extension requires no login or account creation
- **Open Source:** Our code is publicly auditable on GitHub
- **Minimal Permissions:** We only request permissions necessary for core functionality:
  - `storage`: To cache market data locally
  - `alarms`: To schedule periodic data updates
  - `host_permissions` for `https://nobita1998.github.io/*`: To fetch market data

## Your Rights

Since we do not collect personal data, there is no personal information to:
- Access
- Correct
- Delete
- Export

**To stop all data processing:**
- Simply uninstall the Extension from `chrome://extensions`
- This will remove all locally cached data

## Children's Privacy

Opinion HUD does not knowingly collect data from anyone, including children under 13. Prediction markets may have age restrictions - please review Opinion.trade's terms of service.

## Changes to This Policy

We may update this Privacy Policy from time to time. Changes will be posted at:
- **GitHub:** https://github.com/nobita1998/Opinion-HUD/blob/main/PRIVACY_POLICY.md
- **Extension Updates:** Material changes will be noted in release notes

## Contact

For privacy questions or concerns:
- **GitHub Issues:** https://github.com/nobita1998/Opinion-HUD/issues
- **Repository:** https://github.com/nobita1998/Opinion-HUD

## Consent

By installing and using Opinion HUD, you consent to this Privacy Policy.

---

## 中文版隐私政策

**最后更新：2024年12月17日**

### 概述

Opinion HUD（"本扩展"）是一款 Chrome 浏览器扩展，帮助用户在浏览 X（原 Twitter）时发现 Opinion.trade 上的预测市场。本隐私政策说明我们如何处理数据并保护您的隐私。

### 我们不收集的信息

**Opinion HUD 不会收集、存储或传输任何个人信息，包括：**

- 您的推文或浏览活动
- 您的 X (Twitter) 账户信息
- 您的位置数据
- 任何个人身份信息 (PII)
- 分析或使用统计数据

### 我们使用的数据（仅本地）

**来自 GitHub Pages 的市场数据：**
- 扩展从 `https://nobita1998.github.io/Opinion-HUD/data.json` 下载公开的 JSON 文件
- 此数据使用 `chrome.storage.local` 在浏览器中本地缓存
- 此数据仅包含公开的市场信息（标题、标签、URL）- 不含用户数据

**公开市场/成交数据（Opinion Analytics API）：**
- 当你打开 HUD 面板时，扩展可能会从 `https://opinionanalytics.xyz/api` 拉取公开的市场信息与最新成交价
- 这些请求仅用于在 HUD 中展示选项与概率
- 请求中不会包含推文内容

**本地匹配：**
- 所有文本匹配和关键词检测**完全在您的设备上**进行
- 推文内容**从不**发送到任何服务器
- 匹配过程中不会有推文内容离开您的浏览器

### 数据使用方式

1. **市场数据下载：** 每小时获取一次以保持市场列表更新
2. **本地存储：** 市场数据缓存在浏览器中以供离线访问和提高性能
3. **模式匹配：** 推文文本在本地分析以检测相关关键词并显示匹配的市场

### 第三方服务

**Opinion.trade**
- 当您点击扩展中的"交易"按钮时，将重定向到 Opinion.trade
- URL 包含归因参数 `?ref=opinion_hud`
- Opinion.trade 有自己的隐私政策管理其平台上收集的数据

**GitHub Pages**
- 市场数据托管在 GitHub Pages（公共 CDN）
- 获取 `data.json` 时，GitHub 可能记录标准的 Web 服务器信息

**X (Twitter)**
- 扩展作为内容脚本在 X.com 和 Twitter.com 上运行
- 我们不与 Twitter API 交互或访问您的账户

### 您的权利

由于我们不收集个人数据，因此没有个人信息需要访问、更正、删除或导出。

**停止所有数据处理：**
- 只需从 `chrome://extensions` 卸载扩展
- 这将删除所有本地缓存的数据

### 联系方式

如有隐私问题或疑虑：
- **GitHub Issues:** https://github.com/nobita1998/Opinion-HUD/issues

### 同意

通过安装和使用 Opinion HUD，您同意本隐私政策。
**Opinion Analytics API**
- 扩展可能会调用 `https://opinionanalytics.xyz/api` 拉取公开市场信息与最新成交价用于展示概率
- 这些请求不会包含推文内容
