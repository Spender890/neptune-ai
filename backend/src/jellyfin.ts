import * as http from 'http';

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

export class JellyfinClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string = '') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
  }

  private getAuthHeader(): string {
    return `MediaBrowser Token="${this.apiKey}"`;
  }

  /**
   * Search Jellyfin library for any specific title (movie, show, episode).
   */
  public async searchMedia(title: string): Promise<JellyfinSearchResult> {
    const encodedTitle = encodeURIComponent(title.trim());
    const queryPath = `/Items?searchTerm=${encodedTitle}&recursive=true&includeItemTypes=Movie,Series,Episode,Video&limit=1&ApiKey=${this.apiKey}`;

    return new Promise((resolve) => {
      try {
        const urlObj = new URL(`${this.baseUrl}${queryPath}`);
        const options: http.RequestOptions = {
          hostname: urlObj.hostname,
          port: urlObj.port || 8096,
          path: `${urlObj.pathname}${urlObj.search}`,
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Authorization': this.getAuthHeader(),
          },
          timeout: 4000,
        };

        const req = http.request(options, (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const data = JSON.parse(body);
                const items: JellyfinItem[] = data.Items || [];
                if (items.length > 0) {
                  resolve({
                    found: true,
                    item: items[0],
                    message: `Found "${items[0].Name}" (${items[0].Type}) on Jellyfin.`,
                  });
                } else {
                  resolve({
                    found: false,
                    message: `No media matching "${title}" found in Jellyfin library.`,
                  });
                }
              } catch {
                resolve({ found: false, message: 'Invalid JSON response from Jellyfin.' });
              }
            } else {
              resolve({
                found: false,
                message: `Jellyfin responded with HTTP ${res.statusCode}.`,
              });
            }
          });
        });

        req.on('error', (err) => {
          resolve({ found: false, message: `Jellyfin unreachable: ${err.message}` });
        });

        req.on('timeout', () => {
          req.destroy();
          resolve({ found: false, message: 'Jellyfin request timed out.' });
        });

        req.end();
      } catch (err: any) {
        resolve({ found: false, message: `Jellyfin URL parse error: ${err.message}` });
      }
    });
  }

  /**
   * Query all active Jellyfin client sessions.
   */
  public async getSessions(): Promise<JellyfinSession[]> {
    return new Promise((resolve) => {
      try {
        const urlObj = new URL(`${this.baseUrl}/Sessions?ApiKey=${this.apiKey}`);
        const options: http.RequestOptions = {
          hostname: urlObj.hostname,
          port: urlObj.port || 8096,
          path: `${urlObj.pathname}${urlObj.search}`,
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Authorization': this.getAuthHeader(),
          },
          timeout: 4000,
        };

        const req = http.request(options, (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const data = JSON.parse(body);
                return resolve(Array.isArray(data) ? data : []);
              } catch {
                return resolve([]);
              }
            }
            return resolve([]);
          });
        });

        req.on('error', () => resolve([]));
        req.on('timeout', () => {
          req.destroy();
          resolve([]);
        });
        req.end();
      } catch {
        resolve([]);
      }
    });
  }

  /**
   * Command a specific session to start playing an item now.
   */
  public async playOnSession(sessionId: string, itemId: string): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const queryPath = `/Sessions/${sessionId}/Playing?playCommand=PlayNow&itemIds=${itemId}&ApiKey=${this.apiKey}`;
        const urlObj = new URL(`${this.baseUrl}${queryPath}`);
        const options: http.RequestOptions = {
          hostname: urlObj.hostname,
          port: urlObj.port || 8096,
          path: `${urlObj.pathname}${urlObj.search}`,
          method: 'POST',
          headers: {
            'Authorization': this.getAuthHeader(),
            'Content-Length': 0,
          },
          timeout: 4000,
        };

        const req = http.request(options, (res) => {
          resolve(Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 300));
        });

        req.on('error', () => resolve(false));
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });
        req.end();
      } catch {
        resolve(false);
      }
    });
  }

  /**
   * Automatically identifies the active TV session and triggers instant playback.
   */
  public async playItemOnTV(itemId: string): Promise<{ success: boolean; message: string }> {
    let sessions = await this.getSessions();
    let tvSession = sessions.find(
      (s) =>
        s.SupportsRemoteControl &&
        (s.DeviceName.includes('LG') ||
          s.DeviceName.includes('QNED') ||
          s.DeviceName.includes('Smart TV') ||
          s.Client.includes('Jellyfin Web'))
    );

    // If TV app just launched, retry after 1.2s to allow session registration
    if (!tvSession) {
      await new Promise((r) => setTimeout(r, 1200));
      sessions = await this.getSessions();
      tvSession = sessions.find(
        (s) =>
          s.SupportsRemoteControl &&
          (s.DeviceName.includes('LG') ||
            s.DeviceName.includes('QNED') ||
            s.DeviceName.includes('Smart TV') ||
            s.Client.includes('Jellyfin Web'))
      );
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
