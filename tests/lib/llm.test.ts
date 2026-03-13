import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('axios', () => ({
  default: {
    post: vi.fn(),
    create: vi.fn(),
    isAxiosError: vi.fn(() => false),
  },
}));

import axios from 'axios';
import {
  extractJSON,
  buildProvider,
  OpenAIProvider,
  AnthropicProvider,
  OllamaProvider,
} from '../../src/lib/llm.js';

const mockedPost = vi.mocked(axios.post);

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── extractJSON ─────────────────────────────────────────────────────────────

describe('extractJSON', () => {
  it('extracts JSON from a ```json code fence', () => {
    const raw = '```json\n{"key": "value"}\n```';
    expect(extractJSON(raw)).toBe('{"key": "value"}');
  });

  it('extracts JSON from a plain ``` code fence', () => {
    const raw = '```\n{"key": "value"}\n```';
    expect(extractJSON(raw)).toBe('{"key": "value"}');
  });

  it('extracts raw JSON object when no code fence present', () => {
    const raw = 'Here is the result: {"key": "value"} done.';
    expect(extractJSON(raw)).toBe('{"key": "value"}');
  });

  it('returns trimmed input when no JSON object or fence detected', () => {
    const raw = '  plain text response  ';
    expect(extractJSON(raw)).toBe('plain text response');
  });

  it('handles multiline JSON inside a fence', () => {
    const raw = '```json\n{\n  "a": 1,\n  "b": 2\n}\n```';
    const result = extractJSON(raw);
    expect(JSON.parse(result)).toEqual({ a: 1, b: 2 });
  });
});

// ─── buildProvider ───────────────────────────────────────────────────────────

describe('buildProvider', () => {
  it('creates an AnthropicProvider for "anthropic"', () => {
    const p = buildProvider('anthropic', 'claude-sonnet-4-6', 'sk-ant-key');
    expect(p).toBeInstanceOf(AnthropicProvider);
    expect(p.providerName).toBe('anthropic');
  });

  it('creates an OpenAIProvider for "openai"', () => {
    const p = buildProvider('openai', 'gpt-4o', 'sk-key');
    expect(p).toBeInstanceOf(OpenAIProvider);
    expect(p.providerName).toBe('openai');
  });

  it('creates an OpenAIProvider for "xai" with xAI base URL', () => {
    const p = buildProvider('xai', 'grok-3', 'xai-key') as OpenAIProvider;
    expect(p).toBeInstanceOf(OpenAIProvider);
    expect(p.providerName).toBe('xai');
  });

  it('creates an OllamaProvider for "ollama" (no key required)', () => {
    const p = buildProvider('ollama', 'llama3');
    expect(p).toBeInstanceOf(OllamaProvider);
    expect(p.providerName).toBe('ollama');
  });

  it('throws when openai apiKey is missing', () => {
    expect(() => buildProvider('openai', 'gpt-4o')).toThrow('API key');
  });

  it('throws when anthropic apiKey is missing', () => {
    expect(() => buildProvider('anthropic', 'claude-opus-4-6')).toThrow('API key');
  });

  it('throws when xai apiKey is missing', () => {
    expect(() => buildProvider('xai', 'grok-3')).toThrow('API key');
  });
});

// ─── OpenAIProvider.complete ─────────────────────────────────────────────────

describe('OpenAIProvider.complete', () => {
  it('returns content from the first choice', async () => {
    mockedPost.mockResolvedValueOnce({
      data: { choices: [{ message: { content: 'Hello from OpenAI' } }] },
    });

    const provider = new OpenAIProvider('sk-key', 'gpt-4o');
    const result = await provider.complete([{ role: 'user', content: 'hi' }]);
    expect(result).toBe('Hello from OpenAI');
  });

  it('calls the correct OpenAI endpoint', async () => {
    mockedPost.mockResolvedValueOnce({
      data: { choices: [{ message: { content: 'ok' } }] },
    });

    const provider = new OpenAIProvider('sk-key', 'gpt-4o');
    await provider.complete([{ role: 'user', content: 'hi' }]);

    expect(mockedPost).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({ model: 'gpt-4o' }),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer sk-key' }) })
    );
  });

  it('uses a custom baseUrl when provided', async () => {
    mockedPost.mockResolvedValueOnce({
      data: { choices: [{ message: { content: 'ok' } }] },
    });

    const provider = new OpenAIProvider('xai-key', 'grok-3', 'https://api.x.ai/v1', 'xai');
    await provider.complete([{ role: 'user', content: 'hi' }]);

    expect(mockedPost).toHaveBeenCalledWith(
      'https://api.x.ai/v1/chat/completions',
      expect.anything(),
      expect.anything()
    );
  });

  it('throws when response has no content', async () => {
    mockedPost.mockResolvedValueOnce({ data: { choices: [] } });

    const provider = new OpenAIProvider('sk-key', 'gpt-4o');
    await expect(provider.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      'empty response'
    );
  });
});

// ─── AnthropicProvider.complete ──────────────────────────────────────────────

describe('AnthropicProvider.complete', () => {
  it('returns the first text content block', async () => {
    mockedPost.mockResolvedValueOnce({
      data: { content: [{ type: 'text', text: 'Hello from Anthropic' }] },
    });

    const provider = new AnthropicProvider('sk-ant-key', 'claude-sonnet-4-6');
    const result = await provider.complete([{ role: 'user', content: 'hi' }]);
    expect(result).toBe('Hello from Anthropic');
  });

  it('strips the system message from the conversation array', async () => {
    mockedPost.mockResolvedValueOnce({
      data: { content: [{ type: 'text', text: 'ok' }] },
    });

    const provider = new AnthropicProvider('sk-ant-key', 'claude-sonnet-4-6');
    await provider.complete([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
    ]);

    const [, body] = mockedPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(body['system']).toBe('You are helpful.');
    const messages = body['messages'] as { role: string }[];
    expect(messages.every((m) => m.role !== 'system')).toBe(true);
  });

  it('throws when response has no text block', async () => {
    mockedPost.mockResolvedValueOnce({ data: { content: [{ type: 'tool_use', id: 'x' }] } });

    const provider = new AnthropicProvider('sk-ant-key', 'claude-sonnet-4-6');
    await expect(provider.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      'empty response'
    );
  });
});

// ─── OllamaProvider.complete ─────────────────────────────────────────────────

describe('OllamaProvider.complete', () => {
  it('returns the message content', async () => {
    mockedPost.mockResolvedValueOnce({
      data: { message: { content: 'Hello from Ollama' } },
    });

    const provider = new OllamaProvider('llama3');
    const result = await provider.complete([{ role: 'user', content: 'hi' }]);
    expect(result).toBe('Hello from Ollama');
  });

  it('calls the Ollama /api/chat endpoint with stream:false', async () => {
    mockedPost.mockResolvedValueOnce({
      data: { message: { content: 'ok' } },
    });

    const provider = new OllamaProvider('llama3', 'http://localhost:11434');
    await provider.complete([{ role: 'user', content: 'hi' }]);

    expect(mockedPost).toHaveBeenCalledWith(
      'http://localhost:11434/api/chat',
      expect.objectContaining({ stream: false, model: 'llama3' }),
      expect.anything()
    );
  });
});
