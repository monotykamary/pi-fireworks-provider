import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/vitest.setup.ts"],
    clearMocks: true,
    restoreMocks: true,
  },
  resolve: {
    alias: {
      // index.ts imports getAgentDir + types from @earendil-works/pi-coding-agent
      // at module top-level. Without a stub, importing the module would touch the
      // user's real ~/.pi/agent. The mock's getAgentDir honors PI_CODING_AGENT_DIR
      // (set in tests/vitest.setup.ts) to point at a per-run temp dir.
      "@earendil-works/pi-coding-agent": path.resolve(__dirname, "tests/__mocks__/pi-coding-agent.ts"),
    },
  },
});
