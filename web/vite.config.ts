import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // No proxy: the UI talks to the server directly on CLAUDIA_PORT (see web/src/store.ts).
  server: { port: 4318 },
});
