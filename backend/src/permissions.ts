import * as fs from 'fs';

export interface PermissionsConfig {
  allowed_entities: string[];
  allowed_domains: string[];
  consequential_entities: string[];
}

export interface PermissionValidationResult {
  allowed: boolean;
  requires_confirmation: boolean;
  reason?: string;
}

const DOMAIN_RE = /^[a-z0-9_]+$/;
const ENTITY_ID_RE = /^[a-z0-9_]+\.[a-z0-9_]+$/;

const DEFAULT_CONFIG: PermissionsConfig = {
  allowed_entities: [],
  allowed_domains: [
    'light',
    'switch',
    'climate',
    'media_player',
    'webostv',
    'timer',
    'tts',
    'asterisk',
    'intercom',
    'adhan',
    'siri',
    'vision',
    'weather',
  ],
  consequential_entities: ['lock.front_door', 'cover.garage_door'],
};

/**
 * Enforces domain allowlists, explicit entity whitelists, and consequential-action gating
 * before any command reaches Home Assistant or other integrations.
 */
export class PermissionsGateway {
  private config: PermissionsConfig;

  constructor(configPath: string) {
    this.config = this.loadConfig(configPath);
  }

  private loadConfig(configPath: string): PermissionsConfig {
    try {
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          return {
            allowed_entities: Array.isArray(parsed.allowed_entities) ? parsed.allowed_entities : [],
            allowed_domains: Array.isArray(parsed.allowed_domains) ? parsed.allowed_domains : DEFAULT_CONFIG.allowed_domains,
            consequential_entities: Array.isArray(parsed.consequential_entities)
              ? parsed.consequential_entities
              : DEFAULT_CONFIG.consequential_entities,
          };
        }
      }
    } catch {
      // Fall back to safe defaults if configuration file is missing or malformed
    }
    return {
      allowed_entities: [...DEFAULT_CONFIG.allowed_entities],
      allowed_domains: [...DEFAULT_CONFIG.allowed_domains],
      consequential_entities: [...DEFAULT_CONFIG.consequential_entities],
    };
  }

  private matchesPatternList(entityId: string, entries: string[]): boolean {
    return entries.some((entry) => {
      if (entry.endsWith('*')) {
        return entityId.startsWith(entry.slice(0, -1));
      }
      return entry === entityId;
    });
  }

  public validate(domain: string, entity_id: string): PermissionValidationResult {
    if (typeof domain !== 'string' || !DOMAIN_RE.test(domain)) {
      return {
        allowed: false,
        requires_confirmation: false,
        reason: `Invalid domain format '${String(domain)}'.`,
      };
    }

    if (typeof entity_id !== 'string' || !ENTITY_ID_RE.test(entity_id)) {
      return {
        allowed: false,
        requires_confirmation: false,
        reason: `Invalid entity_id format '${String(entity_id)}'.`,
      };
    }

    // 1. Consequential security entities (e.g. door locks, garage doors) always require explicit confirmation.
    // Evaluated before allowed_domains so consequential devices cannot silently bypass confirmation or be hidden.
    if (this.matchesPatternList(entity_id, this.config.consequential_entities)) {
      return {
        allowed: true,
        requires_confirmation: true,
        reason: `Entity '${entity_id}' requires explicit confirmation.`,
      };
    }

    // 2. Block prohibited domains
    if (!this.config.allowed_domains.includes(domain)) {
      return {
        allowed: false,
        requires_confirmation: false,
        reason: `Domain '${domain}' is not in allowed domains.`,
      };
    }

    // 3. Enforce strict entity whitelist when configured
    if (
      this.config.allowed_entities.length > 0 &&
      !this.matchesPatternList(entity_id, this.config.allowed_entities)
    ) {
      return {
        allowed: false,
        requires_confirmation: false,
        reason: `Entity '${entity_id}' is not in allowed_entities whitelist.`,
      };
    }

    return { allowed: true, requires_confirmation: false };
  }
}
