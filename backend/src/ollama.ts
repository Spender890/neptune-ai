import { performHttpRequest } from './httpClient';

export interface LLMToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface LLMResponse {
  type: 'tool' | 'conversational';
  tool_calls?: LLMToolCall[];
  content?: string;
  latency_ms: number;
}

/**
 * Client for Ollama's /api/chat endpoint with structured tool-calling fallback.
 */
export class OllamaAgent {
  private baseUrl: string;
  private model: string;
  private temperature: number;
  private contextWindow: number;

  constructor(baseUrl: string, model: string = 'qwen2.5:3b') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    const envTemp = parseFloat(process.env.LLM_TEMPERATURE || '0.2');
    this.temperature = Number.isFinite(envTemp) ? envTemp : 0.2;
    const envCtx = parseInt(process.env.LLM_CONTEXT_WINDOW || '4096', 10);
    this.contextWindow = Number.isFinite(envCtx) && envCtx > 0 ? envCtx : 4096;
  }

  public async evaluate(prompt: string, toolSchemas: unknown[] = []): Promise<LLMResponse> {
    const startTime = Date.now();
    const payload = JSON.stringify({
      model: this.model,
      messages: [
        {
          role: 'system',
          content: 'You are Neptune-AI, a concise, helpful smart home assistant. Answer directly in 1-2 sentences.',
        },
        { role: 'user', content: prompt },
      ],
      tools: toolSchemas && toolSchemas.length > 0 ? toolSchemas : undefined,
      stream: false,
      keep_alive: '24h',
      options: {
        num_predict: 120,
        num_ctx: this.contextWindow,
        temperature: this.temperature,
      },
    });

    const res = await performHttpRequest(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      timeoutMs: 20000,
    });

    const latency = Date.now() - startTime;

    if (res.error) {
      return {
        type: 'conversational',
        content: res.timedOut ? 'AI Engine response timed out.' : `AI Engine connection error: ${res.error}`,
        latency_ms: latency,
      };
    }

    if (!res.ok) {
      return {
        type: 'conversational',
        content: `AI Engine returned status code ${res.statusCode}: ${res.body}`,
        latency_ms: latency,
      };
    }

    try {
      const parsed = JSON.parse(res.body);
      const toolCalls = parsed?.message?.tool_calls;
      if (toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0) {
        return {
          type: 'tool',
          tool_calls: toolCalls,
          latency_ms: latency,
        };
      }
      return {
        type: 'conversational',
        content: parsed?.message?.content || 'I processed your request.',
        latency_ms: latency,
      };
    } catch {
      return {
        type: 'conversational',
        content: 'Error parsing model response.',
        latency_ms: latency,
      };
    }
  }
}
