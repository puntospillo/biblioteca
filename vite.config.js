import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Percorsi relativi: il sito deve funzionare sia servito dalla radice
  // (Netlify) sia da una sottocartella come /biblioteca/ (GitHub Pages).
  base: './',
  plugins: [react()],
  server: {
    port: 3000,
    host: true
  }
});
