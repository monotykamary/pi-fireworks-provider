/**
 * Fireworks Provider Extension
 *
 * Registers Fireworks as a custom provider using the openai-completions API.
 * Base URL: https://api.fireworks.ai/inference/v1
 *
 * Model resolution strategy: Stale-While-Revalidate
 *   1. Serve stale immediately: disk cache → embedded models.json (zero-latency)
 *   2. Revalidate in background: live API /models → merge with embedded → cache → hot-swap
 *   3. patch.json + custom-models.json applied on top of whichever source won
 *
 * Merge order: [live|cache|embedded] → apply patch.json → merge custom-models.json
 *
 * Usage:
 *   # Option 1: Store in auth.json (recommended)
 *   # Add to ~/.pi/agent/auth.json:
 *   #   "fireworks": { "type": "api_key", "key": "your-api-key" }
 *
 *   # Option 2: Set as environment variable
 *   export FIREWORKS_API_KEY=your-api-key
 *
 *   # Run pi with the extension
 *   pi -e /path/to/pi-fireworks-provider
 *
 * Then use /model to select from available models
 */

import { getAgentDir, type ExtensionAPI, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import modelsData from "./models.json" with { type: "json" };
import customModelsData from "./custom-models.json" with { type: "json" };
import patchData from "./patch.json" with { type: "json" };
import fs from "fs";
import path from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

type FireworksApi = "anthropic-messages" | "openai-completions";

interface JsonModel {
  id: string;
  name: string;
  api?: FireworksApi;
  baseUrl?: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input: string[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  // Loose on purpose: shape depends on `api` (OpenAICompletionsCompat vs
  // AnthropicMessagesCompat). pi-ai validates at runtime.
  compat?: Record<string, unknown>;
}

interface PatchEntry {
  name?: string;
  api?: FireworksApi;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: string[];
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
}

type PatchData = Record<string, PatchEntry>;

// ─── Patch Application ────────────────────────────────────────────────────────

function applyPatch(model: JsonModel, patch: PatchEntry): JsonModel {
  const result = { ...model };

  if (patch.name !== undefined) result.name = patch.name;
  if (patch.api !== undefined) result.api = patch.api;
  if (patch.baseUrl !== undefined) result.baseUrl = patch.baseUrl;
  if (patch.reasoning !== undefined) result.reasoning = patch.reasoning;
  if (patch.thinkingLevelMap !== undefined) result.thinkingLevelMap = patch.thinkingLevelMap;
  if (patch.input !== undefined) result.input = patch.input;
  if (patch.contextWindow !== undefined) result.contextWindow = patch.contextWindow;
  if (patch.maxTokens !== undefined) result.maxTokens = patch.maxTokens;

  if (patch.cost) {
    result.cost = {
      input: patch.cost.input ?? result.cost.input,
      output: patch.cost.output ?? result.cost.output,
      cacheRead: patch.cost.cacheRead ?? result.cost.cacheRead,
      cacheWrite: patch.cost.cacheWrite ?? result.cost.cacheWrite,
    };
  }
  if (patch.compat) {
    result.compat = { ...(result.compat || {}), ...patch.compat };
  }

  if (!result.reasoning && result.compat?.thinkingFormat) {
    delete result.compat.thinkingFormat;
  }
  if (result.compat && Object.keys(result.compat).length === 0) {
    delete result.compat;
  }

  return result;
}

/** Full pipeline: base models → patch → custom → result */
function buildModels(base: JsonModel[], custom: JsonModel[], patch: PatchData): JsonModel[] {
  const modelMap = new Map<string, JsonModel>();

  for (const model of base) {
    modelMap.set(model.id, model);
  }

  for (const [id, patchEntry] of Object.entries(patch)) {
    const existing = modelMap.get(id);
    if (existing) {
      modelMap.set(id, applyPatch(existing, patchEntry));
    }
  }

  for (const model of custom) {
    const existing = modelMap.get(model.id);
    const patchEntry = patch[model.id];
    if (existing && patchEntry) {
      modelMap.set(model.id, applyPatch(model, patchEntry));
    } else if (existing) {
      modelMap.set(model.id, model);
    } else if (patchEntry) {
      modelMap.set(model.id, applyPatch(model, patchEntry));
    } else {
      modelMap.set(model.id, model);
    }
  }

  return Array.from(modelMap.values());
}

// ─── Stale-While-Revalidate Model Sync ────────────────────────────────────────

const PROVIDER_ID = "fireworks";
const BASE_URL = "https://api.fireworks.ai/inference/v1";
const MODELS_URL = `${BASE_URL}/models`;
const CACHE_DIR = path.join(getAgentDir(), "cache");
const CACHE_PATH = path.join(CACHE_DIR, `${PROVIDER_ID}-models.json`);
const LIVE_FETCH_TIMEOUT_MS = 8000;

/** Filter: only keep chat models with useful metadata. */
function isChatModel(apiModel: any): boolean {
  return apiModel.supports_chat === true || apiModel.kind === "HF_BASE_MODEL";
}

/** Transform a model from the Fireworks /v1/models API to JsonModel format. */
function transformApiModel(apiModel: any): JsonModel | null {
  if (!isChatModel(apiModel)) return null;
  return {
    id: apiModel.id,
    name: apiModel.id,
    reasoning: false,
    input: apiModel.supports_image_input ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: apiModel.context_length || 0,
    maxTokens: 0,
  };
}

async function fetchLiveModels(apiKey: string, signal?: AbortSignal): Promise<JsonModel[] | null> {
  try {
    const response = await fetch(MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: signal ? AbortSignal.any([AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS), signal]) : AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const apiModels = Array.isArray(data) ? data : (data.data || []);
    if (!Array.isArray(apiModels) || apiModels.length === 0) return null;
    return apiModels.map(transformApiModel).filter((m): m is JsonModel => m !== null);
  } catch {
    return null;
  }
}

function loadCachedModels(): JsonModel[] | null {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function cacheModels(models: JsonModel[]): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(models, null, 2) + "\n");
  } catch {
    // Cache write failure is non-fatal
  }
}

function mergeWithEmbedded(liveModels: JsonModel[], embeddedModels: JsonModel[]): JsonModel[] {
  const embeddedMap = new Map(embeddedModels.map(m => [m.id, m]));
  const seen = new Set<string>();
  const result: JsonModel[] = [];
  for (const liveModel of liveModels) {
    const embedded = embeddedMap.get(liveModel.id);
    seen.add(liveModel.id);
    if (embedded) {
      // Self-heal: live API pricing is authoritative field-by-field. Prefer the
      // live cost when the API reports it (non-zero); fall back to embedded when
      // the API is silent (0) so curated cacheRead/cacheWrite isn't clobbered and
      // providers whose /models endpoint exposes no pricing keep their curated
      // cost. Curation (reasoning/input/compat/name) still wins via ...embedded.
      result.push({
        ...liveModel,
        ...embedded,
        cost: {
          input: liveModel.cost.input || embedded.cost.input,
          output: liveModel.cost.output || embedded.cost.output,
          cacheRead: liveModel.cost.cacheRead || embedded.cost.cacheRead,
          cacheWrite: liveModel.cost.cacheWrite || embedded.cost.cacheWrite,
        },
        contextWindow: liveModel.contextWindow || embedded.contextWindow,
      });
    } else {
      result.push(liveModel);
    }
  }
  // Append any embedded models that the live API didn't return
  for (const em of embeddedModels) {
    if (!seen.has(em.id)) {
      result.push(em);
    }
  }
  return result;
}

function loadStaleModels(embeddedModels: JsonModel[]): JsonModel[] {
  const cached = loadCachedModels();
  if (!cached || cached.length === 0) return embeddedModels;

  // Merge embedded models that are missing from cache (newly added models)
  const cachedMap = new Map(cached.map(m => [m.id, m]));
  for (const em of embeddedModels) {
    if (!cachedMap.has(em.id)) {
      cached.push(em);
    }
  }
  return cached;
}

async function revalidateModels(apiKey: string | undefined, embeddedModels: JsonModel[], signal?: AbortSignal): Promise<JsonModel[] | null> {
  if (!apiKey) return null;
  const liveModels = await fetchLiveModels(apiKey, signal);
  if (!liveModels || liveModels.length === 0) return null;
  const merged = mergeWithEmbedded(liveModels, embeddedModels);
  cacheModels(merged);
  return merged;
}

// ─── API Key Resolution (via ModelRegistry) ────────────────────────────────────

let cachedApiKey: string | undefined;
let revalidateAbort: AbortController | null = null;

async function resolveApiKey(modelRegistry: ModelRegistry): Promise<void> {
  cachedApiKey = await modelRegistry.getApiKeyForProvider("fireworks") ?? undefined;
}

// ─── Kimi Regex Anchor Bleed Fix ──────────────────────────────────────────────

function isFireworksKimiModel(model: any): boolean {
  if (!model || model.provider !== "fireworks") return false;
  return /kimi-k2/i.test(model.id);
}

function sanitizePattern(pattern: string): string | undefined {
  // Alternation combined with anchors is the known trigger for Kimi's
  // regex anchor bleed bug. Remove the entire pattern in that case.
  if (pattern.includes("|") && (pattern.includes("^") || pattern.includes("$"))) {
    return undefined;
  }
  // For simple patterns, strip anchors so they can't leak into values.
  const stripped = pattern.replace(/\^|\$/g, "");
  return stripped.length > 0 ? stripped : undefined;
}

function sanitizeSchemaForKimi(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) {
    return schema.map((item) => sanitizeSchemaForKimi(item));
  }
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "pattern" && typeof value === "string") {
      const sanitized = sanitizePattern(value);
      if (sanitized !== undefined) {
        result[key] = sanitized;
      }
      // If sanitized is undefined, we omit the key entirely.
    } else if (value && typeof value === "object") {
      result[key] = sanitizeSchemaForKimi(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function stripAnchorBleedInPlace(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (typeof value === "string") {
      let s = value;
      while (s.startsWith("^")) s = s.slice(1);
      while (s.endsWith("$")) s = s.slice(0, -1);
      obj[key] = s;
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (typeof item === "string") {
          let s = item;
          while (s.startsWith("^")) s = s.slice(1);
          while (s.endsWith("$")) s = s.slice(0, -1);
          value[i] = s;
        } else if (item && typeof item === "object") {
          stripAnchorBleedInPlace(item as Record<string, unknown>);
        }
      }
    } else if (value && typeof value === "object") {
      stripAnchorBleedInPlace(value as Record<string, unknown>);
    }
  }
}

// ─── Service Tier (standard / priority) ──────────────────────────────────────

// Fireworks exposes a `service_tier` request field ("standard" | "priority") on
// its chat-completions endpoint. The priority tier trades higher per-token
// pricing for higher throughput / lower latency on supported models. This is
// orthogonal to the "fast" router model IDs (e.g. routers/...-fast), which are
// separate models; priority applies to the base models below.
//
// Per-request priority pricing (USD per million tokens) from Fireworks' tier
// reference. cacheWrite is not tiered (stays 0).
const PRIORITY_PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "accounts/fireworks/models/glm-5p2":          { input: 1.75, output: 5.5,  cacheRead: 0.175, cacheWrite: 0 },
  "accounts/fireworks/models/kimi-k2p7-code":   { input: 1.43, output: 6,   cacheRead: 0.29,  cacheWrite: 0 },
  "accounts/fireworks/models/minimax-m3":       { input: 0.45, output: 1.8,  cacheRead: 0.09,  cacheWrite: 0 },
  "accounts/fireworks/models/deepseek-v4-pro":  { input: 2.61, output: 5.22, cacheRead: 0.218, cacheWrite: 0 },
  "accounts/fireworks/models/kimi-k2p6":        { input: 1.5,  output: 6,   cacheRead: 0.22,  cacheWrite: 0 },
  "accounts/fireworks/models/minimax-m2p7":    { input: 0.45, output: 1.8,  cacheRead: 0.09,  cacheWrite: 0 },
  "accounts/fireworks/models/glm-5p1":         { input: 2.1,  output: 6.6,  cacheRead: 0.39,  cacheWrite: 0 },
  "accounts/fireworks/models/gpt-oss-120b":     { input: 0.18, output: 0.72, cacheRead: 0.018, cacheWrite: 0 },
  "accounts/fireworks/models/deepseek-v4-flash":{ input: 0.21, output: 0.42, cacheRead: 0.045, cacheWrite: 0 },
};

type ServiceTier = "standard" | "priority";

interface ServiceTierConfig {
  default: ServiceTier;
  keybinding: string;
  display: "statusbar" | "off";
}

interface FireworksConfig {
  serviceTier: ServiceTierConfig;
}

const FIREWORKS_CONFIG_PATH = path.join(getAgentDir(), "extensions", "fireworks.json");
const TIER_ENTRY_TYPE = "fireworks-service-tier";
const TIER_STATUS_KEY = "fireworks-tier";
const DEFAULT_SERVICE_TIER_CONFIG: ServiceTierConfig = {
  default: "standard",
  keybinding: "ctrl+shift+l",
  display: "statusbar",
};
const DEFAULT_FIREWORKS_CONFIG: FireworksConfig = { serviceTier: DEFAULT_SERVICE_TIER_CONFIG };

function isValidTier(v: unknown): v is ServiceTier {
  return v === "standard" || v === "priority";
}

function loadFireworksConfig(): FireworksConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(FIREWORKS_CONFIG_PATH, "utf8"));
    const st = raw?.serviceTier ?? {};
    return {
      serviceTier: {
        default: isValidTier(st.default) ? st.default : DEFAULT_SERVICE_TIER_CONFIG.default,
        keybinding: typeof st.keybinding === "string" && st.keybinding.length > 0 ? st.keybinding : DEFAULT_SERVICE_TIER_CONFIG.keybinding,
        display: st.display === "off" ? "off" : "statusbar",
      },
    };
  } catch {
    // Config missing or invalid — write defaults so the user can discover it.
    try {
      fs.mkdirSync(path.dirname(FIREWORKS_CONFIG_PATH), { recursive: true });
      fs.writeFileSync(FIREWORKS_CONFIG_PATH, JSON.stringify(DEFAULT_FIREWORKS_CONFIG, null, 2) + "\n");
    } catch {
      // Write failure is non-fatal — defaults still work in memory.
    }
    return { serviceTier: { ...DEFAULT_SERVICE_TIER_CONFIG } };
  }
}

let fireworksConfig = loadFireworksConfig();

// Held so module-scope helpers (setTier) can call pi.appendEntry.
let piRef: ExtensionAPI | null = null;

function isPriorityApplicable(id: string | undefined): boolean {
  return !!id && Object.prototype.hasOwnProperty.call(PRIORITY_PRICING, id);
}

// Session state: the active service tier. Replayed from session entries on
// session_start so it survives reload / resume.
let currentTier: ServiceTier = fireworksConfig.serviceTier.default;

function replayTierState(ctx: any, defaultTier: ServiceTier): void {
  let tier: ServiceTier = defaultTier;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry?.type === "custom" && entry.customType === TIER_ENTRY_TYPE && entry.data) {
      const t = entry.data.tier;
      if (isValidTier(t)) tier = t;
    }
  }
  currentTier = tier;
}

function updateTierStatus(ctx: any): void {
  if (fireworksConfig.serviceTier.display === "off") {
    ctx.ui.setStatus(TIER_STATUS_KEY, undefined);
    return;
  }
  let model: any;
  try {
    model = ctx.model;
  } catch {
    model = undefined;
  }
  if (!model || model.provider !== "fireworks" || !isPriorityApplicable(model.id)) {
    ctx.ui.setStatus(TIER_STATUS_KEY, undefined);
    return;
  }
  const label = currentTier === "priority" ? "tier: ⚡priority" : "tier: standard";
  try {
    ctx.ui.setStatus(TIER_STATUS_KEY, ctx.ui.theme.fg("dim", label));
  } catch {
    // setStatus / theme are no-ops without a UI runner.
  }
}

function setTier(ctx: any, tier: ServiceTier): void {
  currentTier = tier;
  try {
    piRef?.appendEntry(TIER_ENTRY_TYPE, { tier });
  } catch {
    // appendEntry outside a session context is non-fatal.
  }
  updateTierStatus(ctx);
}

function toggleTier(ctx: any): void {
  let model: any;
  try {
    model = ctx.model;
  } catch {
    model = undefined;
  }
  if (!model || model.provider !== "fireworks") {
    try { ctx.ui.notify("Fireworks service tier only applies to Fireworks models.", "info"); } catch {}
    return;
  }
  if (!isPriorityApplicable(model.id)) {
    try { ctx.ui.notify(`Service tier is not available for ${model.name || model.id}.`, "info"); } catch {}
    return;
  }
  const next: ServiceTier = currentTier === "priority" ? "standard" : "priority";
  setTier(ctx, next);
  try { ctx.ui.notify(`Fireworks service tier: ${next}`, "info"); } catch {}
}

// Recompute a finalized assistant message's cost against priority pricing so
// cost tracking reflects the premium tier instead of the model's base cost.
function recomputePriorityCost(message: any): any {
  const pricing = message?.model ? PRIORITY_PRICING[message.model] : undefined;
  if (!pricing) return undefined;
  const usage = message?.usage;
  if (!usage) return undefined;
  const cost = {
    input: (pricing.input / 1_000_000) * (usage.input || 0),
    output: (pricing.output / 1_000_000) * (usage.output || 0),
    cacheRead: (pricing.cacheRead / 1_000_000) * (usage.cacheRead || 0),
    cacheWrite: 0,
    total: 0,
  };
  cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
  return { ...message, usage: { ...usage, cost } };
}

// ─── Extension Entry Point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  piRef = pi;
  const embeddedModels = modelsData as JsonModel[];
  const customModels = customModelsData as JsonModel[];
  const patches = patchData as PatchData;

  const staleBase = loadStaleModels(embeddedModels);
  const staleModels = buildModels(staleBase, customModels, patches);

  pi.registerProvider("fireworks", {
    baseUrl: BASE_URL,
    apiKey: "$FIREWORKS_API_KEY",
    api: "openai-completions",
    models: staleModels,
  });

  pi.on("session_start", async (_event, ctx) => {
    revalidateAbort?.abort();
    revalidateAbort = new AbortController();
    const signal = revalidateAbort.signal;
    fireworksConfig = loadFireworksConfig();
    replayTierState(ctx, fireworksConfig.serviceTier.default);
    updateTierStatus(ctx);
    resolveApiKey(ctx.modelRegistry).then(() => {
      revalidateModels(cachedApiKey, embeddedModels, signal).then((freshBase) => {
        if (freshBase && !signal.aborted) {
          pi.registerProvider("fireworks", {
            baseUrl: BASE_URL,
            apiKey: "$FIREWORKS_API_KEY",
            api: "openai-completions",
            models: buildModels(freshBase, customModels, patches),
          });
        }
      });
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    revalidateAbort?.abort();
    try { ctx.ui.setStatus(TIER_STATUS_KEY, undefined); } catch {}
  });

  // Sanitize JSON Schema patterns for Kimi models before sending to Fireworks.
  // Kimi K2.x has a known bug where regex anchors (^ and $) in pattern fields
  // leak into generated argument strings, especially when alternation (|) is
  // present. We strip anchors from simple patterns and drop patterns that
  // combine alternation with anchors entirely.
  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    if (!model || model.provider !== "fireworks") return;

    const payload = event.payload as Record<string, unknown>;
    if (!payload || typeof payload !== "object") return;

    let modified = false;

    // Service tier: inject `service_tier` on supported Fireworks models when
    // priority is selected. Injected at the top level of both the OpenAI
    // completions and Anthropic Messages request bodies (Fireworks accepts the
    // field on its chat-completions endpoint; the Anthropic-compatible endpoint
    // passes it through as a top-level extra).
    if (currentTier === "priority" && isPriorityApplicable(model.id)) {
      payload.service_tier = "priority";
      modified = true;
    }

    // Kimi anchor-bleed sanitization (Kimi K2.x pattern bug). Only applies to
    // Kimi models, but a single request can be both Kimi and priority-tiered.
    if (isFireworksKimiModel(model)) {
      const tools = payload.tools;
      if (Array.isArray(tools)) {
        payload.tools = tools.map((tool: any) => {
          // OpenAI completions shape: tools[].function.parameters
          if (tool?.function?.parameters) {
            return {
              ...tool,
              function: { ...tool.function, parameters: sanitizeSchemaForKimi(tool.function.parameters) },
            };
          }
          // Anthropic messages shape: tools[].input_schema
          if (tool?.input_schema) {
            return { ...tool, input_schema: sanitizeSchemaForKimi(tool.input_schema) };
          }
          return tool;
        });
        modified = true;
      }

      // OpenAI-only: the Anthropic Messages API has no response_format equivalent.
      const responseFormat = payload.response_format as any;
      if (responseFormat?.json_schema?.schema) {
        responseFormat.json_schema.schema = sanitizeSchemaForKimi(responseFormat.json_schema.schema);
        modified = true;
      }
    }

    if (modified) {
      return payload;
    }
  });

  // Defense-in-depth: if the model still generates a value with a leading ^ or
  // trailing $ (anchor bleed), strip those characters from string tool arguments
  // before they reach the tool / MCP server.
  pi.on("tool_call", (event, ctx) => {
    if (!isFireworksKimiModel(ctx.model)) return;

    const input = (event as any).input;
    if (input && typeof input === "object") {
      stripAnchorBleedInPlace(input);
    }
  });

  // Refresh the tier status area when the active model changes.
  pi.on("model_select", async (_event, ctx) => {
    updateTierStatus(ctx);
  });

  // Recompute finalized assistant-message cost against priority pricing so
  // usage/cost reflects the premium tier rather than the model's base cost.
  // message_end fires for user, assistant, and toolResult messages; we only
  // touch assistant messages, and only when priority is active for that model.
  pi.on("message_end", async (event, _ctx) => {
    if (currentTier !== "priority") return;
    const message = (event as any).message;
    if (!message || message.role !== "assistant") return;
    const replaced = recomputePriorityCost(message);
    if (replaced) {
      return { message: replaced };
    }
  });

  // Keybinding: toggle the service tier for the active Fireworks model.
  pi.registerShortcut(fireworksConfig.serviceTier.keybinding, {
    description: "Toggle Fireworks service tier (standard / priority)",
    handler: async (ctx) => {
      toggleTier(ctx);
    },
  });

  // Command form (non-TUI use, or explicit setting): /fireworks-tier [standard|priority|toggle]
  pi.registerCommand("fireworks-tier", {
    description: "Set Fireworks service tier: standard | priority | toggle (default)",
    handler: async (args, ctx) => {
      const arg = (args || "").trim().toLowerCase();
      let model: any;
      try { model = ctx.model; } catch { model = undefined; }
      if (!model || model.provider !== "fireworks" || !isPriorityApplicable(model.id)) {
        try { ctx.ui.notify("Fireworks service tier only applies to supported Fireworks models.", "info"); } catch {}
        return;
      }
      if (arg === "priority") {
        setTier(ctx, "priority");
        try { ctx.ui.notify("Fireworks service tier: priority", "info"); } catch {}
      } else if (arg === "standard") {
        setTier(ctx, "standard");
        try { ctx.ui.notify("Fireworks service tier: standard", "info"); } catch {}
      } else {
        toggleTier(ctx);
      }
    },
  });
}