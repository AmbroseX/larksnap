import { defineConfig } from 'vitest/config';

// 只跑本项目 src 下的单测；ref/ 是第三方参考代码（自带测试），一律排除
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'ref/**', 'dist/**'],
  },
});
