import { defineConfig } from 'vitest/config';
// hookTimeout: the cleanup of a temporary folder retries for several seconds while Windows (an antivirus scan) still holds a file.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 20000, hookTimeout: 60000 } });
