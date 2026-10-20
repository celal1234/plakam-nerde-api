import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC, Nest'in ihtiyaç duyduğu decorator metadata'sını üretir (esbuild üretmez).
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: false,
    projects: [
      { extends: true, test: { name: 'unit', include: ['src/**/*.spec.ts'] } },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['test/**/*.e2e-spec.ts'],
          fileParallelism: false,
          env: {
            JWT_SECRET: 'e2e-test-secret-e2e-test-secret-1234',
            APP_URL: 'https://plakamnerde.test',
            // İmzalı adres üretimi çevrimdışı çalışır; testler gerçek bir S3'e bağlanmaz.
            S3_ENDPOINT: 'http://localhost:3900',
            S3_ACCESS_KEY: 'test',
            S3_SECRET_KEY: 'test',
          },
        },
      },
    ],
  },
});
