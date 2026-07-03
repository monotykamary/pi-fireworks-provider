/**
 * Tests for the preserved-thinking (reasoning_history) helpers.
 *
 * Fireworks exposes a single top-level `reasoning_history` request parameter;
 * the only accepted value is "preserved" (omitted = prior reasoning stripped).
 * Unlike neuralwatt/makora (per-model chat_template_kwargs flags), this is one
 * global knob, so preserve state is a single boolean. These tests cover the
 * pure eligibility + state helpers; the request injection itself is exercised
 * in before-provider-request.test.ts.
 */

import { describe, expect, it } from "vitest";
import { isPreserveEligible, setPreserve } from "../index.js";

describe("isPreserveEligible", () => {
  it("accepts a Fireworks reasoning model", () => {
    expect(isPreserveEligible({ provider: "fireworks", id: "glm-5p2", reasoning: true })).toBe(true);
    expect(isPreserveEligible({ provider: "fireworks", id: "kimi-k2p7-code", reasoning: true })).toBe(true);
  });

  it("rejects a non-reasoning Fireworks model", () => {
    expect(isPreserveEligible({ provider: "fireworks", id: "glm-5p2-fast", reasoning: false })).toBe(false);
    expect(isPreserveEligible({ provider: "fireworks", id: "x", reasoning: false })).toBe(false);
  });

  it("rejects a non-fireworks provider even when reasoning is true", () => {
    expect(isPreserveEligible({ provider: "neuralwatt", id: "glm-5.2", reasoning: true })).toBe(false);
    expect(isPreserveEligible({ provider: "openai", id: "gpt", reasoning: true })).toBe(false);
  });

  it("rejects missing / malformed models", () => {
    expect(isPreserveEligible(undefined)).toBe(false);
    expect(isPreserveEligible(null)).toBe(false);
    expect(isPreserveEligible({})).toBe(false);
    expect(isPreserveEligible({ provider: "fireworks" })).toBe(false); // no reasoning flag
    expect(isPreserveEligible({ provider: "fireworks", id: "x" })).toBe(false);
  });
});

describe("setPreserve", () => {
  it("toggles the module-level preserveOn flag (verified via before_provider_request injection)", () => {
    // setPreserve is a one-liner mutator; the observable effect is the
    // reasoning_history param being injected in before_provider_request. We
    // assert it doesn't throw and accepts both states. The full behavioral
    // assertion lives in before-provider-request.test.ts.
    expect(() => setPreserve(true)).not.toThrow();
    expect(() => setPreserve(false)).not.toThrow();
  });
});
