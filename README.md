# pi-fireworks-provider

A [pi](https://github.com/badlogic/pi-mono) extension that registers [Fireworks AI](https://fireworks.ai/) as a custom provider. Access Kimi, MiniMax, GLM, DeepSeek, and GPT-OSS models through a unified OpenAI-compatible API.

## Features

- **32+ AI Models** including Kimi K2.5, MiniMax M2.5, GLM 4.5/4.7/5, DeepSeek V3.1/V3.2, and GPT-OSS
- **Unified API** via Fireworks AI's OpenAI-compatible completions endpoint
- **Cost Tracking** with per-model pricing for budget management
- **Reasoning Models** support for advanced reasoning capabilities
- **Vision Support** for image-capable models

## Installation

### Option 1: Using `pi install` (Recommended)

Install directly from GitHub:

```bash
pi install git:github.com/monotykamary/pi-fireworks-provider
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
| DeepSeek-V4-Pro | Text | 1.0M | - | Free | Free |
| Llama 3.3 70B Instruct | Text | 131K | - | Free | Free |
| Qwen3 8B | Text | 41K | - | Free | Free |
| Qwen3 VL 30B A3B Instruct | Text + Image | 262K | - | Free | Free |
| Qwen3 VL 30B A3B Thinking | Text + Image | 262K | - | Free | Free |
| DeepSeek V3.1 | Text | 164K | 164K | $0.56 | $1.68 |
| DeepSeek V3.2 | Text | 164K | 160K | $0.56 | $1.68 |
| DeepSeek V4 Pro (router) | Text | 1.0M | 1.0M | $1.74 | $3.48 |
| Gemma 4 26B A4B IT | Text + Image | 262K | - | Free | Free |
| Gemma 4 31B IT | Text + Image | 262K | - | Free | Free |
| GLM 4.5 | Text | 131K | 131K | $0.55 | $2.19 |
| GLM 4.7 | Text | 203K | 198K | $0.60 | $2.20 |
| GLM 5 | Text | 203K | 131K | $1.00 | $3.20 |
| GLM 5 Fast (router) | Text | 203K | 131K | $1.00 | $3.20 |
| GLM 5.1 | Text | 203K | 131K | $1.40 | $4.40 |
| GLM 5.1 Fast (router) | Text | 203K | 131K | $1.40 | $4.40 |
| GLM 4.5 Air | Text | 131K | 131K | $0.22 | $0.88 |
| GPT OSS 120B | Text | 131K | 33K | $0.15 | $0.60 |
| GPT OSS 20B | Text | 131K | 33K | $0.05 | $0.20 |
| Kimi K2 Instruct | Text | 131K | 16K | $1.00 | $3.00 |
| Kimi K2 Thinking | Text | 262K | 256K | $0.60 | $2.50 |
| Kimi K2.5 | Text + Image | 262K | 256K | $0.60 | $3.00 |
| Kimi K2.5 Fast (router) | Text + Image | 262K | 256K | $0.60 | $3.00 |
| Kimi K2.5 Turbo (router) | Text + Image | 256K | 256K | $0.60 | $3.00 |
| Kimi K2.6 | Text + Image | 262K | 262K | $0.95 | $4.00 |
| Kimi K2.6 (router) | Text + Image | 262K | 262K | $0.95 | $4.00 |
| Kimi K2.6 Turbo (router) | Text + Image | 262K | 262K | $0.95 | $4.00 |
| MiniMax M2.7 (router) | Text | 204K | - | $0.30 | $1.20 |
| MiniMax-M2.1 | Text | 197K | 200K | $0.30 | $1.20 |
| MiniMax-M2.5 | Text | 197K | 197K | $0.30 | $1.20 |
| MiniMax-M2.7 | Text | 197K | 197K | $0.30 | $1.20 |
| Qwen 3.6 Plus | Text + Image | 128K | 8K | $0.50 | $3.00 |
*Costs are per million tokens. Prices subject to change - check [fireworks.ai](https://fireworks.ai) for current pricing.*

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

## License

MIT
