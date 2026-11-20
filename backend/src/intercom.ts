import * as crypto from 'crypto';
import * as http from 'http';
import { HomeAssistantClient } from './homeassistant';
import { LGWebOSManager } from './webos';
import { TelephonyManager } from './telephony';

export interface HikDoorConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  pass: string;
  doorIndex: number;
  doorEntityId: string;
}

export interface IntercomConfig {
  port: number;
  user: string;
  pass: string;
  doorIndex: number;
  quickDoorToken: string;
  doors: HikDoorConfig[];
}

export interface RingEvent {
  id: string;
  timestamp: number;
  doorId: string;
  doorName: string;
  source: string;
  message: string;
}

export interface SingleDoorResult {
  doorId: string;
  doorName: string;
  success: boolean;
  method: 'hikvision_isapi' | 'home_assistant' | 'simulation';
  details?: string;
}

export interface DoorUnlockResult {
  success: boolean;
  action: 'unlock_door';
  target: string;
  speech: string;
  results: SingleDoorResult[];
  latency_ms: number;
}

export class IntercomManager {
  public readonly config: IntercomConfig;
  private haClient?: HomeAssistantClient;
  private webOSManager?: LGWebOSManager;
  private telephonyManager?: TelephonyManager;
  private speakerEntityId: string;
  private recentRings: RingEvent[] = [];
  private doorStates: Record<string, boolean> = {};
  private unlockTimers: Record<string, NodeJS.Timeout> = {};

  constructor(
    config?: Partial<IntercomConfig>,
    haClient?: HomeAssistantClient,
    webOSManager?: LGWebOSManager,
    telephonyManager?: TelephonyManager,
    speakerEntityId: string = 'media_player.living_room_vlc_telnet'
  ) {
    const defaultPort = config?.port || parseInt(process.env.HIKVISION_PORT || '80', 10);
    const defaultUser = config?.user || process.env.HIKVISION_USER || 'admin';
    const defaultPass = config?.pass || process.env.HIKVISION_PASS || '';
    const defaultIndex = config?.doorIndex || parseInt(process.env.HIKVISION_DOOR_INDEX || '1', 10);

    const door1Host = process.env.HIKVISION_DOOR1_HOST || process.env.HIKVISION_HOST || '192.168.1.39';
    const door1Name = process.env.HIKVISION_DOOR1_NAME || 'Front Door';
    const door1Entity = process.env.HIKVISION_DOOR1_ENTITY || process.env.DOOR_ENTITY_ID || 'lock.front_door';

    const door2Host = process.env.HIKVISION_DOOR2_HOST || '192.168.1.40';
    const door2Name = process.env.HIKVISION_DOOR2_NAME || 'Gate / Side Door';
    const door2Entity = process.env.HIKVISION_DOOR2_ENTITY || 'lock.side_gate';

    const doors: HikDoorConfig[] = [
      {
        id: 'door1',
        name: door1Name,
        host: door1Host,
        port: defaultPort,
        user: defaultUser,
        pass: defaultPass,
        doorIndex: defaultIndex,
        doorEntityId: door1Entity,
      },
      {
        id: 'door2',
        name: door2Name,
        host: door2Host,
        port: defaultPort,
        user: defaultUser,
        pass: defaultPass,
        doorIndex: defaultIndex,
        doorEntityId: door2Entity,
      },
    ];

    this.config = {
      port: defaultPort,
      user: defaultUser,
      pass: defaultPass,
      doorIndex: defaultIndex,
      quickDoorToken: config?.quickDoorToken || process.env.QUICK_DOOR_TOKEN || 'neptune-open-door',
      doors: config?.doors || doors,
    };
    this.haClient = haClient;
    this.webOSManager = webOSManager;
    this.telephonyManager = telephonyManager;
    this.speakerEntityId = speakerEntityId;
  }

  public getStatus() {
    return {
      intercom: 'Hikvision Dual Door Stations',
      doors: this.config.doors.map((d) => ({
        id: d.id,
        name: d.name,
        host: d.host,
        state: this.doorStates[d.id] ? 'unlocked' : 'locked',
        configured: Boolean(d.host),
      })),
      quick_token: this.config.quickDoorToken,
      recent_rings: this.recentRings.slice(-6),
      vision_ai_ready: true,
    };
  }

  /**
   * Resolves target string to matched door config objects.
   */
  public resolveDoors(target: string = 'door1'): HikDoorConfig[] {
    const clean = target.trim().toLowerCase();
    if (clean === 'all' || clean === 'both' || clean === 'all doors' || clean === 'both doors') {
      return [...this.config.doors];
    }
    if (clean === 'door2' || clean === 'gate' || clean === 'side' || clean === 'back' || clean === 'second') {
      return this.config.doors.filter((d) => d.id === 'door2');
    }
    // Default to door1 (Front Door)
    return this.config.doors.filter((d) => d.id === 'door1');
  }

  /**
   * Unlocks specified door(s): 'door1' (Front), 'door2' (Gate), or 'all' (Both).
   */
  public async unlockDoor(targetQuery: string = 'door1'): Promise<DoorUnlockResult> {
    const start = Date.now();
    const targets = this.resolveDoors(targetQuery);
    const results: SingleDoorResult[] = [];

    for (const door of targets) {
      const res = await this.unlockSingleDoor(door);
      results.push(res);
      if (res.success) {
        this.doorStates[door.id] = true;
        if (this.unlockTimers[door.id]) clearTimeout(this.unlockTimers[door.id]);
        this.unlockTimers[door.id] = setTimeout(() => {
          this.doorStates[door.id] = false;
        }, 5000);
      }
    }

    const allSuccess = results.every((r) => r.success);
    const anySuccess = results.some((r) => r.success);

    let speech: string;
    if (targets.length > 1) {
      speech = allSuccess ? 'Both doors have been unlocked.' : 'One or more doors could not be unlocked.';
    } else {
      const targetName = targets[0]?.name || 'door';
      speech = anySuccess ? `The ${targetName} has been unlocked.` : `Failed to unlock the ${targetName}.`;
    }

    return {
      success: anySuccess,
      action: 'unlock_door',
      target: targetQuery,
      speech,
      results,
      latency_ms: Date.now() - start,
    };
  }

  private async unlockSingleDoor(door: HikDoorConfig): Promise<SingleDoorResult> {
    let method: 'hikvision_isapi' | 'home_assistant' | 'simulation' = 'simulation';
    let success = false;
    let details = '';

    // 1. Direct Hikvision ISAPI
    if (door.host) {
      try {
        const isapiRes = await this.sendHikvisionUnlock(door);
        if (isapiRes.success) {
          return {
            doorId: door.id,
            doorName: door.name,
            success: true,
            method: 'hikvision_isapi',
            details: isapiRes.details,
          };
        }
        details = isapiRes.details || 'ISAPI returned non-2xx status';
      } catch (err: unknown) {
        details = `ISAPI error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // 2. Home Assistant Fallback
    if (this.haClient && door.doorEntityId) {
      const entityId = door.doorEntityId;
      const domain = entityId.split('.')[0] || 'lock';
      const service = domain === 'button' ? 'press' : domain === 'switch' ? 'turn_on' : 'unlock';
      try {
        const haRes = await this.haClient.callService(domain, service, entityId);
        if (haRes.success) {
          return {
            doorId: door.id,
            doorName: door.name,
            success: true,
            method: 'home_assistant',
            details: `Triggered ${domain}.${service} on ${entityId}`,
          };
        }
      } catch (err: unknown) {
        details += ` | HA error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // 3. Dry-run simulation when host is empty
    if (!door.host) {
      success = true;
      method = 'simulation';
      details = 'Simulated relay pulse (No host IP set).';
    }

    return {
      doorId: door.id,
      doorName: door.name,
      success,
      method,
      details,
    };
  }

  /**
   * Handles incoming doorbell ring event from a specific door.
   */
  public async handleDoorbellRing(doorTarget: string = 'door1', source: string = 'Intercom Doorbell'): Promise<{
    success: boolean;
    speech: string;
    event: RingEvent;
  }> {
    const door = this.resolveDoors(doorTarget)[0] || this.config.doors[0];
    const event: RingEvent = {
      id: `ring_${Date.now()}_${door.id}`,
      timestamp: Date.now(),
      doorId: door.id,
      doorName: door.name,
      source,
      message: `Someone is at the ${door.name}.`,
    };

    this.recentRings.push(event);
    if (this.recentRings.length > 20) this.recentRings.shift();

    const speech = `Someone is at the ${door.name}.`;

    // 1. Whole-House Speakers announcement
    if (this.haClient) {
      void this.haClient.callService('tts', 'speak', 'tts.google_translate_en_com', {
        media_player_entity_id: this.speakerEntityId,
        message: speech,
      }).catch(() => undefined);
    }

    // 2. Pop-up toast banner on LG TV
    if (this.webOSManager) {
      void this.webOSManager.showToast(`🔔 Intercom: Someone is at the ${door.name}!`).catch(() => undefined);
    }

    return {
      success: true,
      speech,
      event,
    };
  }

function parseDigestChallenge(header: string): Record<string, string> {
  const params: Record<string, string> = {};
  const cleanHeader = header.replace(/^Digest\s+/i, '');
  const regex = /(\w+)=(?:"([^"]+)"|([^\s,]+))/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(cleanHeader)) !== null) {
    params[match[1]] = match[2] !== undefined ? match[2] : match[3];
  }
  return params;
}

function computeDigestAuth(
  method: string,
  uri: string,
  user: string,
  pass: string,
  challenge: Record<string, string>,
  ncVal: number = 1
): string {
  const realm = challenge.realm || '';
  const nonce = challenge.nonce || '';
  const qop = challenge.qop || '';
  const opaque = challenge.opaque;
  const ncStr = ncVal.toString(16).padStart(8, '0');
  const cnonce = crypto.randomBytes(8).toString('hex');

  const ha1 = crypto.createHash('md5').update(`${user}:${realm}:${pass}`).digest('hex');
  const ha2 = crypto.createHash('md5').update(`${method}:${uri}`).digest('hex');

  let response: string;
  if (qop && qop.toLowerCase().includes('auth')) {
    response = crypto.createHash('md5').update(`${ha1}:${nonce}:${ncStr}:${cnonce}:auth:${ha2}`).digest('hex');
  } else {
    response = crypto.createHash('md5').update(`${ha1}:${nonce}:${ha2}`).digest('hex');
  }

  let authHeader = `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
  if (qop && qop.toLowerCase().includes('auth')) {
    authHeader += `, qop=auth, nc=${ncStr}, cnonce="${cnonce}"`;
  }
  if (opaque !== undefined) {
    authHeader += `, opaque="${opaque}"`;
  }
  return authHeader;
}

  /**
   * Issues Hikvision ISAPI Door Relay Unlock HTTP request using Digest Authentication.
   */
  private sendHikvisionUnlock(door: HikDoorConfig): Promise<{ success: boolean; details?: string }> {
    return new Promise((resolve) => {
      const xmlBody = '<RemoteControlDoor><cmd>open</cmd></RemoteControlDoor>';
      const uri = `/ISAPI/AccessControl/RemoteControl/door/${door.doorIndex || 1}`;

      const doRequest = (authHeader?: string) => {
        const headers: Record<string, string | number> = {
          'Content-Type': 'application/xml',
          'Content-Length': Buffer.byteLength(xmlBody),
        };
        if (authHeader) {
          headers['Authorization'] = authHeader;
        }

        const req = http.request(
          {
            hostname: door.host,
            port: door.port || 80,
            path: uri,
            method: 'PUT',
            headers,
            timeout: 3500,
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => {
              data += chunk;
            });
            res.on('end', () => {
              // If 401 Unauthorized, challenge with Digest Authentication
              if (res.statusCode === 401 && res.headers['www-authenticate'] && !authHeader) {
                const challengeHeader = res.headers['www-authenticate'];
                const challengeStr = Array.isArray(challengeHeader) ? challengeHeader[0] : challengeHeader;
                if (challengeStr && challengeStr.toLowerCase().startsWith('digest')) {
                  const parsed = parseDigestChallenge(challengeStr);
                  const digestHeader = computeDigestAuth('PUT', uri, door.user, door.pass, parsed);
                  return doRequest(digestHeader);
                }
              }

              if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                console.log(`[Hikvision ISAPI] Successfully unlocked door on ${door.host} (${door.name})`);
                resolve({ success: true, details: `Hikvision ${door.host} responded ${res.statusCode}: Door Opened` });
              } else {
                console.warn(`[Hikvision ISAPI] Unlock failed on ${door.host} (${door.name}): HTTP ${res.statusCode} - ${data.slice(0, 150)}`);
                resolve({ success: false, details: `Hikvision ${door.host} HTTP ${res.statusCode}: ${data.slice(0, 100)}` });
              }
            });
          }
        );

        req.on('error', (err) => {
          console.error(`[Hikvision ISAPI] Connection error to ${door.host}:`, err.message);
          resolve({ success: false, details: `Connection to ${door.host}:${door.port} failed: ${err.message}` });
        });

        req.on('timeout', () => {
          req.destroy();
          console.error(`[Hikvision ISAPI] Request to ${door.host} timed out.`);
          resolve({ success: false, details: `Connection to ${door.host}:${door.port} timed out.` });
        });

        req.write(xmlBody);
        req.end();
      };

      // Initial call triggers 401 challenge, which computes digest auth and unlocks the door
      doRequest();
    });
  }
}
