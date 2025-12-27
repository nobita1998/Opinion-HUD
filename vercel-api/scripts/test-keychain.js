#!/usr/bin/env node

/**
 * Test Script - 测试 API Key 读取
 *
 * 用法:
 *   node scripts/test-keychain.js
 */

const { getOpinionApiKey } = require('../lib/keychain');

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║     Opinion HUD API - Keychain Test Tool                ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  console.log('🔍 检查 API Key 来源...');
  console.log('');

  // 检查环境变量
  const envKey = process.env.OPINION_KEY;
  if (envKey) {
    console.log('✅ 环境变量 OPINION_KEY:');
    console.log(`   ${maskApiKey(envKey)}`);
    console.log('');
  } else {
    console.log('❌ 环境变量 OPINION_KEY: 未设置');
    console.log('');
  }

  // 检查操作系统
  console.log(`📱 操作系统: ${process.platform}`);
  if (process.platform !== 'darwin') {
    console.log('⚠️  macOS Keychain 仅在 macOS 上可用');
  }
  console.log('');

  // 尝试获取 API Key
  console.log('🔑 尝试获取 API Key...');
  console.log('');

  try {
    const apiKey = await getOpinionApiKey();

    if (apiKey) {
      console.log('✅ 成功获取 API Key!');
      console.log(`   ${maskApiKey(apiKey)}`);
      console.log('');
      console.log('📊 来源判断:');
      if (envKey === apiKey) {
        console.log('   📌 环境变量');
      } else {
        console.log('   🔐 macOS Keychain');
      }
      console.log('');
      console.log('✨ API 配置正确，可以启动开发服务器:');
      console.log('   npm run dev');
    } else {
      console.log('❌ 未找到 API Key');
      console.log('');
      console.log('💡 请使用以下方式之一设置 API Key:');
      console.log('');
      console.log('   方式 1 (macOS Keychain):');
      console.log('     npm run setup');
      console.log('');
      console.log('   方式 2 (环境变量):');
      console.log('     export OPINION_API_KEY=your_api_key');
      console.log('');
      console.log('   方式 3 (.env 文件):');
      console.log('     cp .env.example .env');
      console.log('     # 编辑 .env，添加 OPINION_API_KEY');
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ 获取 API Key 时发生错误:');
    console.error(`   ${error.message}`);
    console.error('');
    console.error('请检查配置并重试');
    process.exit(1);
  }
}

function maskApiKey(key) {
  if (!key || key.length < 8) {
    return '***';
  }
  const start = key.substring(0, 4);
  const end = key.substring(key.length - 4);
  const middle = '*'.repeat(Math.min(key.length - 8, 20));
  return `${start}${middle}${end}`;
}

main().catch((error) => {
  console.error('发生错误:', error);
  process.exit(1);
});
