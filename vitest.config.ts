import { defaultExclude, defineConfig } from "vitest/config";

/**
 * Root-level config, for `npx vitest run` typed at the repository root.
 *
 * `npm test` doesn't come through here — it runs `-w @zpcrweb/core`, which uses
 * `packages/core/vitest.config.ts` and its `test/**` include. But a bare `npx vitest run` at the
 * root walks the whole tree, and `.claude/worktrees/` holds complete checkouts of this repo: one
 * per branch in flight, each with its own copy of every test file. Left alone it collects them
 * all — 152 files and 2104 tests instead of 39 and 540 — and runs whatever stale code those
 * branches happen to be sitting on, which is both slow and a lie about the working tree.
 */
export default defineConfig({
  test: {
    exclude: [...defaultExclude, "**/.claude/**"],
  },
});
