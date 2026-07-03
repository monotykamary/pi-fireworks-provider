/**
 * Integration tests for the before_provider_request event handler — the
 * Fireworks analog of neuralwatt/makora's stream-onPayload injection tests.
 *
 * Fireworks does NOT wrap pi-ai's streamOpenAICompletions, so there is no
 * onPayload hook to test. Instead, all request mutation happens in a single
 * before_provider_request handler that injects, on both transports:
 *   - service_tier: "priority" (when priority is active for a supported model)
 *   - reasoning_history: "preserved" (when preserve is on for a reasoning model)
 *   - Kimi K2.x anchor-bleed sanitization (tools[].parameters + response_format)
 *
 * We invoke the extension's default export with a stub pi that records the
 * handler, then drive it with crafted { payload, model } pairs to assert each
 * injection in isolation and combination, plus the "no mutation → undefined"
 * passthrough and the OpenAI vs Anthropic tool shapes.
 */

import { describe, expect, it, beforeEach } from "vitest";
import init, { setPreserve, setTier, isFireworksKimiModel } from "../index.js";

// Capture pi event handlers so we can invoke before_provider_request directly.
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

const glmPriority = "accounts/fireworks/models/glm-5p2";
const kimiPriority = "accounts/fireworks/models/kimi-k2p7-code";

function fwModel(id: string, overrides: any = {}) {
  return { provider: "fireworks", id, name: id, reasoning: true, ...overrides };
}

let before: (event: any, ctx: any) => any;

beforeEach(() => {
  const handlers = captureHandlers();
  before = handlers["before_provider_request"];
  // reset module state to a clean baseline each test
  setPreserve(false);
  const ctx = stubCtx(fwModel(glmPriority));
  setTier(ctx, "standard");
});

describe("before_provider_request: passthrough", () => {
  it("returns undefined when nothing applies (standard tier, preserve off, non-kimi)", () => {
    setPreserve(false);
    const ctx = stubCtx(fwModel(glmPriority));
    const out = before({ payload: { model: glmPriority, messages: [] } }, ctx);
    expect(out).toBeUndefined();
  });

  it("returns undefined for a non-fireworks model even when preserve + priority are on", () => {
    setPreserve(true);
    const ctx = stubCtx({ provider: "neuralwatt", id: "glm-5.2", reasoning: true });
    const out = before({ payload: { model: "glm-5.2", messages: [] } }, ctx);
    expect(out).toBeUndefined();
  });

  it("returns undefined when the payload is missing / not an object", () => {
    const ctx = stubCtx(fwModel(glmPriority));
    expect(before({ payload: undefined }, ctx)).toBeUndefined();
    expect(before({ payload: "string" }, ctx)).toBeUndefined();
    expect(before({ payload: null }, ctx)).toBeUndefined();
  });
});

describe("before_provider_request: service_tier injection", () => {
  it("injects service_tier: priority on the OpenAI completions body when priority is active", () => {
    const ctx = stubCtx(fwModel(glmPriority));
    setTier(ctx, "priority");
    const out = before({ payload: { model: glmPriority, messages: [] } }, ctx);
    expect(out.service_tier).toBe("priority");
  });

  it("injects service_tier: priority on the Anthropic Messages body too", () => {
    const ctx = stubCtx(fwModel(glmPriority));
    setTier(ctx, "priority");
    const out = before({ payload: { model: glmPriority, messages: [], max_tokens: 1024 } }, ctx);
    expect(out.service_tier).toBe("priority");
  });

  it("does NOT inject service_tier for a model without priority pricing", () => {
    const ctx = stubCtx(fwModel("accounts/fireworks/models/kimi-k2p6-fast"));
    setTier(ctx, "priority");
    const out = before({ payload: { model: "accounts/fireworks/models/kimi-k2p6-fast", messages: [] } }, ctx);
    expect(out?.service_tier).toBeUndefined();
  });

  it("does NOT inject service_tier when standard is active", () => {
    const ctx = stubCtx(fwModel(glmPriority));
    setTier(ctx, "standard");
    const out = before({ payload: { model: glmPriority, messages: [] } }, ctx);
    expect(out?.service_tier).toBeUndefined();
  });
});

describe("before_provider_request: reasoning_history (preserved thinking) injection", () => {
  it("injects reasoning_history: preserved on the OpenAI body when preserve is on for a reasoning model", () => {
    setPreserve(true);
    const ctx = stubCtx(fwModel(glmPriority));
    const out = before({ payload: { model: glmPriority, messages: [] } }, ctx);
    expect(out.reasoning_history).toBe("preserved");
  });

  it("injects reasoning_history: preserved on the Anthropic Messages body too", () => {
    setPreserve(true);
    const ctx = stubCtx(fwModel(kimiPriority));
    const out = before({ payload: { model: kimiPriority, messages: [], max_tokens: 1024 } }, ctx);
    expect(out.reasoning_history).toBe("preserved");
  });

  it("does NOT inject reasoning_history when preserve is off", () => {
    setPreserve(false);
    const ctx = stubCtx(fwModel(glmPriority));
    const out = before({ payload: { model: glmPriority, messages: [] } }, ctx);
    expect(out?.reasoning_history).toBeUndefined();
  });

  it("does NOT inject reasoning_history for a non-reasoning Fireworks model", () => {
    setPreserve(true);
    const ctx = stubCtx(fwModel("accounts/fireworks/models/kimi-k2p6-fast", { reasoning: false }));
    const out = before({ payload: { model: "accounts/fireworks/models/kimi-k2p6-fast", messages: [] } }, ctx);
    expect(out?.reasoning_history).toBeUndefined();
  });

  it("priority + preserve both inject on the same request (Kimi priority model)", () => {
    setPreserve(true);
    const ctx = stubCtx(fwModel(kimiPriority));
    setTier(ctx, "priority");
    const out = before({ payload: { model: kimiPriority, messages: [] } }, ctx);
    expect(out.service_tier).toBe("priority");
    expect(out.reasoning_history).toBe("preserved");
  });
});

describe("before_provider_request: Kimi anchor-bleed sanitization", () => {
  // Kimi model id that is ALSO priority-applicable
  const kimiId = "accounts/fireworks/models/kimi-k2p7-code";

  it("sanitizes OpenAI-shape tools[].function.parameters patterns", () => {
    const ctx = stubCtx(fwModel(kimiId));
    const out = before(
      {
        payload: {
          model: kimiId,
          messages: [],
          tools: [
            {
              type: "function",
              function: {
                name: "do_thing",
                parameters: { type: "object", properties: { x: { type: "string", pattern: "^x$" } } },
              },
            },
          ],
        },
      },
      ctx,
    ) as any;
    expect(out.tools[0].function.parameters.properties.x.pattern).toBe("x");
  });

  it("drops a pattern that combines alternation with anchors (OpenAI shape)", () => {
    const ctx = stubCtx(fwModel(kimiId));
    const out = before(
      {
        payload: {
          model: kimiId,
          messages: [],
          tools: [
            {
              type: "function",
              function: {
                name: "do_thing",
                parameters: { type: "string", pattern: "^(a|b)$" },
              },
            },
          ],
        },
      },
      ctx,
    ) as any;
    expect(out.tools[0].function.parameters.pattern).toBeUndefined();
    expect(out.tools[0].function.parameters.type).toBe("string");
  });

  it("sanitizes Anthropic-shape tools[].input_schema patterns", () => {
    const ctx = stubCtx(fwModel(kimiId));
    const out = before(
      {
        payload: {
          model: kimiId,
          messages: [],
          tools: [
            {
              name: "do_thing",
              input_schema: { type: "object", properties: { y: { type: "string", pattern: "^y$" } } },
            },
          ],
        },
      },
      ctx,
    ) as any;
    expect(out.tools[0].input_schema.properties.y.pattern).toBe("y");
  });

  it("sanitizes response_format.json_schema.schema (OpenAI only)", () => {
    const ctx = stubCtx(fwModel(kimiId));
    const out = before(
      {
        payload: {
          model: kimiId,
          messages: [],
          response_format: { type: "json_schema", json_schema: { schema: { pattern: "^z$" } } },
        },
      },
      ctx,
    ) as any;
    expect(out.response_format.json_schema.schema.pattern).toBe("z");
  });

  it("does NOT sanitize tools for a non-Kimi Fireworks model", () => {
    const ctx = stubCtx(fwModel(glmPriority));
    setTier(ctx, "priority"); // force a modification so `out` is defined
    const payload = {
      model: glmPriority,
      messages: [],
      tools: [{ type: "function", function: { name: "x", parameters: { pattern: "^keep-me$" } } }],
    };
    const out = before({ payload }, ctx) as any;
    // service_tier injected (priority model), but the tool pattern stays untouched
    expect(out.service_tier).toBe("priority");
    expect(out.tools[0].function.parameters.pattern).toBe("^keep-me$");
  });

  it("Kimi + priority + preserve: all three apply on one request", () => {
    setPreserve(true);
    const ctx = stubCtx(fwModel(kimiId));
    setTier(ctx, "priority");
    const out = before(
      {
        payload: {
          model: kimiId,
          messages: [],
          tools: [
            { type: "function", function: { name: "x", parameters: { pattern: "^x$" } } },
          ],
        },
      },
      ctx,
    ) as any;
    expect(out.service_tier).toBe("priority");
    expect(out.reasoning_history).toBe("preserved");
    expect(out.tools[0].function.parameters.pattern).toBe("x");
  });

  it("isFireworksKimiModel agrees with the handler's Kimi branch", () => {
    // sanity: the handler's Kimi gate uses isFireworksKimiModel; the exported
    // helper is the same predicate, so a model it rejects must not get sanitized.
    expect(isFireworksKimiModel(fwModel(kimiId))).toBe(true);
    expect(isFireworksKimiModel(fwModel(glmPriority))).toBe(false);
  });
});
