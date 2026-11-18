import * as crypto from 'crypto';
import type { FastifyError, FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { NeptuneEngine } from './engine';

export { NeptuneEngine, TOOL_SCHEMAS, loadConfigFromEnv } from './engine';

/**
 * Constant-time API key verification supporting `X-API-Key` and `Authorization: Bearer <key>`.
 * When `expectedKey` is empty, API requests rely on the local network perimeter (Caddy/LAN).
 */
export function verifyApiKey(
  headers: Record<string, string | string[] | undefined>,
  expectedKey: string
): boolean {
  if (!expectedKey) {
    return true;
  }

  const rawApiKey = headers['x-api-key'];
  const rawAuth = headers['authorization'];
  let candidate = '';

  if (typeof rawApiKey === 'string' && rawApiKey.trim()) {
    candidate = rawApiKey.trim();
  } else if (typeof rawAuth === 'string' && rawAuth.startsWith('Bearer ')) {
    candidate = rawAuth.slice('Bearer '.length).trim();
  }

  if (!candidate) {
    return false;
  }

  const expectedBuf = Buffer.from(expectedKey, 'utf-8');
  const candidateBuf = Buffer.from(candidate, 'utf-8');
  if (expectedBuf.length !== candidateBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, candidateBuf);
}

/**
 * Registers all HTTP REST routes and optional API key enforcement on a Fastify instance.
 */
export function registerRoutes(fastify: FastifyInstance, engine: NeptuneEngine): void {
  if (engine.config.apiKey) {
    fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
      const requestPath = request.url.split('?')[0];
      if (requestPath === '/api/health' || requestPath === '/api/door/quick-unlock' || requestPath === '/api/intercom/ring') {
        return;
      }
      if (!verifyApiKey(request.headers as Record<string, string | string[] | undefined>, engine.config.apiKey)) {
        return reply.status(401).send({ error: 'Unauthorized: invalid or missing API key.' });
      }
    });
  }

  fastify.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    request.log.error(error);
    return reply.status(500).send({ error: 'Internal server error.' });
  });

  fastify.get('/api/health', async () => engine.getHealth());
  fastify.get('/api/status', async () => engine.getStatus());
  fastify.get('/api/contacts', async () => engine.getContacts());

  fastify.post(
    '/api/contacts',
    async (
      request: FastifyRequest<{
        Body: {
          name: string;
          extension: string;
          role?: string;
          aliases?: string[];
        };
      }>,
      reply: FastifyReply
    ) => {
      const res = engine.addContact(request.body || ({} as any));
      return reply.status(res.statusCode).send(res.body);
    }
  );

  fastify.delete(
    '/api/contacts/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const res = engine.deleteContact(request.params.id);
      return reply.status(res.statusCode).send(res.body);
    }
  );

  fastify.get('/api/tv/state', async () => engine.getTVState());

  fastify.post(
    '/api/tv/power',
    async (request: FastifyRequest<{ Body: { action?: 'on' | 'off' | 'toggle' } }>, reply: FastifyReply) => {
      const res = await engine.setTVPower(request.body?.action || 'toggle');
      return reply.status(res.statusCode).send(res.body);
    }
  );

  fastify.post(
    '/api/tv/source',
    async (request: FastifyRequest<{ Body: { source: string } }>, reply: FastifyReply) => {
      const res = await engine.setTVSource(request.body?.source);
      return reply.status(res.statusCode).send(res.body);
    }
  );

  fastify.post(
    '/api/tv/volume',
    async (
      request: FastifyRequest<{ Body: { action: 'up' | 'down' | 'mute' | 'set'; level?: number } }>,
      reply: FastifyReply
    ) => {
      const { action, level } = request.body || ({} as any);
      const res = await engine.setTVVolume(action || 'set', level);
      return reply.status(res.statusCode).send(res.body);
    }
  );

  fastify.post(
    '/api/tv/app',
    async (request: FastifyRequest<{ Body: { app: string } }>, reply: FastifyReply) => {
      const res = await engine.launchTVApp(request.body?.app);
      return reply.status(res.statusCode).send(res.body);
    }
  );

  fastify.post(
    '/api/tv/sound-output',
    async (request: FastifyRequest<{ Body: { sound_output: string } }>, reply: FastifyReply) => {
      const res = await engine.setTVSoundOutput(request.body?.sound_output);
      return reply.status(res.statusCode).send(res.body);
    }
  );

  // Hikvision Intercom & Front Door
  fastify.get('/api/intercom/status', async () => engine.getIntercomStatus());

  fastify.post(
    '/api/intercom/ring',
    async (request: FastifyRequest<{ Body: { source?: string } }>, reply: FastifyReply) => {
      const res = await engine.handleDoorbellRing(request.body?.source);
      return reply.status(res.statusCode).send(res.body);
    }
  );

  fastify.post('/api/door/unlock', async (_request: FastifyRequest, reply: FastifyReply) => {
    const res = await engine.unlockDoor();
    return reply.status(res.statusCode).send(res.body);
  });

  // Apple Watch / iOS Shortcuts 1-tap quick unlock
  fastify.get(
    '/api/door/quick-unlock',
    async (request: FastifyRequest<{ Querystring: { token?: string } }>, reply: FastifyReply) => {
      const queryToken = request.query?.token;
      const expectedToken = engine.intercomManager.config.quickDoorToken;
      if (expectedToken && queryToken !== expectedToken) {
        return reply.status(403).send({ error: 'Forbidden: Invalid quick-unlock token.' });
      }
      const res = await engine.unlockDoor();
      return reply.status(res.statusCode).send({
        status: res.statusCode === 200 ? 'success' : 'failed',
        message: 'Front door unlocked successfully!',
        details: res.body,
      });
    }
  );

  // In-Browser Voice Interaction (Whisper STT + Fast-Path/LLM + Piper TTS)
  fastify.post(
    '/api/voice/interact',
    async (
      request: FastifyRequest<{
        Body: {
          audio?: string;
          text?: string;
        };
      }>,
      reply: FastifyReply
    ) => {
      const { audio, text } = request.body || {};
      const res = await engine.handleVoiceInteract(audio, text);
      return reply.status(res.statusCode).send(res.body);
    }
  );

  fastify.post(
    '/api/telephony/call',
    async (request: FastifyRequest<{ Body: { to: string; message: string; from?: string } }>, reply: FastifyReply) => {
      const { to, message, from } = request.body || {};
      const res = await engine.placeOutboundCall(to, message, from);
      return reply.status(res.statusCode).send(res.body);
    }
  );

  fastify.get('/api/reminders', async () => engine.listReminders());

  fastify.post(
    '/api/reminders',
    async (
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
      const res = engine.createReminder(request.body || {});
      return reply.status(res.statusCode).send(res.body);
    }
  );

  fastify.delete('/api/reminders/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const res = engine.deleteReminder(request.params.id);
    return reply.status(res.statusCode).send(res.body);
  });

  fastify.post(
    '/api/command',
    async (
      request: FastifyRequest<{
        Body: {
          text: string;
          caller_id?: string;
          caller_name?: string;
        };
      }>,
      reply: FastifyReply
    ) => {
      const res = await engine.handleCommand(request.body || {});
      return reply.status(res.statusCode).send(res.body);
    }
  );
}

/**
 * Instantiates the Fastify server and registers routes without binding a network port.
 */
export function createServer(engine: NeptuneEngine = new NeptuneEngine()): {
  fastify: FastifyInstance;
  engine: NeptuneEngine;
} {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Fastify = require('fastify') as (opts?: Record<string, unknown>) => FastifyInstance;
  const fastify: FastifyInstance = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
  });

  registerRoutes(fastify, engine);
  return { fastify, engine };
}

async function start(): Promise<void> {
  const { fastify, engine } = createServer();
  const { port, host } = engine.config;

  const shutdown = async (signal: string) => {
    fastify.log.info(`Received ${signal}, closing gracefully...`);
    engine.agendaDaemon.stop();
    await fastify.close();
    process.exit(0);
  };

  (['SIGINT', 'SIGTERM'] as NodeJS.Signals[]).forEach((signal) => {
    process.on(signal, () => {
      void shutdown(signal);
    });
  });

  try {
    engine.agendaDaemon.start(3000);
    await fastify.listen({ port, host });
    fastify.log.info(`Neptune-AI Core Backend listening on http://${host}:${port}`);
  } catch (err) {
    engine.agendaDaemon.stop();
    fastify.log.error(err);
    process.exit(1);
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  void start();
}
