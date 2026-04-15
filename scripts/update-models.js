#!/usr/bin/env node

/**
 * Script to update fireworks models from models.dev API
 * Updates models.json (regular models) and README.md
 * Custom models are maintained separately in custom-models.json
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_URL = 'https://models.dev/api.json';
const PROVIDER_ID = 'fireworks-ai';
const MODELS_PATH = path.join(process.cwd(), 'models.json');
const CUSTOM_MODELS_PATH = path.join(process.cwd(), 'custom-models.json');

// Fetch JSON from URL
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse JSON: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

// Load models from JSON file
function loadModels(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const data = fs.readFileSync(filePath, 'utf8');
    const models = JSON.parse(data);
    console.log(`✓ Loaded ${models.length} models from ${path.basename(filePath)}`);
    return models;
  } catch (error) {
    console.warn(`Warning: Could not load ${path.basename(filePath)}:`, error.message);
    return [];
  }
}

// Save models to JSON file
function saveModels(filePath, models) {
  fs.writeFileSync(filePath, JSON.stringify(models, null, 2) + '\n');
  console.log(`✓ Saved ${models.length} models to ${path.basename(filePath)}`);
}

// Find custom models that now exist in upstream (duplicates to remove)
function findDuplicateCustomModels(upstreamModels, customModels) {
  const upstreamIds = new Set(upstreamModels.map(m => m.id));
  return customModels.filter(model => upstreamIds.has(model.id));
}

// Remove duplicate models from custom-models.json
function removeDuplicateCustomModels(customModels, duplicates) {
  const duplicateIds = new Set(duplicates.map(m => m.id));
  return customModels.filter(model => !duplicateIds.has(model.id));
}

// Merge upstream and custom models (custom takes precedence on ID conflict)
function mergeModels(upstreamModels, customModels) {
  const modelMap = new Map();

  // Add upstream models first
  for (const model of upstreamModels) {
    modelMap.set(model.id, model);
  }

  // Add/override with custom models
  for (const model of customModels) {
    modelMap.set(model.id, model);
  }

  return Array.from(modelMap.values());
}

// Format cost for display (handles null/undefined)
function formatCost(cost) {
  if (cost === null || cost === undefined) return '-';
  if (cost === 0) return 'Free';
  return `$${cost.toFixed(2)}`;
}

// Format number with K/M suffix (handles null/undefined)
function formatNumber(num) {
  if (num === null || num === undefined) return '-';
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(0)}K`;
  return num.toString();
}

// Get input types from modalities
function getInputTypes(modalities) {
  const types = modalities?.input || ['text'];
  const hasImage = types.includes('image');
  const hasText = types.includes('text');

  if (hasImage && hasText) return 'Text + Image';
  if (hasImage) return 'Image';
  return 'Text';
}

// Generate README model table row
function generateReadmeRow(model) {
  const cost = model.cost || {};
  const limit = model.limit || {};

  return `| ${model.name} | ${getInputTypes(model.modalities)} | ${formatNumber(limit.context)} | ${formatNumber(limit.output)} | ${formatCost(cost.input)} | ${formatCost(cost.output)} |`;
}

// Update README model table
function updateReadme(models) {
  const readmePath = path.join(process.cwd(), 'README.md');
  let readme = fs.readFileSync(readmePath, 'utf8');

  // Sort models by family and name
  const sortedModels = [...models].sort((a, b) => {
    const familyA = a.family || '';
    const familyB = b.family || '';
    if (familyA !== familyB) return familyA.localeCompare(familyB);
    return a.name.localeCompare(b.name);
  });

  // Generate table rows
  const tableRows = sortedModels.map(generateReadmeRow).join('\n');
  const newTable = `| Model | Type | Context | Max Tokens | Input Cost | Output Cost |
|-------|------|---------|------------|------------|-------------|
${tableRows}`;

  // Replace table in README
  const tableRegex = /\| Model \| Type \| Context \| Max Tokens \| Input Cost \| Output Cost \|[\s\S]*?(?=\n\*Costs are per million)/;
  readme = readme.replace(tableRegex, newTable);

  // Update model count in features
  readme = readme.replace(/\*\*\d+\+ AI Models\*\*/, `**${models.length}+ AI Models**`);

  fs.writeFileSync(readmePath, readme);
  console.log(`✓ Updated README.md with ${models.length} models`);
}

async function main() {
  console.log('Fetching models from API...');

  try {
    const data = await fetchJSON(API_URL);
    const provider = data[PROVIDER_ID];

    if (!provider) {
      throw new Error(`Provider "${PROVIDER_ID}" not found in API`);
    }

    if (!provider.models) {
      throw new Error(`No models found for provider "${PROVIDER_ID}"`);
    }

    // Convert models object to array and filter out deprecated
    const upstreamModels = Object.values(provider.models).filter(m => m.status !== 'deprecated');
    console.log(`Found ${upstreamModels.length} upstream models from API`);

    // Normalize cost fields to ensure all fields are present (prevents NaN in pi cost calculations)
    for (const model of upstreamModels) {
      if (model.cost) {
        model.cost.input = model.cost.input ?? 0;
        model.cost.output = model.cost.output ?? 0;
        model.cost.cache_read = model.cost.cache_read ?? 0;
        model.cost.cache_write = model.cost.cache_write ?? 0;
      }
    }

    // Load existing custom models
    const customModels = loadModels(CUSTOM_MODELS_PATH);

    // Normalize cost fields in custom models too
    for (const model of customModels) {
      if (model.cost) {
        model.cost.input = model.cost.input ?? 0;
        model.cost.output = model.cost.output ?? 0;
        model.cost.cache_read = model.cost.cache_read ?? 0;
        model.cost.cache_write = model.cost.cache_write ?? 0;
      }
    }

    // Find and remove duplicates from custom-models.json
    const duplicates = findDuplicateCustomModels(upstreamModels, customModels);
    if (duplicates.length > 0) {
      console.log(`Found ${duplicates.length} custom model(s) now available upstream:`);
      for (const dup of duplicates) {
        console.log(`  - ${dup.id} (${dup.name})`);
      }
      
      const cleanedCustomModels = removeDuplicateCustomModels(customModels, duplicates);
      saveModels(CUSTOM_MODELS_PATH, cleanedCustomModels);
      console.log(`✓ Removed ${duplicates.length} duplicate(s) from custom-models.json`);
      
      // Use cleaned list for further processing
      customModels.length = 0;
      customModels.push(...cleanedCustomModels);
    }

    // Save upstream models to models.json (regular models)
    saveModels(MODELS_PATH, upstreamModels);

    // Merge for README update
    const allModels = mergeModels(upstreamModels, customModels);
    console.log(`Total: ${allModels.length} models (${upstreamModels.length} regular + ${customModels.length} custom, ${allModels.length - upstreamModels.length} custom overrides)`);

    // Update README with merged models
    updateReadme(allModels);

    console.log('\nDone!');
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
