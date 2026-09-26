import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/main/config';

describe('configuration', () => {
  it('uses safe local defaults', () => {
    const config = loadConfig({});
    expect(config.http.appUrl).toBe('http://localhost:4000');
    expect(config.http.cookieSecure).toBe(false);
    expect(config.ai.llmProvider).toBe('fake');
    expect(config.gitSha).toBeNull();
  });

  it("takes the public URL and commit from Render's variables", () => {
    const config = loadConfig({
      RENDER_EXTERNAL_URL: 'https://agentforge-46h1.onrender.com',
      RENDER_GIT_COMMIT: 'd34d5f50a4d9f7f68ecb74ce0fc2740257887214',
    });
    expect(config.http.appUrl).toBe('https://agentforge-46h1.onrender.com');
    expect(config.http.allowedOrigins).toEqual(['https://agentforge-46h1.onrender.com']);
    expect(config.gitSha).toBe('d34d5f50a4d9f7f68ecb74ce0fc2740257887214');
  });

  it('lets explicit settings win over platform defaults', () => {
    const config = loadConfig({
      APP_URL: 'https://agents.example.com',
      RENDER_EXTERNAL_URL: 'https://agentforge-46h1.onrender.com',
      GIT_SHA: 'abc1234',
      RENDER_GIT_COMMIT: 'd34d5f5',
    });
    expect(config.http.appUrl).toBe('https://agents.example.com');
    expect(config.gitSha).toBe('abc1234');
  });

  it('refuses to start with an incomplete Anthropic setup', () => {
    expect(() => loadConfig({ LLM_PROVIDER: 'anthropic' })).toThrow(ConfigError);
  });

  it('lists every invalid setting at once', () => {
    expect(() => loadConfig({ PORT: 'eighty', DATABASE_SSL: 'sometimes' })).toThrow(
      /PORT[\s\S]*DATABASE_SSL|DATABASE_SSL[\s\S]*PORT/,
    );
  });
});
