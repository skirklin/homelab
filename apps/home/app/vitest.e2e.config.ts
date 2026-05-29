import { defineConfig } from "vitest/config";
import { e2eTestConfig } from "@kirkl/shared/test-utils";

// Shared e2e config — include glob, node env, timeouts, and the per-worktree
// PB_TEST_URL fallback all live in `e2eTestConfig()`. See infra/test-env.sh
// for the port-derivation algorithm.
export default defineConfig({ test: e2eTestConfig() });
