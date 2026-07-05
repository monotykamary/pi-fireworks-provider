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
import type { Input, matchesKey, Key, truncateToWidth, visibleWidth, wrapTextWithAnsi, fuzzyFilter, SettingsListTheme } from "@earendil-works/pi-tui";
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

type PreserveMode = boolean; // true = inject reasoning_history:"preserved"; false = default (stripped)

interface ServiceTierConfig {
  default: ServiceTier;
  keybinding: string;
  display: "statusbar" | "off";
}

interface PreserveThinkingConfig {
  default: PreserveMode;
}

// Logit bias: an OpenAI-style map of token ID → bias (-100..100), forwarded
// verbatim as the top-level `logit_bias` request field on Fireworks'
// OpenAI-compatible completions endpoint. Token IDs are tokenizer-specific
// (the caller must match the model's tokenizer). Disabled by default; an empty
// map or enabled=false means no injection. String-keyed so it serializes 1:1
// to the wire format.
interface LogitBiasConfig {
  enabled: boolean;
  biases: Record<string, number>;
}

interface FireworksConfig {
  serviceTier: ServiceTierConfig;
  preserveThinking: PreserveThinkingConfig;
  logitBias: LogitBiasConfig;
}

const FIREWORKS_CONFIG_PATH = path.join(getAgentDir(), "extensions", "fireworks.json");
const TIER_ENTRY_TYPE = "fireworks-service-tier";
const TIER_STATUS_KEY = "fireworks-tier";
const DEFAULT_SERVICE_TIER_CONFIG: ServiceTierConfig = {
  default: "standard",
  keybinding: "ctrl+shift+l",
  display: "statusbar",
};
// Preserved thinking is OFF by default to match pi core and Fireworks' default
// (`reasoning_history` omitted = prior reasoning stripped). Opt in via the
// /fireworks-settings panel (mirrors neuralwatt/makora: settings-only, no
// command or keybinding).
const DEFAULT_PRESERVE_CONFIG: PreserveThinkingConfig = {
  default: false,
};
const DEFAULT_LOGIT_BIAS_CONFIG: LogitBiasConfig = {
  enabled: false,
  biases: {},
};
const DEFAULT_FIREWORKS_CONFIG: FireworksConfig = {
  serviceTier: DEFAULT_SERVICE_TIER_CONFIG,
  preserveThinking: DEFAULT_PRESERVE_CONFIG,
  logitBias: DEFAULT_LOGIT_BIAS_CONFIG,
};

function isValidTier(v: unknown): v is ServiceTier {
  return v === "standard" || v === "priority";
}

function isValidKeybinding(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

// A valid logit-bias value: integer in [-100, 100]. -100 effectively bans the
// token (sets its logit to -inf on Fireworks / vLLM); other values shift the
// logit additively before sampling (per OpenAI / Fireworks semantics).
function isValidBiasValue(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= -100 && v <= 100;
}

// Validate the logit_bias map (tokenId-string → bias). Keys must be pure
// non-negative-integer strings ("1", "007"); they're normalized to canonical
// "String(parseInt)" keys. Invalid keys / values are dropped silently so a
// malformed config can't crash model registration. Rejects "1.5", "-1", "abc".
function parseLogitBiasMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d+$/.test(key)) continue;
    const tokenId = Number.parseInt(key, 10);
    if (!Number.isInteger(tokenId) || tokenId < 0) continue;
    if (!isValidBiasValue(value)) continue;
    result[String(tokenId)] = value;
  }
  return result;
}

// Validate the `logitBias` config object. Non-object / array → defaults.
function parseLogitBiasConfig(raw: unknown): LogitBiasConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { enabled: false, biases: {} };
  }
  const lb = raw as Record<string, unknown>;
  return {
    enabled: lb.enabled === true,
    biases: parseLogitBiasMap(lb.biases),
  };
}

// Strict integer parse for user-typed logit-bias inputs. Rejects decimals
// ("1.5"), signs ("+5"), empty, and non-numeric strings — Number.parseInt
// would silently truncate those, masking typos. Used by the TUI editor.
function parseTokenIdInput(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function parseBiasInput(raw: string): number | null {
  if (!/^-?\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= -100 && n <= 100 ? n : null;
}

function loadFireworksConfig(): FireworksConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(FIREWORKS_CONFIG_PATH, "utf8"));
    const st = raw?.serviceTier ?? {};
    const pt = raw?.preserveThinking ?? {};
    const lb = raw?.logitBias ?? {};
    return {
      serviceTier: {
        default: isValidTier(st.default) ? st.default : DEFAULT_SERVICE_TIER_CONFIG.default,
        keybinding: isValidKeybinding(st.keybinding) ? st.keybinding : DEFAULT_SERVICE_TIER_CONFIG.keybinding,
        display: st.display === "off" ? "off" : "statusbar",
      },
      preserveThinking: {
        default: typeof pt.default === "boolean" ? pt.default : DEFAULT_PRESERVE_CONFIG.default,
      },
      logitBias: parseLogitBiasConfig(lb),
    };
  } catch {
    // Config missing or invalid — write defaults so the user can discover it.
    try {
      fs.mkdirSync(path.dirname(FIREWORKS_CONFIG_PATH), { recursive: true });
      fs.writeFileSync(FIREWORKS_CONFIG_PATH, JSON.stringify(DEFAULT_FIREWORKS_CONFIG, null, 2) + "\n");
    } catch {
      // Write failure is non-fatal — defaults still work in memory.
    }
    return { serviceTier: { ...DEFAULT_SERVICE_TIER_CONFIG }, preserveThinking: { ...DEFAULT_PRESERVE_CONFIG }, logitBias: { enabled: false, biases: {} } };
  }
}

// Read-modify-write the raw config JSON without re-validating, so unrelated
// fields a user added survive a settings-UI write. `loadFireworksConfig()`
// (validated) is still called after writing to refresh the in-memory config.
function readRawFireworksConfig(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(FIREWORKS_CONFIG_PATH, "utf8"));
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_FIREWORKS_CONFIG));
  }
}

function writeRawFireworksConfig(raw: Record<string, any>): void {
  try {
    fs.mkdirSync(path.dirname(FIREWORKS_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(FIREWORKS_CONFIG_PATH, JSON.stringify(raw, null, 2) + "\n");
  } catch {
    // Write failure is non-fatal — the in-memory refresh still applies.
  }
}

let fireworksConfig = loadFireworksConfig();

// Logit Bias state — read/refresh/mutate the logit_bias config. The in-memory
// cache (`fireworksConfig`) is refreshed on session_start and after every
// settings write (mutateLogitBias); before_provider_request reads it directly.
function getLogitBias(): LogitBiasConfig {
  return fireworksConfig.logitBias;
}

// Re-read + refresh the in-memory config from disk so the settings editor sees
// the latest file state (handles hand-edits since session_start). Called when
// the logit-bias submenu opens (mirrors makora's "fresh state on each open").
function reloadLogitBias(): LogitBiasConfig {
  fireworksConfig = loadFireworksConfig();
  return fireworksConfig.logitBias;
}

// Read-modify-write the validated logit-bias config, then refresh the in-memory
// cache so before_provider_request picks up the change on the next request.
// The mutator receives a normalized LogitBiasConfig it can mutate in place.
function mutateLogitBias(mutator: (lb: LogitBiasConfig) => void): void {
  const raw = readRawFireworksConfig();
  const current = parseLogitBiasConfig(raw.logitBias);
  mutator(current);
  raw.logitBias = current;
  writeRawFireworksConfig(raw);
  fireworksConfig = loadFireworksConfig();
}

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

// ─── Preserved Thinking (reasoning_history) ──────────────────────────────────

// Fireworks exposes a top-level `reasoning_history` request parameter. The
// only accepted value is `"preserved"`; omitting it (or any other value)
// means prior assistant reasoning is STRIPPED from the model's context
// (verified by e2e: reasoning_content on an assistant message yields 0%
// multi-turn recall without the flag, 100% with it). This works on BOTH
// transports — the OpenAI completions endpoint (assistant `reasoning_content`
// field) and the Anthropic Messages endpoint (assistant `thinking` content
// block, which Firebooks returns a `signature` for so pi-ai replays it).
//
// Unlike neuralwatt/makora (which use per-model vLLM `chat_template_kwargs`
// flags like preserve_thinking/clear_thinking), Fireworks' knob is a single
// global top-level param that applies to every reasoning model. We expose it
// as one on/off toggle. See https://docs.fireworks.ai/guides/reasoning#preserved-thinking.

// A Fireworks model is preserve-eligible if it's a reasoning model. We read
// `reasoning` off the registered model when available, but also accept a
// truthy `reasoning` flag on ctx.model (pi-ai attaches it).
function isPreserveEligible(model: any): boolean {
  if (!model || model.provider !== "fireworks") return false;
  return model.reasoning === true;
}

// Runtime state: whether preserved thinking is active. Initialized from the
// config-file default at session_start (mirrors neuralwatt/makora, which drive
// preserve state from the config file, not session entries) and updated by the
// /fireworks-settings panel, which also persists the new default.
let preserveOn: boolean = fireworksConfig.preserveThinking.default;

function setPreserve(on: boolean): void {
  preserveOn = on;
}

// Logit Bias Editor (TUI) — custom Component for the "Logit bias" submenu.
//
// The makora nested-UI idiom is SettingsList → submenu → SettingsList, but
// SettingsList only cycles fixed `values` or opens a sub-Component — it can't
// take free text, and "add an arbitrary token ID + bias" needs free text. So
// this editor IS the submenu Component: it owns an ordered entry list (add /
// edit / delete mutate it in place and re-render without closing the submenu)
// and uses pi-tui's Input for the token-ID and bias prompts. Every mutation is
// persisted immediately via mutateLogitBias; Esc returns to the parent settings
// list, passing back a one-line summary so the top-level row's value refreshes.

type LogitBiasEntry = { tokenId: number; bias: number };

type Row = { label: string; value: string; description: string; kind: "enabled" | "entry" | "add"; tokenId?: number };

interface LogitBiasEditorDeps {
  InputCtor: typeof Input;
  matchesKey: typeof matchesKey;
  Key: typeof Key;
  truncateToWidth: typeof truncateToWidth;
  visibleWidth: typeof visibleWidth;
  wrapTextWithAnsi: typeof wrapTextWithAnsi;
  fuzzyFilter: typeof fuzzyFilter;
  settingsListTheme: SettingsListTheme;
  theme: { fg(name: string, text: string): string };
  notify: (msg: string, level: "info" | "error") => void;
  subDone: (value?: string) => void;
}

class LogitBiasEditor {
  private entries: LogitBiasEntry[];
  private enabled: boolean;
  private selectedIndex = 0;
  private mode: "list" | "addToken" | "addBias" | "editBias" = "list";
  private input: Input;
  // Search `>` area at the top of the panel (matches SettingsList's search).
  // Filters rows by label via fuzzyFilter; queries are numeric (token IDs), so
  // `d` is reserved as a delete shortcut when the query is empty.
  private searchInput: Input;
  private searchQuery = "";
  private pendingTokenId: number | null = null;
  private editingTokenId: number | null = null;
  private readonly maxVisible = 10;

  constructor(private deps: LogitBiasEditorDeps) {
    const lb = reloadLogitBias();
    this.enabled = lb.enabled;
    this.entries = LogitBiasEditor.sorted(lb.biases);
    this.input = new deps.InputCtor();
    this.input.onSubmit = () => this.submitInput();
    this.input.onEscape = () => this.cancelInput();
    this.searchInput = new deps.InputCtor();
  }

  private static sorted(biases: Record<string, number>): LogitBiasEntry[] {
    return Object.entries(biases)
      .map(([k, bias]) => ({ tokenId: Number.parseInt(k, 10), bias }))
      .sort((a, b) => a.tokenId - b.tokenId);
  }

  private persist(): void {
    const biases: Record<string, number> = {};
    for (const e of this.entries) biases[String(e.tokenId)] = e.bias;
    mutateLogitBias((lb) => {
      lb.enabled = this.enabled;
      lb.biases = biases;
    });
  }

  private summary(): string {
    const n = this.entries.length;
    if (n === 0) return this.enabled ? "on · empty" : "off";
    return `${n} ${n === 1 ? "entry" : "entries"} · ${this.enabled ? "on" : "off"}`;
  }

  // Virtual rows: [Enabled toggle] + entries + [Add token…].
  private buildRows(): Row[] {
    const rows: Row[] = [];
    rows.push({
      label: "Enabled",
      value: this.enabled ? "on" : "off",
      kind: "enabled",
      description: "When on, the logit_bias map is sent on every Fireworks OpenAI-completions request, biasing the listed token IDs by their bias (-100..100). Off = nothing sent (entries are kept). Token IDs are tokenizer-specific — match the model's tokenizer.",
    });
    for (const e of this.entries) {
      rows.push({
        label: `token ${e.tokenId}`,
        value: String(e.bias),
        kind: "entry",
        tokenId: e.tokenId,
        description: `token ${e.tokenId} → ${e.bias}. Enter to edit the bias (-100..100), d to delete. Token IDs are tokenizer-specific.`,
      });
    }
    rows.push({
      label: "Add token…",
      value: "",
      kind: "add",
      description: "Add a new entry: prompts for the token ID (non-negative integer), then the bias (-100..100).",
    });
    return rows;
  }

  // Rows visible after the search filter. With no query, returns all rows.
  private filteredRows(): Row[] {
    const rows = this.buildRows();
    if (!this.searchQuery) return rows;
    return this.deps.fuzzyFilter(rows, this.searchQuery, (r) => r.label);
  }

  private applyFilter(): void {
    this.searchQuery = this.searchInput.getValue();
    this.selectedIndex = 0;
  }

  private clearSearch(): void {
    this.searchInput.setValue("");
    this.searchQuery = "";
  }

  handleInput(data: string): void {
    if (this.mode !== "list") {
      this.input.handleInput(data);
      return;
    }
    const { matchesKey, Key } = this.deps;
    if (matchesKey(data, Key.up)) {
      const n = this.filteredRows().length;
      if (n > 0) this.selectedIndex = (this.selectedIndex - 1 + n) % n;
    } else if (matchesKey(data, Key.down)) {
      const n = this.filteredRows().length;
      if (n > 0) this.selectedIndex = (this.selectedIndex + 1) % n;
    } else if (matchesKey(data, Key.enter) || data === " ") {
      this.activateSelected();
    } else if (matchesKey(data, Key.escape)) {
      this.close();
    } else if (this.searchQuery === "" && (data === "d" || data === "D")) {
      // `d` deletes the selected entry. Only active when not searching — with a
      // query active, `d` is routed to the search input (token IDs are numeric,
      // so `d` is never a useful search term, but routing avoids accidental
      // deletes mid-search).
      this.deleteSelected();
    } else {
      // Route everything else (printables, backspace, cursor arrows) to the
      // search input, mirroring SettingsList. Spaces are dropped (sanitized)
      // so they never enter the query.
      const sanitized = data.replace(/ /g, "");
      if (!sanitized) return;
      this.searchInput.handleInput(sanitized);
      this.applyFilter();
    }
  }

  private activateSelected(): void {
    const row = this.filteredRows()[this.selectedIndex];
    if (!row) return;
    if (row.kind === "enabled") {
      this.toggleEnabled();
    } else if (row.kind === "add") {
      this.startAddToken();
    } else if (row.kind === "entry" && row.tokenId !== undefined) {
      const entry = this.entries.find((e) => e.tokenId === row.tokenId);
      if (entry) this.startEditBias(entry);
    }
  }

  private toggleEnabled(): void {
    this.enabled = !this.enabled;
    this.persist();
    this.deps.notify(`Logit bias ${this.enabled ? "on" : "off"}.`, "info");
  }

  private deleteSelected(): void {
    const row = this.filteredRows()[this.selectedIndex];
    if (!row || row.kind !== "entry" || row.tokenId === undefined) return;
    const idx = this.entries.findIndex((e) => e.tokenId === row.tokenId);
    if (idx < 0) return;
    const [removed] = this.entries.splice(idx, 1);
    this.persist();
    const newLen = this.filteredRows().length;
    if (this.selectedIndex >= newLen) this.selectedIndex = Math.max(0, newLen - 1);
    if (removed) this.deps.notify(`Removed token ${removed.tokenId}.`, "info");
  }

  private startAddToken(): void {
    this.clearSearch();
    this.mode = "addToken";
    this.pendingTokenId = null;
    this.input.setValue("");
    this.input.focused = true;
  }

  private startEditBias(entry: LogitBiasEntry): void {
    this.clearSearch();
    // Re-select the entry in the (now unfiltered) full list so the cursor
    // stays on it after returning from the bias prompt.
    const fullIdx = this.buildRows().findIndex((r) => r.kind === "entry" && r.tokenId === entry.tokenId);
    this.selectedIndex = fullIdx >= 0 ? fullIdx : 0;
    this.mode = "editBias";
    this.editingTokenId = entry.tokenId;
    this.input.setValue(String(entry.bias));
    this.input.focused = true;
  }

  private submitInput(): void {
    const raw = this.input.getValue().trim();
    if (this.mode === "addToken") {
      const tokenId = parseTokenIdInput(raw);
      if (tokenId === null) {
        this.deps.notify("Token ID must be a non-negative integer.", "error");
        return;
      }
      if (this.entries.some((e) => e.tokenId === tokenId)) {
        this.deps.notify(`Token ${tokenId} already has a bias — edit it instead.`, "error");
        return;
      }
      this.pendingTokenId = tokenId;
      this.mode = "addBias";
      this.input.setValue("0");
      this.input.focused = true;
      return;
    }
    if (this.mode === "addBias") {
      const bias = parseBiasInput(raw);
      if (bias === null) {
        this.deps.notify("Bias must be an integer from -100 to 100.", "error");
        return;
      }
      const tokenId = this.pendingTokenId!;
      this.entries.push({ tokenId, bias });
      this.entries.sort((a, b) => a.tokenId - b.tokenId);
      this.persist();
      const newIdx = this.entries.findIndex((e) => e.tokenId === tokenId);
      this.selectedIndex = 1 + newIdx;
      this.pendingTokenId = null;
      this.mode = "list";
      this.input.focused = false;
      this.deps.notify(`Added token ${tokenId} → ${bias}.`, "info");
      return;
    }
    if (this.mode === "editBias") {
      const bias = parseBiasInput(raw);
      if (bias === null) {
        this.deps.notify("Bias must be an integer from -100 to 100.", "error");
        return;
      }
      const tokenId = this.editingTokenId!;
      const entry = this.entries.find((e) => e.tokenId === tokenId);
      if (entry) {
        entry.bias = bias;
        this.persist();
      }
      this.editingTokenId = null;
      this.mode = "list";
      this.input.focused = false;
      this.deps.notify(`Set token ${tokenId} → ${bias}.`, "info");
      return;
    }
  }

  private cancelInput(): void {
    this.mode = "list";
    this.pendingTokenId = null;
    this.editingTokenId = null;
    this.input.focused = false;
  }

  private close(): void {
    this.input.focused = false;
    this.searchInput.focused = false;
    this.deps.subDone(this.summary());
  }

  private renderList(width: number): string[] {
    const t = this.deps.settingsListTheme;
    const { truncateToWidth, visibleWidth, wrapTextWithAnsi } = this.deps;
    const lines: string[] = [];
    // Search `>` area — mirrors SettingsList (renderMainList) so the panel stays
    // visually consistent with the rest of /fireworks-settings.
    lines.push(...this.searchInput.render(width));
    lines.push("");

    const rows = this.filteredRows();
    const total = rows.length;
    if (total === 0) {
      lines.push(t.hint(truncateToWidth("  No matching tokens", width)));
    } else {
      const maxLabel = Math.min(30, Math.max(...rows.map((r) => visibleWidth(r.label)), 1));
      const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), total - this.maxVisible));
      const end = Math.min(start + this.maxVisible, total);
      for (let i = start; i < end; i++) {
        const row = rows[i];
        const selected = i === this.selectedIndex;
        const prefix = selected ? t.cursor : "  ";
        const labelPadded = row.label + " ".repeat(Math.max(0, maxLabel - visibleWidth(row.label)));
        const label = t.label(labelPadded, selected);
        const sep = "  ";
        const valueWidth = width - visibleWidth(prefix) - maxLabel - visibleWidth(sep) - 2;
        const value = row.value ? t.value(truncateToWidth(row.value, Math.max(0, valueWidth), ""), selected) : "";
        lines.push(truncateToWidth(prefix + label + sep + value, width));
      }
      if (start > 0 || end < total) {
        lines.push(t.hint(truncateToWidth(`  (${this.selectedIndex + 1}/${total})`, width - 2, "")));
      }
      const sel = rows[this.selectedIndex];
      if (sel?.description) {
        lines.push("");
        for (const ln of wrapTextWithAnsi(sel.description, width - 4)) {
          lines.push(t.description(`  ${ln}`));
        }
      }
    }

    lines.push("");
    lines.push(truncateToWidth(t.hint("  Type to search · ↑↓ move · Enter activate · d delete · Esc back"), width));
    return lines;
  }

  private renderInput(width: number): string[] {
    const { settingsListTheme: t, theme, truncateToWidth } = this.deps;
    const lines: string[] = [];
    let prompt = "";
    if (this.mode === "addToken") {
      prompt = "Token ID (non-negative integer):";
    } else if (this.mode === "addBias") {
      prompt = `Bias for token ${this.pendingTokenId} (-100..100):`;
    } else if (this.mode === "editBias") {
      prompt = `New bias for token ${this.editingTokenId} (-100..100):`;
    }
    lines.push(truncateToWidth(theme.fg("accent", prompt), width));
    lines.push(...this.input.render(width));
    lines.push("");
    lines.push(truncateToWidth(t.hint("  Enter submit · Esc cancel"), width));
    return lines;
  }

  render(width: number): string[] {
    return this.mode === "list" ? this.renderList(width) : this.renderInput(width);
  }

  invalidate(): void {
    this.input.invalidate?.();
    this.searchInput.invalidate?.();
  }
}

// One-line summary of the logit-bias config for the top-level settings row.
function logitBiasSummary(): string {
  const lb = getLogitBias();
  const n = Object.keys(lb.biases).length;
  if (n === 0) return lb.enabled ? "on · empty" : "off";
  return `${n} ${n === 1 ? "entry" : "entries"} · ${lb.enabled ? "on" : "off"}`;
}

// ─── Extension Entry Point ────────────────────────────────────────────────────

export {
  applyPatch,
  buildModels,
  isChatModel,
  transformApiModel,
  mergeWithEmbedded,
  loadStaleModels,
  isFireworksKimiModel,
  sanitizePattern,
  sanitizeSchemaForKimi,
  stripAnchorBleedInPlace,
  isValidTier,
  isValidKeybinding,
  loadFireworksConfig,
  readRawFireworksConfig,
  writeRawFireworksConfig,
  isPriorityApplicable,
  PRIORITY_PRICING,
  recomputePriorityCost,
  replayTierState,
  setTier,
  updateTierStatus,
  isPreserveEligible,
  setPreserve,
  isValidBiasValue,
  parseLogitBiasMap,
  parseLogitBiasConfig,
  parseBiasInput,
  parseTokenIdInput,
  getLogitBias,
  reloadLogitBias,
  mutateLogitBias,
  logitBiasSummary,
  LogitBiasEditor,
};

export type {
  JsonModel,
  PatchEntry,
  PatchData,
  FireworksApi,
  ServiceTier,
  ServiceTierConfig,
  PreserveThinkingConfig,
  FireworksConfig,
  LogitBiasConfig,
  LogitBiasEntry,
};

export default function (pi: ExtensionAPI) {
  piRef = pi;
  const embeddedModels = modelsData as JsonModel[];
  const customModels = customModelsData as JsonModel[];
  const patches = patchData as PatchData;

  // Deferred model_select notify timer — cleared on rapid re-switch and on
  // session_shutdown so only the latest switch notifies. Mirrors neuralwatt's
  // pattern so pi core's (and other extensions') notifications land first.
  let modelSelectNotifyTimer: ReturnType<typeof setTimeout> | null = null;
  const MODEL_SELECT_NOTIFY_DELAY_MS = 250;

  // Notify preserved-thinking state for a Fireworks reasoning model. Deferred
  // so pi core's notifications land first; cancelled on re-switch/shutdown so
  // only the latest shows. Always level "info" — the text conveys the
  // preserve/strip tradeoff, not a warning.
  function notifyPreserveOnSelect(model: any, ctx: any): void {
    if (!model || model.provider !== "fireworks") return;
    if (!isPreserveEligible(model)) return;
    const msg = preserveOn
      ? `Preserved thinking ON for ${model.name || model.id} — full reasoning history retained across turns (better multi-turn recall; uses more tokens). Open /fireworks-settings to change.`
      : `Preserved thinking OFF for ${model.name || model.id} — reasoning stripped each turn (Fireworks default; lighter, weaker multi-turn recall). Open /fireworks-settings to change.`;
    if (modelSelectNotifyTimer) clearTimeout(modelSelectNotifyTimer);
    modelSelectNotifyTimer = setTimeout(() => {
      modelSelectNotifyTimer = null;
      try { ctx.ui.notify(msg, "info"); } catch { /* notify is a no-op without a UI runner */ }
    }, MODEL_SELECT_NOTIFY_DELAY_MS);
  }

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
    preserveOn = fireworksConfig.preserveThinking.default;
    updateTierStatus(ctx);
    notifyPreserveOnSelect(ctx.model, ctx);
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
    if (modelSelectNotifyTimer) { clearTimeout(modelSelectNotifyTimer); modelSelectNotifyTimer = null; }
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

    // Preserved thinking: inject top-level `reasoning_history: "preserved"`
    // so Fireworks renders prior assistant reasoning (reasoning_content on the
    // OpenAI endpoint, thinking blocks on the Anthropic endpoint) into the
    // model's context instead of stripping it. The only accepted value is
    // "preserved"; omitted = stripped (Fireworks default / pi core). Applies to
    // any Fireworks reasoning model on both transports. pi-ai already replays
    // the reasoning field/block on prior assistant turns; this flag is what
    // makes Fireworks honor it. See https://docs.fireworks.ai/guides/reasoning.
    if (preserveOn && isPreserveEligible(model)) {
      payload.reasoning_history = "preserved";
      modified = true;
    }

    // Logit bias: forward the user's logit_bias map (token ID → -100..100) on
    // Fireworks OpenAI-completions requests. The map is OpenAI-compatible and
    // Fireworks adds each bias to the token's logit before sampling. Gated to
    // the OpenAI-completions transport — the Anthropic Messages API has no
    // logit_bias equivalent, so we skip models routed via `api:
    // "anthropic-messages"` (the provider default is "openai-completions"; only
    // a patched/custom model sets the Anthropic transport). Token IDs are
    // tokenizer-specific — the caller must match the model's tokenizer.
    const lb = fireworksConfig.logitBias;
    if (lb.enabled && Object.keys(lb.biases).length > 0 && model.api !== "anthropic-messages") {
      payload.logit_bias = lb.biases;
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

  // Refresh the tier status area when the active model changes, and notify
  // preserved-thinking state for the selected reasoning model (mirrors
  // neuralwatt/makora: notification only, no preserve status area).
  pi.on("model_select", async (event, ctx) => {
    updateTierStatus(ctx);
    notifyPreserveOnSelect(event.model ?? ctx.model, ctx);
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

  // /fireworks-settings: TUI settings panel (mirrors /neuralwatt-settings &
  // /makora-settings). Opens a SettingsList via ctx.ui.custom(). Toggles write
  // to ~/.pi/agent/extensions/fireworks.json (raw read-modify-write so unknown
  // fields survive) and refresh the in-memory config. Preserved thinking is
  // settings-only (no command/keybinding), exactly like the siblings; the
  // service-tier keybinding is load-time only, so keybinding changes need /reload.
  pi.registerCommand("fireworks-settings", {
    description: "Configure Fireworks: preserved thinking + service tier + logit bias + display",
    async handler(_args, ctx) {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/fireworks-settings requires TUI mode.", "error");
        return;
      }
      const { SettingsList, Container, Input, matchesKey, Key, truncateToWidth, visibleWidth, wrapTextWithAnsi, fuzzyFilter } = await import("@earendil-works/pi-tui");
      const { getSettingsListTheme, DynamicBorder } = await import("@earendil-works/pi-coding-agent");

      await ctx.ui.custom((_tui, theme, _kb, done) => {
        const border = () => new DynamicBorder((s: string) => theme.fg("border", s));

        const items: any[] = [
          {
            id: "preserveThinking",
            label: "Preserved thinking",
            description: "Inject reasoning_history:\"preserved\" so Fireworks retains prior assistant reasoning across turns (better multi-turn recall; uses more tokens). Off = Fireworks default (stripped). Applies to every Fireworks reasoning model on both endpoints.",
            currentValue: preserveOn ? "on" : "off",
            values: ["on", "off"],
          },
          {
            id: "serviceTier",
            label: "Service tier",
            description: "Fireworks service tier for supported models. priority = higher throughput / latency at ~1.2\u20131.5\u00d7 cost (priority pricing reflected in cost tracking). standard = default.",
            currentValue: currentTier,
            values: ["standard", "priority"],
          },
          {
            id: "serviceTier.display",
            label: "Service tier display",
            description: "Where the \u201ctier: standard / \u26a1priority\u201d indicator is shown: footer status area or hidden",
            currentValue: fireworksConfig.serviceTier.display,
            values: ["statusbar", "off"],
          },
          {
            id: "logitBias",
            label: "Logit bias",
            description: "Send an OpenAI-style logit_bias map (token ID → -100..100) on every Fireworks OpenAI-completions request. Open the nested panel to add / edit / delete token IDs and biases. Token IDs are tokenizer-specific — use the exact tokenizer of the model you're calling. Not sent on Anthropic-routed models.",
            currentValue: logitBiasSummary(),
            submenu: (_cv: string, subDone: (v?: string) => void) =>
              new LogitBiasEditor({
                InputCtor: Input,
                matchesKey,
                Key,
                truncateToWidth,
                visibleWidth,
                wrapTextWithAnsi,
                fuzzyFilter,
                settingsListTheme: getSettingsListTheme(),
                theme,
                notify: (msg, level) => { try { ctx.ui.notify(msg, level); } catch { /* notify is a no-op without a UI runner */ } },
                subDone,
              }),
          },
        ];

        const container = new Container();
        container.addChild(border());

        const settingsList = new SettingsList(
          items,
          Math.min(items.length + 2, 15),
          getSettingsListTheme(),
          (id: string, newValue: string) => {
            if (id === "preserveThinking") {
              const on = newValue === "on";
              setPreserve(on);
              // Persist as the default too, so it survives new sessions.
              const raw = readRawFireworksConfig();
              raw.preserveThinking = { ...(raw.preserveThinking ?? {}), default: on };
              writeRawFireworksConfig(raw);
              fireworksConfig = loadFireworksConfig();
              ctx.ui.notify(`Preserved thinking ${on ? "on" : "off"} \u2014 takes effect now.`, "info");
            } else if (id === "serviceTier") {
              let model: any;
              try { model = ctx.model; } catch { model = undefined; }
              if (!model || model.provider !== "fireworks" || !isPriorityApplicable(model.id)) {
                ctx.ui.notify("Service tier only applies to supported Fireworks models.", "info");
                return;
              }
              const tier = newValue as ServiceTier;
              setTier(ctx, tier);
              const raw = readRawFireworksConfig();
              raw.serviceTier = { ...(raw.serviceTier ?? {}), default: tier };
              writeRawFireworksConfig(raw);
              fireworksConfig = loadFireworksConfig();
              ctx.ui.notify(`Fireworks service tier: ${tier}`, "info");
            } else if (id === "serviceTier.display") {
              const raw = readRawFireworksConfig();
              raw.serviceTier = { ...(raw.serviceTier ?? {}), display: newValue };
              writeRawFireworksConfig(raw);
              fireworksConfig = loadFireworksConfig();
              updateTierStatus(ctx);
            }
          },
          () => done(undefined),
          { enableSearch: true },
        );
        container.addChild(settingsList);
        container.addChild(border());

        return {
          render(width: number) {
            return container.render(width);
          },
          invalidate() {
            container.invalidate();
          },
          handleInput(data: string) {
            settingsList.handleInput?.(data);
          },
        };
      });
    },
  });
}