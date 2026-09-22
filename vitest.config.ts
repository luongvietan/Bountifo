import { defineConfig } from "vitest/config";
import { WxtVitest } from "wxt/testing/vitest-plugin";

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    environment: "node",
    // Isolated agent worktrees under .worktrees/ run their own suites —
    // the root suite must not glob them.
    exclude: [".worktrees/**", "**/node_modules/**"],
  },
});
