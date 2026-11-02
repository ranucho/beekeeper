import { defineConfig } from 'vite';
// ports: BK_PORT (the page, default 8080) and BK_API_PORT (the data, default 8081)
export default defineConfig({ server: { port: Number(process.env.BK_PORT) || 8080, strictPort: true, proxy: { '/api': 'http://localhost:' + (process.env.BK_API_PORT || 8081) } } });
