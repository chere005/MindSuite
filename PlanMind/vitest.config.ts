import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['packages/core/test/**/*.test.ts', 'app/**/*.test.ts'], setupFiles: ['packages/core/test/people.setup.ts'] } });
