import os from "os";
import fs from "fs";
import path from "path";

// Isolate every test run from the user's real ~/.pi/agent AND from other test
// files (which run in parallel workers). index.ts calls getAgentDir() at module
// top-level (before any test runs), so this must happen in a globalSetup /
// setupFile that runs prior to importing the module under test. The per-worker
// suffix (VITEST_WORKER_ID) gives each test file its own dir so parallel files
// that read/write the same config/cache paths (e.g. config.test.ts and
// logit-bias.test.ts both touch extensions/fireworks.json) don't race, and each
// worker gets its own module instance (so module-level caches like fireworksConfig
// can't bleed across files).
const workerId = process.env.VITEST_WORKER_ID ?? "0";
const tmpRoot = path.join(os.tmpdir(), `pi-fireworks-provider-tests-${workerId}`);
fs.mkdirSync(tmpRoot, { recursive: true });
process.env.PI_CODING_AGENT_DIR = tmpRoot;
