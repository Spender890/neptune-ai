import * as http from 'http';

export interface HACommandResult {
  success: boolean;
  message: string;
  statusCode?: number;
}

export interface HAEntityState {
  success: boolean;
  state?: string;
  attributes?: Record<string, any>;
  message?: string;
}

export class HomeAssistantClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
  }

  public async callService(domain: string, service: string, entity_id: string, extraData: Record<string, any> = {}): Promise<HACommandResult> {
    const payload = JSON.stringify({
      entity_id: entity_id,
      ...extraData,
    });

    return new Promise((resolve) => {
      try {
        const urlObj = new URL(`${this.baseUrl}/api/services/${domain}/${service}`);
        const options: http.RequestOptions = {
          hostname: urlObj.hostname,
          port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
          path: urlObj.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          },
          timeout: 4000,
        };

        const req = http.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ success: true, message: `Command executed: ${domain}.${service} on ${entity_id}`, statusCode: res.statusCode });
            } else {
              resolve({ success: false, message: `Home Assistant returned HTTP ${res.statusCode}: ${data}`, statusCode: res.statusCode });
            }
          });
        });

        req.on('error', (err) => {
          resolve({ success: false, message: `Connection error to Home Assistant: ${err.message}` });
        });

        req.on('timeout', () => {
          req.destroy();
          resolve({ success: false, message: 'Connection to Home Assistant timed out (4000ms).' });
        });

        req.write(payload);
        req.end();
      } catch (err: any) {
        resolve({ success: false, message: `Invalid Home Assistant URL: ${err.message}` });
      }
    });
  }

  /**
   * Retrieves the live state and attributes of a Home Assistant entity (GET /api/states/<entity_id>).
   */
  public async getState(entity_id: string): Promise<HAEntityState> {
    return new Promise((resolve) => {
      try {
        const urlObj = new URL(`${this.baseUrl}/api/states/${entity_id}`);
        const options: http.RequestOptions = {
          hostname: urlObj.hostname,
          port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
          path: urlObj.pathname,
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          },
          timeout: 4000,
        };

        const req = http.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const parsed = JSON.parse(data);
                resolve({
                  success: true,
                  state: parsed.state,
                  attributes: parsed.attributes || {},
                });
              } catch (e: any) {
                resolve({ success: false, message: `Failed to parse HA state JSON: ${e.message}` });
              }
            } else {
              resolve({ success: false, message: `Home Assistant returned HTTP ${res.statusCode}: ${data}` });
            }
          });
        });

        req.on('error', (err) => {
          resolve({ success: false, message: `Connection error to Home Assistant: ${err.message}` });
        });

        req.on('timeout', () => {
          req.destroy();
          resolve({ success: false, message: 'Connection to Home Assistant timed out (4000ms).' });
        });

        req.end();
      } catch (err: any) {
        resolve({ success: false, message: `Invalid Home Assistant URL: ${err.message}` });
      }
    });
  }
}
