#!/usr/bin/env node

/**
 * 本地测试脚本 - 不需要 Vercel CLI
 * 直接测试 API 函数逻辑
 */

const handler = require('./api/token/[tokenId]');

// 模拟 Vercel 请求和响应对象
class MockRequest {
  constructor(tokenId) {
    this.method = 'GET';
    this.query = { tokenId };
  }
}

class MockResponse {
  constructor() {
    this.statusCode = 200;
    this.headers = {};
    this.body = null;
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  setHeader(key, value) {
    this.headers[key] = value;
    return this;
  }

  json(data) {
    this.body = data;
    console.log('\n📊 Response Status:', this.statusCode);
    console.log('📦 Response Headers:', JSON.stringify(this.headers, null, 2));
    console.log('📄 Response Body:', JSON.stringify(data, null, 2));
    return this;
  }

  end() {
    console.log('\n✅ Request completed');
    return this;
  }
}

async function testApi() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║     Opinion HUD API - Local Test                        ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  // 测试用例 1: Market 3062 - Trump YES token
  const testTokenId = '68227038457866748595233145251243944054564947305383894629176574093714476769147';

  console.log('🧪 测试用例: Market 3062 (Trump) - YES Token');
  console.log(`📝 Token ID: ${testTokenId}`);
  console.log('');

  const req = new MockRequest(testTokenId);
  const res = new MockResponse();

  try {
    await handler(req, res);

    if (res.statusCode === 200 && res.body.success) {
      console.log('');
      console.log('✅ 测试成功！API 正常工作');
      console.log('');
      console.log('💡 下一步:');
      console.log('   1. 部署到 Vercel: npm run deploy');
      console.log('   2. 或者继续测试其他 Token ID');
      process.exit(0);
    } else {
      console.error('');
      console.error('❌ 测试失败: API 返回错误');
      process.exit(1);
    }

  } catch (error) {
    console.error('');
    console.error('❌ 测试失败:');
    console.error(`   ${error.message}`);
    console.error('');
    console.error('Stack trace:');
    console.error(error.stack);
    process.exit(1);
  }
}

// 运行测试
testApi().catch((error) => {
  console.error('发生错误:', error);
  process.exit(1);
});
