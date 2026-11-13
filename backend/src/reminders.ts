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
  created_by: string; // e.g. "Sultan (Ext 1001)", "Desk (Ext 1002)", "Web Cockpit"
  target_person: string; // e.g. "Sultan", "Desk", "All"
  created_at: number;
  completed_at?: number;
}

export class ReminderStore {
  private filePath: string;
  private reminders: Reminder[] = [];

  constructor(storageDir: string = '/app/data') {
    if (!fs.existsSync(storageDir)) {
      try {
        fs.mkdirSync(storageDir, { recursive: true });
      } catch {
        // Fallback for local dev testing
        storageDir = path.join(__dirname, '../../data');
        if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });
      }
    }
    this.filePath = path.join(storageDir, 'reminders.json');
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        this.reminders = JSON.parse(raw);
      } else {
        this.reminders = [];
      }
    } catch {
      this.reminders = [];
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.reminders, null, 2), 'utf-8');
    } catch (err) {
      console.error('Error saving reminders:', err);
    }
  }

  public create(
    title: string,
    durationMinutes: number,
    channels: string[] = ['tv', 'speaker', 'call', 'web'],
    source: 'phone_call' | 'web_cockpit' | 'api' | 'voice_assistant' = 'web_cockpit',
    created_by: string = 'Web Cockpit',
    target_person: string = 'Sultan'
  ): Reminder {
    const now = Date.now();
    const reminder: Reminder = {
      id: `rem_${now}_${Math.random().toString(36).substring(2, 7)}`,
      title,
      due_at: now + durationMinutes * 60 * 1000,
      priority: 'normal',
      status: 'pending',
      channels,
      source,
      created_by,
      target_person,
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
    return [...this.reminders]
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, limit);
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
