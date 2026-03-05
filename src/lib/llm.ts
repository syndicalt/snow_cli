import axios from 'axios';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMProvider {
  readonly providerName: string;
  complete(messages: LLMMessage[]): Promise<string>;
}

/**
 * OpenAI-compatible provider.
 * Works for: OpenAI (gpt-4o, gpt-4-turbo, etc.), xAI/Grok (grok-3, grok-2),
 * and any other OpenAI-compatible endpoint.
 */
export class OpenAIProvider implements LLMProvider {
  readonly providerName: string;

  constructor(
    private apiKey: string,
    private model: string,
    private baseUrl: string = 'https://api.openai.com/v1',
    name: string = 'openai'
  ) {
    this.providerName = name;
  }

  async complete(messages: LLMMessage[]): Promise<string> {
    const res = await axios.post<{
      choices: { message: { content: string } }[];
    }>(
      `${this.baseUrl.replace(/\/$/, '')}/chat/completions`,
      { model: this.model, messages },
      {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 120_000,
      }
    );
    const content = res.data.choices[0]?.message.content;
    if (!content) throw new Error('LLM returned an empty response');
    return content;
  }
}

/**
 * Anthropic provider (claude-opus-4-6, claude-sonnet-4-6, etc.)
 */
export class AnthropicProvider implements LLMProvider {
  readonly providerName = 'anthropic';

  constructor(private apiKey: string, private model: string) {}

  async complete(messages: LLMMessage[]): Promise<string> {
    const system = messages.find((m) => m.role === 'system')?.content;
    const conversation = messages.filter((m) => m.role !== 'system');

    const res = await axios.post<{
      content: { type: string; text: string }[];
    }>(
      'https://api.anthropic.com/v1/messages',
      {
        model: this.model,
        max_tokens: 8192,
        ...(system ? { system } : {}),
        messages: conversation,
      },
      {
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        timeout: 120_000,
      }
    );

    const text = res.data.content.find((c) => c.type === 'text')?.text;
    if (!text) throw new Error('Anthropic returned an empty response');
    return text;
  }
}

/**
 * Ollama provider — runs models locally.
 * Default base URL: http://localhost:11434
 */
export class OllamaProvider implements LLMProvider {
  readonly providerName = 'ollama';

  constructor(
    private model: string,
    private baseUrl: string = 'http://localhost:11434'
  ) {}

  async complete(messages: LLMMessage[]): Promise<string> {
    const res = await axios.post<{
      message: { content: string };
    }>(
      `${this.baseUrl.replace(/\/$/, '')}/api/chat`,
      { model: this.model, messages, stream: false },
      { headers: { 'Content-Type': 'application/json' }, timeout: 300_000 }
    );
    const content = res.data.message.content;
    if (!content) throw new Error('Ollama returned an empty response');
    return content;
  }
}

/**
 * Build an LLMProvider from stored config.
 */
export function buildProvider(
  name: string,
  model: string,
  apiKey?: string,
  baseUrl?: string
): LLMProvider {
  switch (name) {
    case 'anthropic':
      if (!apiKey) throw new Error('Anthropic provider requires an API key (https://platform.claude.com/)');
      return new AnthropicProvider(apiKey, model);

    case 'xai':
      if (!apiKey) throw new Error('xAI provider requires an API key (https://platform.x.ai/)');
      return new OpenAIProvider(
        apiKey,
        model,
        baseUrl ?? 'https://api.x.ai/v1',
        'xai'
      );

    case 'ollama':
      return new OllamaProvider(model, baseUrl);

    case 'openai':
    default:
      if (!apiKey) throw new Error('OpenAI provider requires an API key (https://platform.openai.com/)');
      return new OpenAIProvider(apiKey, model, baseUrl, name);
  }
}

/**
 * Extract JSON from an LLM response that may be wrapped in a markdown code fence.
 */
export function extractJSON(raw: string): string {
  // Try ```json ... ``` or ``` ... ```
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  // Try to find raw JSON object
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end !== -1) return raw.slice(start, end + 1);
  return raw.trim();
}
