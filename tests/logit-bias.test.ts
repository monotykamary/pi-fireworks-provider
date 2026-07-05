/**
 * Tests for the logit_bias feature: config validation helpers (parseLogitBiasMap,
 * parseLogitBiasConfig, isValidBiasValue, parseBiasInput / parseTokenIdInput),
 * the config round-trip (loadFireworksConfig + mutateLogitBias / getLogitBias),
 * the summary helper, and the before_provider_request injection (OpenAI injected;
 * disabled / empty / Anthropic-transport / non-fireworks skipped).
 *
 * The TUI editor (LogitBiasEditor) is a thin Component over these pure helpers
 * + mutateLogitBias, so it isn't unit-tested here — mirroring makora, which tests
 * the helpers and the onPayload injection, not the SettingsList rendering.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import init, {
  setPreserve,
  setTier,
  isValidBiasValue,
  parseLogitBiasMap,
  parseLogitBiasConfig,
  parseBiasInput,
  parseTokenIdInput,
  getLogitBias,
  mutateLogitBias,
  logitBiasSummary,
  loadFireworksConfig,
  LogitBiasEditor,
} from "../index.js";

const CONFIG_DIR = path.join(process.env.PI_CODING_AGENT_DIR!, "extensions");
const CONFIG_PATH = path.join(CONFIG_DIR, "fireworks.json");

beforeEach(() => {
  try { fs.rmSync(CONFIG_DIR, { recursive: true, force: true }); } catch {}
});
afterEach(() => {
  try { fs.rmSync(CONFIG_DIR, { recursive: true, force: true }); } catch {}
});

describe("isValidBiasValue", () => {
  it("accepts integers in [-100, 100] (boundaries inclusive)", () => {
    expect(isValidBiasValue(-100)).toBe(true);
    expect(isValidBiasValue(-1)).toBe(true);
    expect(isValidBiasValue(0)).toBe(true);
    expect(isValidBiasValue(50)).toBe(true);
    expect(isValidBiasValue(100)).toBe(true);
  });

  it("rejects out-of-range, non-integer, and non-number values", () => {
    expect(isValidBiasValue(-101)).toBe(false);
    expect(isValidBiasValue(101)).toBe(false);
    expect(isValidBiasValue(1.5)).toBe(false);
    expect(isValidBiasValue("5")).toBe(false);
    expect(isValidBiasValue(null)).toBe(false);
    expect(isValidBiasValue(undefined)).toBe(false);
    expect(isValidBiasValue(NaN)).toBe(false);
    expect(isValidBiasValue(true)).toBe(false);
  });
});

describe("parseLogitBiasMap", () => {
  it("returns {} for non-object / array / null / undefined", () => {
    expect(parseLogitBiasMap(null)).toEqual({});
    expect(parseLogitBiasMap(undefined)).toEqual({});
    expect(parseLogitBiasMap("x")).toEqual({});
    expect(parseLogitBiasMap([])).toEqual({});
    expect(parseLogitBiasMap(42)).toEqual({});
  });

  it("keeps valid entries and normalizes integer-string keys (042 → 42)", () => {
    expect(parseLogitBiasMap({ "1": 5, "042": -3, "0": 100 })).toEqual({ "1": 5, "42": -3, "0": 100 });
  });

  it("drops non-numeric / negative / decimal / whitespace-padded keys", () => {
    expect(parseLogitBiasMap({ "abc": 5, "-1": 5, "1.5": 5, " 1": 5 })).toEqual({});
  });

  it("drops out-of-range / non-integer / non-number values", () => {
    expect(parseLogitBiasMap({ "1": 101, "2": -101, "3": 1.5, "4": "5", "5": null })).toEqual({});
  });
});

describe("parseLogitBiasConfig", () => {
  it("returns defaults for non-object / array", () => {
    expect(parseLogitBiasConfig(null)).toEqual({ enabled: false, biases: {} });
    expect(parseLogitBiasConfig("x")).toEqual({ enabled: false, biases: {} });
    expect(parseLogitBiasConfig([])).toEqual({ enabled: false, biases: {} });
    expect(parseLogitBiasConfig(undefined)).toEqual({ enabled: false, biases: {} });
  });

  it("enabled is true only for the boolean true", () => {
    expect(parseLogitBiasConfig({ enabled: "true", biases: { "1": 5 } }).enabled).toBe(false);
    expect(parseLogitBiasConfig({ enabled: 1, biases: { "1": 5 } }).enabled).toBe(false);
    expect(parseLogitBiasConfig({ biases: { "1": 5 } }).enabled).toBe(false);
    expect(parseLogitBiasConfig({ enabled: true, biases: { "1": 5 } }).enabled).toBe(true);
  });

  it("parses enabled + biases, dropping invalid entries", () => {
    expect(parseLogitBiasConfig({ enabled: true, biases: { "1": 5, "bad": 999, "2": -50 } })).toEqual({
      enabled: true,
      biases: { "1": 5, "2": -50 },
    });
  });
});

describe("parseTokenIdInput / parseBiasInput", () => {
  it("parseTokenIdInput accepts non-negative integers, normalizes leading zeros", () => {
    expect(parseTokenIdInput("0")).toBe(0);
    expect(parseTokenIdInput("123")).toBe(123);
    expect(parseTokenIdInput("007")).toBe(7);
  });

  it("parseTokenIdInput rejects negatives / decimals / signs / empty / non-numeric / whitespace", () => {
    expect(parseTokenIdInput("-1")).toBeNull();
    expect(parseTokenIdInput("1.5")).toBeNull();
    expect(parseTokenIdInput("+5")).toBeNull();
    expect(parseTokenIdInput("")).toBeNull();
    expect(parseTokenIdInput("abc")).toBeNull();
    expect(parseTokenIdInput(" 1")).toBeNull();
  });

  it("parseBiasInput accepts integers in [-100, 100] (boundaries)", () => {
    expect(parseBiasInput("0")).toBe(0);
    expect(parseBiasInput("-100")).toBe(-100);
    expect(parseBiasInput("100")).toBe(100);
    expect(parseBiasInput("-50")).toBe(-50);
  });

  it("parseBiasInput rejects out-of-range / decimals / signs / empty / non-numeric", () => {
    expect(parseBiasInput("101")).toBeNull();
    expect(parseBiasInput("-101")).toBeNull();
    expect(parseBiasInput("1.5")).toBeNull();
    expect(parseBiasInput("+5")).toBeNull();
    expect(parseBiasInput("")).toBeNull();
    expect(parseBiasInput("abc")).toBeNull();
  });
});

describe("loadFireworksConfig + mutateLogitBias + getLogitBias", () => {
  it("mutateLogitBias writes the file and refreshes the in-memory cache (getLogitBias reads it)", () => {
    mutateLogitBias((lb) => { lb.enabled = true; lb.biases = { "10": 7, "20": -3 }; });
    expect(getLogitBias()).toEqual({ enabled: true, biases: { "10": 7, "20": -3 } });
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    expect(raw.logitBias).toEqual({ enabled: true, biases: { "10": 7, "20": -3 } });
  });

  it("mutateLogitBias preserves unrelated config fields (read-modify-write)", () => {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        futureKey: 99,
        serviceTier: { default: "priority" },
        preserveThinking: { default: true },
        logitBias: { enabled: false, biases: { "5": 1 } },
      }),
    );
    mutateLogitBias((lb) => { lb.enabled = true; lb.biases["9"] = 9; });
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    expect(raw.futureKey).toBe(99); // survived the partial write
    expect(raw.serviceTier.default).toBe("priority");
    expect(raw.preserveThinking.default).toBe(true);
    expect(raw.logitBias).toEqual({ enabled: true, biases: { "5": 1, "9": 9 } });
  });

  it("loadFireworksConfig parses a hand-edited logitBias map (normalizes + drops invalid)", () => {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        logitBias: { enabled: true, biases: { "01": 5, "abc": 3, "99": 999, "-1": 1, "42": -50 } },
      }),
    );
    // "01" → "1" normalized; "abc" dropped (non-numeric key); "99":999 dropped
    // (bias > 100); "-1" dropped (negative token-ID key); "42": -50 kept.
    expect(loadFireworksConfig().logitBias).toEqual({ enabled: true, biases: { "1": 5, "42": -50 } });
  });

  it("defaults to disabled + empty when logitBias is absent from the file", () => {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ serviceTier: { default: "standard" } }));
    expect(loadFireworksConfig().logitBias).toEqual({ enabled: false, biases: {} });
  });
});

describe("logitBiasSummary", () => {
  it("is 'off' when disabled + empty", () => {
    mutateLogitBias((lb) => { lb.enabled = false; lb.biases = {}; });
    expect(logitBiasSummary()).toBe("off");
  });

  it("is 'on · empty' when enabled + empty", () => {
    mutateLogitBias((lb) => { lb.enabled = true; lb.biases = {}; });
    expect(logitBiasSummary()).toBe("on · empty");
  });

  it("counts entries and reflects enabled state", () => {
    mutateLogitBias((lb) => { lb.enabled = true; lb.biases = { "1": 1 }; });
    expect(logitBiasSummary()).toBe("1 entry · on");
    mutateLogitBias((lb) => { lb.enabled = false; lb.biases = { "1": 1, "2": 2 }; });
    expect(logitBiasSummary()).toBe("2 entries · off");
  });
});

// ─── before_provider_request injection ───────────────────────────────────────

function captureHandlers() {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const piStub: any = {
    on: (event: string, handler: any) => { handlers[event] = handler; },
    registerProvider: () => {},
    registerShortcut: () => {},
    registerCommand: () => {},
    appendEntry: () => {},
    events: { emit: () => {} },
  };
  init(piStub);
  return handlers;
}

function stubCtx(model: any) {
  return {
    model,
    ui: { setStatus: () => {}, theme: { fg: (_n: string, s: string) => s } },
  };
}

const glmId = "accounts/fireworks/models/glm-5p2";

function fwModel(id: string, overrides: any = {}) {
  return { provider: "fireworks", id, name: id, reasoning: true, ...overrides };
}

describe("before_provider_request: logit_bias injection", () => {
  let before: (event: any, ctx: any) => any;

  beforeEach(() => {
    const handlers = captureHandlers();
    before = handlers["before_provider_request"];
    setPreserve(false);
    const ctx = stubCtx(fwModel(glmId));
    setTier(ctx, "standard");
    mutateLogitBias((lb) => { lb.enabled = false; lb.biases = {}; });
  });

  it("injects logit_bias when enabled + non-empty on an OpenAI-completions model", () => {
    mutateLogitBias((lb) => { lb.enabled = true; lb.biases = { "123": 5, "456": -100 }; });
    const ctx = stubCtx(fwModel(glmId));
    const out = before({ payload: { model: glmId, messages: [] } }, ctx) as any;
    expect(out.logit_bias).toEqual({ "123": 5, "456": -100 });
  });

  it("does NOT inject when enabled is false (even with entries)", () => {
    mutateLogitBias((lb) => { lb.enabled = false; lb.biases = { "123": 5 }; });
    const ctx = stubCtx(fwModel(glmId));
    const out = before({ payload: { model: glmId, messages: [] } }, ctx);
    expect(out?.logit_bias).toBeUndefined();
  });

  it("does NOT inject when the map is empty (even if enabled)", () => {
    mutateLogitBias((lb) => { lb.enabled = true; lb.biases = {}; });
    const ctx = stubCtx(fwModel(glmId));
    const out = before({ payload: { model: glmId, messages: [] } }, ctx);
    expect(out?.logit_bias).toBeUndefined();
  });

  it("does NOT inject on an Anthropic-routed model (api: anthropic-messages)", () => {
    mutateLogitBias((lb) => { lb.enabled = true; lb.biases = { "123": 5 }; });
    const ctx = stubCtx(fwModel(glmId, { api: "anthropic-messages" }));
    const out = before({ payload: { model: glmId, messages: [], max_tokens: 1024 } }, ctx);
    expect(out?.logit_bias).toBeUndefined();
  });

  it("does NOT inject for a non-fireworks model (early return)", () => {
    mutateLogitBias((lb) => { lb.enabled = true; lb.biases = { "123": 5 }; });
    const ctx = stubCtx({ provider: "neuralwatt", id: "glm-5.2", reasoning: true });
    const out = before({ payload: { model: "glm-5.2", messages: [] } }, ctx);
    expect(out).toBeUndefined();
  });

  it("coexists with priority + preserve (all three inject on one OpenAI request)", () => {
    mutateLogitBias((lb) => { lb.enabled = true; lb.biases = { "1": 1 }; });
    setPreserve(true);
    const ctx = stubCtx(fwModel(glmId));
    setTier(ctx, "priority");
    const out = before({ payload: { model: glmId, messages: [] } }, ctx) as any;
    expect(out.service_tier).toBe("priority");
    expect(out.reasoning_history).toBe("preserved");
    expect(out.logit_bias).toEqual({ "1": 1 });
  });

  it("logit_bias injects even when service_tier does not (non-priority model)", () => {
    mutateLogitBias((lb) => { lb.enabled = true; lb.biases = { "7": -7 }; });
    const ctx = stubCtx(fwModel("accounts/fireworks/models/kimi-k2p6-fast", { reasoning: false }));
    const out = before({ payload: { model: "accounts/fireworks/models/kimi-k2p6-fast", messages: [] } }, ctx) as any;
    expect(out?.service_tier).toBeUndefined();
    expect(out.logit_bias).toEqual({ "7": -7 });
  });
});

// ─── LogitBiasEditor TUI (render + interactions with stub deps) ────────────────
//
// The editor is a thin Component over mutateLogitBias + the pi-tui Input. We
// drive it with minimal stub deps (Input that echoes "> <value>", matchesKey by
// string equality, fuzzyFilter by substring) to assert the search `>` area
// renders, filtering works, and add/delete via keys persist — guarding the UX
// the unit tests above don't cover.

function stubInput(): any {
  return class {
    focused = false;
    onSubmit?: (v: string) => void;
    onEscape?: () => void;
    private v = "";
    setValue(s: string) { this.v = s; }
    getValue() { return this.v; }
    handleInput(d: string) {
      // The real Input fires onSubmit on Enter and onEscape on Esc; the editor
      // delegates all keys to the Input in add/edit modes, so the stub must too.
      if (d === "enter") { this.onSubmit?.(this.v); return; }
      if (d === "escape") { this.onEscape?.(); return; }
      this.v += d;
    }
    invalidate(): void {}
    render(_w: number): string[] { return ["> " + this.v]; }
  };
}

function stubDeps(overrides: Record<string, any> = {}): any {
  return {
    InputCtor: stubInput(),
    matchesKey: (data: string, key: any) => typeof key === "string" && data === key,
    Key: { up: "up", down: "down", enter: "enter", escape: "escape" },
    truncateToWidth: (s: string) => s,
    visibleWidth: (s: string) => s.length,
    wrapTextWithAnsi: (s: string) => [s],
    fuzzyFilter: <T,>(items: T[], q: string, keyFn: (i: T) => string): T[] =>
      q ? items.filter((i) => keyFn(i).includes(q)) : items,
    settingsListTheme: {
      label: (t: string) => t,
      value: (t: string) => t,
      description: (t: string) => t,
      cursor: "> ",
      hint: (t: string) => t,
    },
    theme: { fg: (_n: string, t: string) => t },
    notify: () => {},
    subDone: () => {},
    ...overrides,
  };
}

describe("LogitBiasEditor", () => {
  it("renders the search `>` area at the top of the panel", () => {
    mutateLogitBias((lb) => { lb.enabled = true; lb.biases = { "123": 5 }; });
    const ed = new LogitBiasEditor(stubDeps());
    const lines = ed.render(80);
    expect(lines[0]).toMatch(/^> /); // the search `>` line
    expect(lines.some((l) => l.includes("Enabled"))).toBe(true);
    expect(lines.some((l) => l.includes("token 123"))).toBe(true);
    expect(lines.some((l) => l.includes("Add token"))).toBe(true);
    expect(lines.some((l) => l.includes("Type to search"))).toBe(true);
  });

  it("filters rows by the search query (substring on label)", () => {
    mutateLogitBias((lb) => { lb.enabled = true; lb.biases = { "123": 5, "456": -3 }; });
    const ed = new LogitBiasEditor(stubDeps());
    ed.handleInput("4"); // search "4" → only token 456 matches
    const lines = ed.render(80);
    expect(lines.some((l) => l.includes("token 456"))).toBe(true);
    expect(lines.some((l) => l.includes("token 123"))).toBe(false);
  });

  it("shows `No matching tokens` when the query matches nothing", () => {
    mutateLogitBias((lb) => { lb.enabled = true; lb.biases = { "123": 5 }; });
    const ed = new LogitBiasEditor(stubDeps());
    ed.handleInput("z");
    const lines = ed.render(80);
    expect(lines.some((l) => l.includes("No matching tokens"))).toBe(true);
    expect(lines.some((l) => l.includes("token 123"))).toBe(false);
  });

  it("`d` deletes the selected entry when the search query is empty", () => {
    mutateLogitBias((lb) => { lb.enabled = true; lb.biases = { "123": 5, "456": -3 }; });
    const notify: string[] = [];
    const ed = new LogitBiasEditor(stubDeps({ notify: (m: string) => notify.push(m) }));
    ed.handleInput("down"); // Enabled (0) → token 123 (1)
    ed.handleInput("d");    // delete token 123
    expect(notify[0]).toContain("123");
    expect(getLogitBias().biases).toEqual({ "456": -3 });
  });

  it("routes `d` to the search input (no delete) when a query is active", () => {
    mutateLogitBias((lb) => { lb.enabled = true; lb.biases = { "123": 5, "456": -3 }; });
    const notify: string[] = [];
    const ed = new LogitBiasEditor(stubDeps({ notify: (m: string) => notify.push(m) }));
    ed.handleInput("4"); // search "4" → token 456
    ed.handleInput("d"); // query active → append "d" (query "4d"), NOT a delete
    expect(notify.length).toBe(0);
    const lines = ed.render(80);
    expect(lines.some((l) => l.includes("No matching tokens"))).toBe(true);
  });

  it("Enter on Add token… prompts for token ID then bias and persists", () => {
    mutateLogitBias((lb) => { lb.enabled = true; lb.biases = {}; });
    const ed = new LogitBiasEditor(stubDeps());
    ed.handleInput("down"); // Enabled (0) → Add token… (1, no entries)
    ed.handleInput("enter"); // → addToken mode
    ed.handleInput("1"); ed.handleInput("2"); ed.handleInput("3"); // token ID "123"
    ed.handleInput("enter"); // → addBias mode (prefilled "0")
    ed.handleInput("5"); // bias "05"
    ed.handleInput("enter"); // submit → add entry
    expect(getLogitBias().biases).toEqual({ "123": 5 });
  });

  it("Enter on an entry edits its bias and persists", () => {
    mutateLogitBias((lb) => { lb.enabled = true; lb.biases = { "123": 5 }; });
    const ed = new LogitBiasEditor(stubDeps());
    ed.handleInput("down"); // Enabled (0) → token 123 (1)
    ed.handleInput("enter"); // → editBias mode (prefilled "5"), search cleared
    ed.handleInput("0"); // append → "50"
    ed.handleInput("enter"); // submit → bias 50
    expect(getLogitBias().biases).toEqual({ "123": 50 });
  });
});
