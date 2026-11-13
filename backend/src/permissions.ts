import * as fs from 'fs';

export interface PermissionsConfig {
  allowed_entities: string[];
  allowed_domains: string[];
  consequential_entities: string[];
}

export class PermissionsGateway {
  private config: PermissionsConfig;

  constructor(configPath: string) {
    try {
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf-8');
        this.config = JSON.parse(raw);
      } else {
        this.config = {
          allowed_entities: [],
          allowed_domains: ['light', 'switch', 'climate', 'media_player'],
          consequential_entities: ['lock.front_door', 'cover.garage_door'],
        };
      }
    } catch {
      this.config = {
        allowed_entities: [],
        allowed_domains: ['light', 'switch', 'climate', 'media_player'],
        consequential_entities: ['lock.front_door', 'cover.garage_door'],
      };
    }
  }

  public validate(domain: string, entity_id: string): { allowed: boolean; requires_confirmation: boolean; reason?: string } {
    // 1. Block prohibited domains
    if (!this.config.allowed_domains.includes(domain)) {
      return { allowed: false, requires_confirmation: false, reason: `Domain '${domain}' is not in allowed domains.` };
    }

    // 2. Check consequential security entities (require interactive confirmation)
    if (this.config.consequential_entities.includes(entity_id)) {
      return { allowed: true, requires_confirmation: true, reason: `Entity '${entity_id}' requires explicit confirmation.` };
    }

    // 3. Check allowed entities (if list populated, enforce strict whitelist; otherwise allow valid domain members)
    if (this.config.allowed_entities.length > 0) {
      const allowed = this.config.allowed_entities.some((e) => entity_id.startsWith(e) || e === entity_id);
      if (!allowed) {
        return { allowed: false, requires_confirmation: false, reason: `Entity '${entity_id}' is not in allowed_entities whitelist.` };
      }
    }

    return { allowed: true, requires_confirmation: false };
  }
}
