#!/usr/bin/env node

/**
 * Setup Script - 保存 API Key 到 macOS Keychain
 *
 * 用法:
 *   node scripts/setup-keychain.js
 *
 * 或者:
 *   npm run setup
 */

const readline = require('readline');
const { saveKeyToKeychain, KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT } = require('../lib/keychain');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer);
    });
  });
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║     Opinion HUD API - Keychain Setup Tool               ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('此工具将您的 Opinion.Trade API Key 保存到 macOS Keychain。');
  console.log('');
  console.log('存储位置:');
  console.log(`  Service: ${KEYCHAIN_SERVICE}`);
  console.log(`  Account: ${KEYCHAIN_ACCOUNT}`);
  console.log('');

  // 检查操作系统
  if (process.platform !== 'darwin') {
    console.error('❌ 错误: 此工具仅支持 macOS');
    console.error('');
    console.error('对于其他操作系统，请使用环境变量:');
    console.error('  export OPINION_API_KEY=your_api_key');
    rl.close();
    process.exit(1);
  }

  // 获取 API Key
  const apiKey = await question('请输入您的 Opinion.Trade API Key: ');

  if (!apiKey || apiKey.trim().length === 0) {
    console.error('❌ API Key 不能为空');
    rl.close();
    process.exit(1);
  }

  console.log('');
  console.log('⏳ 正在保存到 Keychain...');

  // 保存到 Keychain
  const success = await saveKeyToKeychain(apiKey.trim());

  console.log('');

  if (success) {
    console.log('✅ 成功! API Key 已保存到 macOS Keychain');
    console.log('');
    console.log('您现在可以:');
    console.log('  1. 启动开发服务器: npm run dev');
    console.log('  2. 测试 API: http://localhost:3000/test.html');
    console.log('');
    console.log('提示: API Key 会在本地开发时自动从 Keychain 读取');
  } else {
    console.error('❌ 保存失败，请检查错误信息');
    console.log('');
    console.log('替代方案: 使用 .env 文件');
    console.log('  1. cp .env.example .env');
    console.log('  2. 编辑 .env，添加 OPINION_API_KEY=your_api_key');
  }

  rl.close();
}

main().catch((error) => {
  console.error('发生错误:', error);
  rl.close();
  process.exit(1);
});
