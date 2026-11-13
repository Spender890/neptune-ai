import * as http from 'http';

export interface LLMResponse {
  type: 'tool' | 'conversational';
  tool_calls?: Array<{
    function: {
      name: string;
      arguments: Record<string, any>;
    };
  }>;
  content?: string;
  latency_ms: number;
}

export class OllamaAgent {
  private baseUrl: string;
  private model: string;

  constructor(baseUrl: string, model: string = 'qwen2.5:1.5b') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
  }

  public async evaluate(prompt: string, toolSchemas: any[] = []): Promise<LLMResponse> {
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
        temperature: 0.2,
      },
    });

    return new Promise((resolve) => {
      try {
        const urlObj = new URL(`${this.baseUrl}/api/chat`);
        const options: http.RequestOptions = {
          hostname: urlObj.hostname,
          port: urlObj.port || 11434,
          path: urlObj.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: 20000,
        };

        const req = http.request(options, (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            const latency = Date.now() - startTime;
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const parsed = JSON.parse(body);
                const toolCalls = parsed?.message?.tool_calls;
                if (toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0) {
                  return resolve({
                    type: 'tool',
                    tool_calls: toolCalls,
                    latency_ms: latency,
                  });
                } else {
                  return resolve({
                    type: 'conversational',
                    content: parsed?.message?.content || 'I processed your request.',
                    latency_ms: latency,
                  });
                }
              } catch {
                return resolve({
                  type: 'conversational',
                  content: 'Error parsing model response.',
                  latency_ms: latency,
                });
              }
            } else {
              return resolve({
                type: 'conversational',
                content: `AI Engine returned status code ${res.statusCode}: ${body}`,
                latency_ms: latency,
              });
            }
          });
        });

        req.on('error', (err) => {
          resolve({
            type: 'conversational',
            content: `AI Engine connection error: ${err.message}`,
            latency_ms: Date.now() - startTime,
          });
        });

        req.on('timeout', () => {
          req.destroy();
          resolve({
            type: 'conversational',
            content: 'AI Engine response timed out.',
            latency_ms: Date.now() - startTime,
          });
        });

        req.write(payload);
        req.end();
      } catch (err: any) {
        resolve({
          type: 'conversational',
          content: `AI request failed: ${err.message}`,
          latency_ms: Date.now() - startTime,
        });
      }
    });
  }
}
