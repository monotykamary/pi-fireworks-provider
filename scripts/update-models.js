#!/usr/bin/env node

/**
 * Script to update fireworks models from the Fireworks API
 *
 * Uses the official Fireworks Gateway REST API to discover available models:
 *   GET /v1/accounts/fireworks/models
 *
 * API key: the stored `fireworks` credential in ~/.pi/agent/auth.json wins, then
 * the FIREWORKS_API_KEY environment variable. The script refuses to run without one.
 * Usage: FIREWORKS_API_KEY=your-key node scripts/update-models.js
 *
 * Data flow:
 *   models.json       → auto-generated from Fireworks API (model discovery)
 *   patch.json        → manual overrides (pricing, reasoning, limits, etc.)
 *   custom-models.json → hidden/router models not in the API
 *
 * The API provides: id, displayName, contextLength, supportsImageInput,
 * supportsTools, supportsServerless, state, kind, moe, parameterCount, etc.
 *
 * It does NOT provide: pricing, max output tokens, reasoning mode, or
 * interleaved thinking details. Those come from patch.json.
 *
 * Merge order for README: models.json → apply patch.json → merge custom-models.json
 */

import https from 'https';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// pi's agent directory: PI_CODING_AGENT_DIR (with ~ expansion) or ~/.pi/agent.
function piAgentDir() {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) {
    return envDir.startsWith('~/') || envDir === '~'
      ? path.join(os.homedir(), envDir.slice(1))
      : envDir;
  }
  return path.join(os.homedir(), '.pi', 'agent');
}

const AUTH_JSON_PATH = path.join(piAgentDir(), 'auth.json');

/**
 * Resolve a configured value using pi's semantics (resolve-config-value.ts in
 * pi-mono): "!command" runs via the shell (10s timeout) and uses trimmed
 * stdout; "$VAR" / "${VAR}" interpolate environment variables ("$$" escapes a
 * literal "$", "$!" a literal "!"); anything else is a literal. Returns
 * undefined when a referenced env var is unset or a command fails.
 */
function resolveConfigValue(config, env) {
  if (typeof config !== 'string' || config.length === 0) return undefined;
  if (config.startsWith('!')) {
    try {
      const out = execSync(config.slice(1), {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return out.trim() || undefined;
    } catch {
      return undefined;
    }
  }
  const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  let resolved = '';
  let index = 0;
  while (index < config.length) {
    const dollar = config.indexOf('$', index);
    if (dollar < 0) {
      resolved += config.slice(index);
      break;
    }
    resolved += config.slice(index, dollar);
    const next = config[dollar + 1];
    let name;
    if (next === '$' || next === '!') {
      resolved += next;
      index = dollar + 2;
      continue;
    } else if (next === '{') {
      const end = config.indexOf('}', dollar + 2);
      if (end < 0) {
        resolved += '$';
        index = dollar + 1;
        continue;
      }
      const inner = config.slice(dollar + 2, end);
      if (!ENV_NAME_RE.test(inner)) {
        resolved += config.slice(dollar, end + 1);
        index = end + 1;
        continue;
      }
      name = inner;
      index = end + 1;
    } else {
      const match = config.slice(dollar + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      if (!match) {
        resolved += '$';
        index = dollar + 1;
        continue;
      }
      name = match[0];
      index = dollar + 1 + name.length;
    }
    const value = (env && env[name]) || process.env[name] || undefined;
    if (value === undefined) return undefined;
    resolved += value;
  }
  return resolved;
}

/**
 * The API key, resolved the way pi itself resolves it for this provider: the
 * stored `fireworks` credential in ~/.pi/agent/auth.json wins, then
 * the FIREWORKS_API_KEY environment variable.
 */
function resolveApiKey() {
  try {
    const auth = JSON.parse(fs.readFileSync(AUTH_JSON_PATH, 'utf8'));
    const credential = auth?.fireworks;
    if (credential && credential.type === 'api_key' && typeof credential.key === 'string') {
      const key = resolveConfigValue(credential.key, credential.env);
      if (key) return key;
    }
  } catch {
    // Missing or unparseable auth.json: fall through to the env var.
  }
  return process.env.FIREWORKS_API_KEY || undefined;
}

const FIREWORKS_API_BASE = 'https://api.fireworks.ai';
const ACCOUNT_ID = 'fireworks';
const MODELS_PATH = path.join(process.cwd(), 'models.json');
const CUSTOM_MODELS_PATH = path.join(process.cwd(), 'custom-models.json');
const PATCH_PATH = path.join(process.cwd(), 'patch.json');

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
    console.log(`✓ Loaded ${Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length} entries from ${path.basename(filePath)}`);
    return parsed;
  } catch (e) {
    console.warn(`Warning: Could not load ${path.basename(filePath)}: ${e.message}`);
    return {};
  }
}

function saveJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  const count = Array.isArray(data) ? data.length : Object.keys(data).length;
  console.log(`✓ Saved ${count} entries to ${path.basename(filePath)}`);
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
  if (!name || name === m.name) {
    name = m.name.split('/').pop() || m.name;
  }
  return name;
}

/**
 * Convert a Fireworks API model to Pi-native models.json format.
 * Only includes data the API provides — no pricing, reasoning, or output limits.
 * Those come from patch.json.
 */
function convertModel(apiModel) {
  const id = apiModel.name;
  const name = buildDisplayName(apiModel);
  const input = ['text'];
  if (apiModel.supportsImageInput) input.push('image');

  return {
    id,
    name,
    reasoning: false,
    input,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: apiModel.contextLength || 0,
    maxTokens: 0,
  };
}

/**
 * Deep merge a patch into a model. Nested objects (cost) are merged
 * field-by-field; scalar fields are replaced.
 */
function applyPatch(model, patch) {
  const result = { ...model };

  if (patch.name !== undefined) result.name = patch.name;
  if (patch.family !== undefined) result.family = patch.family;
  if (patch.reasoning !== undefined) result.reasoning = patch.reasoning;
  if (patch.interleaved !== undefined) result.interleaved = patch.interleaved;

  if (patch.input !== undefined) result.input = patch.input;
  if (patch.contextWindow !== undefined) result.contextWindow = patch.contextWindow;
  if (patch.maxTokens !== undefined) result.maxTokens = patch.maxTokens;

  if (patch.cost) {
    result.cost = {
      input: patch.cost.input ?? result.cost?.input ?? 0,
      output: patch.cost.output ?? result.cost?.output ?? 0,
      cacheRead: patch.cost.cacheRead ?? result.cost?.cacheRead ?? 0,
      cacheWrite: patch.cost.cacheWrite ?? result.cost?.cacheWrite ?? 0,
    };
  }

  return result;
}

// ─── README generation ──────────────────────────────────────────────────────

function formatCost(cost) {
  if (cost === 0) return '—';
  if (cost === null || cost === undefined) return '—';
  return '$' + cost.toFixed(2);
}

function formatNumber(num) {
  if (num === null || num === undefined) return '-';
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(0)}K`;
  return num.toString();
}

function getInputTypes(inputTypes) {
  const types = inputTypes || ['text'];
  const hasImage = types.includes('image');
  const hasText = types.includes('text');
  if (hasImage && hasText) return 'Text + Image';
  if (hasImage) return 'Image';
  return 'Text';
}

function generateReadmeRow(model) {
  const cost = model.cost || {};
  return `| ${model.name} | ${getInputTypes(model.input)} | ${formatNumber(model.contextWindow)} | ${formatNumber(model.maxTokens)} | ${formatCost(cost.input)} | ${formatCost(cost.output)} |`;
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

// Grace period for delisted models: update-models.js moves models the API no
// longer lists into deprecated-models.json (stamped with deprecatedAt) instead
// of dropping them; the runtime appends them back so sessions and saved model
// settings keep working, and after 14 days they are evicted permanently.
const DEPRECATED_MODEL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Reconcile deprecated-models.json against the freshly fetched model list.
 * - in old models.json but not the API: moved into the deprecated file
 *   (deprecatedAt = now; preserved on repeat runs so the grace clock is not reset)
 * - back in the API: resurrected (dropped from the deprecated file)
 * - deprecatedAt older than 14 days: evicted permanently
 * Must run BEFORE the new models.json is written; it reads the old file itself.
 */
function updateDeprecatedModels(modelsJsonPath, newModels) {
  const deprecatedPath = path.join(path.dirname(modelsJsonPath), 'deprecated-models.json');

  let oldModels = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(modelsJsonPath, 'utf8'));
    if (Array.isArray(parsed)) oldModels = parsed;
  } catch { /* first run: no previous models.json */ }

  let deprecated = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(deprecatedPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) deprecated = parsed;
  } catch { /* no graveyard yet */ }

  const currentIds = new Set(newModels.map(m => m.id));
  const now = new Date().toISOString();
  const added = [];
  const resurrected = [];
  const evicted = [];

  for (const old of oldModels) {
    if (old && old.id && !currentIds.has(old.id) && !deprecated[old.id]) {
      deprecated[old.id] = { ...old, deprecatedAt: now };
      added.push(old.id);
    }
  }

  for (const [id, entry] of Object.entries(deprecated)) {
    if (currentIds.has(id)) {
      delete deprecated[id];
      resurrected.push(id);
      continue;
    }
    const removedAt = Date.parse(entry && entry.deprecatedAt ? entry.deprecatedAt : '');
    if (Number.isNaN(removedAt) || Date.now() - removedAt > DEPRECATED_MODEL_TTL_MS) {
      delete deprecated[id];
      evicted.push(id);
    }
  }

  if (added.length > 0 || resurrected.length > 0 || evicted.length > 0) {
    fs.writeFileSync(deprecatedPath, JSON.stringify(deprecated, null, 2) + '\n');
    console.log('Updated deprecated-models.json ' + JSON.stringify({ added, resurrected, evicted }));
  }
}

/**
 * Grace-period deprecated models (deprecatedAt within TTL) with metadata stripped.
 * Keeps the README table serving models that are delisted but still within their
 * 14-day grace window.
 */
function withDeprecatedForReadme(models) {
  const deprecatedPath = path.join(path.dirname(MODELS_PATH), 'deprecated-models.json');
  let deprecated = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(deprecatedPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) deprecated = parsed;
  } catch { /* no graveyard yet */ }
  const now = Date.now();
  const seen = new Set(models.map(m => m.id));
  const extras = [];
  for (const entry of Object.values(deprecated)) {
    if (!entry || !entry.id || seen.has(entry.id)) continue;
    const removedAt = Date.parse(entry.deprecatedAt || '');
    if (Number.isNaN(removedAt) || now - removedAt > DEPRECATED_MODEL_TTL_MS) continue;
    const m = { ...entry };
    delete m.deprecatedAt;
    extras.push(m);
  }
  return extras.length > 0 ? [...models, ...extras] : models;
}
async function main() {
  // `--offline` skips the API entirely and regenerates the README from the
  // already-committed models.json + patch.json + custom-models.json. Useful for
  // cost/metadata corrections when no API key is available; it never rewrites
  // models.json or deprecated-models.json.
  const offline = process.argv.includes('--offline');
  let allUpstreamModels;

  try {
    if (offline) {
      allUpstreamModels = Array.isArray(loadJSON(MODELS_PATH)) ? loadJSON(MODELS_PATH) : [];
      if (allUpstreamModels.length === 0) {
        throw new Error('--offline requires an existing models.json (nothing to render)');
      }
      console.log(`Offline mode: rendering README from ${allUpstreamModels.length} committed models (no API fetch)\n`);
    } else {
      const apiKey = resolveApiKey();
      if (!apiKey) {
        console.error('Error: No API key found: no `fireworks` credential resolved from ' + AUTH_JSON_PATH + ' and FIREWORKS_API_KEY is not set');
        console.error('Usage: FIREWORKS_API_KEY=your-key node scripts/update-models.js');
        console.error('       node scripts/update-models.js --offline   # regenerate README only, no key needed');
        process.exit(1);
      }

      console.log('Fetching models from Fireworks API...\n');

      // 1. Fetch all models from Fireworks API
      const apiModels = await fetchAllFireworksModels(apiKey);
      console.log(`\nTotal models from API: ${apiModels.length}`);
      if (apiModels.length === 0) {
        throw new Error('Fireworks account model API returned zero models; refusing to archive the entire catalog');
      }

      // 2. Load existing models.json for filtering/deprecation
      const existingModels = Array.isArray(loadJSON(MODELS_PATH)) ? loadJSON(MODELS_PATH) : [];
      const existingIds = new Set(existingModels.map((m) => m.id));

      // 3. Filter to relevant LLMs (serverless + previously curated)
      const relevantApiModels = apiModels.filter((m) => isRelevantModel(m, existingIds));
      console.log(`Relevant LLM models: ${relevantApiModels.length}`);

      // 4. Convert API models to models.json format (no pricing — that comes from patch.json)
      const newModels = relevantApiModels.map((apiModel) => convertModel(apiModel));

      // Live API is authoritative — models absent from API are removed
      allUpstreamModels = [...newModels];

      // 5. Save upstream models (API-derived, no pricing)
      // Move delisted models to deprecated-models.json BEFORE models.json is overwritten
      updateDeprecatedModels(MODELS_PATH, allUpstreamModels);
      saveJSON(MODELS_PATH, allUpstreamModels);
    }

    // 6. Load patch + custom models and surface any upstream model still unpatched
    const patchData = loadJSON(PATCH_PATH);
    for (const m of allUpstreamModels) {
      if (!patchData[m.id]) {
        console.log(`  🆕 New model: ${m.id} (${m.name}) — add to patch.json for pricing/output limits`);
      }
    }
    const customModels = Array.isArray(loadJSON(CUSTOM_MODELS_PATH)) ? loadJSON(CUSTOM_MODELS_PATH) : [];

    // Find custom models that now appear in upstream (remove from custom).
    // Skipped offline: without a fresh API list, upstream == the committed
    // models.json, so this would delete intentional custom duplicates.
    if (!offline) {
      const upstreamIds = new Set(allUpstreamModels.map((m) => m.id));
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
    }

    // 7. Build merged models with patches applied (for README)
    const mergedMap = new Map();

    // Start with upstream models
    for (const m of allUpstreamModels) mergedMap.set(m.id, m);

    // Apply patches (enrichment: pricing, reasoning, limits, etc.)
    for (const [id, patch] of Object.entries(patchData)) {
      const existing = mergedMap.get(id);
      if (existing) {
        mergedMap.set(id, applyPatch(existing, patch));
      }
    }

    // Add/override with custom models, also applying their patches
    for (const m of customModels) {
      const patch = patchData[m.id];
      mergedMap.set(m.id, patch ? applyPatch(m, patch) : m);
    }

    const allModels = withDeprecatedForReadme(Array.from(mergedMap.values()));

    console.log(
      `\nTotal: ${allModels.length} models (${allUpstreamModels.length} upstream + ${customModels.length} custom, ${Object.keys(patchData).length} patches)`
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
