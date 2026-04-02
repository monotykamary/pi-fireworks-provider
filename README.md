# pi-fireworks-provider

A [pi](https://github.com/marioechr/pi) extension that registers [Fireworks AI](https://fireworks.ai/) as a custom provider. Access Kimi, MiniMax, GLM, DeepSeek, and GPT-OSS models through a unified OpenAI-compatible API.

## Features

- **14+ AI Models** including Kimi K2.5, MiniMax M2.5, GLM 4.5/4.7/5, DeepSeek V3.1/V3.2, and GPT-OSS
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
| DeepSeek V3.2 | Text | 160K | 160K | $0.56 | $1.68 |
| GLM 4.5 | Text | 131K | 131K | $0.55 | $2.19 |
| GLM 4.7 | Text | 198K | 198K | $0.60 | $2.20 |
| GLM 5 | Text | 203K | 131K | $1.00 | $3.20 |
| GLM 4.5 Air | Text | 131K | 131K | $0.22 | $0.88 |
| GPT OSS 120B | Text | 131K | 33K | $0.15 | $0.60 |
| GPT OSS 20B | Text | 131K | 33K | $0.05 | $0.20 |
| Kimi K2 Instruct | Text | 128K | 16K | $1.00 | $3.00 |
| Kimi K2 Thinking | Text | 256K | 256K | $0.60 | $2.50 |
| Kimi K2.5 | Text + Image | 256K | 256K | $0.60 | $3.00 |
| Kimi K2.5 Turbo | Text + Image | 256K | 256K | Free | Free |
| MiniMax-M2.1 | Text | 200K | 200K | $0.30 | $1.20 |
| MiniMax-M2.5 | Text | 197K | 197K | $0.30 | $1.20 |
*Costs are per million tokens. Prices subject to change - check [fireworks.ai](https://fireworks.ai) for current pricing.*

## Usage

After loading the extension, use the `/model` command in pi to select your preferred model:

```
/model
```

Then select "fireworks" as the provider and choose from the available models.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FIREWORKS_API_KEY` | Yes | Your Fireworks AI API key |

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
