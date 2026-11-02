import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const webRoot = fileURLToPath(new URL('./src/web', import.meta.url));
const sharedRoot = fileURLToPath(new URL('./src/shared', import.meta.url));
const outDir = fileURLToPath(new URL('./dist/public', import.meta.url));

/**
 * 前端构建：Vue 3 SFC + TypeScript + SCSS，产物直接落到 dist/public，
 * 由 src/server 的 express 静态托管（生产环境只有一个进程、一个端口）。
 *
 * dev 时 Vite 跑在 5173，把 /socket.io 与 /health 代理到 3210 的 tsx 后端，
 * 这样 `yarn dev` 可以是两条命令并行、仍是同源 socket 连接。
 */
export default defineConfig({
  root: webRoot,
  publicDir: false,
  plugins: [vue()],
  resolve: {
    alias: {
      '@': webRoot,
      '@shared': sharedRoot,
    },
  },
  build: {
    outDir,
    emptyOutDir: true,
    target: 'es2022',
    assetsDir: 'assets',
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/socket.io': { target: 'http://127.0.0.1:3210', ws: true },
      '/health': { target: 'http://127.0.0.1:3210' },
    },
  },
  css: {
    preprocessorOptions: {
      scss: { api: 'modern-compiler' },
    },
  },
});
