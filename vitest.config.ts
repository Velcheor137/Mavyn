import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['packages/{core,markdown-engine,i18n,storage,sync-client}/src/**/*.test.ts', 'tests/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['packages/{ui,editor,platform}/src/**/*.test.{ts,tsx}', 'apps/web/src/**/*.test.{ts,tsx}'],
          setupFiles: ['./tests/setup-dom.ts'],
        },
      },
    ],
  },
});
