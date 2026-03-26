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

export default function (pi: ExtensionAPI) {
	pi.registerProvider("fireworks", {
		baseUrl: "https://api.fireworks.ai/inference/v1",
		apiKey: "FIREWORKS_API_KEY",
		api: "openai-completions",

		models: [
		{
			id: "accounts/fireworks/routers/kimi-k2p5-turbo",
			name: "Kimi K2.5 Turbo",
			reasoning: true,
			input: ["text","image"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 256000,
			maxTokens: 256000,
		},
		{
			id: "accounts/fireworks/models/kimi-k2-instruct",
			name: "Kimi K2 Instruct",
			reasoning: false,
			input: ["text"],
			cost: {
				input: 1,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 128000,
			maxTokens: 16384,
		},
		{
			id: "accounts/fireworks/models/glm-4p7",
			name: "GLM 4.7",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0.6,
				output: 2.2,
				cacheRead: 0.3,
				cacheWrite: 0,
			},
			contextWindow: 198000,
			maxTokens: 198000,
		},
		{
			id: "accounts/fireworks/models/glm-5",
			name: "GLM 5",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 1,
				output: 3.2,
				cacheRead: 0.5,
				cacheWrite: 0,
			},
			contextWindow: 202752,
			maxTokens: 131072,
		},
		{
			id: "accounts/fireworks/models/deepseek-v3p1",
			name: "DeepSeek V3.1",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0.56,
				output: 1.68,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 163840,
			maxTokens: 163840,
		},
		{
			id: "accounts/fireworks/models/minimax-m2p1",
			name: "MiniMax-M2.1",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0.3,
				output: 1.2,
				cacheRead: 0.03,
				cacheWrite: 0,
			},
			contextWindow: 200000,
			maxTokens: 200000,
		},
		{
			id: "accounts/fireworks/models/glm-4p5-air",
			name: "GLM 4.5 Air",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0.22,
				output: 0.88,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 131072,
			maxTokens: 131072,
		},
		{
			id: "accounts/fireworks/models/deepseek-v3p2",
			name: "DeepSeek V3.2",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0.56,
				output: 1.68,
				cacheRead: 0.28,
				cacheWrite: 0,
			},
			contextWindow: 160000,
			maxTokens: 160000,
		},
		{
			id: "accounts/fireworks/models/minimax-m2p5",
			name: "MiniMax-M2.5",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0.3,
				output: 1.2,
				cacheRead: 0.03,
				cacheWrite: 0,
			},
			contextWindow: 196608,
			maxTokens: 196608,
		},
		{
			id: "accounts/fireworks/models/gpt-oss-120b",
			name: "GPT OSS 120B",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0.15,
				output: 0.6,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 131072,
			maxTokens: 32768,
		},
		{
			id: "accounts/fireworks/models/kimi-k2p5",
			name: "Kimi K2.5",
			reasoning: true,
			input: ["text","image","video"],
			cost: {
				input: 0.6,
				output: 3,
				cacheRead: 0.1,
				cacheWrite: 0,
			},
			contextWindow: 256000,
			maxTokens: 256000,
		},
		{
			id: "accounts/fireworks/models/kimi-k2-thinking",
			name: "Kimi K2 Thinking",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0.6,
				output: 2.5,
				cacheRead: 0.3,
				cacheWrite: 0,
			},
			contextWindow: 256000,
			maxTokens: 256000,
		},
		{
			id: "accounts/fireworks/models/glm-4p5",
			name: "GLM 4.5",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0.55,
				output: 2.19,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 131072,
			maxTokens: 131072,
		},
		{
			id: "accounts/fireworks/models/gpt-oss-20b",
			name: "GPT OSS 20B",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0.05,
				output: 0.2,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 131072,
			maxTokens: 32768,
		}
		],
	});
}
