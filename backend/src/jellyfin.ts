import { performHttpRequest } from './httpClient';

export interface JellyfinItem {
  Id: string;
  Name: string;
  Type: string;
  ServerId?: string;
}

export interface JellyfinSearchResult {
  found: boolean;
  item?: JellyfinItem;
  message: string;
}

export interface JellyfinSession {
  Id: string;
  DeviceName: string;
  Client: string;
  SupportsRemoteControl: boolean;
  NowPlayingItem?: {
    Name?: string;
    SeriesName?: string;
    Type?: string;
  };
}

/**
 * HTTP/HTTPS client for Jellyfin Media Server search and session playback dispatch.
 */
export class JellyfinClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string = '') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
  }

  private getAuthHeaders(): Record<string, string> {
    return {
      Accept: 'application/json',
      Authorization: `MediaBrowser Token="${this.apiKey}"`,
    };
  }

  private buildUrl(pathname: string, query: Record<string, string> = {}): string {
    const params = new URLSearchParams(query);
    if (this.apiKey) {
      params.set('ApiKey', this.apiKey);
    }
    const qs = params.toString();
    return qs ? `${this.baseUrl}${pathname}?${qs}` : `${this.baseUrl}${pathname}`;
  }

  /**
   * Search Jellyfin library for any specific title (movie, show, episode).
   */
  public async searchMedia(title: string): Promise<JellyfinSearchResult> {
    const targetUrl = this.buildUrl('/Items', {
      searchTerm: title.trim(),
      recursive: 'true',
      includeItemTypes: 'Movie,Series,Episode,Video',
      limit: '1',
    });

    const res = await performHttpRequest(targetUrl, {
      method: 'GET',
      headers: this.getAuthHeaders(),
      timeoutMs: 4000,
    });

    if (res.error) {
      return {
        found: false,
        message: res.timedOut ? 'Jellyfin request timed out.' : `Jellyfin unreachable: ${res.error}`,
      };
    }

    if (!res.ok) {
      return {
        found: false,
        message: `Jellyfin responded with HTTP ${res.statusCode}.`,
      };
    }

    try {
      const data = JSON.parse(res.body);
      const items: JellyfinItem[] = data.Items || [];
      if (items.length > 0) {
        return {
          found: true,
          item: items[0],
          message: `Found "${items[0].Name}" (${items[0].Type}) on Jellyfin.`,
        };
      }
      return {
        found: false,
        message: `No media matching "${title}" found in Jellyfin library.`,
      };
    } catch {
      return { found: false, message: 'Invalid JSON response from Jellyfin.' };
    }
  }

  /**
   * Query all active Jellyfin client sessions.
   */
  public async getSessions(): Promise<JellyfinSession[]> {
    const targetUrl = this.buildUrl('/Sessions');
    const res = await performHttpRequest(targetUrl, {
      method: 'GET',
      headers: this.getAuthHeaders(),
      timeoutMs: 4000,
    });

    if (!res.ok) {
      return [];
    }

    try {
      const data = JSON.parse(res.body);
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  /**
   * Command a specific session to start playing an item now.
   */
  public async playOnSession(sessionId: string, itemId: string): Promise<boolean> {
    const safeSessionId = encodeURIComponent(sessionId);
    const targetUrl = this.buildUrl(`/Sessions/${safeSessionId}/Playing`, {
      playCommand: 'PlayNow',
      itemIds: itemId,
    });

    const res = await performHttpRequest(targetUrl, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      body: '',
      timeoutMs: 4000,
    });

    return res.ok;
  }

  private findTVSession(sessions: JellyfinSession[]): JellyfinSession | undefined {
    return sessions.find(
      (s) =>
        s.SupportsRemoteControl &&
        (s.DeviceName.includes('LG') ||
          s.DeviceName.includes('QNED') ||
          s.DeviceName.includes('Smart TV') ||
          s.Client.includes('Jellyfin Web'))
    );
  }

  /**
   * Automatically identifies the active TV session and triggers instant playback.
   */
  public async playItemOnTV(itemId: string): Promise<{ success: boolean; message: string }> {
    let sessions = await this.getSessions();
    let tvSession = this.findTVSession(sessions);

    // If TV app just launched, retry once after 1.2s to allow session registration
    if (!tvSession) {
      await new Promise((r) => setTimeout(r, 1200));
      sessions = await this.getSessions();
      tvSession = this.findTVSession(sessions);
    }

    if (!tvSession) {
      return { success: false, message: 'No active TV Jellyfin session detected.' };
    }

    const played = await this.playOnSession(tvSession.Id, itemId);
    return {
      success: played,
      message: played ? `Playback initiated on ${tvSession.DeviceName}.` : 'Failed to send play command to TV session.',
    };
  }
}
