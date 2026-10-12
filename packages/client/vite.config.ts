import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev (`npm run dev:client`) the socket goes to the host server on port 3000.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/ws': { target: 'ws://localhost:3000', ws: true }, '/api': 'http://localhost:3000' } },
});
