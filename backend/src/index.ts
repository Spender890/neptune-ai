import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as path from 'path';
import { FastPathRouter } from './fastpath';
import { PermissionsGateway } from './permissions';
import { HomeAssistantClient } from './homeassistant';
import { OllamaAgent } from './ollama';
import { JellyfinClient } from './jellyfin';
import { LGWebOSManager } from './webos';
import { ReminderStore } from './reminders';
import { AgendaDaemon } from './agenda';
import { TelephonyManager } from './telephony';
import { CONTACT_DIRECTORY, getContactByExtension, resolveContact } from './contacts';

const fastify: FastifyInstance = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
  },
});

const PORT = parseInt(process.env.NEPTUNE_PORT || '3000', 10);
const HOST = process.env.NEPTUNE_HOST || '0.0.0.0';

// Configurable endpoints
const CONFIG_PATH = process.env.ALLOWED_ENTITIES_PATH || path.join(__dirname, '../../config/allowed_entities.json');
const DATA_DIR = process.env.DATA_DIR || '/app/data';
const SPOOL_DIR = process.env.ASTERISK_SPOOL_DIR || '/var/spool/asterisk/outgoing';
const HA_URL = process.env.HOMEASSISTANT_URL || 'http://homeassistant.local:8123';
const HA_TOKEN = process.env.HOMEASSISTANT_TOKEN || '';
const JELLYFIN_URL = process.env.JELLYFIN_URL || 'http://jellyfin.local:8096';
const JELLYFIN_KEY = process.env.JELLYFIN_API_KEY || '';
const OLLAMA_URL = process.env.OLLAMA_BASE_URL || 'http://ollama:11434';
const LLM_MODEL = process.env.LLM_MODEL || 'qwen2.5:3b';

const TV_ENTITY = process.env.TV_ENTITY_ID || 'media_player.living_room_lg_webos_tv_qned806qa';
const SPEAKER_ENTITY = process.env.SPEAKER_ENTITY_ID || 'media_player.living_room_vlc_telnet';

// Initialize Core Subsystems
const fastPath = new FastPathRouter();
const permissions = new PermissionsGateway(CONFIG_PATH);
const haClient = new HomeAssistantClient(HA_URL, HA_TOKEN);
const jellyfinClient = new JellyfinClient(JELLYFIN_URL, JELLYFIN_KEY);
const webOSManager = new LGWebOSManager(haClient, jellyfinClient, TV_ENTITY);
const ollamaAgent = new OllamaAgent(OLLAMA_URL, LLM_MODEL);
const reminderStore = new ReminderStore(DATA_DIR);
const agendaDaemon = new AgendaDaemon(reminderStore, webOSManager, haClient);
const telephonyManager = new TelephonyManager(SPOOL_DIR);

// Registered Tool Schemas for Qwen 2.5 Fallback
const TOOL_SCHEMAS = [
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
          recipient: { type: 'string', description: 'Name or extension of recipient (e.g. Sultan, Desk, 1001, 1002)' },
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
          action: { type: 'string', enum: ['play', 'pause', 'stop', 'next', 'previous', 'set_volume', 'volume_up', 'volume_down', 'select_source'] },
          target_player: { type: 'string' },
          volume_level: { type: 'number' },
          source: { type: 'string' },
        },
        required: ['action', 'target_player'],
      },
    },
  },
];

// Health endpoint for Caddy & Docker
fastify.get('/api/health', async () => {
  return {
    status: 'ok',
    service: 'neptune-backend',
    version: '0.7.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  };
});

// Detailed system status endpoint
fastify.get('/api/status', async () => {
  return {
    system: 'Neptune-AI',
    phase: 'Phase 7 Operational: Multi-Person Voice, Telephony, Universal Reminders & Audio Routing',
    engine: {
      fast_path_latency_target: '< 5 ms',
      llm_model: LLM_MODEL,
      ollama_url: OLLAMA_URL,
    },
    integrations: {
      home_assistant: { url: HA_URL, configured: Boolean(HA_TOKEN) },
      lg_webos: 'Integrated via Home Assistant webostv & Jellyfin',
      speech: { stt: 'Wyoming Whisper (10300)', tts: 'Wyoming Piper (10200)' },
      telephony: { pbx: 'Asterisk PJSIP', contacts: CONTACT_DIRECTORY.length },
      reminders: { active_count: reminderStore.listActive().length },
    },
  };
});

// CONTACTS ENDPOINT
fastify.get('/api/contacts', async () => {
  return { contacts: CONTACT_DIRECTORY };
});

// TV STATE & SOUND ROUTING REST ENDPOINTS
fastify.get('/api/tv/state', async () => {
  const state = await webOSManager.getPlaybackState();
  return state;
});

fastify.post('/api/tv/sound-output', async (request: FastifyRequest<{ Body: { sound_output: string } }>, reply: FastifyReply) => {
  const { sound_output } = request.body || {};
  if (!sound_output) {
    return reply.status(400).send({ error: 'Missing "sound_output" in request body.' });
  }
  const result = await webOSManager.selectSoundOutput(sound_output);
  return result;
});

// TELEPHONY OUTBOUND CALL ENDPOINT
fastify.post('/api/telephony/call', async (request: FastifyRequest<{ Body: { to: string; message: string; from?: string } }>, reply: FastifyReply) => {
  const { to, message, from } = request.body || {};
  if (!to || !message) {
    return reply.status(400).send({ error: 'Missing "to" or "message" in request body.' });
  }
  const result = await telephonyManager.dispatchCallMessage({
    recipientQuery: to,
    message: message,
    senderName: from || 'Neptune',
  });
  return result;
});

// REMINDERS & AGENDA REST ENDPOINTS
fastify.get('/api/reminders', async () => {
  return {
    active: reminderStore.listActive(),
    recent: reminderStore.listRecent(15),
  };
});

fastify.post('/api/reminders', async (
  request: FastifyRequest<{
    Body: {
      title: string;
      duration_minutes: number;
      channels?: string[];
      source?: 'phone_call' | 'web_cockpit' | 'api' | 'voice_assistant';
      created_by?: string;
      target_person?: string;
    };
  }>,
  reply: FastifyReply
) => {
  const { title, duration_minutes, channels, source, created_by, target_person } = request.body || {};
  if (!title || typeof duration_minutes !== 'number') {
    return reply.status(400).send({ error: 'Missing title or duration_minutes.' });
  }
  const rem = reminderStore.create(
    title,
    duration_minutes,
    channels || ['tv', 'speaker', 'call', 'web'],
    source || 'web_cockpit',
    created_by || 'Web Cockpit',
    target_person || process.env.PRIMARY_USER_NAME || 'Primary'
  );
  return { success: true, reminder: rem };
});

fastify.delete('/api/reminders/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
  const id = request.params.id;
  const deleted = reminderStore.delete(id);
  return { success: deleted };
});

// Primary Natural Language & Voice Command Intent Router
fastify.post('/api/command', async (
  request: FastifyRequest<{
    Body: {
      text: string;
      caller_id?: string;
      caller_name?: string;
    };
  }>,
  reply: FastifyReply
) => {
  const startTime = Date.now();
  const text = request.body?.text;
  const callerId = request.body?.caller_id;
  let callerName = request.body?.caller_name;

  if (!callerName && callerId) {
    const contact = getContactByExtension(callerId);
    callerName = contact ? contact.name : `Extension ${callerId}`;
  }

  if (!text || typeof text !== 'string') {
    return reply.status(400).send({ error: 'Missing or invalid "text" in request body.' });
  }

  // STAGE 1: Deterministic Fast-Path Evaluation (< 5 ms)
  const fpResult = fastPath.match(text);
  if (fpResult.matched && fpResult.domain && fpResult.entity_id && fpResult.service) {
    const perm = permissions.validate(fpResult.domain, fpResult.entity_id);
    if (!perm.allowed) {
      return {
        path: 'fast-path-rejected',
        latency_ms: Date.now() - startTime,
        speech: `I cannot execute that command: ${perm.reason}`,
        success: false,
      };
    }

    if (perm.requires_confirmation) {
      return {
        path: 'fast-path-confirmation-required',
        latency_ms: Date.now() - startTime,
        speech: `Are you sure you want to perform that action on ${fpResult.entity_id}?`,
        requires_confirmation: true,
        action: fpResult,
      };
    }

    // 1. Proactive Telephony Call & Message Delivery
    if (fpResult.intent === 'telephony_call_message' && fpResult.data?.recipient && fpResult.data?.message) {
      const sender = callerName || process.env.PRIMARY_USER_NAME || 'Primary';
      const callRes = await telephonyManager.dispatchCallMessage({
        recipientQuery: fpResult.data.recipient,
        message: fpResult.data.message,
        senderName: sender,
      });

      return {
        path: 'fast-path-telephony-call',
        latency_ms: Date.now() - startTime,
        speech: callRes.speech,
        success: callRes.success,
        details: callRes,
      };
    }

    // 2. TV State & "What's Playing on TV" Query
    if (fpResult.intent === 'tv_state_query') {
      const tvState = await webOSManager.getPlaybackState();
      return {
        path: 'fast-path-tv-state',
        latency_ms: Date.now() - startTime,
        speech: tvState.speech,
        success: tvState.success,
        tv_state: tvState,
      };
    }

    // 3. Route TV Audio Output (Home Speakers vs TV Speakers)
    if (fpResult.intent === 'tv_sound_output' && fpResult.data?.sound_output) {
      const soundRes = await webOSManager.selectSoundOutput(fpResult.data.sound_output);
      return {
        path: 'fast-path-tv-sound',
        latency_ms: Date.now() - startTime,
        speech: soundRes.speech,
        success: soundRes.success,
      };
    }

    // 4. Native Timer / Reminder
    if (fpResult.intent === 'set_reminder' && fpResult.data?.title && fpResult.data?.duration_minutes !== undefined) {
      const source = callerId ? 'phone_call' : 'web_cockpit';
      const createdBy = callerName ? `${callerName} (Ext ${callerId})` : 'Web Cockpit';
      const targetPerson = callerName || process.env.PRIMARY_USER_NAME || 'Primary';

      const reminder = reminderStore.create(
        fpResult.data.title,
        fpResult.data.duration_minutes,
        ['tv', 'speaker', 'call', 'web'],
        source,
        createdBy,
        targetPerson
      );

      // Dispatch to Home Assistant native timer if available
      try {
        await haClient.callService('timer', 'start', 'timer.neptune_timer', {
          duration: fpResult.data.ha_duration || 60,
        });
      } catch (e) {
        // Soft fallback
      }

      return {
        path: 'fast-path-reminder',
        latency_ms: Date.now() - startTime,
        speech: fpResult.confirmation_speech,
        success: true,
        reminder,
      };
    }

    // 5. Whole-House Speaker Broadcast
    if (fpResult.intent === 'whole_house_broadcast' && fpResult.data?.message) {
      const haRes = await haClient.callService('tts', 'speak', 'tts.google_translate_en_com', {
        media_player_entity_id: SPEAKER_ENTITY,
        message: fpResult.data.message,
      });
      return {
        path: 'fast-path-broadcast',
        latency_ms: Date.now() - startTime,
        speech: fpResult.confirmation_speech,
        success: haRes.success,
      };
    }

    // 6. TV Entertainment Media Playback (Jellyfin -> TV)
    if (fpResult.intent === 'tv_media' && fpResult.data?.media_title) {
      const tvRes = await webOSManager.playMediaOnTV(fpResult.data.media_title);
      return {
        path: 'fast-path-entertainment',
        latency_ms: Date.now() - startTime,
        speech: tvRes.speech,
        success: tvRes.success,
        details: tvRes.details,
      };
    }

    // 7. TV App Launching & Source Selection
    if (fpResult.intent === 'tv_app' && fpResult.data?.source) {
      const tvRes = await webOSManager.launchAppOrSource(fpResult.data.source);
      return {
        path: 'fast-path-app',
        latency_ms: Date.now() - startTime,
        speech: tvRes.speech,
        success: tvRes.success,
      };
    }

    // 8. TV Volume Up / Down Step
    if (fpResult.intent === 'media_volume_step') {
      const tvRes = fpResult.service === 'volume_up' ? await webOSManager.volumeUp() : await webOSManager.volumeDown();
      return {
        path: 'fast-path-volume',
        latency_ms: Date.now() - startTime,
        speech: tvRes.speech,
        success: tvRes.success,
      };
    }

    // Execute directly to Home Assistant
    const haRes = await haClient.callService(fpResult.domain, fpResult.service, fpResult.entity_id, fpResult.data);
    return {
      path: 'fast-path',
      latency_ms: Date.now() - startTime,
      speech: fpResult.confirmation_speech,
      success: haRes.success,
      details: haRes.message,
    };
  }

  // STAGE 2: LLM Reasoning Evaluation (Qwen 2.5 Fallback)
  const llmRes = await ollamaAgent.evaluate(text, TOOL_SCHEMAS);
  if (llmRes.type === 'tool' && llmRes.tool_calls) {
    const executedTools = [];

    for (const call of llmRes.tool_calls) {
      const fnName = call.function.name;
      const args = call.function.arguments;

      // LLM broadcast to whole house
      if (fnName === 'broadcast_announcement' && args?.message) {
        const haRes = await haClient.callService('tts', 'speak', 'tts.google_translate_en_com', {
          media_player_entity_id: SPEAKER_ENTITY,
          message: args.message,
        });
        executedTools.push({ tool: fnName, success: haRes.success, speech: `Broadcasting to whole house: "${args.message}".` });
        continue;
      }

      // LLM telephony call
      if (fnName === 'telephony_call' && args?.recipient && args?.message) {
        const callRes = await telephonyManager.dispatchCallMessage({
          recipientQuery: args.recipient,
          message: args.message,
          senderName: callerName || process.env.PRIMARY_USER_NAME || 'Primary',
        });
        executedTools.push({ tool: fnName, success: callRes.success, speech: callRes.speech });
        continue;
      }

      let domain = 'light';
      let service = 'turn_on';
      let entity_id = args.entity_id || 'unknown';

      if (fnName === 'ha_set_state') {
        domain = args.domain || 'light';
        service = args.state === 'on' ? 'turn_on' : args.state === 'off' ? 'turn_off' : 'toggle';
      } else if (fnName === 'ha_set_climate') {
        domain = 'climate';
        service = args.temperature ? 'set_temperature' : 'set_hvac_mode';
      } else if (fnName === 'media_control') {
        domain = 'media_player';
        entity_id = args.target_player || TV_ENTITY;
        if (args.action === 'volume_up') {
          service = 'volume_up';
        } else if (args.action === 'volume_down') {
          service = 'volume_down';
        } else if (args.action === 'select_source' && args.source) {
          service = 'select_source';
          args.source = webOSManager.normalizeSourceName(args.source);
        } else {
          service = args.action === 'play' ? 'media_play' : args.action === 'pause' ? 'media_pause' : args.action;
        }
      }

      const perm = permissions.validate(domain, entity_id);
      if (perm.allowed && !perm.requires_confirmation) {
        const haRes = await haClient.callService(domain, service, entity_id, args);
        executedTools.push({ tool: fnName, entity_id, success: haRes.success });
      } else {
        executedTools.push({ tool: fnName, entity_id, success: false, reason: perm.reason });
      }
    }

    return {
      path: 'llm-tool-call',
      latency_ms: Date.now() - startTime,
      speech: 'Command processed.',
      executed_tools: executedTools,
    };
  }

  // STAGE 3: Conversational Answer
  return {
    path: 'llm-conversational',
    latency_ms: Date.now() - startTime,
    speech: llmRes.content,
  };
});

async function start() {
  try {
    agendaDaemon.start(3000); // Check every 3 seconds for active reminders
    await fastify.listen({ port: PORT, host: HOST });
    fastify.log.info(`Neptune-AI Core Backend listening on http://${HOST}:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

// Graceful shutdown
['SIGINT', 'SIGTERM'].forEach((signal) => {
  process.on(signal as NodeJS.Signals, async () => {
    fastify.log.info(`Received ${signal}, closing gracefully...`);
    agendaDaemon.stop();
    await fastify.close();
    process.exit(0);
  });
});

start();
