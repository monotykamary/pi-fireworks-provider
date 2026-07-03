import os from "os";
import fs from "fs";
import path from "path";

// Isolate every test run from the user's real ~/.pi/agent. index.ts calls
// getAgentDir() at module top-level (before any test runs), so this must happen
// in a globalSetup / setupFile that runs prior to importing the module under
// test. Vitest loads setupFiles before the test modules are imported.
const tmpRoot = path.join(os.tmpdir(), "pi-fireworks-provider-tests");
fs.mkdirSync(tmpRoot, { recursive: true });
process.env.PI_CODING_AGENT_DIR = tmpRoot;
