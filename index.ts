/**
 * Fireworks Provider Extension
 *
 * Registers Fireworks as a custom provider using the openai-completions API.
 * Base URL: https://api.fireworks.ai/inference/v1
 *
 * Data flow:
 *   models.json       → auto-generated from Fireworks API (model discovery)
 *   patch.json        → manual overrides (pricing, reasoning, limits, etc.)
 *   custom-models.json → hidden/router models not in the API
 *
 * Merge order: models.json → apply patch.json → merge custom-models.json → transform to pi format
 *
 * Usage:
 *   # Set your API key
 *   export FIREWORKS_API_KEY=your-api-key
 *
 *   # Run pi with the extension
 *   pi -e /path/to/pi-fireworks-provider
 *
 * Then use /model to select from available models
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import regularModels from "./models.json" with { type: "json" };
import customModels from "./custom-models.json" with { type: "json" };
import patches from "./patch.json" with { type: "json" };

// Model data structure from JSON files
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

// Patch data structure (partial overrides keyed by model id)
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

// Pi's expected model structure
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

/**
 * Deep merge a patch into a model. Nested objects (cost, limit, modalities)
 * are merged field-by-field; scalar fields are replaced.
 */
function applyPatch(model: JsonModel, patch: PatchEntry): JsonModel {
  const result = { ...model };

  if (patch.name !== undefined) result.name = patch.name;
  if (patch.family !== undefined) result.family = patch.family;
  if (patch.reasoning !== undefined) result.reasoning = patch.reasoning;
  if (patch.interleaved !== undefined) result.interleaved = patch.interleaved;

  if (patch.modalities) {
    result.modalities = {
      ...result.modalities,
      ...patch.modalities,
    };
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

// Transform JSON model to Pi's expected format
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

// Build the model list: regular → patch → custom → transform
function buildModels(
  regular: JsonModel[],
  custom: JsonModel[],
  patchData: Record<string, PatchEntry>
): PiModel[] {
  const modelMap = new Map<string, JsonModel>();

  // 1. Add regular models (from API)
  for (const model of regular) {
    modelMap.set(model.id, model);
  }

  // 2. Apply patches (enrichment: pricing, reasoning, limits, etc.)
  for (const [id, patch] of Object.entries(patchData)) {
    const existing = modelMap.get(id);
    if (existing) {
      modelMap.set(id, applyPatch(existing, patch));
    }
    // If patch references a model not in models.json (e.g., router models),
    // it will be handled when custom models are merged below
  }

  // 3. Add/override with custom models (routers, hidden models)
  for (const model of custom) {
    const existing = modelMap.get(model.id);
    const patch = patchData[model.id];

    if (existing && patch) {
      // Custom model exists in regular + has a patch: apply patch to custom
      modelMap.set(model.id, applyPatch(model, patch));
    } else if (existing) {
      // Custom model exists in regular but no patch: use custom as-is
      // (custom takes precedence)
      modelMap.set(model.id, model);
    } else if (patch) {
      // Custom model not in regular, has patch: apply patch to custom
      modelMap.set(model.id, applyPatch(model, patch));
    } else {
      // Custom model not in regular, no patch: use as-is
      modelMap.set(model.id, model);
    }
  }

  // 4. Transform all models to Pi format
  return Array.from(modelMap.values()).map(transformModel);
}

const models = buildModels(
  regularModels as JsonModel[],
  customModels as JsonModel[],
  patches as Record<string, PatchEntry>
);

export default function (pi: ExtensionAPI) {
  pi.registerProvider("fireworks", {
    baseUrl: "https://api.fireworks.ai/inference/v1",
    apiKey: "FIREWORKS_API_KEY",
    api: "openai-completions",
    models,
  });
}
