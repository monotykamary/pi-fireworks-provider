/**
 * Tests for the fireworks.json config layer: loadFireworksConfig (validated
 * read with defaults-populate-on-miss), readRawFireworksConfig / writeRawFireworksConfig
 * (read-modify-write that preserves unknown fields), and the tier / keybinding
 * validators.
 *
 * Mirrors neuralwatt's config.test.ts and makora's getConfig/updateConfig tests,
 * adapted to Fireworks' config shape (serviceTier + preserveThinking).
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import {
  isValidTier,
  isValidKeybinding,
  loadFireworksConfig,
  readRawFireworksConfig,
  writeRawFireworksConfig,
} from "../index.js";

const CONFIG_PATH = path.join(process.env.PI_CODING_AGENT_DIR!, "extensions", "fireworks.json");
const CONFIG_DIR = path.dirname(CONFIG_PATH);

const DEFAULT_CONFIG = {
  serviceTier: { default: "standard", keybinding: "ctrl+shift+l", display: "statusbar" },
  preserveThinking: { default: false },
  logitBias: { enabled: false, biases: {} },
};

beforeEach(() => {
  vi.restoreAllMocks();
  try { fs.rmSync(CONFIG_DIR, { recursive: true, force: true }); } catch {}
});

afterEach(() => {
  try { fs.rmSync(CONFIG_DIR, { recursive: true, force: true }); } catch {}
});

describe("isValidTier", () => {
  it("accepts standard and priority", () => {
    expect(isValidTier("standard")).toBe(true);
    expect(isValidTier("priority")).toBe(true);
  });

  it("rejects unknown / non-string values", () => {
    expect(isValidTier("fast")).toBe(false);
    expect(isValidTier("")).toBe(false);
    expect(isValidTier(42)).toBe(false);
    expect(isValidTier(null)).toBe(false);
    expect(isValidTier(undefined)).toBe(false);
  });
});

describe("isValidKeybinding", () => {
  it("accepts a non-empty string", () => {
    expect(isValidKeybinding("ctrl+shift+l")).toBe(true);
    expect(isValidKeybinding("ctrl+alt+t")).toBe(true);
  });

  it("rejects empty / non-string values", () => {
    expect(isValidKeybinding("")).toBe(false);
    expect(isValidKeybinding(42)).toBe(false);
    expect(isValidKeybinding(null)).toBe(false);
    expect(isValidKeybinding(undefined)).toBe(false);
  });
});

describe("loadFireworksConfig", () => {
  it("returns defaults when the config file does not exist", () => {
    expect(loadFireworksConfig()).toEqual(DEFAULT_CONFIG);
  });

  it("populates the config file with defaults when it does not exist", () => {
    loadFireworksConfig();
    expect(fs.existsSync(CONFIG_PATH)).toBe(true);
    expect(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))).toEqual(DEFAULT_CONFIG);
  });

  it("returns defaults even if the populate write fails", () => {
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error("EACCES"); });
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => { throw new Error("EACCES"); });
    expect(loadFireworksConfig()).toEqual(DEFAULT_CONFIG);
  });

  it("returns defaults when the config file is invalid JSON", () => {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, "not json {{{");
    // re-spy readFileSync so the populate-on-miss write sees the invalid file
    // (loadFireworksConfig catches JSON.parse + read errors uniformly)
    expect(loadFireworksConfig()).toEqual(DEFAULT_CONFIG);
  });

  it("loads a valid config file", () => {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        serviceTier: { default: "priority", keybinding: "ctrl+alt+t", display: "off" },
        preserveThinking: { default: true },
      }),
    );
    expect(loadFireworksConfig()).toEqual({
      serviceTier: { default: "priority", keybinding: "ctrl+alt+t", display: "off" },
      preserveThinking: { default: true },
      logitBias: { enabled: false, biases: {} },
    });
  });

  it("falls back per-field on invalid values (keeps valid siblings)", () => {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        serviceTier: { default: "bogus", keybinding: "", display: "weird" },
        preserveThinking: { default: "not-bool" },
      }),
    );
    expect(loadFireworksConfig()).toEqual(DEFAULT_CONFIG);
  });

  it("falls back display to 'statusbar' for any non-'off' value", () => {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ serviceTier: { display: "footer" } }));
    expect(loadFireworksConfig().serviceTier.display).toBe("statusbar");
  });

  it("ignores unknown keys in the config file (forward-compat)", () => {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ futureKey: 123, serviceTier: { default: "priority" }, preserveThinking: { default: true } }),
    );
    const cfg = loadFireworksConfig();
    expect(cfg.serviceTier.default).toBe("priority");
    expect(cfg.preserveThinking.default).toBe(true);
  });
});

describe("readRawFireworksConfig / writeRawFireworksConfig", () => {
  it("readRawFireworksConfig returns defaults when no file exists (deep clone)", () => {
    const raw = readRawFireworksConfig();
    expect(raw).toEqual(DEFAULT_CONFIG);
    // mutating the returned defaults must not bleed into the next read
    raw.serviceTier.default = "priority";
    expect(readRawFireworksConfig().serviceTier.default).toBe("standard");
  });

  it("writeRawFireworksConfig writes arbitrary JSON, readRawFireworksConfig reads it back", () => {
    const obj = { serviceTier: { default: "priority", keybinding: "ctrl+alt+t", display: "off" }, preserveThinking: { default: true } };
    writeRawFireworksConfig(obj);
    expect(readRawFireworksConfig()).toEqual(obj);
  });

  it("preserves unknown fields a user added (read-modify-write)", () => {
    const obj = { futureKey: 123, serviceTier: { default: "standard", keybinding: "ctrl+shift+l", display: "statusbar" }, preserveThinking: { default: false } };
    writeRawFireworksConfig(obj);
    // a settings-panel write that only touches preserveThinking.default
    const raw = readRawFireworksConfig();
    raw.preserveThinking = { ...(raw.preserveThinking ?? {}), default: true };
    writeRawFireworksConfig(raw);
    const back = readRawFireworksConfig();
    expect(back.futureKey).toBe(123); // survived the partial write
    expect(back.preserveThinking.default).toBe(true);
  });

  it("writeRawFireworksConfig is non-fatal on a write failure", () => {
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error("EACCES"); });
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => { throw new Error("EACCES"); });
    expect(() => writeRawFireworksConfig({ foo: 1 })).not.toThrow();
  });
});
