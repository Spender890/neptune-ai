import * as fs from 'fs';
import * as path from 'path';

export interface Reminder {
  id: string;
  title: string;
  due_at: number; // Unix timestamp ms
  recurrence?: string; // e.g., 'daily', 'weekly'
  priority: 'low' | 'normal' | 'high';
  status: 'pending' | 'completed' | 'dismissed';
  channels: string[]; // ['tv', 'speaker', 'call', 'web']
  source: 'phone_call' | 'web_cockpit' | 'api' | 'voice_assistant';
  created_by: string; // e.g. "Primary (Ext 1001)", "Desk (Ext 1002)", "Web Cockpit"
  target_person: string; // e.g. "Primary", "Desk", "All"
  created_at: number;
  completed_at?: number;
}

const MAX_TITLE_LENGTH = 250;
const MAX_DURATION_MINUTES = 525600; // 1 year

function sanitizeReminderText(value: string, maxLen: number): string {
  return value.replace(/[\r\n\0]/g, ' ').trim().slice(0, maxLen);
}

/**
 * JSON-backed persistent reminder store using atomic temp-file rename writes.
 */
export class ReminderStore {
  private filePath: string;
  private reminders: Reminder[] = [];

  constructor(storageDir: string = '/app/data') {
    let resolvedDir = storageDir;
    if (!fs.existsSync(resolvedDir)) {
      try {
        fs.mkdirSync(resolvedDir, { recursive: true });
      } catch {
        const candidates: string[] = [];
        if (typeof __dirname !== 'undefined') {
          const twoUp = path.join(__dirname, '../..');
          const threeUp = path.join(__dirname, '../../..');
          candidates.push(
            fs.existsSync(path.join(threeUp, 'config')) ? path.join(threeUp, 'data') : path.join(twoUp, 'data')
          );
        }
        candidates.push(path.resolve(process.cwd(), 'data'));
        resolvedDir = candidates[0];
        if (!fs.existsSync(resolvedDir)) {
          fs.mkdirSync(resolvedDir, { recursive: true });
        }
      }
    }
    this.filePath = path.join(resolvedDir, 'reminders.json');
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        this.reminders = Array.isArray(parsed) ? parsed : [];
      } else {
        this.reminders = [];
      }
    } catch {
      this.reminders = [];
    }
  }

  private save(): void {
    const tmpPath = `${this.filePath}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(this.reminders, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      console.error('Error saving reminders:', err);
      try {
        if (fs.existsSync(tmpPath)) {
          fs.unlinkSync(tmpPath);
        }
      } catch {
        // Ignore cleanup failure
      }
    }
  }

  public create(
    title: string,
    durationMinutes: number,
    channels: string[] = ['tv', 'speaker', 'call', 'web'],
    source: 'phone_call' | 'web_cockpit' | 'api' | 'voice_assistant' = 'web_cockpit',
    created_by: string = 'Web Cockpit',
    target_person?: string
  ): Reminder {
    if (typeof title !== 'string') {
      throw new Error('Reminder title must be a string.');
    }
    const cleanTitle = sanitizeReminderText(title, MAX_TITLE_LENGTH);
    if (!cleanTitle) {
      throw new Error('Reminder title cannot be empty.');
    }
    if (typeof durationMinutes !== 'number' || !Number.isFinite(durationMinutes) || durationMinutes <= 0 || durationMinutes > MAX_DURATION_MINUTES) {
      throw new Error('Reminder duration_minutes must be a positive number up to 525600.');
    }

    const defaultPerson = process.env.PRIMARY_USER_NAME || 'Primary';
    const cleanTarget = sanitizeReminderText(target_person || defaultPerson, 80) || defaultPerson;
    const cleanCreator = sanitizeReminderText(created_by || 'Web Cockpit', 80) || 'Web Cockpit';
    const validChannels = Array.isArray(channels)
      ? channels.filter((c) => typeof c === 'string' && c.trim().length > 0).map((c) => c.trim().toLowerCase())
      : ['tv', 'speaker', 'call', 'web'];

    const now = Date.now();
    const reminder: Reminder = {
      id: `rem_${now}_${Math.random().toString(36).substring(2, 7)}`,
      title: cleanTitle,
      due_at: now + durationMinutes * 60 * 1000,
      priority: 'normal',
      status: 'pending',
      channels: validChannels.length > 0 ? validChannels : ['web'],
      source,
      created_by: cleanCreator,
      target_person: cleanTarget,
      created_at: now,
    };
    this.reminders.push(reminder);
    this.save();
    return reminder;
  }

  public listActive(): Reminder[] {
    return this.reminders.filter((r) => r.status === 'pending').sort((a, b) => a.due_at - b.due_at);
  }

  public listRecent(limit: number = 20): Reminder[] {
    return [...this.reminders].sort((a, b) => b.created_at - a.created_at).slice(0, limit);
  }

  public markCompleted(id: string): void {
    const rem = this.reminders.find((r) => r.id === id);
    if (rem) {
      rem.status = 'completed';
      rem.completed_at = Date.now();
      this.save();
    }
  }

  public delete(id: string): boolean {
    const idx = this.reminders.findIndex((r) => r.id === id);
    if (idx !== -1) {
      this.reminders.splice(idx, 1);
      this.save();
      return true;
    }
    return false;
  }
}
