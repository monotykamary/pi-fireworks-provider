/**
 * Tests for the Kimi K2.x regex anchor-bleed sanitization.
 *
 * Kimi K2.x on Fireworks has a known bug where regex anchors (^ and $) in JSON
 * Schema `pattern` fields leak into generated argument strings, especially when
 * alternation (|) combines with anchors. We strip anchors from simple patterns
 * and drop patterns that combine alternation with anchors entirely, both before
 * the request (sanitizeSchemaForKimi on tools[].parameters + response_format)
 * and after generation (stripAnchorBleedInPlace on tool-call arguments as
 * defense-in-depth).
 */

import { describe, expect, it } from "vitest";
import {
  isFireworksKimiModel,
  sanitizePattern,
  sanitizeSchemaForKimi,
  stripAnchorBleedInPlace,
} from "../index.js";

describe("isFireworksKimiModel", () => {
  it("matches Kimi K2 model ids (case-insensitive kimi-k2)", () => {
    expect(isFireworksKimiModel({ provider: "fireworks", id: "accounts/fireworks/models/kimi-k2p7-code" })).toBe(true);
    expect(isFireworksKimiModel({ provider: "fireworks", id: "kimi-k2p6" })).toBe(true);
  });

  it("rejects non-fireworks providers and non-kimi ids", () => {
    expect(isFireworksKimiModel({ provider: "neuralwatt", id: "kimi-k2" })).toBe(false);
    expect(isFireworksKimiModel({ provider: "fireworks", id: "glm-5p2" })).toBe(false);
    expect(isFireworksKimiModel(null)).toBe(false);
    expect(isFireworksKimiModel(undefined)).toBe(false);
    expect(isFireworksKimiModel({})).toBe(false);
  });
});

describe("sanitizePattern", () => {
  it("strips ^ and $ from a simple pattern", () => {
    expect(sanitizePattern("^foo$")).toBe("foo");
    expect(sanitizePattern("^^foo$$")).toBe("foo");
    expect(sanitizePattern("foo")).toBe("foo");
  });

  it("returns undefined (drop the key) when alternation combines with anchors", () => {
    expect(sanitizePattern("^a|b$")).toBeUndefined();
    expect(sanitizePattern("^(a|b)$")).toBeUndefined();
    expect(sanitizePattern("^a|b|^c")).toBeUndefined();
  });

  it("keeps alternation-only patterns (no anchors) after stripping nothing", () => {
    expect(sanitizePattern("a|b")).toBe("a|b");
  });

  it("returns undefined when only anchors remain after stripping", () => {
    expect(sanitizePattern("^$")).toBeUndefined();
    expect(sanitizePattern("^^^")).toBeUndefined();
  });
});

describe("sanitizeSchemaForKimi", () => {
  it("strips anchors from a top-level pattern", () => {
    const out = sanitizeSchemaForKimi({ pattern: "^foo$" });
    expect(out).toEqual({ pattern: "foo" });
  });

  it("omits the pattern key when alternation + anchors combine", () => {
    const out = sanitizeSchemaForKimi({ pattern: "^a|b$", type: "string" });
    expect(out).toEqual({ type: "string" });
    expect(out.pattern).toBeUndefined();
  });

  it("recurses into nested objects (properties)", () => {
    const out = sanitizeSchemaForKimi({
      type: "object",
      properties: { name: { type: "string", pattern: "^x$" } },
    });
    expect(out.properties.name).toEqual({ type: "string", pattern: "x" });
  });

  it("recurses into arrays (items / anyOf / allOf / oneOf)", () => {
    const out = sanitizeSchemaForKimi({
      anyOf: [{ pattern: "^a$" }, { pattern: "^b|c$" }],
    });
    expect(out.anyOf).toEqual([{ pattern: "a" }, {}]);
  });

  it("recurses into array items that are objects", () => {
    const out = sanitizeSchemaForKimi({ items: { pattern: "^y$" } });
    expect(out.items).toEqual({ pattern: "y" });
  });

  it("leaves non-pattern, non-object values untouched", () => {
    const out = sanitizeSchemaForKimi({ type: "string", minLength: 3, maxLength: 10 });
    expect(out).toEqual({ type: "string", minLength: 3, maxLength: 10 });
  });

  it("returns non-object schemas as-is", () => {
    expect(sanitizeSchemaForKimi("string")).toBe("string");
    expect(sanitizeSchemaForKimi(null)).toBeNull();
    expect(sanitizeSchemaForKimi(undefined)).toBeUndefined();
    expect(sanitizeSchemaForKimi(42)).toBe(42);
  });

  it("does not mutate the input schema", () => {
    const schema = { properties: { x: { pattern: "^x$" } } };
    sanitizeSchemaForKimi(schema);
    expect(schema.properties.x.pattern).toBe("^x$");
  });

  it("sanitizes a realistic OpenAI tool parameters object", () => {
    const schema = {
      type: "object",
      properties: {
        path: { type: "string", pattern: "^/api/v1/" },
        mode: { type: "string", pattern: "^(get|post|put|delete)$" },
        name: { type: "string", pattern: "^[a-z]+$" },
      },
      required: ["path"],
    };
    const out = sanitizeSchemaForKimi(schema) as any;
    expect(out.properties.path.pattern).toBe("/api/v1/");
    // alternation + anchors → dropped
    expect(out.properties.mode.pattern).toBeUndefined();
    expect(out.properties.mode.type).toBe("string");
    expect(out.properties.name.pattern).toBe("[a-z]+");
  });
});

describe("stripAnchorBleedInPlace (defense-in-depth on tool args)", () => {
  it("strips leading ^ and trailing $ from string values", () => {
    const input: Record<string, unknown> = { a: "^foo$", b: "^^bar$$", c: "plain" };
    stripAnchorBleedInPlace(input);
    expect(input.a).toBe("foo");
    expect(input.b).toBe("bar");
    expect(input.c).toBe("plain");
  });

  it("recurses into nested objects", () => {
    const input: Record<string, unknown> = { outer: { inner: "^val$" } };
    stripAnchorBleedInPlace(input);
    expect((input.outer as any).inner).toBe("val");
  });

  it("recurses into array elements (strings + objects)", () => {
    const input: Record<string, unknown> = { list: ["^a$", { nested: "^b$" }, 42] };
    stripAnchorBleedInPlace(input);
    expect(input.list).toEqual(["a", { nested: "b" }, 42]);
  });

  it("leaves non-string values untouched", () => {
    const input: Record<string, unknown> = { n: 42, b: true, z: null, obj: { x: 1 } };
    stripAnchorBleedInPlace(input);
    expect(input).toEqual({ n: 42, b: true, z: null, obj: { x: 1 } });
  });

  it("handles a realistic tool-call input object", () => {
    const input: Record<string, unknown> = {
      pattern: "^leaked$",
      items: ["^one$", "^two$"],
      opts: { regex: "^x|y$" },
    };
    stripAnchorBleedInPlace(input);
    expect(input.pattern).toBe("leaked");
    expect(input.items).toEqual(["one", "two"]);
    expect((input.opts as any).regex).toBe("x|y");
  });
});
