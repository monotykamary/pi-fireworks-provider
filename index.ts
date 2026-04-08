/**
 * Fireworks Provider Extension
 *
 * Registers Fireworks as a custom provider using the openai-completions API.
 * Base URL: https://api.fireworks.ai/inference/v1
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

// Model data structure from JSON files
interface JsonModel {
  id: string;
  name: string;
  reasoning: boolean;
  modalities: {
    input: string[];
  };
  cost: {
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

// Transform JSON model to Pi's expected format
function transformModel(model: JsonModel): PiModel {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: model.modalities.input,
    cost: {
      input: model.cost.input,
      output: model.cost.output,
      cacheRead: model.cost.cache_read,
      cacheWrite: model.cost.cache_write,
    },
    contextWindow: model.limit.context ?? 0,
    maxTokens: model.limit.output ?? 0,
  };
}

// Merge regular and custom models (custom takes precedence on ID conflict)
function mergeModels(regular: JsonModel[], custom: JsonModel[]): PiModel[] {
  const modelMap = new Map<string, JsonModel>();

  // Add regular models first
  for (const model of regular) {
    modelMap.set(model.id, model);
  }

  // Add/override with custom models
  for (const model of custom) {
    modelMap.set(model.id, model);
  }

  // Transform all models to Pi format
  return Array.from(modelMap.values()).map(transformModel);
}

const models = mergeModels(
  regularModels as JsonModel[],
  customModels as JsonModel[]
);

export default function (pi: ExtensionAPI) {
  pi.registerProvider("fireworks", {
    baseUrl: "https://api.fireworks.ai/inference/v1",
    apiKey: "FIREWORKS_API_KEY",
    api: "openai-completions",
    models,
  });
}
