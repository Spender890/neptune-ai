import * as fs from 'fs';
import * as path from 'path';
import { resolveContact, type Contact, CONTACT_DIRECTORY } from './contacts';

export interface OutboundCallRequest {
  recipientQuery: string;
  message: string;
  senderName?: string;
}

export interface OutboundCallResult {
  success: boolean;
  speech: string;
  targetExtension?: string;
  contact?: Contact;
  callFile?: string;
}

const EMERGENCY_NUMBERS = new Set(['911', '999', '112', '000', '110', '119', '988']);
const ALLOWED_RAW_EXTENSION_RE = /^(100[1-9]|7000)$/;
const MAX_SPOKEN_MESSAGE_LENGTH = 300;

function sanitizeCallHeaderField(value: string, maxLen: number): string {
  return value.replace(/[\r\n\0]/g, ' ').replace(/"/g, "'").trim().slice(0, maxLen);
}

/**
 * Formats and safely writes Asterisk `.call` spool files for outbound household intercom messages.
 */
export class TelephonyManager {
  private spoolDir: string;
  private directory: Contact[];

  constructor(
    spoolDir: string = process.env.ASTERISK_SPOOL_DIR || '/var/spool/asterisk/outgoing',
    directory: Contact[] = CONTACT_DIRECTORY
  ) {
    this.spoolDir = spoolDir;
    this.directory = directory;
  }

  /**
   * Places an outbound automated voice call to a whitelisted contact or internal SIP extension,
   * speaking the requested message when answered.
   */
  public async dispatchCallMessage(req: OutboundCallRequest): Promise<OutboundCallResult> {
    if (!req || typeof req.recipientQuery !== 'string' || typeof req.message !== 'string') {
      return {
        success: false,
        speech: 'Invalid outbound call request: missing recipient or message.',
      };
    }

    const rawDigits = req.recipientQuery.replace(/\D/g, '');
    if (EMERGENCY_NUMBERS.has(rawDigits)) {
      return {
        success: false,
        speech: 'Dialing emergency numbers is prohibited by Neptune-AI safety policy.',
      };
    }

    const contact = resolveContact(req.recipientQuery, this.directory);
    let targetExt = '';

    if (contact && /^[0-9]{3,6}$/.test(contact.extension) && !EMERGENCY_NUMBERS.has(contact.extension)) {
      targetExt = contact.extension;
    } else if (ALLOWED_RAW_EXTENSION_RE.test(req.recipientQuery.trim())) {
      targetExt = req.recipientQuery.trim();
    } else if (rawDigits && ALLOWED_RAW_EXTENSION_RE.test(rawDigits)) {
      targetExt = rawDigits;
    }

    if (!targetExt) {
      return {
        success: false,
        speech: `I could not find an authorized internal contact or extension matching "${sanitizeCallHeaderField(req.recipientQuery, 60)}".`,
      };
    }

    const cleanMsg = sanitizeCallHeaderField(req.message, MAX_SPOKEN_MESSAGE_LENGTH);
    if (!cleanMsg) {
      return {
        success: false,
        speech: 'Outbound call message cannot be empty.',
      };
    }

    const recipientName = sanitizeCallHeaderField(contact ? contact.name : `Extension ${targetExt}`, 60);
    const sender = sanitizeCallHeaderField(req.senderName || 'Neptune', 60) || 'Neptune';

    try {
      if (!fs.existsSync(this.spoolDir)) {
        try {
          fs.mkdirSync(this.spoolDir, { recursive: true });
        } catch {
          // May be restricted or running outside docker during test
        }
      }

      const callId = `call_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

      // Asterisk Call Spool Configuration
      // MaxRetries: 0 prevents repeat redialing
      const callFileContent =
        [
          `Channel: PJSIP/${targetExt}`,
          `CallerID: "Neptune (${sender})" <7000>`,
          `MaxRetries: 0`,
          `WaitTime: 30`,
          `Context: internal`,
          `Extension: 7000`,
          `Priority: 1`,
          `Set: OUTBOUND_MSG=${cleanMsg}`,
          `Set: OUTBOUND_TO=${recipientName}`,
          `Set: OUTBOUND_FROM=${sender}`,
        ].join('\n') + '\n';

      const tempFile = path.join(this.spoolDir, `.tmp_${callId}.call`);
      const targetFile = path.join(this.spoolDir, `${callId}.call`);

      fs.writeFileSync(tempFile, callFileContent, 'utf-8');
      try {
        fs.chmodSync(tempFile, 0o666);
      } catch {
        // chmod may be unsupported on Windows or restricted mounts
      }
      fs.renameSync(tempFile, targetFile);

      console.log(
        `[TelephonyManager] Successfully dropped call file ${targetFile} for Ext ${targetExt} (${recipientName})`
      );

      return {
        success: true,
        speech: `Calling ${recipientName} at extension ${targetExt} to deliver your message: "${cleanMsg}".`,
        targetExtension: targetExt,
        contact,
        callFile: targetFile,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[TelephonyManager] Failed to create call file:', err);
      return {
        success: false,
        speech: `Failed to place call to ${recipientName}: ${message}`,
        targetExtension: targetExt,
        contact,
      };
    }
  }
}
