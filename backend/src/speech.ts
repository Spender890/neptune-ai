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

    let payload = Buffer.alloc(0);
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

/**
 * Transcribes PCM / WAV audio via Wyoming Whisper TCP protocol.
 */
export async function transcribeAudioWyoming(
  audioBuffer: Buffer,
  host: string = process.env.WHISPER_HOST || '127.0.0.1',
  port: number = parseInt(process.env.WHISPER_PORT || '10300', 10),
  timeoutMs: number = 10000
): Promise<string> {
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
      cleanup('');
    }, timeoutMs);

    socket.connect(port, host, () => {
      // If WAV header present, strip 44 bytes to get raw PCM, or send chunks
      let pcm = audioBuffer;
      let rate = 16000;
      if (audioBuffer.length > 44 && audioBuffer.subarray(0, 4).toString('ascii') === 'RIFF') {
        rate = audioBuffer.readUInt32LE(24);
        pcm = audioBuffer.subarray(44);
      }

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
          clearTimeout(timer);
          cleanup(text);
          return;
        }
      }
    });

    socket.on('error', () => {
      clearTimeout(timer);
      cleanup('');
    });

    socket.on('close', () => {
      clearTimeout(timer);
      cleanup('');
    });
  });
}
