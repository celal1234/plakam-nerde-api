import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC, Nest'in ihtiyaç duyduğu decorator metadata'sını üretir (esbuild üretmez).
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: false,
    projects: [
      { extends: true, test: { name: 'unit', include: ['src/**/*.spec.ts'] } },
      { extends: true, test: { name: 'e2e', include: ['test/**/*.e2e-spec.ts'], fileParallelism: false } },
    ],
  },
});
