<div align="center">

# 🎆 pi-fireworks-provider

**31+ models through [Fireworks AI](https://fireworks.ai/)**

_Kimi, MiniMax, GLM, DeepSeek, GPT-OSS — via Fireworks AI's Anthropic Messages and OpenAI-compatible endpoints for [pi](https://github.com/earendil-works/pi-coding-agent)._

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

## Features

- **35+ AI Models** including Kimi K2.5, MiniMax M2.5, GLM 4.5/4.7/5, DeepSeek V3.1/V3.2, DeepSeek V4 Flash, and GPT-OSS
- **Dual API support** via Fireworks AI's Anthropic Messages and OpenAI-compatible completions endpoints (per-model routing, matching pi core's Fireworks provider)
- **Service tiers** — toggle Fireworks `priority` vs `standard` per request on supported models (with priority pricing reflected in cost tracking), via a keybinding, `/fireworks-tier`, and a footer status area
- **Preserved thinking** — toggle Fireworks' `reasoning_history: "preserved"` so prior assistant reasoning is retained across turns (better multi-turn recall; uses more tokens), via the `/fireworks-settings` panel, with a model-select notification. Matches neuralwatt/makora's settings-only UX, adapted to Fireworks' single global `reasoning_history` knob
- **Settings panel** — `/fireworks-settings` (TUI) to configure preserved thinking, service tier, and display preferences; persisted to `~/.pi/agent/extensions/fireworks.json`
- **Cost Tracking** with per-model pricing for budget management
- **Reasoning Models** support for advanced reasoning capabilities
- **Vision Support** for image-capable models

## Installation

### Option 1: Using `pi install` (Recommended)

Install directly from GitHub:

```bash
pi install https://github.com/monotykamary/pi-fireworks-provider
```

Then set your API key and run pi:
```bash
# Recommended: add to auth.json
# See Authentication section below

# Or set as environment variable
export FIREWORKS_API_KEY=your-api-key-here

pi
```

### Option 2: Manual Clone

1. Clone this repository:
   ```bash
   git clone https://github.com/monotykamary/pi-fireworks-provider.git
   cd pi-fireworks-provider
   ```

2. Set your Fireworks API key:
   ```bash
   # Recommended: add to auth.json
   # See Authentication section below

   # Or set as environment variable
   export FIREWORKS_API_KEY=your-api-key-here
   ```

3. Run pi with the extension:
   ```bash
   pi -e /path/to/pi-fireworks-provider
   ```

## Available Models

| Model | Type | Context | Max Tokens | Input Cost | Output Cost |
|-------|------|---------|------------|------------|-------------|
| DeepSeek V3.1 | Text | 164K | 164K | $0.56 | $1.68 |
| DeepSeek V3.2 | Text | 164K | 160K | $0.56 | $1.68 |
| DeepSeek V4 Flash | Text | 1.0M | 1.0M | $0.14 | $0.28 |
| DeepSeek V4 Pro | Text | 1.0M | 1.0M | Free | Free |
| DeepSeek V4 Pro (router) | Text | 1.0M | 1.0M | $1.74 | $3.48 |
| Gemma 4 26B A4B IT | Text + Image | 262K | 0 | Free | Free |
| Gemma 4 31B IT | Text + Image | 262K | 0 | Free | Free |
| GLM 4.5 | Text | 131K | 131K | $0.55 | $2.19 |
| GLM 4.5 Air | Text | 131K | 131K | $0.22 | $0.88 |
| GLM 4.7 | Text | 203K | 198K | $0.60 | $2.20 |
| GLM 5 | Text | 203K | 131K | $1.00 | $3.20 |
| GLM 5 Fast (router) | Text | 203K | 131K | $1.00 | $3.20 |
| GLM 5.1 | Text | 203K | 131K | $1.40 | $4.40 |
| GLM 5.1 Fast (router) | Text | 203K | 131K | $1.40 | $4.40 |
| GLM 5.2 | Text | 1.0M | 0 | Free | Free |
| GPT OSS 120B | Text | 131K | 33K | $0.15 | $0.60 |
| GPT OSS 20B | Text | 131K | 33K | $0.05 | $0.20 |
| Kimi K2 Instruct | Text | 131K | 16K | $1.00 | $3.00 |
| Kimi K2 Thinking | Text | 262K | 256K | $0.60 | $2.50 |
| Kimi K2.5 | Text + Image | 262K | 256K | $0.60 | $3.00 |
| Kimi K2.5 Fast (router) | Text + Image | 262K | 256K | $0.60 | $3.00 |
| Kimi K2.6 | Text + Image | 262K | 262K | $0.95 | $4.00 |
| Kimi K2.6 (router) | Text + Image | 262K | 262K | $0.95 | $4.00 |
| Kimi K2.6 Turbo (router) | Text + Image | 262K | 262K | $0.95 | $4.00 |
| Kimi K2.7 Code | Text + Image | 262K | 0 | Free | Free |
| Llama 3.3 70B Instruct | Text | 131K | 0 | Free | Free |
| MiniMax M2.7 (router) | Text | 204K | 0 | $0.30 | $1.20 |
| Minimax M3 | Text + Image | 512K | 0 | Free | Free |
| MiniMax-M2.1 | Text | 197K | 200K | $0.30 | $1.20 |
| MiniMax-M2.5 | Text | 197K | 197K | $0.30 | $1.20 |
| MiniMax-M2.7 | Text | 197K | 197K | $0.30 | $1.20 |
| NVIDIA Nemotron 3 Ultra NVFP4 | Text | 262K | 0 | Free | Free |
| Qwen3 8B | Text | 41K | 0 | Free | Free |
| Qwen3 VL 30B A3B Instruct | Text + Image | 262K | 0 | Free | Free |
| Qwen3 VL 30B A3B Thinking | Text + Image | 262K | 0 | Free | Free |
*Costs are per million tokens. Prices subject to change - check [fireworks.ai](https://fireworks.ai) for current pricing.*

## Service Tiers

Fireworks exposes a `service_tier` request field (`standard` | `priority`) on its chat-completions endpoint. The **priority** tier trades higher per-token pricing for higher throughput / lower latency. This is orthogonal to the `-fast`/`-turbo` router model IDs (which are separate models) — service tiers apply to the base models below.

| Model | Priority Uncached Input | Priority Cached Input | Priority Output |
| --- | --- | --- | --- |
| GLM 5.2 | $1.75/M | $0.175/M | $5.5/M |
| Kimi K2.7 Code | $1.43/M | $0.29/M | $6/M |
| Minimax M3 | $0.45/M | $0.09/M | $1.8/M |
| DeepSeek V4 Pro | $2.61/M | $0.218/M | $5.22/M |
| Kimi K2.6 | $1.5/M | $0.22/M | $6/M |
| MiniMax M2.7 | $0.45/M | $0.09/M | $1.8/M |
| GLM 5.1 | $2.1/M | $0.39/M | $6.6/M |
| GPT OSS 120B | $0.18/M | $0.018/M | $0.72/M |
| DeepSeek V4 Flash | $0.21/M | $0.045/M | $0.42/M |

*Priority pricing is roughly 1.2–1.5× the standard rate. `cacheWrite` is not tiered.*

**Switching tiers:**

- **Keybinding:** `ctrl+shift+l` (default) toggles `standard` ↔ `priority` for the active supported model. No-op with an info notice for unsupported models.
- **Command:** `/fireworks-tier standard|priority|toggle`.
- **Status area:** a dim `tier: standard` / `tier: ⚡priority` line is shown in the footer for supported models while a Fireworks model is active.

The selection is persisted per session (survives `/reload` and resume). When `priority` is active, `service_tier: "priority"` is injected into every request and finalized cost is recomputed against the priority rates above.

**Configuration** — `~/.pi/agent/extensions/fireworks.json` (created with defaults on first load):

```json
{
  "serviceTier": {
    "default": "standard",
    "keybinding": "ctrl+shift+l",
    "display": "statusbar"
  },
  "preserveThinking": {
    "default": false
  }
}
```

- `serviceTier.default` — tier used until you toggle (`standard` | `priority`).
- `serviceTier.keybinding` — any [pi key format](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/keybindings.md) (e.g. `ctrl+shift+l`, `ctrl+shift+k`). Requires `/reload` after changing. On macOS browser terminals (localterm), avoid `alt`/`ctrl+alt` (Option produces special chars) and `ctrl+shift+t/w/n/c/v` (browser/localterm tab + copy/paste shortcuts).
- `serviceTier.display` — `statusbar` (footer status area) or `off` (hide the tier indicator).
- `preserveThinking.default` — whether `reasoning_history: "preserved"` is injected (`true` | `false`, default `false`). Also settable via `/fireworks-settings`.

> **Note:** The OpenAI completions endpoint accepts `service_tier` directly (per Fireworks' API). The Anthropic Messages endpoint passes the top-level field through as an extra. If a supported Anthropic-routed model rejects it, file an issue so we can gate injection by API.

## Preserved Thinking

Fireworks exposes a top-level `reasoning_history` request parameter. The only accepted value is `"preserved"`; omitting it (the default) means prior assistant reasoning is **stripped** from the model's context each turn. Setting `reasoning_history: "preserved"` makes Fireworks render prior assistant reasoning into the model's context, improving multi-turn recall at the cost of extra tokens. See [the Fireworks reasoning guide](https://docs.fireworks.ai/guides/reasoning#preserved-thinking).

This works on **both** transports — the OpenAI completions endpoint (assistant `reasoning_content` field) and the Anthropic Messages endpoint (assistant `thinking` content blocks, for which Fireworks returns a `signature` so pi-ai replays them). pi-ai already replays the reasoning field/block on prior assistant turns; this extension's only job is injecting the top-level `reasoning_history: "preserved"` flag that makes Fireworks honor it.

Unlike neuralwatt/makora (which use per-model vLLM `chat_template_kwargs` flags like `preserve_thinking`/`clear_thinking`), Fireworks' knob is a single global parameter that applies to every reasoning model, so we expose it as one on/off toggle rather than a per-model submenu.

**Toggle it:**

- **`/fireworks-settings`** (TUI) → *Preserved thinking* → `on` / `off`. Takes effect immediately and persists as the default for future sessions.
- A dim **model-select notification** tells you the current state when you switch to a Fireworks reasoning model (`Preserved thinking ON for …` / `… OFF for …`).

Preserved thinking is **off by default** to match pi core and Fireworks' default (stripped). There is intentionally no `/fireworks-preserve` command or keybinding — it's settings-panel-only, mirroring neuralwatt/makora.

## Usage

After loading the extension, use the `/model` command in pi to select your preferred model:

```
/model
```

Then select "fireworks" as the provider and choose from the available models.

## Authentication

The Fireworks API key can be configured in multiple ways (resolved in this order):

1. **`auth.json`** (recommended) — Add to `~/.pi/agent/auth.json`:
   ```json
   { "fireworks": { "type": "api_key", "key": "your-api-key" } }
   ```
   The `key` field supports literal values, env var names, and shell commands (prefix with `!`). See [pi's auth file docs](https://github.com/badlogic/pi-mono) for details.
2. **Runtime override** — Use the `--api-key` CLI flag
3. **Environment variable** — Set `FIREWORKS_API_KEY`

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FIREWORKS_API_KEY` | No | Your Fireworks AI API key (fallback if not in auth.json) |

## Configuration

Add to your pi configuration for automatic loading:

```json
{
  "extensions": [
    "/path/to/pi-fireworks-provider"
  ]
}
```

## Development

```bash
pnpm install          # install dev tooling (vitest, knip, typescript)
pnpm test             # run the test suite (vitest)
pnpm run test:watch   # watch mode
pnpm run lint:dead    # dead-code / unused-export scan (knip)
pnpm run check        # typecheck (tsc) + tests + knip, all green or exit non-zero
```

Tests live in `tests/` and stub the `@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui` peer dependencies (see `tests/__mocks__/`) so they run without the real pi packages installed. A per-run temp dir is used for `~/.pi/agent` (via `PI_CODING_AGENT_DIR` in `tests/vitest.setup.ts`) so config/cache reads and writes never touch your real environment.

## License

MIT
