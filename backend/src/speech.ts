import * as cp from 'child_process';
import * as net from 'net';

export interface WyomingEvent {
  type: string;
  data: Record<string, unknown>;
  payload: Buffer;
}

/**
 * Creates standard 44-byte RIFF/WAVE header for raw linear PCM audio.
 */
export function createWavBuffer(
  pcm: Buffer,
  sampleRate: number = 22050,
  channels: number = 1,
  bitDepth: number = 16
): Buffer {
  const byteRate = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // SubChunk1Size (16 for PCM)
  header.writeUInt16LE(1, 20);  // AudioFormat (1 for PCM)
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Parses incoming Wyoming event streams over a TCP socket.
 */
class WyomingSocketStream {
  private socket: net.Socket;
  private buffer: Buffer = Buffer.alloc(0);

  constructor(socket: net.Socket) {
    this.socket = socket;
  }

  public feed(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
  }

  public readEvent(): WyomingEvent | null {
    // 1. Look for newline terminating header
    const newlineIdx = this.buffer.indexOf(10); // '\n'
    if (newlineIdx === -1) {
      return null;
    }

    const headerLine = this.buffer.subarray(0, newlineIdx).toString('utf-8').trim();
    if (!headerLine) {
      this.buffer = this.buffer.subarray(newlineIdx + 1);
      return this.readEvent();
    }

    let header: { type: string; data_length?: number; payload_length?: number; data?: Record<string, unknown> };
    try {
      header = JSON.parse(headerLine);
    } catch {
      this.buffer = this.buffer.subarray(newlineIdx + 1);
      return null;
    }

    const dataLen = Number(header.data_length || 0);
    const payloadLen = Number(header.payload_length || 0);
    const totalRequired = newlineIdx + 1 + dataLen + payloadLen;

    if (this.buffer.length < totalRequired) {
      return null; // Need more data
    }

    let dataObj = header.data || {};
    let cursor = newlineIdx + 1;
    if (dataLen > 0) {
      try {
        const rawData = this.buffer.subarray(cursor, cursor + dataLen).toString('utf-8');
        const parsed = JSON.parse(rawData);
        if (typeof parsed === 'object' && parsed !== null) {
          dataObj = { ...dataObj, ...parsed };
        }
      } catch {
        // ignore data parse error
      }
      cursor += dataLen;
    }

    let payload: Buffer = Buffer.alloc(0);
    if (payloadLen > 0) {
      payload = this.buffer.subarray(cursor, cursor + payloadLen);
      cursor += payloadLen;
    }

    this.buffer = this.buffer.subarray(cursor);
    return {
      type: header.type,
      data: dataObj,
      payload,
    };
  }
}

/**
 * Synthesizes text speech via Wyoming Piper TCP protocol.
 */
export async function synthesizeSpeechWyoming(
  text: string,
  host: string = process.env.PIPER_HOST || '127.0.0.1',
  port: number = parseInt(process.env.PIPER_PORT || '10200', 10),
  timeoutMs: number = 8000
): Promise<Buffer> {
  return new Promise((resolve) => {
    let resolved = false;
    const socket = new net.Socket();
    const stream = new WyomingSocketStream(socket);
    const pcmChunks: Buffer[] = [];
    let sampleRate = 22050;
    let channels = 1;
    let bitDepth = 16;

    const cleanup = (resultBuffer: Buffer) => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve(resultBuffer);
      }
    };

    const timer = setTimeout(() => {
      cleanup(createWavBuffer(Buffer.concat(pcmChunks), sampleRate, channels, bitDepth));
    }, timeoutMs);

    socket.connect(port, host, () => {
      // Send synthesize request
      const req = { type: 'synthesize', data: { text } };
      const reqLine = JSON.stringify(req) + '\n';
      socket.write(reqLine);
    });

    socket.on('data', (chunk) => {
      stream.feed(chunk);
      while (true) {
        const ev = stream.readEvent();
        if (!ev) break;

        if (ev.type === 'audio-start') {
          if (typeof ev.data.rate === 'number') sampleRate = ev.data.rate;
          if (typeof ev.data.channels === 'number') channels = ev.data.channels;
          if (typeof ev.data.width === 'number') bitDepth = ev.data.width * 8;
        } else if (ev.type === 'audio-chunk' && ev.payload.length > 0) {
          pcmChunks.push(ev.payload);
        } else if (ev.type === 'audio-stop') {
          clearTimeout(timer);
          cleanup(createWavBuffer(Buffer.concat(pcmChunks), sampleRate, channels, bitDepth));
          return;
        }
      }
    });

    socket.on('error', () => {
      clearTimeout(timer);
      cleanup(createWavBuffer(Buffer.alloc(0)));
    });

    socket.on('close', () => {
      clearTimeout(timer);
      cleanup(createWavBuffer(Buffer.concat(pcmChunks), sampleRate, channels, bitDepth));
    });
  });
}

const SILENCE_HALLUCINATIONS = new Set(['', '.', '...', 'you']);

/**
 * Decodes browser audio (WebM/Opus, MP4/AAC, Ogg, WAV) to 16kHz 16-bit mono linear PCM.
 */
async function decodeToPcm16kMono(audioBuffer: Buffer): Promise<Buffer> {
  if (
    audioBuffer.length > 44 &&
    audioBuffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    audioBuffer.subarray(8, 12).toString('ascii') === 'WAVE'
  ) {
    const audioFormat = audioBuffer.readUInt16LE(20);
    const channels = audioBuffer.readUInt16LE(22);
    const sampleRate = audioBuffer.readUInt32LE(24);
    const bitDepth = audioBuffer.readUInt16LE(34);
    if (audioFormat === 1 && channels === 1 && sampleRate === 16000 && bitDepth === 16) {
      return audioBuffer.subarray(44);
    }
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const ff = cp.spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ar', '16000', '-ac', '1', '-f', 's16le', 'pipe:1']);

    const finish = (pcm: Buffer) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(pcm);
      }
    };

    const timer = setTimeout(() => {
      console.error('[STT] ffmpeg decode timed out after 8000ms.');
      try {
        ff.kill('SIGKILL');
      } catch {
        // ignore kill error
      }
      finish(Buffer.alloc(0));
    }, 8000);

    ff.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    ff.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    ff.stdin.on('error', () => undefined);

    ff.on('error', (err) => {
      console.error('[STT] ffmpeg spawn error:', err.message);
      finish(Buffer.alloc(0));
    });

    ff.on('close', (code) => {
      if (code !== 0) {
        const errText = Buffer.concat(stderrChunks).toString('utf-8').trim();
        console.error(`[STT] ffmpeg exited with code ${code}: ${errText || 'unknown error'}`);
        finish(Buffer.alloc(0));
        return;
      }
      finish(Buffer.concat(chunks));
    });

    ff.stdin.end(audioBuffer);
  });
}

/**
 * Transcribes PCM / WAV / browser-encoded audio via Wyoming Whisper TCP protocol.
 */
export async function transcribeAudioWyoming(
  audioBuffer: Buffer,
  host: string = process.env.WHISPER_HOST || '127.0.0.1',
  port: number = parseInt(process.env.WHISPER_PORT || '10300', 10),
  timeoutMs: number = 20000
): Promise<string> {
  const pcm = await decodeToPcm16kMono(audioBuffer);
  if (pcm.length < 320) {
    return '';
  }

  return new Promise((resolve) => {
    let resolved = false;
    const socket = new net.Socket();
    const stream = new WyomingSocketStream(socket);

    const cleanup = (transcript: string) => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve(transcript);
      }
    };

    const timer = setTimeout(() => {
      console.error(`[STT] Wyoming Whisper timed out after ${timeoutMs}ms (${host}:${port}).`);
      cleanup('');
    }, timeoutMs);

    socket.connect(port, host, () => {
      const rate = 16000;

      // 1. Transcribe event
      const transReq = JSON.stringify({ type: 'transcribe', data: { language: 'en' } }) + '\n';
      socket.write(transReq);

      // 2. Audio-start
      const startReq = JSON.stringify({
        type: 'audio-start',
        data: { rate, width: 2, channels: 1 },
      }) + '\n';
      socket.write(startReq);

      // 3. Audio-chunk(s)
      const chunkSize = 4096;
      for (let i = 0; i < pcm.length; i += chunkSize) {
        const slice = pcm.subarray(i, i + chunkSize);
        const chunkHdr = JSON.stringify({
          type: 'audio-chunk',
          data: { rate, width: 2, channels: 1 },
          payload_length: slice.length,
        }) + '\n';
        socket.write(chunkHdr);
        socket.write(slice);
      }

      // 4. Audio-stop
      const stopReq = JSON.stringify({ type: 'audio-stop' }) + '\n';
      socket.write(stopReq);
    });

    socket.on('data', (chunk) => {
      stream.feed(chunk);
      while (true) {
        const ev = stream.readEvent();
        if (!ev) break;
        if (ev.type === 'transcript') {
          const text = typeof ev.data.text === 'string' ? ev.data.text.trim() : '';
          const cleaned = SILENCE_HALLUCINATIONS.has(text.toLowerCase()) ? '' : text;
          clearTimeout(timer);
          cleanup(cleaned);
          return;
        }
      }
    });

    socket.on('error', (err) => {
      console.error(`[STT] Wyoming Whisper socket error (${host}:${port}):`, err.message);
      clearTimeout(timer);
      cleanup('');
    });

    socket.on('close', () => {
      clearTimeout(timer);
      cleanup('');
    });
  });
}
