import * as http from 'http';
import { HomeAssistantClient } from './homeassistant';
import { LGWebOSManager } from './webos';
import { TelephonyManager } from './telephony';

export interface IntercomConfig {
  hikvisionHost: string;
  hikvisionPort: number;
  hikvisionUser: string;
  hikvisionPass: string;
  doorIndex: number;
  doorEntityId: string;
  quickDoorToken: string;
}

export interface RingEvent {
  id: string;
  timestamp: number;
  source: string;
  message: string;
}

export interface DoorUnlockResult {
  success: boolean;
  action: 'unlock_door';
  speech: string;
  method: 'hikvision_isapi' | 'home_assistant' | 'simulation';
  latency_ms: number;
  details?: string;
}

export class IntercomManager {
  public readonly config: IntercomConfig;
  private haClient?: HomeAssistantClient;
  private webOSManager?: LGWebOSManager;
  private telephonyManager?: TelephonyManager;
  private speakerEntityId: string;
  private recentRings: RingEvent[] = [];
  private isDoorUnlocked = false;
  private unlockTimer: NodeJS.Timeout | null = null;

  constructor(
    config?: Partial<IntercomConfig>,
    haClient?: HomeAssistantClient,
    webOSManager?: LGWebOSManager,
    telephonyManager?: TelephonyManager,
    speakerEntityId: string = 'media_player.living_room_vlc_telnet'
  ) {
    this.config = {
      hikvisionHost: config?.hikvisionHost || process.env.HIKVISION_HOST || '',
      hikvisionPort: config?.hikvisionPort || parseInt(process.env.HIKVISION_PORT || '80', 10),
      hikvisionUser: config?.hikvisionUser || process.env.HIKVISION_USER || 'admin',
      hikvisionPass: config?.hikvisionPass || process.env.HIKVISION_PASS || '',
      doorIndex: config?.doorIndex || parseInt(process.env.HIKVISION_DOOR_INDEX || '1', 10),
      doorEntityId: config?.doorEntityId || process.env.DOOR_ENTITY_ID || 'lock.front_door',
      quickDoorToken: config?.quickDoorToken || process.env.QUICK_DOOR_TOKEN || 'neptune-open-door',
    };
    this.haClient = haClient;
    this.webOSManager = webOSManager;
    this.telephonyManager = telephonyManager;
    this.speakerEntityId = speakerEntityId;
  }

  public getStatus() {
    return {
      intercom: 'Hikvision Door Station',
      configured: Boolean(this.config.hikvisionHost || (this.haClient && this.config.doorEntityId)),
      door_state: this.isDoorUnlocked ? 'unlocked' : 'locked',
      quick_token: this.config.quickDoorToken,
      door_entity: this.config.doorEntityId,
      recent_rings: this.recentRings.slice(-5),
      vision_ai_ready: true,
    };
  }

  /**
   * Unlocks the door relay via Hikvision ISAPI PUT or Home Assistant relay/lock entity.
   */
  public async unlockDoor(): Promise<DoorUnlockResult> {
    const start = Date.now();
    let method: 'hikvision_isapi' | 'home_assistant' | 'simulation' = 'simulation';
    let success = false;
    let details = '';

    // Strategy 1: Direct Hikvision ISAPI Door Relay
    if (this.config.hikvisionHost) {
      try {
        const isapiRes = await this.sendHikvisionUnlock();
        if (isapiRes.success) {
          method = 'hikvision_isapi';
          success = true;
          details = isapiRes.details || 'ISAPI door relay command acknowledged.';
        }
      } catch (err: unknown) {
        details = `ISAPI attempt failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // Strategy 2: Home Assistant Lock / Button / Switch Fallback
    if (!success && this.haClient && this.config.doorEntityId) {
      const entityId = this.config.doorEntityId;
      const domain = entityId.split('.')[0] || 'lock';
      let service = 'unlock';
      if (domain === 'button') {
        service = 'press';
      } else if (domain === 'switch') {
        service = 'turn_on';
      }

      try {
        const haRes = await this.haClient.callService(domain, service, entityId);
        if (haRes.success) {
          method = 'home_assistant';
          success = true;
          details = `Dispatched ${domain}.${service} on ${entityId}.`;
        } else {
          details = haRes.message || 'Home Assistant service call unsuccessful.';
        }
      } catch (err: unknown) {
        details = `Home Assistant door unlock failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // Strategy 3: Simulation mode when no hardware is yet attached on local network
    if (!success && !this.config.hikvisionHost) {
      success = true;
      method = 'simulation';
      details = 'Door relay pulse triggered (Simulated / Local dry-run).';
    }

    if (success) {
      this.isDoorUnlocked = true;
      if (this.unlockTimer) clearTimeout(this.unlockTimer);
      // Auto relock state after 5 seconds
      this.unlockTimer = setTimeout(() => {
        this.isDoorUnlocked = false;
      }, 5000);
    }

    const latency_ms = Date.now() - start;
    return {
      success,
      action: 'unlock_door',
      speech: success ? 'The front door has been unlocked.' : 'Failed to unlock the front door.',
      method,
      latency_ms,
      details,
    };
  }

  /**
   * Handles incoming doorbell ring event from Hikvision intercom or external webhook:
   * 1. Broadcasts announcement across whole house speakers.
   * 2. Shows pop-up toast banner on LG TV.
   * 3. Logs ring event.
   */
  public async handleDoorbellRing(source: string = 'Intercom Doorbell'): Promise<{
    success: boolean;
    speech: string;
    event: RingEvent;
  }> {
    const event: RingEvent = {
      id: `ring_${Date.now()}`,
      timestamp: Date.now(),
      source,
      message: 'Someone is at the front door.',
    };
    this.recentRings.push(event);
    if (this.recentRings.length > 20) {
      this.recentRings.shift();
    }

    const speech = 'Someone is at the front door.';

    // 1. Announce over whole-house speakers (VLC-Telnet via Home Assistant)
    if (this.haClient) {
      void this.haClient.callService('tts', 'speak', 'tts.google_translate_en_com', {
        media_player_entity_id: this.speakerEntityId,
        message: speech,
      }).catch(() => undefined);
    }

    // 2. Pop up toast notification on LG TV
    if (this.webOSManager) {
      void this.webOSManager.showToast('🔔 Front Door Intercom: Someone is at the front door!').catch(() => undefined);
    }

    return {
      success: true,
      speech,
      event,
    };
  }

  /**
   * Issues Hikvision ISAPI Door Relay Unlock HTTP request.
   */
  private sendHikvisionUnlock(): Promise<{ success: boolean; details?: string }> {
    return new Promise((resolve) => {
      const xmlBody = '<?xml version="1.0" encoding="UTF-8"?><RemoteControlDoor version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><cmd>open</cmd></RemoteControlDoor>';
      const authHeader = 'Basic ' + Buffer.from(`${this.config.hikvisionUser}:${this.config.hikvisionPass}`).toString('base64');

      const req = http.request(
        {
          hostname: this.config.hikvisionHost,
          port: this.config.hikvisionPort,
          path: `/ISAPI/AccessControl/RemoteControl/door/${this.config.doorIndex}`,
          method: 'PUT',
          headers: {
            'Authorization': authHeader,
            'Content-Type': 'application/xml',
            'Content-Length': Buffer.byteLength(xmlBody),
          },
          timeout: 2500,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ success: true, details: `Hikvision ISAPI response ${res.statusCode}` });
            } else {
              resolve({ success: false, details: `Hikvision HTTP ${res.statusCode}: ${data.slice(0, 100)}` });
            }
          });
        }
      );

      req.on('error', (err) => {
        resolve({ success: false, details: err.message });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ success: false, details: 'Hikvision ISAPI request timed out.' });
      });

      req.write(xmlBody);
      req.end();
    });
  }
}
