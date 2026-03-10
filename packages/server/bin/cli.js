#!/usr/bin/env node

// CLI 진입점 - rca up / rca relay
// tsx가 있으면 TypeScript 직접 실행, 없으면 빌드된 dist 사용

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distEntry = resolve(__dirname, '..', 'dist', 'index.js');
const srcEntry = resolve(__dirname, '..', 'src', 'index.ts');

async function run() {
  if (existsSync(distEntry)) {
    // 빌드된 파일 사용
    await import(distEntry);
  } else if (existsSync(srcEntry)) {
    // tsx를 통한 직접 실행 시도
    try {
      // tsx register가 이미 활성화되어 있으면 직접 import 가능
      await import(srcEntry);
    } catch {
      console.error('Error: Build the project first with `npm run build` or use `npx tsx` to run directly.');
      console.error('  npm run build     - Build the project');
      console.error('  npx tsx src/index.ts  - Run directly with tsx');
      process.exit(1);
    }
  } else {
    console.error('Error: Could not find entry point. Run `npm run build` first.');
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
