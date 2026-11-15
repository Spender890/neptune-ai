import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import * as https from 'node:https';

import { FastPathRouter } from '../src/fastpath';
import { PermissionsGateway } from '../src/permissions';
import { loadContacts, resolveContact, getContactByExtension } from '../src/contacts';
import { ReminderStore } from '../src/reminders';
import { AgendaDaemon } from '../src/agenda';
import { TelephonyManager } from '../src/telephony';
import { HomeAssistantClient } from '../src/homeassistant';
import { JellyfinClient } from '../src/jellyfin';
import { LGWebOSManager } from '../src/webos';
import { OllamaAgent } from '../src/ollama';
import { performHttpRequest, resolveHttpTransport, setHttpRequester } from '../src/httpClient';
import { NeptuneEngine } from '../src/engine';
import { verifyApiKey, registerRoutes } from '../src/index';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeTempJson(dir: string, filename: string, data: unknown): string {
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  return filePath;
}

describe('FastPathRouter', () => {
  const router = new FastPathRouter('media_player.custom_tv', 'media_player.custom_speaker');

  it('matches light and switch toggle commands deterministically', () => {
    const kitchen = router.match('Please turn off the kitchen light.');
    assert.equal(kitchen.matched, true);
    assert.equal(kitchen.domain, 'light');
    assert.equal(kitchen.service, 'turn_off');
    assert.equal(kitchen.entity_id, 'light.kitchen');

    const fan = router.match('switch on desk fan');
    assert.equal(fan.matched, true);
    assert.equal(fan.domain, 'switch');
    assert.equal(fan.service, 'turn_on');
    assert.equal(fan.entity_id, 'switch.desk');

    const defaultLight = router.match('turn off the light');
    assert.equal(defaultLight.matched, true);
    assert.equal(defaultLight.entity_id, 'light.living_room');
  });

  it('uses configured TV and speaker entity IDs', () => {
    const tvState = router.match('what is playing on tv?');
    assert.equal(tvState.matched, true);
    assert.equal(tvState.intent, 'tv_state_query');
    assert.equal(tvState.entity_id, 'media_player.custom_tv');

    const broadcast = router.match('broadcast dinner is ready');
    assert.equal(broadcast.matched, true);
    assert.equal(broadcast.intent, 'whole_house_broadcast');
    assert.equal(broadcast.data?.media_player_entity_id, 'media_player.custom_speaker');

    const pauseSpeaker = router.match('pause the speaker');
    assert.equal(pauseSpeaker.matched, true);
    assert.equal(pauseSpeaker.entity_id, 'media_player.custom_speaker');
  });

  it('matches TV audio routing, playback, apps, and volume commands', () => {
    const arc = router.match('route tv audio through home speakers');
    assert.equal(arc.matched, true);
    assert.equal(arc.intent, 'tv_sound_output');
    assert.equal(arc.data?.sound_output, 'external_arc');

    const internal = router.match('switch tv audio back to tv speakers');
    assert.equal(internal.matched, true);
    assert.equal(internal.data?.sound_output, 'tv_speaker');

    const volClamp = router.match('set tv volume to 150');
    assert.equal(volClamp.matched, true);
    assert.equal(volClamp.data?.volume_level, 1);

    const yt = router.match('launch youtube on tv');
    assert.equal(yt.matched, true);
    assert.equal(yt.intent, 'tv_app');
    assert.equal(yt.data?.source, 'youtube');

    const jelly = router.match('play zootopia on tv');
    assert.equal(jelly.matched, true);
    assert.equal(jelly.intent, 'tv_media');
    assert.equal(jelly.data?.media_title, 'zootopia');

    const toast = router.match('show toast on tv saying Dinner is served');
    assert.equal(toast.matched, true);
    assert.equal(toast.intent, 'tv_toast');
    assert.deepEqual(toast.data?.payload, { message: 'dinner is served' });
  });

  it('matches climate, outbound calls, and reminders/timers', () => {
    const climate = router.match('set thermostat to 22 degrees');
    assert.equal(climate.matched, true);
    assert.equal(climate.domain, 'climate');
    assert.deepEqual(climate.data, { temperature: 22 });

    const call = router.match('call desk and tell them dinner is ready');
    assert.equal(call.matched, true);
    assert.equal(call.intent, 'telephony_call_message');
    assert.equal(call.data?.recipient, 'desk');
    assert.equal(call.data?.message, 'dinner is ready');

    const rem = router.match('remind me to check the oven in 1 minute');
    assert.equal(rem.matched, true);
    assert.equal(rem.intent, 'set_reminder');
    assert.equal(rem.data?.title, 'check the oven');
    assert.equal(rem.data?.duration_minutes, 1);

    const timer = router.match('set timer for 30 seconds to steep tea');
    assert.equal(timer.matched, true);
    assert.equal(timer.data?.duration_seconds, 30);

    const zeroTimer = router.match('set timer for 0 minutes to test');
    assert.equal(zeroTimer.matched, false);
  });

  it('deterministically captures consequential lock and cover commands', () => {
    const unlock = router.match('unlock the front door');
    assert.equal(unlock.matched, true);
    assert.equal(unlock.domain, 'lock');
    assert.equal(unlock.entity_id, 'lock.front_door');
    assert.equal(unlock.requires_confirmation, true);

    const garage = router.match('open the garage door');
    assert.equal(garage.matched, true);
    assert.equal(garage.domain, 'cover');
    assert.equal(garage.entity_id, 'cover.garage_door');
    assert.equal(garage.requires_confirmation, true);
  });

  it('routes TV power before light toggle and normalizes lock and cover aliases', () => {
    const tvOn = router.match('turn on the tv');
    assert.equal(tvOn.matched, true);
    assert.equal(tvOn.intent, 'tv_power');
    assert.equal(tvOn.domain, 'media_player');
    assert.equal(tvOn.service, 'turn_on');
    assert.equal(tvOn.entity_id, 'media_player.custom_tv');

    const tvOff = router.match('turn off the tv');
    assert.equal(tvOff.matched, true);
    assert.equal(tvOff.intent, 'tv_power');
    assert.equal(tvOff.domain, 'media_player');
    assert.equal(tvOff.service, 'turn_off');
    assert.equal(tvOff.entity_id, 'media_player.custom_tv');

    const unlockAlias = router.match('unlock the front door lock');
    assert.equal(unlockAlias.matched, true);
    assert.equal(unlockAlias.domain, 'lock');
    assert.equal(unlockAlias.entity_id, 'lock.front_door');
    assert.equal(unlockAlias.requires_confirmation, true);

    const garageAlias = router.match('open the garage');
    assert.equal(garageAlias.matched, true);
    assert.equal(garageAlias.domain, 'cover');
    assert.equal(garageAlias.entity_id, 'cover.garage_door');
    assert.equal(garageAlias.requires_confirmation, true);
  });

  it('rejects conversational queries, empty strings, and oversized input cleanly', () => {
    assert.equal(router.match('What is the speed of light in vacuum?').matched, false);
    assert.equal(router.match('   ').matched, false);
    assert.equal(router.match('a'.repeat(501)).matched, false);
  });
});

describe('PermissionsGateway', () => {
  it('enforces entity allowlist, domain allowlist, and consequential confirmation', () => {
    const dir = makeTempDir('neptune-perm-');
    try {
      const cfgPath = writeTempJson(dir, 'allowed.json', {
        allowed_entities: ['light.kitchen', 'light.bedroom_*'],
        allowed_domains: ['light', 'switch'],
        consequential_entities: ['lock.*', 'cover.garage_door'],
      });
      const gw = new PermissionsGateway(cfgPath);

      assert.deepEqual(gw.validate('light', 'light.kitchen'), {
        allowed: true,
        requires_confirmation: false,
      });

      assert.deepEqual(gw.validate('light', 'light.bedroom_lamp'), {
        allowed: true,
        requires_confirmation: false,
      });

      // Prevent implicit prefix bypass
      const prefixAttack = gw.validate('light', 'light.kitchen_override');
      assert.equal(prefixAttack.allowed, false);

      // Consequential entities (exact and trailing wildcard) must trigger requires_confirmation
      const lockCheck = gw.validate('lock', 'lock.front_door');
      assert.equal(lockCheck.allowed, true);
      assert.equal(lockCheck.requires_confirmation, true);

      const wildcardLockCheck = gw.validate('lock', 'lock.back_door');
      assert.equal(wildcardLockCheck.allowed, true);
      assert.equal(wildcardLockCheck.requires_confirmation, true);

      const garageCheck = gw.validate('cover', 'cover.garage_door');
      assert.equal(garageCheck.allowed, true);
      assert.equal(garageCheck.requires_confirmation, true);

      // Disallowed domain
      const autoCheck = gw.validate('automation', 'automation.evil');
      assert.equal(autoCheck.allowed, false);

      // Malformed / traversal identifiers
      assert.equal(gw.validate('../api', 'light.kitchen').allowed, false);
      assert.equal(gw.validate('light', 'light.kitchen/../../secrets').allowed, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Contacts Directory & Resolution', () => {
  it('loads custom contacts and resolves names, aliases, and extensions without substring false positives', () => {
    const dir = makeTempDir('neptune-contacts-');
    try {
      const customPath = writeTempJson(dir, 'contacts.json', [
        { id: 'me', name: 'Me', extension: '1001', role: 'Mobile', aliases: ['me', 'alex', 'my phone'] },
        { id: 'desk', name: 'Desk', extension: '1002', role: 'Desk', aliases: ['desk', 'office'] },
        { id: 'ai', name: 'Neptune AI', extension: '7000', role: 'AI', aliases: ['ai', 'neptune'] },
      ]);
      const contacts = loadContacts(customPath);
      assert.equal(contacts.length, 3);
      assert.equal(resolveContact('my phone', contacts)?.extension, '1001');
      assert.equal(resolveContact('Desk!', contacts)?.extension, '1002');
      assert.equal(resolveContact('call desk please', contacts)?.extension, '1002');
      assert.equal(getContactByExtension('1001', contacts)?.name, 'Me');
      assert.equal(resolveContact('james', contacts), undefined);
      assert.equal(resolveContact('claire', contacts), undefined);
      assert.equal(resolveContact('a', contacts), undefined);
      assert.equal(resolveContact('unknown_person', contacts), undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ReminderStore & AgendaDaemon', () => {
  it('persists reminders atomically and validates inputs', () => {
    const dir = makeTempDir('neptune-rem-');
    try {
      const store = new ReminderStore(dir);
      const created = store.create('Check\noven', 5, ['tv', 'web'], 'web_cockpit', 'Tester', 'Alex');
      assert.equal(created.title, 'Check oven');
      assert.equal(store.listActive().length, 1);

      const reloaded = new ReminderStore(dir);
      assert.equal(reloaded.listActive().length, 1);
      assert.equal(reloaded.listActive()[0].id, created.id);

      assert.throws(() => store.create('   ', 5));
      assert.throws(() => store.create('Valid', 0));
      assert.throws(() => store.create('Valid', -2));

      assert.equal(reloaded.delete(created.id), true);
      assert.equal(reloaded.listActive().length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dispatches due reminders once and sanitizes Asterisk .call files against injection', async () => {
    const dir = makeTempDir('neptune-agenda-');
    const spoolDir = path.join(dir, 'outgoing');
    fs.mkdirSync(spoolDir, { recursive: true });

    const haCalls: Array<{ domain: string; service: string; data: Record<string, unknown> }> = [];
    setHttpRequester(async (urlString, opts) => {
      const parsedUrl = new URL(urlString);
      const parts = parsedUrl.pathname.split('/');
      const bodyObj = opts.body ? JSON.parse(opts.body) : {};
      haCalls.push({
        domain: parts[3],
        service: parts[4],
        data: bodyObj,
      });
      return { ok: true, statusCode: 200, body: '{}' };
    });

    try {
      const store = new ReminderStore(dir);
      const ha = new HomeAssistantClient('https://ha.local:8123', 'test-token');
      const jf = new JellyfinClient('http://jf.local:8096', '');
      const webos = new LGWebOSManager(ha, jf, 'media_player.living_room_tv');
      const daemon = new AgendaDaemon(store, webos, ha, 'media_player.custom_speaker', spoolDir);

      let callbackCount = 0;
      daemon.setTriggerCallback(() => {
        callbackCount += 1;
      });

      const rem = store.create(
        'Check oven\nApplication: System\nData: evil',
        0.0001,
        ['tv', 'speaker', 'call', 'web'],
        'web_cockpit',
        'Tester',
        'Desk'
      );
      rem.due_at = Date.now() - 1000;

      await Promise.all([daemon.tick(), daemon.tick()]);

      assert.equal(store.listActive().length, 0);
      assert.equal(callbackCount, 1);
      assert.equal(haCalls.length, 2);
      assert.equal(haCalls[0].domain, 'webostv');
      assert.equal(haCalls[1].domain, 'tts');
      assert.equal(haCalls[1].data.media_player_entity_id, 'media_player.custom_speaker');

      const files = fs.readdirSync(spoolDir).filter((f) => f.endsWith('.call'));
      assert.equal(files.length, 1);
      const content = fs.readFileSync(path.join(spoolDir, files[0]), 'utf-8');
      assert.match(content, /^Channel: PJSIP\/1002$/m);
      assert.equal(content.includes('\nApplication:'), false);
    } finally {
      setHttpRequester(null);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('TelephonyManager Security', () => {
  it('generates sanitized .call files for contacts and blocks emergency/external numbers', async () => {
    const dir = makeTempDir('neptune-tel-');
    try {
      const manager = new TelephonyManager(dir);

      const okRes = await manager.dispatchCallMessage({
        recipientQuery: 'desk',
        message: 'Dinner is ready\nApplication: System',
        senderName: 'Alex\nContext: evil',
      });
      assert.equal(okRes.success, true);
      assert.equal(okRes.targetExtension, '1002');
      assert.ok(okRes.callFile);
      const written = fs.readFileSync(okRes.callFile!, 'utf-8');
      assert.equal(written.includes('\nApplication:'), false);
      assert.equal(written.includes('\nContext: evil'), false);

      const emergencyRes = await manager.dispatchCallMessage({
        recipientQuery: '911',
        message: 'Test',
      });
      assert.equal(emergencyRes.success, false);
      assert.match(emergencyRes.speech, /prohibited/i);

      const externalRes = await manager.dispatchCallMessage({
        recipientQuery: '15551234567',
        message: 'Spam call',
      });
      assert.equal(externalRes.success, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('HttpClient & Upstream Clients', () => {
  it('selects http vs https transports and rejects unsupported protocols', async () => {
    assert.equal(resolveHttpTransport('http:').request, http.request);
    assert.equal(resolveHttpTransport('https:').request, https.request);

    const badProto = await performHttpRequest('ftp://example.com/file', { method: 'GET' });
    assert.equal(badProto.ok, false);
    assert.match(badProto.error || '', /Unsupported URL protocol/);
  });

  it('rejects malformed HA identifiers and handles upstream timeouts/errors', async () => {
    const ha = new HomeAssistantClient('http://ha.local:8123', 'tok');
    const badService = await ha.callService('../evil', 'turn_on', 'light.kitchen');
    assert.equal(badService.success, false);
    assert.match(badService.message, /Rejected invalid/);

    setHttpRequester(async () => ({ ok: false, body: '', error: 'Request timed out (4000ms).', timedOut: true }));
    try {
      const timeoutRes = await ha.getState('light.kitchen');
      assert.equal(timeoutRes.success, false);
      assert.match(timeoutRes.message || '', /timed out/);

      const ollama = new OllamaAgent('http://ollama.local:11434', 'qwen2.5:3b');
      const llmErr = await ollama.evaluate('hello');
      assert.equal(llmErr.type, 'conversational');
      assert.match(llmErr.content || '', /timed out/);
    } finally {
      setHttpRequester(null);
    }
  });
});

describe('NeptuneEngine End-to-End Mock Routing', () => {
  it('routes FastPath, consequential confirmation, LLM tool calls, and conversational fallback', async () => {
    const dir = makeTempDir('neptune-engine-');
    const haRequests: Array<{ method: string; pathname: string; auth?: string | number; body: string }> = [];
    const ollamaRequests: Array<{ body: string }> = [];

    setHttpRequester(async (urlString, opts) => {
      const urlObj = new URL(urlString);
      if (urlObj.hostname === 'ha.local') {
        haRequests.push({
          method: opts.method,
          pathname: urlObj.pathname,
          auth: opts.headers?.Authorization,
          body: opts.body || '',
        });
        if (urlObj.pathname === '/api/states/media_player.living_room_tv') {
          return {
            ok: true,
            statusCode: 200,
            body: JSON.stringify({
              state: 'playing',
              attributes: {
                source: 'Jellyfin',
                volume_level: 0.35,
                is_volume_muted: false,
                sound_output: 'external_arc',
              },
            }),
          };
        }
        return { ok: true, statusCode: 200, body: JSON.stringify([{ entity_id: 'light.kitchen' }]) };
      }

      if (urlObj.hostname === 'jf.local') {
        if (urlObj.pathname === '/Items') {
          return {
            ok: true,
            statusCode: 200,
            body: JSON.stringify({ Items: [{ Id: 'item-1', Name: 'Zootopia', Type: 'Movie' }] }),
          };
        }
        if (urlObj.pathname === '/Sessions') {
          return {
            ok: true,
            statusCode: 200,
            body: JSON.stringify([
              {
                Id: 'sess-1',
                DeviceName: 'LG Smart TV',
                Client: 'Jellyfin Web',
                SupportsRemoteControl: true,
                NowPlayingItem: { Name: 'Zootopia' },
              },
            ]),
          };
        }
        if (urlObj.pathname === '/Sessions/sess-1/Playing') {
          return { ok: true, statusCode: 204, body: '' };
        }
        return { ok: false, statusCode: 404, body: '' };
      }

      if (urlObj.hostname === 'ollama.local') {
        ollamaRequests.push({ body: opts.body || '' });
        const parsed = JSON.parse(opts.body || '{}');
        const prompt = parsed.messages?.[1]?.content || '';

        if (prompt.includes('living room lamp')) {
          return {
            ok: true,
            statusCode: 200,
            body: JSON.stringify({
              message: {
                tool_calls: [
                  {
                    function: {
                      name: 'ha_set_state',
                      arguments: { domain: 'light', entity_id: 'light.living_room', state: 'on' },
                    },
                  },
                ],
              },
            }),
          };
        }

        if (prompt.includes('secure door')) {
          return {
            ok: true,
            statusCode: 200,
            body: JSON.stringify({
              message: {
                tool_calls: [
                  {
                    function: {
                      name: 'ha_set_state',
                      arguments: { domain: 'lock', entity_id: 'lock.front_door', state: 'off' },
                    },
                  },
                ],
              },
            }),
          };
        }

        return {
          ok: true,
          statusCode: 200,
          body: JSON.stringify({ message: { content: 'The speed of light is roughly 299,792 km/s.' } }),
        };
      }

      return { ok: false, statusCode: 404, body: '' };
    });

    try {
      const cfgPath = writeTempJson(dir, 'allowed_entities.json', {
        allowed_entities: ['light.kitchen', 'light.living_room', 'media_player.living_room_tv'],
        allowed_domains: ['light', 'switch', 'climate', 'media_player', 'webostv', 'timer', 'tts', 'asterisk'],
        consequential_entities: ['lock.front_door', 'cover.garage_door'],
      });

      const engine = new NeptuneEngine({
        config: {
          configPath: cfgPath,
          dataDir: dir,
          spoolDir: path.join(dir, 'spool'),
          haUrl: 'https://ha.local:8123',
          haToken: 'secret-ha-token',
          jellyfinUrl: 'http://jf.local:8096',
          jellyfinKey: 'secret-jf-key',
          ollamaUrl: 'http://ollama.local:11434',
          tvEntity: 'media_player.living_room_tv',
          speakerEntity: 'media_player.living_room_vlc_telnet',
        },
      });

      // 1. FastPath bypasses Ollama and calls HA with Bearer token
      const fpRes = await engine.handleCommand({ text: 'turn off the kitchen light' });
      assert.equal(fpRes.statusCode, 200);
      assert.equal(fpRes.body.path, 'fast-path');
      assert.equal(fpRes.body.success, true);
      assert.equal(ollamaRequests.length, 0);
      assert.equal(haRequests[0].auth, 'Bearer secret-ha-token');

      // 2. FastPath consequential lock never calls HA
      const haCountBeforeLock = haRequests.length;
      const lockRes = await engine.handleCommand({ text: 'unlock the front door' });
      assert.equal(lockRes.statusCode, 200);
      assert.equal(lockRes.body.path, 'fast-path-confirmation-required');
      assert.equal(lockRes.body.requires_confirmation, true);
      assert.equal(haRequests.length, haCountBeforeLock);

      // 3. TV state enrichment combining HA + Jellyfin
      const tvStateRes = await engine.handleCommand({ text: 'what is playing on tv' });
      assert.equal(tvStateRes.body.path, 'fast-path-tv-state');
      assert.equal((tvStateRes.body.tv_state as { title?: string }).title, 'Zootopia');

      // 4. Jellyfin media search + TV playback
      const playRes = await engine.handleCommand({ text: 'play zootopia on tv' });
      assert.equal(playRes.body.path, 'fast-path-entertainment');
      assert.equal(playRes.body.success, true);

      // 5. LLM tool call for allowed entity
      const llmToolRes = await engine.handleCommand({ text: 'could you please illuminate the living room lamp' });
      assert.equal(llmToolRes.body.path, 'llm-tool-call');
      assert.equal((llmToolRes.body.executed_tools as Array<{ success: boolean }>)[0].success, true);

      // 6. LLM tool call hitting consequential entity is blocked and flags requires_confirmation
      const haCountBeforeLlmLock = haRequests.length;
      const llmLockRes = await engine.handleCommand({ text: 'please handle the secure door now' });
      assert.equal(llmLockRes.body.path, 'llm-tool-call');
      assert.equal(llmLockRes.body.requires_confirmation, true);
      assert.equal(haRequests.length, haCountBeforeLlmLock);

      // 7. LLM conversational fallback
      const convRes = await engine.handleCommand({ text: 'What is the speed of light?' });
      assert.equal(convRes.body.path, 'llm-conversational');
      assert.match(String(convRes.body.speech), /299,792/);

      // 8. Validation errors
      assert.equal((await engine.handleCommand({ text: '' })).statusCode, 400);
      assert.equal((await engine.handleCommand({ text: 'a'.repeat(1001) })).statusCode, 400);
      assert.equal((await engine.setTVSoundOutput('invalid_output')).statusCode, 400);
      assert.equal(engine.createReminder({ title: 'Test', duration_minutes: -5 }).statusCode, 400);
    } finally {
      setHttpRequester(null);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads default config path, supports HOMEASSISTANT_URL env vars, handles tv_power, and strips extra LLM tool keys', async () => {
    const dir = makeTempDir('neptune-engine-defaults-');
    const haCalls: Array<{ pathname: string; auth?: string | number; body: Record<string, unknown> }> = [];
    let llmCallIndex = 0;

    const prevEnv: Record<string, string | undefined> = {
      HA_URL: process.env.HA_URL,
      HA_TOKEN: process.env.HA_TOKEN,
      HOMEASSISTANT_URL: process.env.HOMEASSISTANT_URL,
      HOMEASSISTANT_TOKEN: process.env.HOMEASSISTANT_TOKEN,
    };

    delete process.env.HA_URL;
    delete process.env.HA_TOKEN;
    process.env.HOMEASSISTANT_URL = 'https://ha-env.local:8123';
    process.env.HOMEASSISTANT_TOKEN = 'env-homeassistant-token';

    setHttpRequester(async (urlString, opts) => {
      const urlObj = new URL(urlString);
      if (urlObj.hostname === 'ha-env.local') {
        const parsedBody = opts.body ? (JSON.parse(opts.body) as Record<string, unknown>) : {};
        haCalls.push({
          pathname: urlObj.pathname,
          auth: opts.headers?.Authorization,
          body: parsedBody,
        });
        return { ok: true, statusCode: 200, body: '{}' };
      }

      if (urlObj.hostname === 'ollama-env.local') {
        llmCallIndex += 1;
        if (llmCallIndex === 1) {
          return {
            ok: true,
            statusCode: 200,
            body: JSON.stringify({
              message: {
                tool_calls: [
                  {
                    function: {
                      name: 'ha_set_state',
                      arguments: { domain: 'light', entity_id: 'light.living_room', state: 'on' },
                    },
                  },
                ],
              },
            }),
          };
        }
        if (llmCallIndex === 2) {
          return {
            ok: true,
            statusCode: 200,
            body: JSON.stringify({
              message: {
                tool_calls: [
                  {
                    function: {
                      name: 'ha_set_state',
                      arguments: { domain: 'light', entity_id: 'light.unlisted_secret', state: 'off' },
                    },
                  },
                ],
              },
            }),
          };
        }
        return {
          ok: true,
          statusCode: 200,
          body: JSON.stringify({
            message: {
              tool_calls: [
                {
                  function: {
                    name: 'media_control',
                    arguments: { action: 'set_volume', volume_level: 0.4, target_player: 'tv' },
                  },
                },
                {
                  function: {
                    name: 'media_control',
                    arguments: { action: 'stop', target_player: 'speaker' },
                  },
                },
              ],
            },
          }),
        };
      }

      return { ok: false, statusCode: 404, body: '' };
    });

    try {
      const engine = new NeptuneEngine({
        config: {
          dataDir: dir,
          spoolDir: path.join(dir, 'spool'),
          ollamaUrl: 'http://ollama-env.local:11434',
          tvEntity: 'media_player.living_room_tv',
          speakerEntity: 'media_player.living_room_speaker',
        },
      });

      const tvOnRes = await engine.handleCommand({ text: 'turn on the tv' });
      assert.equal(tvOnRes.statusCode, 200);
      assert.equal(tvOnRes.body.path, 'fast-path');
      assert.equal(haCalls.length, 1);
      assert.equal(haCalls[0].pathname, '/api/services/media_player/turn_on');
      assert.equal(haCalls[0].auth, 'Bearer env-homeassistant-token');
      assert.deepEqual(haCalls[0].body, { entity_id: 'media_player.living_room_tv' });

      const allowedLlm = await engine.handleCommand({ text: 'ambient atmosphere preset one' });
      assert.ok(
        Array.isArray(allowedLlm.body.executed_tools),
        `Expected executed_tools for preset one, got: ${JSON.stringify(allowedLlm.body)}`,
      );
      assert.equal((allowedLlm.body.executed_tools as Array<{ success: boolean }>)[0].success, true);
      assert.equal(haCalls.length, 2);
      assert.equal(haCalls[1].pathname, '/api/services/light/turn_on');
      assert.deepEqual(haCalls[1].body, { entity_id: 'light.living_room' });

      const blockedUnlisted = await engine.handleCommand({ text: 'ambient atmosphere preset two' });
      assert.ok(
        Array.isArray(blockedUnlisted.body.executed_tools),
        `Expected executed_tools for preset two, got: ${JSON.stringify(blockedUnlisted.body)}`,
      );
      assert.equal((blockedUnlisted.body.executed_tools as Array<{ success: boolean }>)[0].success, false);
      assert.equal(haCalls.length, 2);

      const mediaTools = await engine.handleCommand({ text: 'ambient atmosphere preset three' });
      assert.ok(
        Array.isArray(mediaTools.body.executed_tools),
        `Expected executed_tools for preset three, got: ${JSON.stringify(mediaTools.body)}`,
      );
      const results = mediaTools.body.executed_tools as Array<{ success: boolean }>;
      assert.equal(results.length, 2);
      assert.equal(results[0].success, true, `Expected media tool 0 success, got: ${JSON.stringify(results)}`);
      assert.equal(results[1].success, true, `Expected media tool 1 success, got: ${JSON.stringify(results)}`);
      assert.equal(haCalls.length, 4);
      assert.equal(haCalls[2].pathname, '/api/services/media_player/volume_set');
      assert.deepEqual(haCalls[2].body, { entity_id: 'media_player.living_room_tv', volume_level: 0.4 });
      assert.equal(haCalls[3].pathname, '/api/services/media_player/media_stop');
      assert.deepEqual(haCalls[3].body, { entity_id: 'media_player.living_room_speaker' });
    } finally {
      setHttpRequester(null);
      for (const [key, val] of Object.entries(prevEnv)) {
        if (val === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = val;
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('API Auth & Route Registration', () => {
  it('verifies API keys safely and executes registered auth hooks and route handlers', async () => {
    assert.equal(verifyApiKey({}, ''), true);
    assert.equal(verifyApiKey({ 'x-api-key': 'secret123' }, 'secret123'), true);
    assert.equal(verifyApiKey({ authorization: 'Bearer secret123' }, 'secret123'), true);
    assert.equal(verifyApiKey({ 'x-api-key': 'wrong' }, 'secret123'), false);
    assert.equal(verifyApiKey({}, 'secret123'), false);

    type MockReq = {
      url: string;
      headers: Record<string, string | undefined>;
      body?: unknown;
      params?: Record<string, string>;
    };
    type MockReplyState = {
      statusCode: number;
      sent: unknown;
      hasSent: boolean;
      code: (status: number) => MockReplyState;
      status: (status: number) => MockReplyState;
      send: (payload: unknown) => MockReplyState;
    };
    type HookHandler = (request: MockReq, reply: MockReplyState) => Promise<unknown> | unknown;
    type RouteHandler = (request: MockReq, reply: MockReplyState) => Promise<unknown> | unknown;

    const createReply = (): MockReplyState => {
      const state: MockReplyState = {
        statusCode: 200,
        sent: undefined,
        hasSent: false,
        code(status: number) {
          state.statusCode = status;
          return state;
        },
        status(status: number) {
          state.statusCode = status;
          return state;
        },
        send(payload: unknown) {
          state.sent = payload;
          state.hasSent = true;
          return state;
        },
      };
      return state;
    };

    const routes: Array<{ method: string; url: string; handler: RouteHandler }> = [];
    const hooks: Array<{ name: string; handler: HookHandler }> = [];
    const mockFastify = {
      addHook(name: string, handler: HookHandler) {
        hooks.push({ name, handler });
      },
      setErrorHandler() {
        /* noop */
      },
      get(url: string, handler: RouteHandler) {
        routes.push({ method: 'GET', url, handler });
      },
      post(url: string, handler: RouteHandler) {
        routes.push({ method: 'POST', url, handler });
      },
      delete(url: string, handler: RouteHandler) {
        routes.push({ method: 'DELETE', url, handler });
      },
    };

    const dir = makeTempDir('neptune-routes-');
    try {
      const engine = new NeptuneEngine({
        config: { dataDir: dir, apiKey: 'test-key' },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registerRoutes(mockFastify as any, engine);
      assert.equal(hooks.some((h) => h.name === 'onRequest'), true);
      assert.equal(routes.some((r) => r.method === 'GET' && r.url === '/api/health'), true);
      assert.equal(routes.some((r) => r.method === 'POST' && r.url === '/api/command'), true);
      assert.equal(routes.some((r) => r.method === 'POST' && r.url === '/api/reminders'), true);
      assert.equal(routes.some((r) => r.method === 'DELETE' && r.url === '/api/reminders/:id'), true);
      assert.equal(routes.some((r) => r.method === 'POST' && r.url === '/api/telephony/call'), true);
      assert.equal(routes.some((r) => r.method === 'POST' && r.url === '/api/tv/sound-output'), true);
      assert.equal(routes.length, 10);

      const onRequest = hooks.find((h) => h.name === 'onRequest')?.handler;
      assert.ok(onRequest);

      const healthHookReply = createReply();
      await onRequest({ url: '/api/health?probe=1', headers: {} }, healthHookReply);
      assert.equal(healthHookReply.hasSent, false);

      const unauthReply = createReply();
      await onRequest({ url: '/api/status', headers: {} }, unauthReply);
      assert.equal(unauthReply.hasSent, true);
      assert.equal(unauthReply.statusCode, 401);

      const authReply = createReply();
      await onRequest({ url: '/api/status', headers: { 'x-api-key': 'test-key' } }, authReply);
      assert.equal(authReply.hasSent, false);

      const invokeRoute = async (method: string, url: string, req: Partial<MockReq> = {}) => {
        const entry = routes.find((r) => r.method === method && r.url === url);
        assert.ok(entry);
        const reply = createReply();
        const result = await entry.handler({ url, headers: {}, ...req }, reply);
        return {
          statusCode: reply.statusCode,
          body: (reply.hasSent ? reply.sent : result) as Record<string, unknown>,
        };
      };

      const healthRes = await invokeRoute('GET', '/api/health');
      assert.equal(healthRes.statusCode, 200);
      assert.equal(healthRes.body.status, 'ok');
      assert.equal(healthRes.body.version, '0.1.0');

      const statusRes = await invokeRoute('GET', '/api/status');
      assert.equal(statusRes.statusCode, 200);
      assert.equal(typeof statusRes.body, 'object');

      const badCmdRes = await invokeRoute('POST', '/api/command', { body: { text: '' } });
      assert.equal(badCmdRes.statusCode, 400);

      const badTvRes = await invokeRoute('POST', '/api/tv/sound-output', { body: { output: 'invalid' } });
      assert.equal(badTvRes.statusCode, 400);

      const createRemRes = await invokeRoute('POST', '/api/reminders', {
        body: { title: 'Water plants', duration_minutes: 10 },
      });
      assert.equal(createRemRes.statusCode >= 200 && createRemRes.statusCode < 300, true);
      const createdId =
        (createRemRes.body.reminder as { id?: string } | undefined)?.id ??
        (createRemRes.body.id as string | undefined);
      assert.ok(createdId);

      const delRemRes = await invokeRoute('DELETE', '/api/reminders/:id', { params: { id: createdId } });
      assert.equal(delRemRes.statusCode, 200);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
