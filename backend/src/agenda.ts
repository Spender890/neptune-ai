import { ReminderStore, Reminder } from './reminders';
import { LGWebOSManager } from './webos';
import { HomeAssistantClient } from './homeassistant';
import { resolveContact } from './contacts';

export class AgendaDaemon {
  private store: ReminderStore;
  private webOS: LGWebOSManager;
  private haClient: HomeAssistantClient;
  private timer: NodeJS.Timeout | null = null;
  private onTriggerCallback?: (reminder: Reminder) => void;

  constructor(store: ReminderStore, webOS: LGWebOSManager, haClient: HomeAssistantClient) {
    this.store = store;
    this.webOS = webOS;
    this.haClient = haClient;
  }

  public setTriggerCallback(cb: (reminder: Reminder) => void): void {
    this.onTriggerCallback = cb;
  }

  public start(pollIntervalMs: number = 3000): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), pollIntervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public async tick(): Promise<void> {
    const now = Date.now();
    const active = this.store.listActive();

    for (const rem of active) {
      if (now >= rem.due_at) {
        // Mark completed immediately so 3-second tick loop never double-dispatches
        this.store.markCompleted(rem.id);
        console.log(`[AgendaDaemon] TRIGGERING REMINDER: "${rem.title}" (Channels: ${rem.channels.join(', ')})`);
        await this.dispatch(rem);
      }
    }
  }

  private async dispatch(rem: Reminder): Promise<void> {
    const recipient = rem.target_person || process.env.PRIMARY_USER_NAME || 'Primary';
    const alertMessage = `Reminder: ${rem.title}`;

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
          media_player_entity_id: 'media_player.living_room_vlc_telnet',
          message: `Attention ${recipient}, here is your reminder: ${rem.title}.`,
        });
      } catch (err) {
        console.error('Failed to dispatch reminder to whole-house speakers:', err);
      }
    }

    // 3. Proactive Telephony Call: Call User's Phone to announce the reminder!
    if (rem.channels.includes('phone') || rem.channels.includes('call') || rem.channels.includes('all')) {
      try {
        const spoolDir = process.env.ASTERISK_SPOOL_DIR || '/var/spool/asterisk/outgoing';
        const fs = await import('fs');
        if (fs.existsSync(spoolDir)) {
          // Resolve target extension (Sultan -> 1001, Desk -> 1002)
          const contact = resolveContact(recipient);
          const targetExt = contact ? contact.extension : '1001';

          // MaxRetries: 0 ensures Asterisk places exactly 1 call and never retries
          const callFileContent = [
            `Channel: PJSIP/${targetExt}`,
            `CallerID: "Neptune Reminder" <7000>`,
            `MaxRetries: 0`,
            `WaitTime: 30`,
            `Context: internal`,
            `Extension: 7000`,
            `Priority: 1`,
            `Set: REMINDER_MSG=${rem.title.replace(/"/g, "'")}`,
            `Set: OUTBOUND_TO=${contact ? contact.name : recipient}`,
          ].join('\n') + '\n';

          const tempCallFile = `${spoolDir}/.tmp_${rem.id}.call`;
          fs.writeFileSync(tempCallFile, callFileContent, 'utf-8');
          fs.chmodSync(tempCallFile, 0o666);
          fs.renameSync(tempCallFile, `${spoolDir}/rem_${rem.id}.call`);
          console.log(`[AgendaDaemon] Dispatched outbound call file to Asterisk for reminder: "${rem.title}" to Ext ${targetExt}`);
        } else {
          console.warn(`[AgendaDaemon] Asterisk spool directory not mounted at ${spoolDir}`);
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
