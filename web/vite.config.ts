import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // No proxy: the UI talks to the server directly on CLAUDIA_PORT (see web/src/store.ts).
  //
  // strictPort matters: by default Vite silently moves to the next free port, so
  // a second instance serves the new code on 4319 while the browser keeps
  // showing stale code from 4318. Failing loudly is far easier to diagnose.
  server: { port: 4318, strictPort: true },
});
