import * as fs from 'fs';
import * as path from 'path';
import { FastPathRouter } from './fastpath';
import { PermissionsGateway } from './permissions';
import { HomeAssistantClient } from './homeassistant';
import { OllamaAgent } from './ollama';
import { JellyfinClient } from './jellyfin';
import { LGWebOSManager } from './webos';
import { ReminderStore, type Reminder } from './reminders';
import { AgendaDaemon } from './agenda';
import { TelephonyManager } from './telephony';
import { CONTACT_DIRECTORY, getContactByExtension } from './contacts';

export interface NeptuneConfig {
  port: number;
  host: string;
  configPath: string;
  dataDir: string;
  spoolDir: string;
  haUrl: string;
  haToken: string;
  jellyfinUrl: string;
  jellyfinKey: string;
  ollamaUrl: string;
  llmModel: string;
  tvEntity: string;
  speakerEntity: string;
  primaryUserName: string;
  apiKey: string;
}

export interface NeptuneDependencies {
  config?: Partial<NeptuneConfig>;
  fastPath?: FastPathRouter;
  permissions?: PermissionsGateway;
  haClient?: HomeAssistantClient;
  jellyfinClient?: JellyfinClient;
  webOSManager?: LGWebOSManager;
  ollamaAgent?: OllamaAgent;
  reminderStore?: ReminderStore;
  agendaDaemon?: AgendaDaemon;
  telephonyManager?: TelephonyManager;
}

export const VALID_SOUND_OUTPUTS = [
  'external_arc',
  'optical',
  'tv_speaker',
  'tv_external_speaker',
  'lineout',
  'headphone',
] as const;

export const MAX_COMMAND_TEXT_LENGTH = 1000;

export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'ha_set_state',
      description: 'Turn on, turn off, or toggle a smart home light or switch.',
      parameters: {
        type: 'object',
        properties: {
          domain: { type: 'string', enum: ['light', 'switch'] },
          entity_id: { type: 'string' },
          state: { type: 'string', enum: ['on', 'off', 'toggle'] },
        },
        required: ['domain', 'entity_id', 'state'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ha_set_climate',
      description: 'Adjust target temperature or mode on an AC or thermostat.',
      parameters: {
        type: 'object',
        properties: {
          entity_id: { type: 'string' },
          temperature: { type: 'number' },
          hvac_mode: { type: 'string', enum: ['heat', 'cool', 'auto', 'off'] },
        },
        required: ['entity_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'broadcast_announcement',
      description: 'Broadcast or announce a message aloud to the whole house through the VLC-Telnet home speakers.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'The spoken announcement text for the whole house.' },
        },
        required: ['message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'telephony_call',
      description: 'Call a person or extension and deliver a spoken message.',
      parameters: {
        type: 'object',
        properties: {
          recipient: { type: 'string', description: 'Name or extension of recipient (e.g. Primary, Desk, 1001, 1002)' },
          message: { type: 'string', description: 'Message to speak to them' },
        },
        required: ['recipient', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'media_control',
      description: 'Control media playback, apps, or volume on TVs and speakers.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['play', 'pause', 'stop', 'next', 'previous', 'set_volume', 'volume_up', 'volume_down', 'select_source'],
          },
          target_player: { type: 'string' },
          volume_level: { type: 'number' },
          source: { type: 'string' },
        },
        required: ['action', 'target_player'],
      },
    },
  },
];

function resolveDefaultEntitiesPath(): string {
  if (process.env.ALLOWED_ENTITIES_PATH) {
    return process.env.ALLOWED_ENTITIES_PATH;
  }
  const candidates: string[] = [];
  if (typeof __dirname !== 'undefined') {
    candidates.push(path.join(__dirname, '../../config/allowed_entities.json'));
    candidates.push(path.join(__dirname, '../../../config/allowed_entities.json'));
  }
  candidates.push(path.resolve(process.cwd(), 'config/allowed_entities.json'));
  candidates.push(path.resolve(process.cwd(), '../config/allowed_entities.json'));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

export function loadConfigFromEnv(overrides: Partial<NeptuneConfig> = {}): NeptuneConfig {
  const parsedPort = parseInt(process.env.NEPTUNE_PORT || '3000', 10);
  return {
    port: overrides.port ?? (Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3000),
    host: overrides.host ?? (process.env.NEPTUNE_HOST || '0.0.0.0'),
    configPath: overrides.configPath ?? resolveDefaultEntitiesPath(),
    dataDir: overrides.dataDir ?? (process.env.DATA_DIR || '/app/data'),
    spoolDir: overrides.spoolDir ?? (process.env.ASTERISK_SPOOL_DIR || '/var/spool/asterisk/outgoing'),
    haUrl: overrides.haUrl ?? (process.env.HOMEASSISTANT_URL || process.env.HA_URL || 'http://homeassistant.local:8123'),
    haToken: overrides.haToken ?? (process.env.HOMEASSISTANT_TOKEN || process.env.HA_TOKEN || ''),
    jellyfinUrl: overrides.jellyfinUrl ?? (process.env.JELLYFIN_URL || 'http://jellyfin.local:8096'),
    jellyfinKey: overrides.jellyfinKey ?? (process.env.JELLYFIN_API_KEY || ''),
    ollamaUrl: overrides.ollamaUrl ?? (process.env.OLLAMA_BASE_URL || 'http://ollama:11434'),
    llmModel: overrides.llmModel ?? (process.env.LLM_MODEL || 'qwen2.5:3b'),
    tvEntity: overrides.tvEntity ?? (process.env.TV_ENTITY_ID || 'media_player.living_room_lg_webos_tv_qned806qa'),
    speakerEntity: overrides.speakerEntity ?? (process.env.SPEAKER_ENTITY_ID || 'media_player.living_room_vlc_telnet'),
    primaryUserName: overrides.primaryUserName ?? (process.env.PRIMARY_USER_NAME || 'Primary'),
    apiKey: overrides.apiKey ?? (process.env.NEPTUNE_API_KEY || ''),
  };
}

/**
 * Core application engine decoupled from Fastify HTTP transport so business logic,
 * routing, permissions, and integrations can be tested deterministically.
 */
export class NeptuneEngine {
  public readonly config: NeptuneConfig;
  public readonly fastPath: FastPathRouter;
  public readonly permissions: PermissionsGateway;
  public readonly haClient: HomeAssistantClient;
  public readonly jellyfinClient: JellyfinClient;
  public readonly webOSManager: LGWebOSManager;
  public readonly ollamaAgent: OllamaAgent;
  public readonly reminderStore: ReminderStore;
  public readonly agendaDaemon: AgendaDaemon;
  public readonly telephonyManager: TelephonyManager;

  constructor(deps: NeptuneDependencies = {}) {
    this.config = loadConfigFromEnv(deps.config);
    this.fastPath = deps.fastPath || new FastPathRouter(this.config.tvEntity, this.config.speakerEntity);
    this.permissions = deps.permissions || new PermissionsGateway(this.config.configPath);
    this.haClient = deps.haClient || new HomeAssistantClient(this.config.haUrl, this.config.haToken);
    this.jellyfinClient = deps.jellyfinClient || new JellyfinClient(this.config.jellyfinUrl, this.config.jellyfinKey);
    this.webOSManager = deps.webOSManager || new LGWebOSManager(this.haClient, this.jellyfinClient, this.config.tvEntity);
    this.ollamaAgent = deps.ollamaAgent || new OllamaAgent(this.config.ollamaUrl, this.config.llmModel);
    this.reminderStore = deps.reminderStore || new ReminderStore(this.config.dataDir);
    this.agendaDaemon =
      deps.agendaDaemon ||
      new AgendaDaemon(this.reminderStore, this.webOSManager, this.haClient, this.config.speakerEntity, this.config.spoolDir);
    this.telephonyManager = deps.telephonyManager || new TelephonyManager(this.config.spoolDir);
  }

  public getHealth(): Record<string, unknown> {
    return {
      status: 'ok',
      service: 'neptune-backend',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  }

  public getStatus(): Record<string, unknown> {
    return {
      system: 'Neptune-AI',
      version: '0.1.0',
      phase: 'v0.1.0 Operational: Voice, Telephony, Reminders & Media Orchestration',
      engine: {
        fast_path_latency_target: '< 5 ms',
        llm_model: this.config.llmModel,
        ollama_url: this.config.ollamaUrl,
        api_auth_enabled: Boolean(this.config.apiKey),
      },
      integrations: {
        home_assistant: { url: this.config.haUrl, configured: Boolean(this.config.haToken) },
        lg_webos: 'Integrated via Home Assistant webostv & Jellyfin',
        speech: { stt: 'Wyoming Whisper (10300)', tts: 'Wyoming Piper (10200)' },
        telephony: { pbx: 'Asterisk PJSIP', contacts: CONTACT_DIRECTORY.length },
        reminders: { active_count: this.reminderStore.listActive().length },
      },
    };
  }

  public getContacts() {
    return { contacts: CONTACT_DIRECTORY };
  }

  public async getTVState() {
    return this.webOSManager.getPlaybackState();
  }

  public async setTVSoundOutput(soundOutput: string) {
    if (typeof soundOutput !== 'string' || !VALID_SOUND_OUTPUTS.includes(soundOutput as (typeof VALID_SOUND_OUTPUTS)[number])) {
      return {
        statusCode: 400,
        body: {
          error: `Invalid "sound_output". Allowed values: ${VALID_SOUND_OUTPUTS.join(', ')}`,
        },
      };
    }
    const result = await this.webOSManager.selectSoundOutput(soundOutput);
    return { statusCode: 200, body: result };
  }

  public async placeOutboundCall(to: string, message: string, from?: string) {
    if (typeof to !== 'string' || !to.trim() || typeof message !== 'string' || !message.trim()) {
      return {
        statusCode: 400,
        body: { error: 'Missing "to" or "message" in request body.' },
      };
    }
    const result = await this.telephonyManager.dispatchCallMessage({
      recipientQuery: to,
      message,
      senderName: from || 'Neptune',
    });
    return { statusCode: 200, body: result };
  }

  public listReminders(): { active: Reminder[]; recent: Reminder[] } {
    return {
      active: this.reminderStore.listActive(),
      recent: this.reminderStore.listRecent(15),
    };
  }

  public createReminder(body: {
    title?: unknown;
    duration_minutes?: unknown;
    channels?: unknown;
    source?: 'phone_call' | 'web_cockpit' | 'api' | 'voice_assistant';
    created_by?: unknown;
    target_person?: unknown;
  }) {
    const { title, duration_minutes, channels, source, created_by, target_person } = body || {};
    if (typeof title !== 'string' || !title.trim() || typeof duration_minutes !== 'number') {
      return { statusCode: 400, body: { error: 'Missing or invalid title or duration_minutes.' } };
    }
    try {
      const rem = this.reminderStore.create(
        title,
        duration_minutes,
        Array.isArray(channels) ? channels.map(String) : ['tv', 'speaker', 'call', 'web'],
        source || 'web_cockpit',
        typeof created_by === 'string' ? created_by : 'Web Cockpit',
        typeof target_person === 'string' ? target_person : this.config.primaryUserName
      );
      return { statusCode: 200, body: { success: true, reminder: rem } };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Invalid reminder request.';
      return { statusCode: 400, body: { error: message } };
    }
  }

  public deleteReminder(id: string) {
    if (!id || typeof id !== 'string') {
      return { statusCode: 400, body: { error: 'Missing reminder id.' } };
    }
    const deleted = this.reminderStore.delete(id);
    return { statusCode: 200, body: { success: deleted } };
  }

  public async handleCommand(body: {
    text?: unknown;
    caller_id?: unknown;
    caller_name?: unknown;
  }): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const startTime = Date.now();
    const rawText = body?.text;
    const callerId = typeof body?.caller_id === 'string' ? body.caller_id : undefined;
    let callerName = typeof body?.caller_name === 'string' ? body.caller_name : undefined;

    if (!callerName && callerId) {
      const contact = getContactByExtension(callerId);
      callerName = contact ? contact.name : `Extension ${callerId}`;
    }

    if (typeof rawText !== 'string' || !rawText.trim()) {
      return { statusCode: 400, body: { error: 'Missing or invalid "text" in request body.' } };
    }

    if (rawText.length > MAX_COMMAND_TEXT_LENGTH) {
      return {
        statusCode: 400,
        body: { error: `Command text exceeds maximum length of ${MAX_COMMAND_TEXT_LENGTH} characters.` },
      };
    }

    const text = rawText.trim();

    // STAGE 1: Deterministic Fast-Path Evaluation (< 5 ms)
    const fpResult = this.fastPath.match(text);
    if (fpResult.matched && fpResult.domain && fpResult.entity_id && fpResult.service) {
      const perm = this.permissions.validate(fpResult.domain, fpResult.entity_id);
      if (!perm.allowed) {
        return {
          statusCode: 200,
          body: {
            path: 'fast-path-rejected',
            latency_ms: Date.now() - startTime,
            speech: `I cannot execute that command: ${perm.reason}`,
            success: false,
          },
        };
      }

      if (perm.requires_confirmation || fpResult.requires_confirmation) {
        return {
          statusCode: 200,
          body: {
            path: 'fast-path-confirmation-required',
            latency_ms: Date.now() - startTime,
            speech: `Are you sure you want to perform that action on ${fpResult.entity_id}?`,
            requires_confirmation: true,
            success: false,
            action: fpResult,
          },
        };
      }

      // 1. Proactive Telephony Call & Message Delivery
      if (
        fpResult.intent === 'telephony_call_message' &&
        typeof fpResult.data?.recipient === 'string' &&
        typeof fpResult.data?.message === 'string'
      ) {
        const sender = callerName || this.config.primaryUserName;
        const callRes = await this.telephonyManager.dispatchCallMessage({
          recipientQuery: fpResult.data.recipient,
          message: fpResult.data.message,
          senderName: sender,
        });

        return {
          statusCode: 200,
          body: {
            path: 'fast-path-telephony-call',
            latency_ms: Date.now() - startTime,
            speech: callRes.speech,
            success: callRes.success,
            details: callRes,
          },
        };
      }

      // 2. TV State & "What's Playing on TV" Query
      if (fpResult.intent === 'tv_state_query') {
        const tvState = await this.webOSManager.getPlaybackState();
        return {
          statusCode: 200,
          body: {
            path: 'fast-path-tv-state',
            latency_ms: Date.now() - startTime,
            speech: tvState.speech,
            success: tvState.success,
            tv_state: tvState,
          },
        };
      }

      // 3. Route TV Audio Output (Home Speakers vs TV Speakers)
      if (fpResult.intent === 'tv_sound_output' && typeof fpResult.data?.sound_output === 'string') {
        const soundRes = await this.webOSManager.selectSoundOutput(fpResult.data.sound_output);
        return {
          statusCode: 200,
          body: {
            path: 'fast-path-tv-sound',
            latency_ms: Date.now() - startTime,
            speech: soundRes.speech,
            success: soundRes.success,
          },
        };
      }

      // 4. Native Timer / Reminder
      if (
        fpResult.intent === 'set_reminder' &&
        typeof fpResult.data?.title === 'string' &&
        typeof fpResult.data?.duration_minutes === 'number'
      ) {
        const source = callerId ? 'phone_call' : 'web_cockpit';
        const createdBy = callerName ? `${callerName} (Ext ${callerId || 'unknown'})` : 'Web Cockpit';
        const targetPerson = callerName || this.config.primaryUserName;

        let reminder: Reminder;
        try {
          reminder = this.reminderStore.create(
            fpResult.data.title,
            fpResult.data.duration_minutes,
            ['tv', 'speaker', 'call', 'web'],
            source,
            createdBy,
            targetPerson
          );
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Unable to create reminder.';
          return {
            statusCode: 400,
            body: {
              path: 'fast-path-rejected',
              latency_ms: Date.now() - startTime,
              speech: message,
              success: false,
            },
          };
        }

        try {
          await this.haClient.callService('timer', 'start', 'timer.neptune_timer', {
            duration: typeof fpResult.data.ha_duration === 'number' ? fpResult.data.ha_duration : 60,
          });
        } catch {
          // Soft fallback when HA native timer entity is not defined
        }

        return {
          statusCode: 200,
          body: {
            path: 'fast-path-reminder',
            latency_ms: Date.now() - startTime,
            speech: fpResult.confirmation_speech,
            success: true,
            reminder,
          },
        };
      }

      // 5. Whole-House Speaker Broadcast
      if (fpResult.intent === 'whole_house_broadcast' && typeof fpResult.data?.message === 'string') {
        const haRes = await this.haClient.callService('tts', 'speak', 'tts.google_translate_en_com', {
          media_player_entity_id: this.config.speakerEntity,
          message: fpResult.data.message,
        });
        return {
          statusCode: 200,
          body: {
            path: 'fast-path-broadcast',
            latency_ms: Date.now() - startTime,
            speech: fpResult.confirmation_speech,
            success: haRes.success,
          },
        };
      }

      // 6. TV Entertainment Media Playback (Jellyfin -> TV)
      if (fpResult.intent === 'tv_media' && typeof fpResult.data?.media_title === 'string') {
        const tvRes = await this.webOSManager.playMediaOnTV(fpResult.data.media_title);
        return {
          statusCode: 200,
          body: {
            path: 'fast-path-entertainment',
            latency_ms: Date.now() - startTime,
            speech: tvRes.speech,
            success: tvRes.success,
            details: tvRes.details,
          },
        };
      }

      // 7. TV App Launching & Source Selection
      if (fpResult.intent === 'tv_app' && typeof fpResult.data?.source === 'string') {
        const tvRes = await this.webOSManager.launchAppOrSource(fpResult.data.source);
        return {
          statusCode: 200,
          body: {
            path: 'fast-path-app',
            latency_ms: Date.now() - startTime,
            speech: tvRes.speech,
            success: tvRes.success,
          },
        };
      }

      // 8. TV Volume Up / Down Step
      if (fpResult.intent === 'media_volume_step') {
        const tvRes =
          fpResult.service === 'volume_up' ? await this.webOSManager.volumeUp() : await this.webOSManager.volumeDown();
        return {
          statusCode: 200,
          body: {
            path: 'fast-path-volume',
            latency_ms: Date.now() - startTime,
            speech: tvRes.speech,
            success: tvRes.success,
          },
        };
      }

      // Execute directly to Home Assistant
      const haRes = await this.haClient.callService(
        fpResult.domain,
        fpResult.service,
        fpResult.entity_id,
        (fpResult.data as Record<string, unknown>) || {}
      );
      return {
        statusCode: 200,
        body: {
          path: 'fast-path',
          latency_ms: Date.now() - startTime,
          speech: fpResult.confirmation_speech,
          success: haRes.success,
          details: haRes.message,
        },
      };
    }

    // STAGE 2: LLM Reasoning Evaluation (Qwen 2.5 Fallback)
    const llmRes = await this.ollamaAgent.evaluate(text, TOOL_SCHEMAS);
    if (llmRes.type === 'tool' && llmRes.tool_calls) {
      const executedTools: Array<Record<string, unknown>> = [];
      let requiresConfirmation = false;

      for (const call of llmRes.tool_calls) {
        const fnName = call.function?.name;
        const args = (call.function?.arguments || {}) as Record<string, unknown>;

        if (fnName === 'broadcast_announcement' && typeof args.message === 'string') {
          const perm = this.permissions.validate('tts', 'tts.google_translate_en_com');
          if (!perm.allowed) {
            executedTools.push({ tool: fnName, success: false, reason: perm.reason });
            continue;
          }
          const haRes = await this.haClient.callService('tts', 'speak', 'tts.google_translate_en_com', {
            media_player_entity_id: this.config.speakerEntity,
            message: args.message,
          });
          executedTools.push({
            tool: fnName,
            success: haRes.success,
            speech: `Broadcasting to whole house: "${args.message}".`,
          });
          continue;
        }

        if (fnName === 'telephony_call' && typeof args.recipient === 'string' && typeof args.message === 'string') {
          const perm = this.permissions.validate('asterisk', 'asterisk.pbx');
          if (!perm.allowed) {
            executedTools.push({ tool: fnName, success: false, reason: perm.reason });
            continue;
          }
          const callRes = await this.telephonyManager.dispatchCallMessage({
            recipientQuery: args.recipient,
            message: args.message,
            senderName: callerName || this.config.primaryUserName,
          });
          executedTools.push({ tool: fnName, success: callRes.success, speech: callRes.speech });
          continue;
        }

        let domain = 'light';
        let service = 'turn_on';
        let entity_id = typeof args.entity_id === 'string' ? args.entity_id : 'unknown';
        let serviceData: Record<string, unknown> = {};

        if (fnName === 'ha_set_state') {
          domain = typeof args.domain === 'string' ? args.domain : 'light';
          service = args.state === 'on' ? 'turn_on' : args.state === 'off' ? 'turn_off' : 'toggle';
        } else if (fnName === 'ha_set_climate') {
          domain = 'climate';
          service = args.temperature !== undefined ? 'set_temperature' : 'set_hvac_mode';
          if (typeof args.temperature === 'number' && Number.isFinite(args.temperature)) {
            serviceData.temperature = args.temperature;
          }
          if (typeof args.hvac_mode === 'string') {
            serviceData.hvac_mode = args.hvac_mode;
          }
        } else if (fnName === 'media_control') {
          domain = 'media_player';
          const rawTarget = typeof args.target_player === 'string' ? args.target_player.trim() : '';
          const targetLower = rawTarget.toLowerCase();
          if (!rawTarget || targetLower === 'tv' || targetLower === 'living_room_tv') {
            entity_id = this.config.tvEntity;
          } else if (targetLower === 'speaker' || targetLower === 'living_room_speaker') {
            entity_id = this.config.speakerEntity;
          } else {
            entity_id = rawTarget;
          }
          const actionStr = typeof args.action === 'string' ? args.action : 'play';
          if (actionStr === 'volume_up' || actionStr === 'volume_down') {
            service = actionStr;
          } else if (actionStr === 'set_volume') {
            service = 'volume_set';
            if (typeof args.volume_level === 'number' && Number.isFinite(args.volume_level)) {
              const normalized = args.volume_level > 1 ? args.volume_level / 100 : args.volume_level;
              serviceData.volume_level = Math.max(0, Math.min(1, normalized));
            }
          } else if (actionStr === 'select_source' && typeof args.source === 'string') {
            service = 'select_source';
            serviceData.source = this.webOSManager.normalizeSourceName(args.source);
          } else if (actionStr === 'play') {
            service = 'media_play';
          } else if (actionStr === 'pause') {
            service = 'media_pause';
          } else if (actionStr === 'stop') {
            service = 'media_stop';
          } else if (actionStr === 'next') {
            service = 'media_next_track';
          } else if (actionStr === 'previous') {
            service = 'media_previous_track';
          } else {
            service = 'media_play_pause';
          }
        } else {
          executedTools.push({ tool: String(fnName), success: false, reason: 'Unknown tool name.' });
          continue;
        }

        const perm = this.permissions.validate(domain, entity_id);
        if (perm.requires_confirmation) {
          requiresConfirmation = true;
          executedTools.push({
            tool: fnName,
            entity_id,
            success: false,
            requires_confirmation: true,
            reason: perm.reason,
          });
        } else if (perm.allowed) {
          const haRes = await this.haClient.callService(domain, service, entity_id, serviceData);
          executedTools.push({ tool: fnName, entity_id, success: haRes.success });
        } else {
          executedTools.push({ tool: fnName, entity_id, success: false, reason: perm.reason });
        }
      }

      return {
        statusCode: 200,
        body: {
          path: 'llm-tool-call',
          latency_ms: Date.now() - startTime,
          speech: requiresConfirmation
            ? 'Confirmation is required before executing a sensitive device action.'
            : 'Command processed.',
          requires_confirmation: requiresConfirmation || undefined,
          executed_tools: executedTools,
        },
      };
    }

    // STAGE 3: Conversational Answer
    return {
      statusCode: 200,
      body: {
        path: 'llm-conversational',
        latency_ms: Date.now() - startTime,
        speech: llmRes.content,
      },
    };
  }
}
