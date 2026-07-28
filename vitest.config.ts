import { defineConfig } from "vitest/config";

/**
 * Monorepo-level Vitest config.
 *
 * Vitest 4 removed `vitest.workspace.ts` in favour of `test.projects` in the
 * root config. Each package keeps its own `vitest.config.ts`, so both
 * `pnpm --filter @loomtrace/core test` and the root `pnpm test:watch` work.
 */
export default defineConfig({
  test: {
    projects: ["packages/*"],
  },
});
