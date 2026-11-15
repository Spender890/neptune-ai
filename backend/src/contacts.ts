import * as fs from 'fs';
import * as path from 'path';

export interface Contact {
  id: string;
  name: string;
  extension: string;
  role: string;
  aliases: string[];
}

const primaryName = process.env.PRIMARY_USER_NAME || 'Primary';

export const DEFAULT_CONTACTS: Contact[] = [
  {
    id: 'primary',
    name: primaryName,
    extension: '1001',
    role: 'Mobile Phone (Linphone)',
    aliases: [primaryName.toLowerCase(), 'primary', 'user', 'me', 'my phone', 'mobile', 'cell', '1001'],
  },
  {
    id: 'desk',
    name: 'Desk',
    extension: '1002',
    role: 'Deskphone / Tablet (Living Room)',
    aliases: ['desk', 'office', 'tablet', 'family', 'deskphone', 'living room desk', '1002'],
  },
  {
    id: 'neptune',
    name: 'Neptune AI',
    extension: '7000',
    role: 'Voice Assistant Operator',
    aliases: ['neptune', 'assistant', 'operator', 'ai', '7000'],
  },
];

function resolveDefaultContactsPath(): string {
  if (process.env.CONTACTS_CONFIG_PATH) {
    return process.env.CONTACTS_CONFIG_PATH;
  }
  const candidates: string[] = [];
  if (typeof __dirname !== 'undefined') {
    candidates.push(path.join(__dirname, '../../config/contacts.json'));
    candidates.push(path.join(__dirname, '../../../config/contacts.json'));
  }
  candidates.push(path.resolve(process.cwd(), 'config/contacts.json'));
  candidates.push(path.resolve(process.cwd(), '../config/contacts.json'));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

/**
 * Loads contacts from JSON config if present and valid; otherwise returns safe defaults.
 */
export function loadContacts(customPath?: string): Contact[] {
  const configPath = customPath || resolveDefaultContactsPath();
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.filter(
          (item): item is Contact =>
            Boolean(item && typeof item.name === 'string' && typeof item.extension === 'string')
        );
      }
    }
  } catch {
    // Fall back to default directory
  }
  return DEFAULT_CONTACTS.map((c) => ({ ...c, aliases: [...c.aliases] }));
}

export const CONTACT_DIRECTORY: Contact[] = loadContacts();

/**
 * Resolves a colloquial name, extension, or alias to a Contact.
 */
export function resolveContact(query: string, directory: Contact[] = CONTACT_DIRECTORY): Contact | undefined {
  if (!query || typeof query !== 'string') return undefined;
  const clean = query.trim().toLowerCase().replace(/[.,!?;:]/g, '');
  if (!clean) return undefined;

  for (const c of directory) {
    if (c.extension === clean || c.name.toLowerCase() === clean || c.id.toLowerCase() === clean) {
      return c;
    }
  }

  const queryWords = new Set(clean.split(/\s+/).filter((w) => w.length >= 3));

  for (const c of directory) {
    const aliases = Array.isArray(c.aliases) ? c.aliases : [];
    for (const alias of aliases) {
      const lowerAlias = alias.trim().toLowerCase();
      if (!lowerAlias) continue;
      if (lowerAlias === clean || (lowerAlias.length >= 3 && queryWords.has(lowerAlias))) {
        return c;
      }
    }
  }

  return undefined;
}

/**
 * Lookup contact by phone extension (e.g. "1001").
 */
export function getContactByExtension(ext: string, directory: Contact[] = CONTACT_DIRECTORY): Contact | undefined {
  if (!ext || typeof ext !== 'string') return undefined;
  const clean = ext.trim().replace(/\D/g, '');
  if (!clean) return undefined;
  return directory.find((c) => c.extension === clean);
}
