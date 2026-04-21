#!/usr/bin/env node

/**
 * Script to update fireworks models from the Fireworks API
 *
 * Uses the official Fireworks Gateway REST API to discover available models:
 *   GET /v1/accounts/fireworks/models
 *
 * Requires FIREWORKS_API_KEY environment variable.
 * Usage: FIREWORKS_API_KEY=your-key node scripts/update-models.js
 *
 * The API provides: id, displayName, contextLength, supportsImageInput,
 * supportsTools, supportsServerless, state, kind, moe, parameterCount, etc.
 *
 * It does NOT provide: pricing, max output tokens, reasoning mode, or
 * interleaved thinking details. Those are preserved from the existing
 * models.json (enriched data). New models from the API that aren't in
 * models.json get stub entries with reasonable defaults.
 *
 * Custom models are maintained separately in custom-models.json.
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIREWORKS_API_BASE = 'https://api.fireworks.ai';
const ACCOUNT_ID = 'fireworks';
const MODELS_PATH = path.join(process.cwd(), 'models.json');
const CUSTOM_MODELS_PATH = path.join(process.cwd(), 'custom-models.json');

// ─── HTTP helpers ───────────────────────────────────────────────────────────

function fetchJSON(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse JSON from ${url}: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
  });
}

/**
 * Paginate through the Fireworks account models API.
 * Returns all models across all pages.
 */
async function fetchAllFireworksModels(apiKey) {
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const allModels = [];
  let pageToken = undefined;
  let page = 0;

  do {
    let url = `${FIREWORKS_API_BASE}/v1/accounts/${ACCOUNT_ID}/models?pageSize=200`;
    if (pageToken) url += `&pageToken=${pageToken}`;

    const data = await fetchJSON(url, headers);
    const models = data.models || [];
    allModels.push(...models);

    pageToken = data.nextPageToken || undefined;
    page++;
    console.log(`  Page ${page}: fetched ${models.length} models (total so far: ${allModels.length})`);
  } while (pageToken);

  return allModels;
}

// ─── File I/O ───────────────────────────────────────────────────────────────

function loadJSON(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const data = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(data);
    console.log(`✓ Loaded ${parsed.length} models from ${path.basename(filePath)}`);
    return parsed;
  } catch (e) {
    console.warn(`Warning: Could not load ${path.basename(filePath)}: ${e.message}`);
    return [];
  }
}

function saveJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  console.log(`✓ Saved ${data.length} models to ${path.basename(filePath)}`);
}

// ─── Model filtering & mapping ──────────────────────────────────────────────

/**
 * Filter: only serverless chat-capable LLM base models that are READY.
 *
 * We only include models that are serverless (pay-per-token) because those
 * are the ones relevant for the pi provider. Non-serverless models can only
 * be used via on-demand deployments, which isn't what this provider targets.
 *
 * Exceptions: models present in the existing models.json are kept even if
 * they lose serverless status (they may still work via routers/firepass).
 */
function isRelevantModel(m, existingIds = new Set()) {
  const kind = m.kind || '';
  // Only HuggingFace base models
  if (kind !== 'HF_BASE_MODEL') return false;
  // Must be READY
  if (m.state !== 'READY') return false;
  // Must have a context length
  if (!m.contextLength || m.contextLength === 0) return false;
  // Must be serverless, OR already exist in our curated list
  if (!m.supportsServerless && !existingIds.has(m.name)) return false;
  return true;
}

/**
 * Build a display name from the API displayName, falling back to the model id.
 */
function buildDisplayName(m) {
  let name = m.displayName || m.name || '';
  // If displayName is just the raw model id suffix, clean it up
  if (!name || name === m.name) {
    name = m.name.split('/').pop() || m.name;
  }
  return name;
}

/**
 * Determine the model "family" from the model id.
 * This is used for grouping in the README table.
 */
function inferFamily(modelId) {
  if (modelId.includes('kimi')) return 'kimi-thinking';
  if (modelId.includes('deepseek')) return 'deepseek';
  if (modelId.includes('glm')) return 'glm';
  if (modelId.includes('minimax')) return 'minimax';
  if (modelId.includes('gpt-oss')) return 'gpt-oss';
  if (modelId.includes('qwen')) return 'qwen';
  if (modelId.includes('gemma')) return 'gemma';
  return 'other';
}

/**
 * Determine if a model likely supports reasoning (interleaved thinking).
 * This is a heuristic based on known model families. The API doesn't expose
 * this directly, so we rely on the enriched data from models.json.
 */
function inferReasoning(modelId) {
  // Most recent MoE models on Fireworks support reasoning via reasoning_content
  const reasoningFamilies = ['kimi-k2', 'kimi-thinking', 'deepseek', 'glm', 'minimax', 'gpt-oss'];
  const family = inferFamily(modelId);
  return reasoningFamilies.includes(family);
}

/**
 * Convert a Fireworks API model to our models.json format.
 * Merges with existing enriched data if available.
 */
function convertModel(apiModel, enriched = {}) {
  const id = apiModel.name;
  const name = buildDisplayName(apiModel);
  const input = ['text'];
  if (apiModel.supportsImageInput) input.push('image');

  return {
    id,
    name: enriched.name || name,
    family: enriched.family || inferFamily(id),
    attachment: enriched.attachment ?? false,
    reasoning: enriched.reasoning ?? inferReasoning(id),
    tool_call: enriched.tool_call ?? apiModel.supportsTools ?? false,
    ...(enriched.interleaved ? { interleaved: enriched.interleaved } : {}),
    temperature: enriched.temperature ?? true,
    ...(enriched.knowledge ? { knowledge: enriched.knowledge } : {}),
    ...(enriched.release_date ? { release_date: enriched.release_date } : {}),
    ...(enriched.last_updated ? { last_updated: enriched.last_updated } : {}),
    modalities: {
      input,
      output: enriched.modalities?.output || ['text'],
    },
    open_weights: enriched.open_weights ?? true,
    cost: {
      input: enriched.cost?.input ?? 0,
      output: enriched.cost?.output ?? 0,
      cache_read: enriched.cost?.cache_read ?? 0,
      cache_write: enriched.cost?.cache_write ?? 0,
    },
    limit: {
      context: enriched.limit?.context || apiModel.contextLength || 0,
      output: enriched.limit?.output ?? null,
    },
  };
}

// ─── README generation ──────────────────────────────────────────────────────

function formatCost(cost) {
  if (cost === null || cost === undefined) return '-';
  if (cost === 0) return 'Free';
  return `$${cost.toFixed(2)}`;
}

function formatNumber(num) {
  if (num === null || num === undefined) return '-';
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(0)}K`;
  return num.toString();
}

function getInputTypes(modalities) {
  const types = modalities?.input || ['text'];
  const hasImage = types.includes('image');
  const hasText = types.includes('text');
  if (hasImage && hasText) return 'Text + Image';
  if (hasImage) return 'Image';
  return 'Text';
}

function generateReadmeRow(model) {
  const cost = model.cost || {};
  const limit = model.limit || {};
  return `| ${model.name} | ${getInputTypes(model.modalities)} | ${formatNumber(limit.context)} | ${formatNumber(limit.output)} | ${formatCost(cost.input)} | ${formatCost(cost.output)} |`;
}

function updateReadme(models) {
  const readmePath = path.join(process.cwd(), 'README.md');
  let readme = fs.readFileSync(readmePath, 'utf8');

  const sortedModels = [...models].sort((a, b) => {
    const familyA = a.family || '';
    const familyB = b.family || '';
    if (familyA !== familyB) return familyA.localeCompare(familyB);
    return a.name.localeCompare(b.name);
  });

  const tableRows = sortedModels.map(generateReadmeRow).join('\n');
  const newTable = `| Model | Type | Context | Max Tokens | Input Cost | Output Cost |
|-------|------|---------|------------|------------|-------------|
${tableRows}`;

  const tableRegex = /\| Model \| Type \| Context \| Max Tokens \| Input Cost \| Output Cost \|[\s\S]*?(?=\n\*Costs are per million)/;
  readme = readme.replace(tableRegex, newTable);

  readme = readme.replace(/\*\*\d+\+ AI Models\*\*/, `**${models.length}+ AI Models**`);

  fs.writeFileSync(readmePath, readme);
  console.log(`✓ Updated README.md with ${models.length} models`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.FIREWORKS_API_KEY;
  if (!apiKey) {
    console.error('Error: FIREWORKS_API_KEY environment variable is required');
    console.error('Usage: FIREWORKS_API_KEY=your-key node scripts/update-models.js');
    process.exit(1);
  }

  console.log('Fetching models from Fireworks API...\n');

  try {
    // 1. Fetch all models from Fireworks API
    const apiModels = await fetchAllFireworksModels(apiKey);
    console.log(`\nTotal models from API: ${apiModels.length}`);

    // 2. Load existing enriched data from models.json
    const existingModels = loadJSON(MODELS_PATH);
    const enrichedMap = new Map(existingModels.map((m) => [m.id, m]));
    const existingIds = new Set(existingModels.map((m) => m.id));

    // 3. Filter to relevant LLMs (serverless + previously curated)
    const relevantApiModels = apiModels.filter((m) => isRelevantModel(m, existingIds));
    console.log(`Relevant LLM models: ${relevantApiModels.length}`);

    // 4. Convert API models, merging with enriched data
    const newModels = relevantApiModels
      .map((apiModel) => {
        const enriched = enrichedMap.get(apiModel.name) || {};
        return convertModel(apiModel, enriched);
      })
      .filter(Boolean);

    // Log new models (not in existing enriched data)
    for (const m of newModels) {
      if (!enrichedMap.has(m.id)) {
        console.log(`  🆕 New model: ${m.id} (${m.name}) — needs pricing/output limits`);
      }
    }

    // Preserve previously curated models that aren't in the API
    // (e.g., router models, non-serverless models still available via firepass)
    const apiIds = new Set(relevantApiModels.map((m) => m.name));
    const preservedModels = [];
    for (const existing of existingModels) {
      if (!apiIds.has(existing.id)) {
        console.log(`  ⚠️  Not in API, preserving: ${existing.id} (${existing.name})`);
        preservedModels.push(existing);
      }
    }

    const allUpstreamModels = [...newModels, ...preservedModels];

    // 5. Save upstream models (API-discovered + preserved)
    saveJSON(MODELS_PATH, allUpstreamModels);

    // 6. Load and process custom models
    const customModels = loadJSON(CUSTOM_MODELS_PATH);

    // Normalize cost fields in custom models
    for (const model of customModels) {
      if (model.cost) {
        model.cost.input = model.cost.input ?? 0;
        model.cost.output = model.cost.output ?? 0;
        model.cost.cache_read = model.cost.cache_read ?? 0;
        model.cost.cache_write = model.cost.cache_write ?? 0;
      }
    }

    // Find custom models that now appear in upstream (remove from custom)
    const upstreamIds = new Set(newModels.map((m) => m.id));
    const duplicates = customModels.filter((m) => upstreamIds.has(m.id));
    if (duplicates.length > 0) {
      console.log(`\nFound ${duplicates.length} custom model(s) now available upstream:`);
      for (const dup of duplicates) {
        console.log(`  - ${dup.id} (${dup.name})`);
      }
      const cleaned = customModels.filter((m) => !upstreamIds.has(m.id));
      saveJSON(CUSTOM_MODELS_PATH, cleaned);
      console.log(`✓ Removed ${duplicates.length} duplicate(s) from custom-models.json`);
      customModels.length = 0;
      customModels.push(...cleaned);
    }

    // 7. Merge for README
    const mergedMap = new Map();
    for (const m of newModels) mergedMap.set(m.id, m);
    for (const m of customModels) mergedMap.set(m.id, m);
    const allModels = Array.from(mergedMap.values());

    console.log(
      `\nTotal: ${allModels.length} models (${allUpstreamModels.length} upstream + ${customModels.length} custom)`
    );

    // 8. Update README
    updateReadme(allModels);

    console.log('\nDone!');
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
