import * as http from 'http';
import * as https from 'https';

export interface HttpRequestOptions {
  method: 'GET' | 'POST' | 'DELETE' | 'PUT';
  headers?: Record<string, string | number>;
  body?: string;
  timeoutMs?: number;
}

export interface HttpResponseResult {
  ok: boolean;
  statusCode?: number;
  body: string;
  error?: string;
  timedOut?: boolean;
}

export type HttpRequester = (urlString: string, opts: HttpRequestOptions) => Promise<HttpResponseResult>;

let customRequester: HttpRequester | null = null;

/**
 * Registers an in-memory HTTP requester for deterministic unit/integration tests
 * without opening OS network sockets. Pass `null` to restore real Node http/https transport.
 */
export function setHttpRequester(requester: HttpRequester | null): void {
  customRequester = requester;
}

export function resolveHttpTransport(protocol: string): typeof http | typeof https {
  return protocol === 'https:' ? https : http;
}

/**
 * Performs an HTTP or HTTPS request with a strict timeout and non-throwing error handling.
 */
export function performHttpRequest(urlString: string, opts: HttpRequestOptions): Promise<HttpResponseResult> {
  if (customRequester) {
    return customRequester(urlString, opts);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: HttpResponseResult) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    try {
      const urlObj = new URL(urlString);
      const isHttps = urlObj.protocol === 'https:';
      if (urlObj.protocol !== 'http:' && !isHttps) {
        finish({ ok: false, body: '', error: `Unsupported URL protocol: ${urlObj.protocol}` });
        return;
      }

      const transport = resolveHttpTransport(urlObj.protocol);
      const timeoutMs = opts.timeoutMs ?? 4000;
      const headers: Record<string, string | number> = { ...(opts.headers || {}) };
      if (opts.body !== undefined) {
        headers['Content-Length'] = Buffer.byteLength(opts.body);
      }

      const req = transport.request(
        {
          hostname: urlObj.hostname,
          port: urlObj.port || (isHttps ? 443 : 80),
          path: `${urlObj.pathname}${urlObj.search}`,
          method: opts.method,
          headers,
          timeout: timeoutMs,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            const statusCode = res.statusCode ?? 0;
            finish({
              ok: statusCode >= 200 && statusCode < 300,
              statusCode,
              body: data,
            });
          });
        }
      );

      req.on('error', (err) => {
        finish({ ok: false, body: '', error: err.message });
      });

      req.on('timeout', () => {
        req.destroy();
        finish({ ok: false, body: '', error: `Request timed out (${timeoutMs}ms).`, timedOut: true });
      });

      if (opts.body !== undefined) {
        req.write(opts.body);
      }
      req.end();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      finish({ ok: false, body: '', error: message });
    }
  });
}
