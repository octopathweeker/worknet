import { defineConfig } from 'vite';
export default defineConfig({ server: { port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:8790', changeOrigin: true }, '/workspace': { target: 'http://127.0.0.1:8790', changeOrigin: true } } } });
