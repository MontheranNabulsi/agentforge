import { AnthropicProvider } from '../platform/ai/anthropic-provider';
import {
  HashingEmbeddingProvider,
  OpenAICompatibleEmbeddingProvider,
} from '../platform/ai/embedding-providers';
import { HeuristicFakeLlm } from '../platform/ai/fake-llm';
import type { Logger } from '../platform/observability/logger';
import type { EmbeddingProvider, LlmProvider } from '../shared-kernel/ai';
import type { AppConfig } from './config';

export interface AiProviders {
  llm: LlmProvider;
  embeddings: EmbeddingProvider;
  describe(): {
    llmProvider: string;
    model: string;
    embeddingProvider: string;
    embeddingModel: string;
    demoMode: boolean;
  };
}

/** Picks adapters from configuration. Without an API key the app runs on the deterministic fakes. */
export function buildAiProviders(
  config: AppConfig,
  logger: Logger,
  overrides: { llm?: LlmProvider; embeddings?: EmbeddingProvider } = {},
): AiProviders {
  const llm: LlmProvider =
    overrides.llm ??
    (config.ai.llmProvider === 'anthropic' && config.ai.anthropicApiKey
      ? new AnthropicProvider(config.ai.anthropicApiKey, config.ai.models)
      : new HeuristicFakeLlm({ streamDelayMs: config.env === 'test' ? 0 : 12 }));

  const embeddings: EmbeddingProvider =
    overrides.embeddings ??
    (config.ai.embeddingProvider === 'openai-compatible'
      ? new OpenAICompatibleEmbeddingProvider({
          baseUrl: config.ai.embeddingBaseUrl,
          model: config.ai.embeddingModel,
          apiKey: config.ai.embeddingApiKey,
          sendDimensions: config.ai.embeddingSendDimensions,
        })
      : new HashingEmbeddingProvider());

  if (llm.deterministic) {
    logger.info(
      'LLM provider: deterministic demo model (set LLM_PROVIDER=anthropic and ANTHROPIC_API_KEY for Claude)',
    );
  }
  return {
    llm,
    embeddings,
    describe: () => ({
      llmProvider: llm.name,
      model: llm.modelFor('default'),
      embeddingProvider: embeddings.name,
      embeddingModel: embeddings.model,
      demoMode: llm.deterministic,
    }),
  };
}
