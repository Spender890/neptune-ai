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
  const dataDir = process.env.DATA_DIR;
  if (dataDir) {
    const dataContacts = path.join(dataDir, 'contacts.json');
    if (fs.existsSync(dataContacts)) {
      return dataContacts;
    }
  }

  const candidates: string[] = [];
  if (dataDir) {
    candidates.push(path.join(dataDir, 'contacts.json'));
  }
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

export let CONTACT_DIRECTORY: Contact[] = loadContacts();

/**
 * Persists current contacts list to disk.
 */
export function saveContacts(contacts: Contact[], customPath?: string): boolean {
  const targetPath = customPath || resolveDefaultContactsPath();
  try {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(targetPath, JSON.stringify(contacts, null, 2), 'utf-8');
    CONTACT_DIRECTORY = contacts;
    return true;
  } catch (err) {
    console.error(`Failed to save contacts to ${targetPath}:`, err);
    return false;
  }
}

/**
 * Dynamically adds or updates a contact and hot-reloads memory directory.
 */
export function addContact(contactData: {
  id?: string;
  name: string;
  extension: string;
  role?: string;
  aliases?: string[];
}): Contact {
  const cleanExt = contactData.extension.trim().replace(/\D/g, '');
  const cleanName = contactData.name.trim();
  const id = contactData.id || cleanName.toLowerCase().replace(/[^a-z0-9]/g, '_') || `contact_${cleanExt}`;
  const defaultAliases = [
    cleanName.toLowerCase(),
    cleanExt,
    cleanName.split(/\s+/)[0]?.toLowerCase() || '',
  ].filter(Boolean);

  const newContact: Contact = {
    id,
    name: cleanName,
    extension: cleanExt,
    role: contactData.role?.trim() || 'Family Extension',
    aliases: Array.from(new Set([...defaultAliases, ...(contactData.aliases || []).map((a) => a.toLowerCase().trim())])).filter(Boolean),
  };

  const existingIndex = CONTACT_DIRECTORY.findIndex((c) => c.id === id || c.extension === cleanExt);
  let updatedList: Contact[];
  if (existingIndex >= 0) {
    updatedList = [...CONTACT_DIRECTORY];
    updatedList[existingIndex] = newContact;
  } else {
    updatedList = [...CONTACT_DIRECTORY, newContact];
  }

  saveContacts(updatedList);
  return newContact;
}

/**
 * Dynamically removes a contact and persists changes.
 */
export function removeContact(idOrExtension: string): boolean {
  const clean = idOrExtension.trim().toLowerCase();
  // Prevent removing system assistant contact (7000)
  if (clean === '7000' || clean === 'neptune') {
    return false;
  }
  const filtered = CONTACT_DIRECTORY.filter((c) => c.id.toLowerCase() !== clean && c.extension !== clean);
  if (filtered.length === CONTACT_DIRECTORY.length) {
    return false;
  }
  saveContacts(filtered);
  return true;
}

/**
 * Reloads directory from disk.
 */
export function reloadContacts(customPath?: string): Contact[] {
  CONTACT_DIRECTORY = loadContacts(customPath);
  return CONTACT_DIRECTORY;
}

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
