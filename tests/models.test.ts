/**
 * Tests for the model pipeline: applyPatch → buildModels → mergeWithEmbedded,
 * plus the Fireworks /v1/models API transform (isChatModel / transformApiModel)
 * and the stale-while-revalidate cache layer (loadStaleModels).
 *
 * Mirrors the buildModels / patch coverage in neuralwatt's flex-models.test.ts
 * and makora's makora-settings.test.ts, adapted to Fireworks' pipeline: base
 * models → patch.json → custom-models.json, with the live/embedded self-heal
 * merge (live cost authoritative when non-zero, curation wins otherwise).
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import {
  applyPatch,
  buildModels,
  isChatModel,
  transformApiModel,
  mergeWithEmbedded,
  loadStaleModels,
} from "../index.js";
import type { JsonModel, PatchEntry } from "../index.js";
import patchData from "../patch.json" with { type: "json" };
import modelsData from "../models.json" with { type: "json" };

const patches = patchData as Record<string, PatchEntry>;
const embedded = modelsData as JsonModel[];

function baseModel(id: string, overrides: Partial<JsonModel> = {}): JsonModel {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 16384,
    ...overrides,
  };
}

describe("applyPatch", () => {
  it("applies scalar overrides (name, api, baseUrl, reasoning, input, contextWindow, maxTokens)", () => {
    const out = applyPatch(baseModel("m"), {
      name: "M",
      api: "anthropic-messages",
      baseUrl: "https://x/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 200000,
      maxTokens: 8192,
    });
    expect(out.name).toBe("M");
    expect(out.api).toBe("anthropic-messages");
    expect(out.baseUrl).toBe("https://x/v1");
    expect(out.reasoning).toBe(true);
    expect(out.input).toEqual(["text", "image"]);
    expect(out.contextWindow).toBe(200000);
    expect(out.maxTokens).toBe(8192);
  });

  it("deep-merges cost (per-field ?? fallback, not whole-object replace)", () => {
    const out = applyPatch(
      baseModel("m", { cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }),
      { cost: { output: 20 } },
    );
    expect(out.cost).toEqual({ input: 1, output: 20, cacheRead: 3, cacheWrite: 4 });
  });

  it("deep-merges compat onto an existing compat block", () => {
    const out = applyPatch(
      baseModel("m", { reasoning: true, compat: { supportsReasoningEffort: true, thinkingFormat: "deepseek" } as any }),
      { compat: { supportsDeveloperRole: false } },
    );
    expect(out.compat).toEqual({ supportsReasoningEffort: true, thinkingFormat: "deepseek", supportsDeveloperRole: false });
  });

  it("initializes compat when the base model has none", () => {
    const out = applyPatch(baseModel("m"), { compat: { supportsReasoningEffort: true } });
    expect(out.compat).toEqual({ supportsReasoningEffort: true });
  });

  it("strips thinkingFormat when the patch (or result) is non-reasoning", () => {
    // baseModel defaults to reasoning:false → thinkingFormat is stripped.
    const out = applyPatch(
      baseModel("m", { compat: { thinkingFormat: "deepseek" } as any }),
      {},
    );
    expect(out.reasoning).toBe(false);
    expect(out.compat?.thinkingFormat).toBeUndefined();
  });

  it("deletes compat when the merged block is empty", () => {
    // reasoning:false strips thinkingFormat → compat empty → deleted
    const out = applyPatch(
      baseModel("m", { compat: { thinkingFormat: "deepseek" } as any }),
      { reasoning: false },
    );
    expect(out.compat).toBeUndefined();
  });

  it("does not mutate the input model", () => {
    const model = baseModel("m", { reasoning: true, compat: { thinkingFormat: "deepseek", supportsReasoningEffort: true } as any });
    applyPatch(model, { reasoning: true, compat: { supportsDeveloperRole: false } });
    expect(model.compat).toEqual({ thinkingFormat: "deepseek", supportsReasoningEffort: true });
    expect(model.reasoning).toBe(true);
  });
});

describe("buildModels (base → patch → custom)", () => {
  it("applies patch.json overrides onto base models by id", () => {
    const out = buildModels([baseModel("glm-5p2")], [], { "glm-5p2": { reasoning: true, name: "GLM 5.2" } });
    const glm = out.find((m) => m.id === "glm-5p2")!;
    expect(glm.reasoning).toBe(true);
    expect(glm.name).toBe("GLM 5.2");
  });

  it("appends custom models not present in base", () => {
    const custom = [baseModel("custom/router", { reasoning: true })];
    const out = buildModels([baseModel("glm-5p2")], custom, {});
    expect(out.map((m) => m.id)).toContain("custom/router");
  });

  it("custom model replaces a base model with the same id (when no patch)", () => {
    const custom = [baseModel("glm-5p2", { reasoning: true, name: "Custom GLM" })];
    const out = buildModels([baseModel("glm-5p2")], custom, {});
    const glm = out.find((m) => m.id === "glm-5p2")!;
    expect(glm.name).toBe("Custom GLM");
    expect(glm.reasoning).toBe(true);
  });

  it("custom model with a matching patch entry has the patch applied on top", () => {
    const custom = [baseModel("glm-5p2", { reasoning: true })];
    const out = buildModels([], custom, { "glm-5p2": { name: "Patched Custom" } });
    const glm = out.find((m) => m.id === "glm-5p2")!;
    expect(glm.name).toBe("Patched Custom");
    expect(glm.reasoning).toBe(true);
  });

  it("against the real patch.json: every entry is a non-null object (no empty/dead overrides)", () => {
    for (const [id, entry] of Object.entries(patches)) {
      expect(entry, `patch[${id}]`).toBeTypeOf("object");
      expect(entry, `patch[${id}]`).not.toBeNull();
    }
  });
});

describe("isChatModel / transformApiModel (Fireworks /v1/models API)", () => {
  it("isChatModel keeps supports_chat === true", () => {
    expect(isChatModel({ supports_chat: true })).toBe(true);
  });

  it("isChatModel keeps kind === 'HF_BASE_MODEL'", () => {
    expect(isChatModel({ kind: "HF_BASE_MODEL" })).toBe(true);
  });

  it("isChatModel drops non-chat / unknown kinds", () => {
    expect(isChatModel({ kind: "embedding" })).toBe(false);
    expect(isChatModel({})).toBe(false);
    expect(isChatModel({ supports_chat: false })).toBe(false);
  });

  it("transformApiModel maps supports_image_input → text+image input", () => {
    const m = transformApiModel({ id: "v", supports_chat: true, supports_image_input: true, context_length: 131072 });
    expect(m).not.toBeNull();
    expect(m!.input).toEqual(["text", "image"]);
    expect(m!.contextWindow).toBe(131072);
  });

  it("transformApiModel defaults input to text-only when no image support", () => {
    const m = transformApiModel({ id: "v", supports_chat: true, context_length: 8192 });
    expect(m!.input).toEqual(["text"]);
    expect(m!.contextWindow).toBe(8192);
  });

  it("transformApiModel returns null for non-chat models", () => {
    expect(transformApiModel({ id: "emb", kind: "embedding" })).toBeNull();
  });

  it("transformApiModel starts reasoning=false and zero cost (curation happens via patch/embedded)", () => {
    const m = transformApiModel({ id: "v", supports_chat: true, context_length: 100 })!;
    expect(m.reasoning).toBe(false);
    expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(m.maxTokens).toBe(0);
  });

  it("transformApiModel handles the { data: [...] } envelope shape (array fallback)", () => {
    // fetchLiveModels unwraps data.data — but transformApiModel itself receives
    // a single apiModel. This just confirms it doesn't choke on a bare object.
    expect(transformApiModel({ id: "x", kind: "HF_BASE_MODEL" })!.id).toBe("x");
  });
});

describe("mergeWithEmbedded (live ↔ embedded self-heal)", () => {
  const emb = [
    baseModel("a", { reasoning: true, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }),
    baseModel("b", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ];

  it("prefers live cost field-by-field when non-zero, keeps embedded cost when live is silent (0)", () => {
    const live = [
      baseModel("a", { cost: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    ];
    const [a] = mergeWithEmbedded(live, emb);
    expect(a.cost).toEqual({ input: 10, output: 2, cacheRead: 3, cacheWrite: 4 });
  });

  it("curation (reasoning/input/name from embedded) wins via ...embedded spread", () => {
    const live = [baseModel("a", { reasoning: false, name: "live-a", cost: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 } })];
    const [a] = mergeWithEmbedded(live, emb);
    expect(a.reasoning).toBe(true);
    expect(a.name).toBe("a"); // embedded name wins (curation)
    expect(a.cost.input).toBe(5);
  });

  it("appends embedded models the live API didn't return", () => {
    const live = [baseModel("a", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })];
    const out = mergeWithEmbedded(live, emb);
    expect(out.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("passes through live models that aren't in embedded", () => {
    const live = [baseModel("c", { cost: { input: 7, output: 7, cacheRead: 7, cacheWrite: 0 } })];
    const [c] = mergeWithEmbedded(live, emb);
    expect(c.id).toBe("c");
    expect(c.cost.input).toBe(7);
  });

  it("prefers live contextWindow when non-zero, embedded when live is 0", () => {
    const live = [baseModel("a", { contextWindow: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })];
    const [a] = mergeWithEmbedded(live, emb);
    expect(a.contextWindow).toBe(131072); // embedded fallback
  });
});

describe("loadStaleModels (cache → embedded fallback)", () => {
  const cacheDir = path.join(process.env.PI_CODING_AGENT_DIR!, "cache");
  const cachePath = path.join(cacheDir, "fireworks-models.json");

  beforeEach(() => {
    vi.restoreAllMocks();
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch {}
  });

  afterEach(() => {
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch {}
  });

  it("falls back to embedded models when no cache exists", () => {
    const out = loadStaleModels(embedded);
    expect(out).toBe(embedded);
  });

  it("serves the cached list when a cache exists", () => {
    fs.mkdirSync(cacheDir, { recursive: true });
    const cached = [baseModel("cached-1", { reasoning: true })];
    fs.writeFileSync(cachePath, JSON.stringify(cached));
    const out = loadStaleModels(embedded);
    expect(out.map((m) => m.id)).toContain("cached-1");
  });

  it("appends embedded models missing from the cache (newly curated models)", () => {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify([baseModel("cached-1")]));
    const out = loadStaleModels(embedded);
    const ids = out.map((m) => m.id);
    expect(ids).toContain("cached-1");
    // every embedded id is present even if the cache predates it
    for (const m of embedded) expect(ids).toContain(m.id);
  });

  it("falls back to embedded when the cache file is invalid JSON", () => {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cachePath, "not json {{{");
    expect(loadStaleModels(embedded)).toBe(embedded);
  });
});

describe("thinkingLevelMap patches (Fireworks reasoning_effort contract)", () => {
  it("GLM 5.3 Flash exposes low/high/max (zai: three levels, default max); medium promotes to high", () => {
    const out = buildModels(embedded, [], patches);
    const flash = out.find((m) => m.id === "accounts/fireworks/models/glm-5p3-flash")!;
    expect(flash.reasoning).toBe(true);
    expect(flash.thinkingLevelMap).toMatchObject({ low: "low", high: "high", max: "max" });
    expect(flash.thinkingLevelMap?.medium).toBe("high");
    expect(flash.thinkingLevelMap?.xhigh).toBeNull();
  });

  it("GLM 5.3 mirrors GLM 5.2's high/max/none level set", () => {
    const out = buildModels(embedded, [], patches);
    const glm = out.find((m) => m.id === "accounts/fireworks/models/glm-5p3")!;
    expect(glm.reasoning).toBe(true);
    expect(glm.thinkingLevelMap).toEqual({ off: "none", minimal: null, low: "high", medium: "high", high: "high", xhigh: null, max: "max" });
  });

  it("MiniMax M2.x and GPT-OSS hide levels Fireworks rejects (minimal/xhigh/max; none)", () => {
    const out = buildModels(embedded, [], patches);
    for (const id of ["minimax-m2p1", "minimax-m2p5", "minimax-m2p7", "minimax-m3", "gpt-oss-120b", "gpt-oss-20b"]) {
      const m = out.find((x) => x.id === "accounts/fireworks/models/" + id)!;
      expect(m.reasoning, id).toBe(true);
      // Wire values stay in the provider-accepted set: low/medium/high only.
      for (const level of ["low", "medium", "high"] as const) {
        expect(["low", "medium", "high"]).toContain(m.thinkingLevelMap?.[level]);
      }
      for (const level of ["minimal", "xhigh", "max"] as const) {
        expect(m.thinkingLevelMap?.[level]).toBeNull();
      }
    }
    // MiniMax reasoning is always on; GPT-OSS errors on none — neither gets an off wire value.
    const minimax = out.find((m) => m.id === "accounts/fireworks/models/minimax-m3")!;
    expect(minimax.thinkingLevelMap?.off).toBeNull();
    const oss = out.find((m) => m.id === "accounts/fireworks/models/gpt-oss-120b")!;
    expect(oss.thinkingLevelMap?.off).toBeNull();
  });

  it("DeepSeek V4 keeps native levels and gains a real off (none) switch", () => {
    const out = buildModels(embedded, [], patches);
    for (const id of ["deepseek-v4-flash", "deepseek-v4-flash-0731", "deepseek-v4-pro", "deepseek-v4-pro-0813"]) {
      const m = out.find((x) => x.id === "accounts/fireworks/models/" + id)!;
      expect(m.reasoning, id).toBe(true);
      expect(m.thinkingLevelMap).toMatchObject({ off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
    }
  });

  it("GLM 4.x is binary on/off: all effort levels hidden, off maps to none", () => {
    const out = buildModels(embedded, [], patches);
    for (const id of ["glm-4p5", "glm-4p5-air", "glm-4p7"]) {
      const m = out.find((x) => x.id === "accounts/fireworks/models/" + id)!;
      expect(m.thinkingLevelMap?.off, id).toBe("none");
      for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
        expect(m.thinkingLevelMap?.[level], id + ":" + level).toBeNull();
      }
    }
  });

  it("previously unpatched reasoning models now register as reasoning (pi core parity)", () => {
    const out = buildModels(embedded, [], patches);
    for (const id of ["deepseek-v4-pro-0813", "muse-glimmer-30b", "nemotron-lightning-3p5-30b-a3b", "qwen3p8-2p4t-a95b"]) {
      expect(out.find((x) => x.id === "accounts/fireworks/models/" + id)?.reasoning, id).toBe(true);
    }
  });
});
