import * as fs from 'fs';
import * as path from 'path';
import { ReminderStore, type Reminder } from './reminders';
import { LGWebOSManager } from './webos';
import { HomeAssistantClient } from './homeassistant';
import { resolveContact } from './contacts';

const SAFE_EXTENSION_RE = /^[0-9]{3,6}$/;

function sanitizeCallField(value: string): string {
  return value.replace(/[\r\n\0]/g, ' ').replace(/"/g, "'").trim();
}

/**
 * Background scheduler polling ReminderStore and dispatching due reminders
 * across LG webOS TV toasts, whole-house TTS speakers, Asterisk SIP calls, and Web callbacks.
 */
export class AgendaDaemon {
  private store: ReminderStore;
  private webOS: LGWebOSManager;
  private haClient: HomeAssistantClient;
  private speakerEntityId: string;
  private spoolDir: string;
  private timer: NodeJS.Timeout | null = null;
  private isTicking = false;
  private onTriggerCallback?: (reminder: Reminder) => void;

  constructor(
    store: ReminderStore,
    webOS: LGWebOSManager,
    haClient: HomeAssistantClient,
    speakerEntityId?: string,
    spoolDir?: string
  ) {
    this.store = store;
    this.webOS = webOS;
    this.haClient = haClient;
    this.speakerEntityId =
      speakerEntityId || process.env.SPEAKER_ENTITY_ID || 'media_player.living_room_vlc_telnet';
    this.spoolDir = spoolDir || process.env.ASTERISK_SPOOL_DIR || '/var/spool/asterisk/outgoing';
  }

  public setTriggerCallback(cb: (reminder: Reminder) => void): void {
    this.onTriggerCallback = cb;
  }

  public start(pollIntervalMs: number = 3000): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      void this.tick();
    }, pollIntervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public async tick(): Promise<void> {
    if (this.isTicking) {
      return;
    }
    this.isTicking = true;
    try {
      const now = Date.now();
      const active = this.store.listActive();

      for (const rem of active) {
        if (now >= rem.due_at) {
          // Mark completed immediately so overlapping or subsequent ticks never double-dispatch
          this.store.markCompleted(rem.id);
          console.log(
            `[AgendaDaemon] TRIGGERING REMINDER: "${rem.title}" (Channels: ${rem.channels.join(', ')})`
          );
          await this.dispatch(rem);
        }
      }
    } finally {
      this.isTicking = false;
    }
  }

  private async dispatch(rem: Reminder): Promise<void> {
    const recipient = sanitizeCallField(rem.target_person || process.env.PRIMARY_USER_NAME || 'Primary');
    const cleanTitle = sanitizeCallField(rem.title);
    const alertMessage = `Reminder: ${cleanTitle}`;

    // 1. Dispatch to LG TV if enabled (Toast notification on screen)
    if (rem.channels.includes('tv') || rem.channels.includes('all')) {
      try {
        await this.webOS.showToast(alertMessage);
      } catch (err) {
        console.error('Failed to show TV toast for reminder:', err);
      }
    }

    // 2. Dispatch to Whole-House VLC-Telnet Speakers via Home Assistant
    if (rem.channels.includes('speaker') || rem.channels.includes('aux') || rem.channels.includes('all')) {
      try {
        await this.haClient.callService('tts', 'speak', 'tts.google_translate_en_com', {
          media_player_entity_id: this.speakerEntityId,
          message: `Attention ${recipient}, here is your reminder: ${cleanTitle}.`,
        });
      } catch (err) {
        console.error('Failed to dispatch reminder to whole-house speakers:', err);
      }
    }

    // 3. Proactive Telephony Call: Call User's Phone to announce the reminder
    if (rem.channels.includes('phone') || rem.channels.includes('call') || rem.channels.includes('all')) {
      try {
        if (fs.existsSync(this.spoolDir)) {
          const contact = resolveContact(recipient);
          const targetExt = contact && SAFE_EXTENSION_RE.test(contact.extension) ? contact.extension : '1001';
          const safeRecipientName = sanitizeCallField(contact ? contact.name : recipient);

          // MaxRetries: 0 ensures Asterisk places exactly 1 call and never retries
          const callFileContent =
            [
              `Channel: PJSIP/${targetExt}`,
              `CallerID: "Neptune Reminder" <7000>`,
              `MaxRetries: 0`,
              `WaitTime: 30`,
              `Context: internal`,
              `Extension: 7000`,
              `Priority: 1`,
              `Set: REMINDER_MSG=${cleanTitle}`,
              `Set: OUTBOUND_TO=${safeRecipientName}`,
            ].join('\n') + '\n';

          const safeRemId = rem.id.replace(/[^a-zA-Z0-9_-]/g, '');
          const tempCallFile = path.join(this.spoolDir, `.tmp_${safeRemId}.call`);
          const finalCallFile = path.join(this.spoolDir, `rem_${safeRemId}.call`);
          fs.writeFileSync(tempCallFile, callFileContent, 'utf-8');
          try {
            fs.chmodSync(tempCallFile, 0o666);
          } catch {
            // chmod may be a no-op on non-POSIX filesystems
          }
          fs.renameSync(tempCallFile, finalCallFile);
          console.log(
            `[AgendaDaemon] Dispatched outbound call file to Asterisk for reminder: "${cleanTitle}" to Ext ${targetExt}`
          );
        } else {
          console.warn(`[AgendaDaemon] Asterisk spool directory not mounted at ${this.spoolDir}`);
        }
      } catch (err) {
        console.error('Telephony dispatch error:', err);
      }
    }

    // 4. Fire WebSocket/Web Notification callback
    if (this.onTriggerCallback) {
      this.onTriggerCallback(rem);
    }
  }
}
