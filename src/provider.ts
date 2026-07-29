import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGroq } from '@ai-sdk/groq';
import type { LanguageModel } from 'ai';

export type ProviderName = 'anthropic' | 'openai' | 'groq';

// Cheap-ish defaults per provider — override with MODEL=... in .env.
const DEFAULT_MODEL: Record<ProviderName, string> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-5.5',
  groq: 'openai/gpt-oss-120b',
};

// Which env var holds each provider's key (for the missing-key warning).
const KEY_ENV: Record<ProviderName, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  groq: 'GROQ_API_KEY',
};

export interface Resolved {
  provider: ProviderName;
  modelId: string;
  model: LanguageModel;
}

/**
 * Reads PROVIDER (default 'anthropic') and MODEL from the environment and
 * returns a ready-to-use model instance. Each provider reads its own key from
 * env automatically; we just select which one to build.
 */
export function resolveModel(): Resolved {
  const provider = (process.env.PROVIDER ?? 'anthropic') as ProviderName;
  const modelId = process.env.MODEL ?? DEFAULT_MODEL[provider];

  if (!process.env[KEY_ENV[provider]]) {
    console.warn(
      `⚠️  ${KEY_ENV[provider]} is not set — ${provider} requests will fail until you set it in .env`,
    );
  }

  let model: LanguageModel;
  switch (provider) {
    case 'anthropic':
      model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(modelId);
      break;
    case 'openai':
      model = createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(modelId);
      break;
    case 'groq':
      model = createGroq({ apiKey: process.env.GROQ_API_KEY })(modelId);
      break;
    default:
      throw new Error(
        `Unknown PROVIDER "${provider}". Use one of: anthropic, openai, groq.`,
      );
  }

  return { provider, modelId, model };
}
