import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
// Two builds:
//   vite build               -> served by the Express API from "/" (npm start)
//   vite build --mode pages  -> static GitHub Pages build under "/AI-job-agent/" (see .env.pages)
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === 'pages' ? '/AI-job-agent/' : '/',
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
}))
