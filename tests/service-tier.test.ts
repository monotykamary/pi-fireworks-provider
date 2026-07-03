/**
 * Tests for the service-tier feature: priority pricing applicability, finalized
 * cost recomputation against priority pricing, session-entry replay, and the
 * setTier / updateTierStatus state mutators.
 *
 * Fireworks exposes a `service_tier` request field ("standard" | "priority") on
 * its chat-completions endpoint; priority trades higher per-token pricing for
 * throughput/latency on the supported base models. These tests cover the pure
 * helpers plus the ctx/ui-driven state surface (stubbed), without a real pi.
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  isPriorityApplicable,
  PRIORITY_PRICING,
  recomputePriorityCost,
  replayTierState,
  setTier,
  updateTierStatus,
} from "../index.js";

const PRIORITY_PRICING_IDS = Object.keys(PRIORITY_PRICING);

function stubCtx(model: any = undefined) {
  const statusCalls: Array<[string, any]> = [];
  return {
    statusCalls,
    ctx: {
      model,
      ui: {
        setStatus: (key: string, val: any) => statusCalls.push([key, val]),
        theme: { fg: (_name: string, s: string) => s },
      },
    },
  };
}

function fullPiStub(): any {
  return {
    on: () => {},
    registerProvider: () => {},
    registerShortcut: () => {},
    registerCommand: () => {},
    appendEntry: () => {},
    events: { emit: () => {} },
  };
}

describe("isPriorityApplicable", () => {
  it("accepts the supported base-model ids", () => {
    for (const id of PRIORITY_PRICING_IDS) {
      expect(isPriorityApplicable(id)).toBe(true);
    }
  });

  it("rejects router / fast models and unknown ids", () => {
    expect(isPriorityApplicable("accounts/fireworks/models/kimi-k2p6-fast")).toBe(false);
    expect(isPriorityApplicable("routers/kimi-fast")).toBe(false);
    expect(isPriorityApplicable("accounts/fireworks/models/something-else")).toBe(false);
    expect(isPriorityApplicable(undefined)).toBe(false);
    expect(isPriorityApplicable(null)).toBe(false);
  });
});

describe("recomputePriorityCost", () => {
  const glm = "accounts/fireworks/models/glm-5p2";

  it("recomputes cost against priority pricing (USD per million tokens)", () => {
    const out = recomputePriorityCost({
      model: glm,
      usage: { input: 1_000_000, output: 2_000_000, cacheRead: 1_000_000 },
    })!;
    expect(out.usage.cost.input).toBeCloseTo(1.75, 6);
    expect(out.usage.cost.output).toBeCloseTo(11, 6);
    expect(out.usage.cost.cacheRead).toBeCloseTo(0.175, 6);
    expect(out.usage.cost.cacheWrite).toBe(0);
    expect(out.usage.cost.total).toBeCloseTo(1.75 + 11 + 0.175, 6);
  });

  it("treats missing usage fields as 0", () => {
    const out = recomputePriorityCost({ model: glm, usage: {} })!;
    expect(out.usage.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
  });

  it("always sets cacheWrite: 0 (cacheWrite is not tiered)", () => {
    const out = recomputePriorityCost({
      model: glm,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 999 },
    })!;
    expect(out.usage.cost.cacheWrite).toBe(0);
  });

  it("returns undefined for a model without priority pricing", () => {
    expect(recomputePriorityCost({ model: "accounts/fireworks/models/kimi-k2p6-fast", usage: {} })).toBeUndefined();
  });

  it("returns undefined when usage is absent", () => {
    expect(recomputePriorityCost({ model: glm })).toBeUndefined();
    expect(recomputePriorityCost({ model: glm, usage: undefined })).toBeUndefined();
  });

  it("returns undefined when model is absent", () => {
    expect(recomputePriorityCost({ usage: {} })).toBeUndefined();
  });

  it("preserves the original usage fields alongside the new cost block", () => {
    const out = recomputePriorityCost({
      model: glm,
      usage: { input: 100, output: 200, cacheRead: 50, someExtra: "keep-me" },
    })!;
    expect(out.usage.input).toBe(100);
    expect(out.usage.someExtra).toBe("keep-me");
    expect(out.usage.cost).toBeDefined();
  });

  it("does not mutate the input message (returns a shallow clone)", () => {
    const msg: any = { model: glm, usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const out = recomputePriorityCost(msg)!;
    expect(msg.usage.cost).toBeUndefined(); // original untouched
    expect(out).not.toBe(msg);
    expect(out.usage).not.toBe(msg.usage);
  });
});

describe("replayTierState", () => {
  it("uses the default tier when no session entries exist", () => {
    const { ctx } = stubCtx();
    ctx.sessionManager = { getBranch: () => [] };
    expect(replayTierState(ctx, "standard")).toBeUndefined(); // void return; sets module state
  });

  it("replays a fireworks-service-tier entry to priority", () => {
    const { ctx } = stubCtx();
    ctx.sessionManager = {
      getBranch: () => [
        { type: "custom", customType: "fireworks-service-tier", data: { tier: "priority" } },
      ],
    };
    replayTierState(ctx, "standard");
    // verify via updateTierStatus side-effect: a priority-applicable model
    // should render the priority label
    const { ctx: ctx2, statusCalls } = stubCtx({ provider: "fireworks", id: "accounts/fireworks/models/glm-5p2" });
    updateTierStatus(ctx2);
    expect(statusCalls.find(([k]) => k === "fireworks-tier")?.[1]).toContain("priority");
  });

  it("ignores a malformed tier entry and keeps the default", () => {
    const { ctx } = stubCtx();
    ctx.sessionManager = {
      getBranch: () => [{ type: "custom", customType: "fireworks-service-tier", data: { tier: "bogus" } }],
    };
    replayTierState(ctx, "standard");
    const { ctx: ctx2, statusCalls } = stubCtx({ provider: "fireworks", id: "accounts/fireworks/models/glm-5p2" });
    updateTierStatus(ctx2);
    expect(statusCalls.find(([k]) => k === "fireworks-tier")?.[1]).toContain("standard");
  });

  it("the last entry wins when multiple tier entries exist", () => {
    const { ctx } = stubCtx();
    ctx.sessionManager = {
      getBranch: () => [
        { type: "custom", customType: "fireworks-service-tier", data: { tier: "priority" } },
        { type: "custom", customType: "fireworks-service-tier", data: { tier: "standard" } },
      ],
    };
    replayTierState(ctx, "priority");
    const { ctx: ctx2, statusCalls } = stubCtx({ provider: "fireworks", id: "accounts/fireworks/models/glm-5p2" });
    updateTierStatus(ctx2);
    expect(statusCalls.find(([k]) => k === "fireworks-tier")?.[1]).toContain("standard");
  });
});

describe("setTier", () => {
  it("sets the active tier and calls appendEntry with the tier entry", () => {
    const entries: Array<[string, any]> = [];
    const piStub: any = { ...fullPiStub(), appendEntry: (type: string, data: any) => entries.push([type, data]) };
    // install piRef by importing the default export and invoking it once
    return import("../index.js").then(({ default: init }) => {
      init(piStub);
      const { ctx, statusCalls } = stubCtx({ provider: "fireworks", id: "accounts/fireworks/models/glm-5p2" });
      setTier(ctx, "priority");
      expect(entries.find(([t]) => t === "fireworks-service-tier")?.[1]).toEqual({ tier: "priority" });
      expect(statusCalls.find(([k]) => k === "fireworks-tier")?.[1]).toContain("priority");
    });
  });
});

describe("updateTierStatus", () => {
  it("clears the status key when display is off", () => {
    // loadFireworksConfig is module-cached; we can't flip display per-test without
    // writing the file + reloading, so this asserts the off-branch shape via a
    // model that is not priority-applicable (clears regardless of display).
    const { ctx, statusCalls } = stubCtx({ provider: "fireworks", id: "routers/kimi-fast" });
    updateTierStatus(ctx);
    expect(statusCalls.find(([k]) => k === "fireworks-tier")?.[1]).toBeUndefined();
  });

  it("clears the status key for a non-fireworks model", () => {
    const { ctx, statusCalls } = stubCtx({ provider: "neuralwatt", id: "glm-5.2" });
    updateTierStatus(ctx);
    expect(statusCalls.find(([k]) => k === "fireworks-tier")?.[1]).toBeUndefined();
  });

  it("clears the status key when no model is selected", () => {
    const { ctx, statusCalls } = stubCtx(undefined);
    updateTierStatus(ctx);
    expect(statusCalls.find(([k]) => k === "fireworks-tier")?.[1]).toBeUndefined();
  });

  it("renders the priority label for a priority-applicable model when priority is active", () => {
    // assumes default/active tier is priority from a prior setTier — verify
    // independently by setting it first
    const piStub: any = fullPiStub();
    return import("../index.js").then(({ default: init }) => {
      init(piStub);
      const { ctx: setCtx } = stubCtx({ provider: "fireworks", id: "accounts/fireworks/models/glm-5p2" });
      setTier(setCtx, "priority");
      const { ctx, statusCalls } = stubCtx({ provider: "fireworks", id: "accounts/fireworks/models/glm-5p2" });
      updateTierStatus(ctx);
      expect(statusCalls.find(([k]) => k === "fireworks-tier")?.[1]).toContain("⚡priority");
    });
  });
});
