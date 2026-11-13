import * as fs from 'fs';
import * as path from 'path';
import { resolveContact, Contact } from './contacts';

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

export class TelephonyManager {
  private spoolDir: string;

  constructor(spoolDir: string = process.env.ASTERISK_SPOOL_DIR || '/var/spool/asterisk/outgoing') {
    this.spoolDir = spoolDir;
  }

  /**
   * Places an outbound automated voice call to a target person or extension,
   * speaking the requested message when answered.
   */
  public async dispatchCallMessage(req: OutboundCallRequest): Promise<OutboundCallResult> {
    const contact = resolveContact(req.recipientQuery);
    const targetExt = contact ? contact.extension : req.recipientQuery.replace(/\D/g, '');

    if (!targetExt) {
      return {
        success: false,
        speech: `I could not find anyone named "${req.recipientQuery}" in your contacts.`,
      };
    }

    const recipientName = contact ? contact.name : `Extension ${targetExt}`;
    const sender = req.senderName && req.senderName.trim() ? req.senderName.trim() : 'Neptune';

    try {
      if (!fs.existsSync(this.spoolDir)) {
        try {
          fs.mkdirSync(this.spoolDir, { recursive: true });
        } catch {
          // May be restricted or running outside docker during test
        }
      }

      const callId = `call_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      
      // Clean message for Asterisk channel variable (single-line, escape quotes)
      const cleanMsg = req.message.replace(/[\r\n]+/g, ' ').replace(/"/g, "'").trim();

      // Asterisk Call Spool Configuration
      // MaxRetries: 0 prevents repeat redialing
      const callFileContent = [
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
      fs.chmodSync(tempFile, 0o666);
      fs.renameSync(tempFile, targetFile);

      console.log(`[TelephonyManager] Successfully dropped call file ${targetFile} for Ext ${targetExt} (${recipientName})`);

      return {
        success: true,
        speech: `Calling ${recipientName} at extension ${targetExt} to deliver your message: "${cleanMsg}".`,
        targetExtension: targetExt,
        contact,
        callFile: targetFile,
      };
    } catch (err: any) {
      console.error('[TelephonyManager] Failed to create call file:', err);
      return {
        success: false,
        speech: `Failed to place call to ${recipientName}: ${err.message}`,
        targetExtension: targetExt,
        contact,
      };
    }
  }
}
