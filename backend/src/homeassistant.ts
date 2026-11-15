import { performHttpRequest } from './httpClient';

export interface HACommandResult {
  success: boolean;
  message: string;
  statusCode?: number;
}

export interface HAEntityState {
  success: boolean;
  state?: string;
  attributes?: Record<string, unknown>;
  message?: string;
}

const IDENTIFIER_RE = /^[a-z0-9_]+$/;
const ENTITY_ID_RE = /^[a-z0-9_]+\.[a-z0-9_]+$/;

/**
 * REST API client for Home Assistant Core service calls and entity state queries.
 */
export class HomeAssistantClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
  }

  private getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    return headers;
  }

  public async callService(
    domain: string,
    service: string,
    entity_id: string,
    extraData: Record<string, unknown> = {}
  ): Promise<HACommandResult> {
    if (!IDENTIFIER_RE.test(domain) || !IDENTIFIER_RE.test(service) || !ENTITY_ID_RE.test(entity_id)) {
      return {
        success: false,
        message: 'Rejected invalid Home Assistant domain, service, or entity_id identifier.',
      };
    }

    const payload = JSON.stringify({
      entity_id,
      ...extraData,
    });

    const targetUrl = `${this.baseUrl}/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`;
    const res = await performHttpRequest(targetUrl, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      body: payload,
      timeoutMs: 4000,
    });

    if (res.error) {
      const prefix = res.timedOut ? 'Connection to Home Assistant timed out' : 'Connection error to Home Assistant';
      return { success: false, message: `${prefix}: ${res.error}` };
    }

    if (res.ok) {
      return {
        success: true,
        message: `Command executed: ${domain}.${service} on ${entity_id}`,
        statusCode: res.statusCode,
      };
    }

    return {
      success: false,
      message: `Home Assistant returned HTTP ${res.statusCode}: ${res.body}`,
      statusCode: res.statusCode,
    };
  }

  /**
   * Retrieves the live state and attributes of a Home Assistant entity (GET /api/states/<entity_id>).
   */
  public async getState(entity_id: string): Promise<HAEntityState> {
    if (!ENTITY_ID_RE.test(entity_id)) {
      return { success: false, message: 'Rejected invalid Home Assistant entity_id identifier.' };
    }

    const targetUrl = `${this.baseUrl}/api/states/${encodeURIComponent(entity_id)}`;
    const res = await performHttpRequest(targetUrl, {
      method: 'GET',
      headers: this.getAuthHeaders(),
      timeoutMs: 4000,
    });

    if (res.error) {
      const prefix = res.timedOut ? 'Connection to Home Assistant timed out' : 'Connection error to Home Assistant';
      return { success: false, message: `${prefix}: ${res.error}` };
    }

    if (res.ok) {
      try {
        const parsed = JSON.parse(res.body);
        return {
          success: true,
          state: parsed.state,
          attributes: parsed.attributes || {},
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, message: `Failed to parse HA state JSON: ${message}` };
      }
    }

    return {
      success: false,
      message: `Home Assistant returned HTTP ${res.statusCode}: ${res.body}`,
    };
  }
}
