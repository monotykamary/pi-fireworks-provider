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
 * Merge order: [live|cache|embedded] → apply patch.json → merge custom-models.json → transform
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

import type { ExtensionAPI, ModelRegistry } from "@mariozechner/pi-coding-agent";
import regularModelsData from "./models.json" with { type: "json" };
import customModelsData from "./custom-models.json" with { type: "json" };
import patchesData from "./patch.json" with { type: "json" };
import fs from "fs";
import os from "os";
import path from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

interface JsonModel {
  id: string;
  name: string;
  family?: string;
  reasoning?: boolean;
  interleaved?: { field: string };
  modalities: {
    input: string[];
    output?: string[];
  };
  cost?: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
  };
  limit: {
    context: number | null;
    output: number | null;
  };
}

interface PatchEntry {
  name?: string;
  family?: string;
  reasoning?: boolean;
  interleaved?: { field: string };
  modalities?: {
    input: string[];
    output?: string[];
  };
  cost?: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
  };
  limit?: {
    context?: number;
    output?: number;
  };
}

interface PiModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
}

// ─── Patch & Merge ────────────────────────────────────────────────────────────

function applyPatch(model: JsonModel, patch: PatchEntry): JsonModel {
  const result = { ...model };

  if (patch.name !== undefined) result.name = patch.name;
  if (patch.family !== undefined) result.family = patch.family;
  if (patch.reasoning !== undefined) result.reasoning = patch.reasoning;
  if (patch.interleaved !== undefined) result.interleaved = patch.interleaved;

  if (patch.modalities) {
    result.modalities = { ...result.modalities, ...patch.modalities };
  }
  if (patch.cost) {
    result.cost = {
      input: patch.cost.input ?? result.cost?.input ?? 0,
      output: patch.cost.output ?? result.cost?.output ?? 0,
      cache_read: patch.cost.cache_read ?? result.cost?.cache_read ?? 0,
      cache_write: patch.cost.cache_write ?? result.cost?.cache_write ?? 0,
    };
  }
  if (patch.limit) {
    result.limit = {
      context: patch.limit.context ?? result.limit?.context ?? 0,
      output: patch.limit.output ?? result.limit?.output ?? null,
    };
  }

  return result;
}

function transformModel(model: JsonModel): PiModel {
  const cost = model.cost ?? {};
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning ?? false,
    input: model.modalities.input,
    cost: {
      input: cost.input ?? 0,
      output: cost.output ?? 0,
      cacheRead: cost.cache_read ?? 0,
      cacheWrite: cost.cache_write ?? 0,
    },
    contextWindow: model.limit.context ?? 0,
    maxTokens: model.limit.output ?? 0,
  };
}

/** Full pipeline: base models → patch → custom → transform to Pi format */
function buildModels(regular: JsonModel[], custom: JsonModel[], patchData: Record<string, PatchEntry>): PiModel[] {
  const modelMap = new Map<string, JsonModel>();

  for (const model of regular) {
    modelMap.set(model.id, model);
  }

  for (const [id, patch] of Object.entries(patchData)) {
    const existing = modelMap.get(id);
    if (existing) {
      modelMap.set(id, applyPatch(existing, patch));
    }
  }

  for (const model of custom) {
    const existing = modelMap.get(model.id);
    const patch = patchData[model.id];
    if (existing && patch) {
      modelMap.set(model.id, applyPatch(model, patch));
    } else if (existing) {
      modelMap.set(model.id, model);
    } else if (patch) {
      modelMap.set(model.id, applyPatch(model, patch));
    } else {
      modelMap.set(model.id, model);
    }
  }

  return Array.from(modelMap.values()).map(transformModel);
}

// ─── Stale-While-Revalidate Model Sync ────────────────────────────────────────

const PROVIDER_ID = "fireworks";
const BASE_URL = "https://api.fireworks.ai/inference/v1";
const MODELS_URL = `${BASE_URL}/models`;
const CACHE_DIR = path.join(os.homedir(), ".pi", "agent", "cache");
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
    modalities: {
      input: apiModel.supports_image_input ? ["text", "image"] : ["text"],
    },
    limit: {
      context: apiModel.context_length || null,
      output: null,
    },
  };
}

async function fetchLiveModels(apiKey: string): Promise<JsonModel[] | null> {
  try {
    const response = await fetch(MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS),
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
  const embeddedIds = new Set(embeddedModels.map(m => m.id));
  const result = [...embeddedModels];
  for (const model of liveModels) {
    if (!embeddedIds.has(model.id)) {
      result.push(model);
    }
  }
  return result;
}

function loadStaleModels(embeddedModels: JsonModel[]): JsonModel[] {
  const cached = loadCachedModels();
  if (cached && cached.length > 0) return cached;
  return embeddedModels;
}

async function revalidateModels(apiKey: string | undefined, embeddedModels: JsonModel[]): Promise<JsonModel[] | null> {
  if (!apiKey) return null;
  const liveModels = await fetchLiveModels(apiKey);
  if (!liveModels || liveModels.length === 0) return null;
  const merged = mergeWithEmbedded(liveModels, embeddedModels);
  cacheModels(merged);
  return merged;
}

// ─── API Key Resolution (via ModelRegistry) ────────────────────────────────────

let cachedApiKey: string | undefined;

async function resolveApiKey(modelRegistry: ModelRegistry): Promise<void> {
  cachedApiKey = await modelRegistry.getApiKeyForProvider("fireworks") ?? undefined;
}

// ─── Extension Entry Point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const embeddedModels = regularModelsData as JsonModel[];
  const customModels = customModelsData as JsonModel[];
  const patches = patchesData as Record<string, PatchEntry>;

  const staleBase = loadStaleModels(embeddedModels);
  const staleModels = buildModels(staleBase, customModels, patches);

  pi.registerProvider("fireworks", {
    baseUrl: BASE_URL,
    apiKey: "FIREWORKS_API_KEY",
    api: "openai-completions",
    models: staleModels,
  });

  pi.on("session_start", async (_event, ctx) => {
    await resolveApiKey(ctx.modelRegistry);
    revalidateModels(cachedApiKey, embeddedModels).then((freshBase) => {
      if (freshBase) {
        pi.registerProvider("fireworks", {
          baseUrl: BASE_URL,
          apiKey: "FIREWORKS_API_KEY",
          models: buildModels(freshBase, customModels, patches),
        });
      }
    });
  });
}
