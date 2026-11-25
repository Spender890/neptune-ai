import { HomeAssistantClient } from './homeassistant';
import { LGWebOSManager } from './webos';
import { TelephonyManager } from './telephony';

export interface HikDoorConfig {
  id: string;
  name: string;
  doorEntityId: string;
  serviceOverride?: string;
}

export interface IntercomConfig {
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
  method: 'home_assistant' | 'simulation';
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

const DEFAULT_HA_DOOR_SERVICES: Record<string, string> = {
  lock: 'unlock',
  button: 'press',
  input_button: 'press',
  switch: 'turn_on',
  cover: 'open_cover',
  script: 'turn_on',
};

const SERVICE_OVERRIDE_RE = /^([a-z0-9_]+)\.([a-z0-9_]+)$/;

/**
 * Resolves the Home Assistant domain and service for a door entity, applying an optional domain.service override.
 */
function resolveHomeAssistantDoorService(
  entityId: string,
  serviceOverride?: string
): { domain: string; service: string } {
  const trimmedOverride = (serviceOverride || '').trim();
  const overrideMatch = SERVICE_OVERRIDE_RE.exec(trimmedOverride);
  if (overrideMatch) {
    return { domain: overrideMatch[1], service: overrideMatch[2] };
  }

  const domain = entityId.split('.')[0] || 'lock';
  const service = DEFAULT_HA_DOOR_SERVICES[domain] || 'unlock';
  return { domain, service };
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
    const door1Name = process.env.DOOR1_NAME || process.env.HIKVISION_DOOR1_NAME || 'Front Door';
    const door1Entity =
      process.env.DOOR1_ENTITY_ID || process.env.HIKVISION_DOOR1_ENTITY || process.env.DOOR_ENTITY_ID || 'lock.front_door';
    const door1Service = process.env.DOOR1_SERVICE || '';

    const door2Name = process.env.DOOR2_NAME || process.env.HIKVISION_DOOR2_NAME || 'Garage';
    const door2Entity =
      process.env.DOOR2_ENTITY_ID || process.env.HIKVISION_DOOR2_ENTITY || 'cover.garage_door';
    const door2Service = process.env.DOOR2_SERVICE || '';

    const doors: HikDoorConfig[] = [
      {
        id: 'door1',
        name: door1Name,
        doorEntityId: door1Entity,
        serviceOverride: door1Service || undefined,
      },
      {
        id: 'door2',
        name: door2Name,
        doorEntityId: door2Entity,
        serviceOverride: door2Service || undefined,
      },
    ];

    this.config = {
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
      intercom: 'Home Assistant Door Access',
      doors: this.config.doors.map((d) => ({
        id: d.id,
        name: d.name,
        entity_id: d.doorEntityId,
        state: this.doorStates[d.id] ? 'unlocked' : 'locked',
        configured: Boolean(d.doorEntityId && this.haClient),
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
    if (
      clean === 'door2' ||
      clean === 'garage' ||
      clean === 'garage door' ||
      clean === 'gate' ||
      clean === 'side' ||
      clean === 'back' ||
      clean === 'second'
    ) {
      return this.config.doors.filter((d) => d.id === 'door2');
    }
    // Default to door1 (Front Door)
    return this.config.doors.filter((d) => d.id === 'door1');
  }

  /**
   * Unlocks specified door(s): 'door1' (Front), 'door2' (Garage/Gate), or 'all' (Both).
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
    if (!door.doorEntityId) {
      return {
        doorId: door.id,
        doorName: door.name,
        success: true,
        method: 'simulation',
        details: 'Simulated unlock (No Home Assistant entity_id configured).',
      };
    }

    if (!this.haClient) {
      return {
        doorId: door.id,
        doorName: door.name,
        success: false,
        method: 'home_assistant',
        details: 'Home Assistant client is not configured.',
      };
    }

    const { domain, service } = resolveHomeAssistantDoorService(door.doorEntityId, door.serviceOverride);
    try {
      const haRes = await this.haClient.callService(domain, service, door.doorEntityId);
      return {
        doorId: door.id,
        doorName: door.name,
        success: haRes.success,
        method: 'home_assistant',
        details: haRes.message,
      };
    } catch (err: unknown) {
      return {
        doorId: door.id,
        doorName: door.name,
        success: false,
        method: 'home_assistant',
        details: `HA error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Handles incoming doorbell ring event from a specific door.
   */
  public async handleDoorbellRing(
    doorTarget: string = 'door1',
    source: string = 'Intercom Doorbell'
  ): Promise<{
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
      void this.haClient
        .callService('tts', 'speak', 'tts.google_translate_en_com', {
          media_player_entity_id: this.speakerEntityId,
          message: speech,
        })
        .catch(() => undefined);
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
}
