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
const DEFAULT_CONTACTS: Contact[] = [
  {
    id: 'primary',
    name: primaryName,
    extension: '1001',
    role: 'Mobile Phone (Linphone)',
    aliases: [primaryName.toLowerCase(), 'user', 'me', 'my phone', 'mobile', 'cell', '1001', 'sultan'],
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

function loadContacts(): Contact[] {
  const configPath = process.env.CONTACTS_CONFIG_PATH || path.join(__dirname, '../../config/contacts.json');
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch {
    // Fall back to default directory
  }
  return DEFAULT_CONTACTS;
}

export const CONTACT_DIRECTORY: Contact[] = loadContacts();

/**
 * Resolves a colloquial name, extension, or alias to a Contact.
 */
export function resolveContact(query: string): Contact | undefined {
  if (!query) return undefined;
  const clean = query.trim().toLowerCase().replace(/[.,!?;:]/g, '');

  for (const c of CONTACT_DIRECTORY) {
    if (c.extension === clean || c.name.toLowerCase() === clean || c.id === clean) {
      return c;
    }
  }

  for (const c of CONTACT_DIRECTORY) {
    for (const alias of c.aliases) {
      if (alias === clean || clean.includes(alias) || alias.includes(clean)) {
        return c;
      }
    }
  }

  return undefined;
}

/**
 * Lookup contact by phone extension (e.g. "1001").
 */
export function getContactByExtension(ext: string): Contact | undefined {
  const clean = ext.trim().replace(/\D/g, '');
  return CONTACT_DIRECTORY.find((c) => c.extension === clean);
}
