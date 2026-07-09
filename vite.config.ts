import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  appendFileSync,
  readdirSync,
  cpSync,
} from 'fs';
import { build as esbuild } from 'esbuild';
import JavaScriptObfuscator from 'javascript-obfuscator';

export default defineConfig(({ mode }) => {
  const isDev = mode === 'development';

  return {
    plugins: [
      react(),
      {
        name: 'extension-post-build',
        async closeBundle() {
          const distDir = resolve(__dirname, 'dist');
          if (!existsSync(distDir)) {
            mkdirSync(distDir, { recursive: true });
          }

          // content script 不支持 ES module，单独用 esbuild 打成 IIFE
          await esbuild({
            entryPoints: [resolve(__dirname, 'src/content/index.ts')],
            bundle: true,
            format: 'iife',
            outfile: resolve(distDir, 'content.js'),
            sourcemap: isDev ? 'inline' : false,
            target: 'chrome110',
            tsconfig: resolve(__dirname, 'tsconfig.json'),
          });

          // webcopy 独立入口：turndown/readability 只进这个包，飞书导出路径体积不变
          await esbuild({
            entryPoints: [resolve(__dirname, 'src/content/webcopy/index.ts')],
            bundle: true,
            format: 'iife',
            outfile: resolve(distDir, 'webcopy.js'),
            sourcemap: isDev ? 'inline' : false,
            target: 'chrome110',
            tsconfig: resolve(__dirname, 'tsconfig.json'),
          });

          // 读取 manifest 并写入 dist（把 background 入口换成编译后的 JS）
          const manifest = JSON.parse(
            readFileSync(resolve(__dirname, 'manifest.json'), 'utf-8')
          );
          manifest.background = {
            service_worker: 'background.js',
            type: 'module',
          };

          if (isDev) {
            // 开发模式：写入构建时间戳并向 background.js 注入热重载逻辑
            manifest._buildTime = Date.now();
            const bgPath = resolve(distDir, 'background.js');
            if (existsSync(bgPath)) {
              const hotReloadCode = `
// === Hot Reload (dev only) ===
;(function(){
  const RELOAD_INTERVAL = 1000;
  let lastHash = '';
  async function hash(t){const d=new TextEncoder().encode(t),b=await crypto.subtle.digest('SHA-256',d);return Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,'0')).join('')}
  async function check(){try{const r=await fetch(chrome.runtime.getURL('manifest.json'),{cache:'no-cache'}),t=await r.text(),h=await hash(t);if(lastHash&&h!==lastHash){console.log('[HotReload] 检测到文件变化，重载插件...');chrome.runtime.reload();return}lastHash=h}catch{}}
  console.log('[HotReload] 开发模式热重载已启用');
  setInterval(check,RELOAD_INTERVAL);check();
})();
`;
              appendFileSync(bgPath, hotReloadCode);
            }
          }

          writeFileSync(
            resolve(distDir, 'manifest.json'),
            JSON.stringify(manifest, null, 2)
          );

          // 拷贝图标到 dist（manifest 里以 icons/icon-*.png 引用）
          const iconsSrc = resolve(__dirname, 'icons');
          if (existsSync(iconsSrc)) {
            for (const f of readdirSync(iconsSrc)) {
              if (f.endsWith('.png')) {
                cpSync(resolve(iconsSrc, f), resolve(distDir, 'icons', f));
              }
            }
          }

          // 代码混淆：默认关闭。Chrome 应用商店禁止上架混淆代码（minify 可以，
          // obfuscate 会被打回），开源版本也应保持可读。需要保护逻辑的私有构建
          // 用 `OBFUSCATE=1 npm run build` 显式开启。
          if (!isDev && process.env.OBFUSCATE === '1') {
            const obfuscateOptions = {
              compact: true,
              controlFlowFlattening: true,
              controlFlowFlatteningThreshold: 0.5,
              deadCodeInjection: true,
              deadCodeInjectionThreshold: 0.2,
              identifierNamesGenerator: 'hexadecimal' as const,
              renameGlobals: false,
              selfDefending: false, // Chrome 扩展不要开，会与 CSP 冲突
              stringArray: true,
              stringArrayThreshold: 0.5,
              stringArrayEncoding: ['base64' as const],
              stringArrayRotate: true,
              stringArrayShuffle: true,
              splitStrings: true,
              splitStringsChunkLength: 10,
              transformObjectKeys: true,
              unicodeEscapeSequence: false,
            };

            const jsFiles: string[] = [];
            for (const f of readdirSync(distDir)) {
              if (f.endsWith('.js')) jsFiles.push(resolve(distDir, f));
            }
            const assetsDir = resolve(distDir, 'assets');
            if (existsSync(assetsDir)) {
              for (const f of readdirSync(assetsDir)) {
                if (f.endsWith('.js')) jsFiles.push(resolve(assetsDir, f));
              }
            }

            for (const filePath of jsFiles) {
              const code = readFileSync(filePath, 'utf-8');
              const result = JavaScriptObfuscator.obfuscate(code, obfuscateOptions);
              writeFileSync(filePath, result.getObfuscatedCode());
            }
            console.log(`[obfuscator] 已混淆 ${jsFiles.length} 个 JS 文件`);
          }
        },
      },
    ],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
      },
    },
    base: './',
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: isDev ? 'inline' : false,
      // 每个页面只加载自己的 CSS，避免 popup/options/sidepanel 的全局 body 规则互相串台
      cssCodeSplit: true,
      watch: isDev ? {} : null,
      rollupOptions: {
        input: {
          background: resolve(__dirname, 'src/background/index.ts'),
          popup: resolve(__dirname, 'popup.html'),
          options: resolve(__dirname, 'options.html'),
          sidepanel: resolve(__dirname, 'sidepanel.html'),
          offscreen: resolve(__dirname, 'offscreen.html'),
        },
        output: {
          entryFileNames: (chunkInfo) => {
            if (chunkInfo.name === 'background') return 'background.js';
            return 'assets/[name]-[hash].js';
          },
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(mode),
    },
  };
});
