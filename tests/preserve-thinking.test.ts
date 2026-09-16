/**
 * Tests for the preserved-thinking (reasoning_history) helpers.
 *
 * Fireworks exposes a single top-level `reasoning_history` request parameter
 * that accepts "disabled" | "interleaved" | "preserved", but per-model support
 * varies: MiniMax M2 and DeepSeek V4 only support "interleaved" (omitted =
 * model/template default). We expose the strongest mode as one boolean and gate
 * it on model support. These tests cover the pure eligibility + support +
 * state helpers; the request injection itself is exercised in
 * before-provider-request.test.ts.
 */

import { describe, expect, it } from "vitest";
import { isPreserveEligible, supportsPreservedReasoningHistory, setPreserve } from "../index.js";

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

describe("supportsPreservedReasoningHistory", () => {
  it("accepts models documented as supporting 'preserved'", () => {
    for (const id of [
      "accounts/fireworks/models/kimi-k2p6",
      "accounts/fireworks/models/kimi-k2p7-code",
      "accounts/fireworks/models/glm-5p2",
      "accounts/fireworks/models/glm-4p7",
    ]) {
      expect(supportsPreservedReasoningHistory(id), id).toBe(true);
    }
  });

  it("rejects interleaved-only models (MiniMax M2, DeepSeek V4 family)", () => {
    for (const id of [
      "accounts/fireworks/models/minimax-m2p1",
      "accounts/fireworks/models/minimax-m2p7",
      "accounts/fireworks/models/deepseek-v4-flash",
      "accounts/fireworks/models/deepseek-v4-flash-0731",
      "accounts/fireworks/models/deepseek-v4-pro-0813",
      "accounts/fireworks/models/deepseek-v4p1-flash",
    ]) {
      expect(supportsPreservedReasoningHistory(id), id).toBe(false);
    }
  });

  it("is permissive for models outside the documented support table", () => {
    expect(supportsPreservedReasoningHistory("accounts/fireworks/models/glm-5p3")).toBe(true);
    expect(supportsPreservedReasoningHistory("accounts/fireworks/models/kimi-k3")).toBe(true);
  });

  it("rejects a missing id", () => {
    expect(supportsPreservedReasoningHistory(undefined)).toBe(false);
    expect(supportsPreservedReasoningHistory("")).toBe(false);
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
