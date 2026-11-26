import * as fs from 'fs';
import * as path from 'path';
import { HomeAssistantClient } from './homeassistant';
import { LGWebOSManager } from './webos';

export type AdhanPrayerKey = 'fajr' | 'dhuhr' | 'asr' | 'maghrib' | 'isha';
export type AdhanMethodKey = 'uae' | 'umm_al_qura' | 'mwl' | 'egypt' | 'isna' | 'karachi';
export type AdhanMadhabKey = 'shafi' | 'hanafi';

export interface AdhanCityPreset {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  timezone: string;
  method: AdhanMethodKey;
}

export const ADHAN_CITY_PRESETS: Record<string, AdhanCityPreset> = {
  dubai: {
    id: 'dubai',
    label: 'Dubai, UAE',
    latitude: 25.2048,
    longitude: 55.2708,
    timezone: 'Asia/Dubai',
    method: 'uae',
  },
  abu_dhabi: {
    id: 'abu_dhabi',
    label: 'Abu Dhabi, UAE',
    latitude: 24.4539,
    longitude: 54.3773,
    timezone: 'Asia/Dubai',
    method: 'uae',
  },
  sharjah: {
    id: 'sharjah',
    label: 'Sharjah, UAE',
    latitude: 25.3463,
    longitude: 55.4209,
    timezone: 'Asia/Dubai',
    method: 'uae',
  },
  al_ain: {
    id: 'al_ain',
    label: 'Al Ain, UAE',
    latitude: 24.1302,
    longitude: 55.8023,
    timezone: 'Asia/Dubai',
    method: 'uae',
  },
  muscat: {
    id: 'muscat',
    label: 'Muscat, Oman',
    latitude: 23.588,
    longitude: 58.3829,
    timezone: 'Asia/Muscat',
    method: 'uae',
  },
  riyadh: {
    id: 'riyadh',
    label: 'Riyadh, Saudi Arabia',
    latitude: 24.7136,
    longitude: 46.6753,
    timezone: 'Asia/Riyadh',
    method: 'umm_al_qura',
  },
  makkah: {
    id: 'makkah',
    label: 'Makkah, Saudi Arabia',
    latitude: 21.3891,
    longitude: 39.8579,
    timezone: 'Asia/Riyadh',
    method: 'umm_al_qura',
  },
};

export interface AdhanMethodSpec {
  id: AdhanMethodKey;
  label: string;
  fajrAngle: number;
  ishaAngle?: number;
  ishaMinutesAfterMaghrib?: number;
  dhuhrOffsetMinutes: number;
  maghribOffsetMinutes: number;
}

export const ADHAN_METHOD_SPECS: Record<AdhanMethodKey, AdhanMethodSpec> = {
  uae: {
    id: 'uae',
    label: 'UAE / Dubai (AWQAF / 18.2°)',
    fajrAngle: 18.2,
    ishaAngle: 18.2,
    dhuhrOffsetMinutes: 2,
    maghribOffsetMinutes: 3,
  },
  umm_al_qura: {
    id: 'umm_al_qura',
    label: 'Umm al-Qura (Makkah)',
    fajrAngle: 18.5,
    ishaMinutesAfterMaghrib: 90,
    dhuhrOffsetMinutes: 0,
    maghribOffsetMinutes: 0,
  },
  mwl: {
    id: 'mwl',
    label: 'Muslim World League (18° / 17°)',
    fajrAngle: 18,
    ishaAngle: 17,
    dhuhrOffsetMinutes: 0,
    maghribOffsetMinutes: 0,
  },
  egypt: {
    id: 'egypt',
    label: 'Egyptian General Authority (19.5° / 17.5°)',
    fajrAngle: 19.5,
    ishaAngle: 17.5,
    dhuhrOffsetMinutes: 1,
    maghribOffsetMinutes: 0,
  },
  isna: {
    id: 'isna',
    label: 'ISNA North America (15° / 15°)',
    fajrAngle: 15,
    ishaAngle: 15,
    dhuhrOffsetMinutes: 0,
    maghribOffsetMinutes: 0,
  },
  karachi: {
    id: 'karachi',
    label: 'Karachi (18° / 18°)',
    fajrAngle: 18,
    ishaAngle: 18,
    dhuhrOffsetMinutes: 0,
    maghribOffsetMinutes: 0,
  },
};

export const PRAYER_LABELS: Record<AdhanPrayerKey, string> = {
  fajr: 'Fajr',
  dhuhr: 'Dhuhr',
  asr: 'Asr',
  maghrib: 'Maghrib',
  isha: 'Isha',
};

export interface AdhanConfig {
  enabled: boolean;
  city: string;
  latitude: number;
  longitude: number;
  timezone: string;
  method: AdhanMethodKey;
  madhab: AdhanMadhabKey;
  audioUrl: string;
  fajrAudioUrl: string;
  lanBaseUrl: string;
  volume: number;
  fajrVolume: number;
  tvToast: boolean;
  prayers: Record<AdhanPrayerKey, boolean>;
  adjustments: Record<AdhanPrayerKey, number>;
}

export interface PrayerScheduleItem {
  key: AdhanPrayerKey | 'sunrise';
  label: string;
  time: string;
  minutes: number;
  enabled: boolean;
  isNext: boolean;
}

export interface AdhanScheduleSummary {
  date: string;
  currentTime: string;
  timezone: string;
  times: Record<AdhanPrayerKey | 'sunrise', string>;
  schedule: PrayerScheduleItem[];
  nextPrayer: {
    key: AdhanPrayerKey;
    label: string;
    time: string;
    inMinutes: number;
    countdown: string;
  };
}

export interface AdhanTriggerResult {
  success: boolean;
  prayer: AdhanPrayerKey;
  label: string;
  method: 'media_player' | 'tts_fallback' | 'none';
  audioUrl?: string;
  tvToastSent: boolean;
  speech: string;
  details: string;
}

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const MAX_AUDIO_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_AUDIO_FILENAMES = new Set(['adhan.mp3', 'adhan_fajr.mp3']);

function sind(d: number): number {
  return Math.sin(d * DEG_TO_RAD);
}

function cosd(d: number): number {
  return Math.cos(d * DEG_TO_RAD);
}

function tand(d: number): number {
  return Math.tan(d * DEG_TO_RAD);
}

function asind(x: number): number {
  return Math.asin(Math.max(-1, Math.min(1, x))) * RAD_TO_DEG;
}

function acosd(x: number): number {
  return Math.acos(Math.max(-1, Math.min(1, x))) * RAD_TO_DEG;
}

function atan2d(y: number, x: number): number {
  return Math.atan2(y, x) * RAD_TO_DEG;
}

function acotd(x: number): number {
  return Math.atan(1 / x) * RAD_TO_DEG;
}

function fixAngle(a: number): number {
  const res = a - 360 * Math.floor(a / 360);
  return res < 0 ? res + 360 : res;
}

function fixHour(h: number): number {
  const res = h - 24 * Math.floor(h / 24);
  return res < 0 ? res + 24 : res;
}

function julianDate(year: number, month: number, day: number): number {
  let y = year;
  let m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + b - 1524.5;
}

function sunPosition(jd: number): { declination: number; equation: number } {
  const d = jd - 2451545.0;
  const g = fixAngle(357.529 + 0.98560028 * d);
  const q = fixAngle(280.459 + 0.98564736 * d);
  const l = fixAngle(q + 1.915 * sind(g) + 0.02 * sind(2 * g));
  const e = 23.439 - 0.00000036 * d;

  const ra = fixHour(atan2d(cosd(e) * sind(l), cosd(l)) / 15);
  const declination = asind(sind(e) * sind(l));
  let equation = q / 15 - ra;
  if (equation > 12) equation -= 24;
  if (equation < -12) equation += 24;
  return { declination, equation };
}

function computeMidDay(jdDay: number, timeHours: number): number {
  const { equation } = sunPosition(jdDay + timeHours / 24);
  return fixHour(12 - equation);
}

function computeSunAngleTime(
  jdDay: number,
  lat: number,
  angleBelowHorizon: number,
  timeHours: number,
  ccw: boolean
): number {
  const { declination } = sunPosition(jdDay + timeHours / 24);
  const noon = computeMidDay(jdDay, timeHours);
  const num = -sind(angleBelowHorizon) - sind(lat) * sind(declination);
  const den = cosd(lat) * cosd(declination);
  if (Math.abs(den) < 1e-9) {
    return noon;
  }
  const cosVal = Math.max(-1, Math.min(1, num / den));
  const delta = acosd(cosVal) / 15;
  return noon + (ccw ? -delta : delta);
}

function computeAsrTime(jdDay: number, lat: number, shadowFactor: number, timeHours: number): number {
  const { declination } = sunPosition(jdDay + timeHours / 24);
  const altitudeAngle = acotd(shadowFactor + tand(Math.abs(lat - declination)));
  return computeSunAngleTime(jdDay, lat, -altitudeAngle, timeHours, false);
}

function formatMinutesAsHHMM(totalMinutes: number): string {
  const wrapped = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
  const hh = Math.floor(wrapped / 60)
    .toString()
    .padStart(2, '0');
  const mm = (wrapped % 60).toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatCountdown(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const hrs = Math.floor(m / 60);
  const rem = m % 60;
  if (hrs > 0 && rem > 0) return `${hrs}h ${rem}m`;
  if (hrs > 0) return `${hrs}h`;
  return `${rem}m`;
}

/**
 * Extracts local year, month, day, hour, minute, and UTC offset (hours) in any IANA timezone.
 */
export function getZonedDateParts(
  now: Date,
  timezone: string
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  dateStr: string;
  timeStr: string;
  utcOffsetHours: number;
} {
  let validTz = timezone || 'Asia/Dubai';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: validTz }).format(now);
  } catch {
    validTz = 'Asia/Dubai';
  }

  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: validTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts: Record<string, number> = {};
  for (const p of fmt.formatToParts(now)) {
    if (p.type !== 'literal') {
      parts[p.type] = parseInt(p.value, 10);
    }
  }

  const year = parts.year || now.getUTCFullYear();
  const month = parts.month || now.getUTCMonth() + 1;
  const day = parts.day || now.getUTCDate();
  const hour = (parts.hour ?? now.getUTCHours()) % 24;
  const minute = parts.minute ?? now.getUTCMinutes();
  const second = parts.second ?? now.getUTCSeconds();

  const zonedAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const utcOffsetHours = Math.round(((zonedAsUtcMs - now.getTime()) / 3600000) * 4) / 4;

  const dateStr = `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day
    .toString()
    .padStart(2, '0')}`;
  const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;

  return { year, month, day, hour, minute, dateStr, timeStr, utcOffsetHours };
}

/**
 * Pure astronomical prayer-time calculation for a given civil date and location.
 */
export function calculatePrayerMinutes(params: {
  year: number;
  month: number;
  day: number;
  latitude: number;
  longitude: number;
  utcOffsetHours: number;
  method: AdhanMethodKey;
  madhab: AdhanMadhabKey;
  adjustments?: Partial<Record<AdhanPrayerKey, number>>;
}): Record<AdhanPrayerKey | 'sunrise', number> {
  const spec = ADHAN_METHOD_SPECS[params.method] || ADHAN_METHOD_SPECS.uae;
  const shadowFactor = params.madhab === 'hanafi' ? 2 : 1;
  const baseJd = julianDate(params.year, params.month, params.day) - params.longitude / 360;

  let fajr = 5;
  let sunrise = 6;
  let dhuhr = 12;
  let asr = 15;
  let maghrib = 18;
  let isha = 19;

  for (let pass = 0; pass < 2; pass++) {
    fajr = computeSunAngleTime(baseJd, params.latitude, spec.fajrAngle, fajr, true);
    sunrise = computeSunAngleTime(baseJd, params.latitude, 0.8333, sunrise, true);
    dhuhr = computeMidDay(baseJd, dhuhr);
    asr = computeAsrTime(baseJd, params.latitude, shadowFactor, asr);
    maghrib = computeSunAngleTime(baseJd, params.latitude, 0.8333, maghrib, false);
    if (spec.ishaAngle !== undefined) {
      isha = computeSunAngleTime(baseJd, params.latitude, spec.ishaAngle, isha, false);
    } else {
      isha = maghrib + (spec.ishaMinutesAfterMaghrib ?? 90) / 60;
    }
  }

  const tzAdjustMinutes = params.utcOffsetHours * 60 - params.longitude * 4;
  const adj = params.adjustments || {};

  const toLocalMin = (solarHours: number, extraMin: number) =>
    Math.round(solarHours * 60 + tzAdjustMinutes + extraMin);

  const sunriseMin = toLocalMin(sunrise, 0);
  const fajrMin = toLocalMin(fajr, adj.fajr ?? 0);
  const dhuhrMin = toLocalMin(dhuhr, spec.dhuhrOffsetMinutes + (adj.dhuhr ?? 0));
  const asrMin = toLocalMin(asr, adj.asr ?? 0);
  const maghribMin = toLocalMin(maghrib, spec.maghribOffsetMinutes + (adj.maghrib ?? 0));
  const ishaMin = toLocalMin(isha, adj.isha ?? 0);

  return {
    fajr: fajrMin,
    sunrise: sunriseMin,
    dhuhr: dhuhrMin,
    asr: asrMin,
    maghrib: maghribMin,
    isha: ishaMin,
  };
}

function parseBoolEnv(val: string | undefined, fallback: boolean): boolean {
  if (val === undefined || val === '') return fallback;
  return val.trim().toLowerCase() !== 'false' && val.trim() !== '0';
}

function parseFloatEnv(val: string | undefined, fallback: number): number {
  const n = val ? Number(val) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function clampVolume(val: unknown, fallback: number): number {
  const num = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(num)) return fallback;
  const scaled = num > 1 ? num / 100 : num;
  return Math.max(0, Math.min(1, Math.round(scaled * 100) / 100));
}

export class AdhanManager {
  private configPath: string;
  private audioDir: string;
  private haClient?: HomeAssistantClient;
  private webOSManager?: LGWebOSManager;
  private speakerEntityId: string;
  private config: AdhanConfig;
  private timer: NodeJS.Timeout | null = null;
  private pendingVolumeTimers: NodeJS.Timeout[] = [];
  private isTicking = false;
  private lastTriggered: Record<string, number> = {};

  constructor(
    dataDir: string = process.env.DATA_DIR || './data',
    haClient?: HomeAssistantClient,
    webOSManager?: LGWebOSManager,
    speakerEntityId: string = process.env.SPEAKER_ENTITY_ID || 'media_player.living_room_vlc_telnet'
  ) {
    this.configPath = path.join(dataDir, 'adhan_config.json');
    this.audioDir = path.join(dataDir, 'audio');
    this.haClient = haClient;
    this.webOSManager = webOSManager;
    this.speakerEntityId = speakerEntityId;
    this.config = this.loadConfig();
  }

  private buildEnvDefaults(): AdhanConfig {
    const cityKey = (process.env.ADHAN_CITY || 'dubai').trim().toLowerCase();
    const preset = ADHAN_CITY_PRESETS[cityKey] || ADHAN_CITY_PRESETS.dubai;
    const rawMethod = (process.env.ADHAN_METHOD || preset.method).trim().toLowerCase() as AdhanMethodKey;
    const method: AdhanMethodKey = ADHAN_METHOD_SPECS[rawMethod] ? rawMethod : preset.method;
    const rawMadhab = (process.env.ADHAN_MADHAB || 'shafi').trim().toLowerCase();
    const madhab: AdhanMadhabKey = rawMadhab === 'hanafi' ? 'hanafi' : 'shafi';

    return {
      enabled: parseBoolEnv(process.env.ADHAN_ENABLED, true),
      city: ADHAN_CITY_PRESETS[cityKey] ? cityKey : 'custom',
      latitude: parseFloatEnv(process.env.ADHAN_LAT, preset.latitude),
      longitude: parseFloatEnv(process.env.ADHAN_LON, preset.longitude),
      timezone: process.env.ADHAN_TIMEZONE || preset.timezone,
      method,
      madhab,
      audioUrl: (process.env.ADHAN_AUDIO_URL || '').trim(),
      fajrAudioUrl: (process.env.ADHAN_FAJR_AUDIO_URL || '').trim(),
      lanBaseUrl: (process.env.NEPTUNE_LAN_URL || '').trim().replace(/\/+$/, ''),
      volume: clampVolume(process.env.ADHAN_VOLUME, 0.7),
      fajrVolume: clampVolume(process.env.ADHAN_FAJR_VOLUME, 0.45),
      tvToast: parseBoolEnv(process.env.ADHAN_TV_TOAST, true),
      prayers: {
        fajr: true,
        dhuhr: true,
        asr: true,
        maghrib: true,
        isha: true,
      },
      adjustments: {
        fajr: 0,
        dhuhr: 0,
        asr: 0,
        maghrib: 0,
        isha: 0,
      },
    };
  }

  private loadConfig(): AdhanConfig {
    const defaults = this.buildEnvDefaults();
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          return this.mergeConfig(defaults, parsed);
        }
      }
    } catch (err) {
      console.warn('[AdhanManager] Failed to load saved adhan_config.json, using defaults:', err);
    }
    return defaults;
  }

  private mergeConfig(base: AdhanConfig, patch: Partial<AdhanConfig>): AdhanConfig {
    const next: AdhanConfig = {
      ...base,
      prayers: { ...base.prayers },
      adjustments: { ...base.adjustments },
    };

    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
    if (typeof patch.tvToast === 'boolean') next.tvToast = patch.tvToast;

    if (typeof patch.city === 'string' && patch.city.trim()) {
      const cleanCity = patch.city.trim().toLowerCase();
      next.city = cleanCity;
      const preset = ADHAN_CITY_PRESETS[cleanCity];
      if (preset && cleanCity !== base.city) {
        next.latitude = preset.latitude;
        next.longitude = preset.longitude;
        next.timezone = preset.timezone;
        next.method = preset.method;
      }
    }

    if (typeof patch.latitude === 'number' && Number.isFinite(patch.latitude) && patch.latitude >= -90 && patch.latitude <= 90) {
      next.latitude = patch.latitude;
    }
    if (typeof patch.longitude === 'number' && Number.isFinite(patch.longitude) && patch.longitude >= -180 && patch.longitude <= 180) {
      next.longitude = patch.longitude;
    }
    if (typeof patch.timezone === 'string' && patch.timezone.trim()) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: patch.timezone.trim() }).format(new Date());
        next.timezone = patch.timezone.trim();
      } catch {
        // Ignore invalid timezone string
      }
    }
    if (typeof patch.method === 'string' && ADHAN_METHOD_SPECS[patch.method as AdhanMethodKey]) {
      next.method = patch.method as AdhanMethodKey;
    }
    if (patch.madhab === 'shafi' || patch.madhab === 'hanafi') {
      next.madhab = patch.madhab;
    }
    if (typeof patch.audioUrl === 'string') {
      next.audioUrl = patch.audioUrl.trim();
    }
    if (typeof patch.fajrAudioUrl === 'string') {
      next.fajrAudioUrl = patch.fajrAudioUrl.trim();
    }
    if (typeof patch.lanBaseUrl === 'string') {
      next.lanBaseUrl = patch.lanBaseUrl.trim().replace(/\/+$/, '');
    }
    if (patch.volume !== undefined) {
      next.volume = clampVolume(patch.volume, next.volume);
    }
    if (patch.fajrVolume !== undefined) {
      next.fajrVolume = clampVolume(patch.fajrVolume, next.fajrVolume);
    }

    if (patch.prayers && typeof patch.prayers === 'object') {
      for (const k of ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] as AdhanPrayerKey[]) {
        if (typeof patch.prayers[k] === 'boolean') {
          next.prayers[k] = patch.prayers[k];
        }
      }
    }

    if (patch.adjustments && typeof patch.adjustments === 'object') {
      for (const k of ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] as AdhanPrayerKey[]) {
        const val = Number(patch.adjustments[k]);
        if (Number.isFinite(val)) {
          next.adjustments[k] = Math.max(-60, Math.min(60, Math.round(val)));
        }
      }
    }

    return next;
  }

  private persistConfig(): void {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmp = `${this.configPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.config, null, 2), 'utf-8');
      fs.renameSync(tmp, this.configPath);
    } catch (err) {
      console.error('[AdhanManager] Failed to persist adhan_config.json:', err);
    }
  }

  public getConfig(): AdhanConfig {
    return {
      ...this.config,
      prayers: { ...this.config.prayers },
      adjustments: { ...this.config.adjustments },
    };
  }

  public updateConfig(patch: Partial<AdhanConfig>): AdhanConfig {
    this.config = this.mergeConfig(this.config, patch || {});
    this.persistConfig();
    return this.getConfig();
  }

  public getSchedule(now: Date = new Date()): AdhanScheduleSummary {
    const zoned = getZonedDateParts(now, this.config.timezone);
    const rawMin = calculatePrayerMinutes({
      year: zoned.year,
      month: zoned.month,
      day: zoned.day,
      latitude: this.config.latitude,
      longitude: this.config.longitude,
      utcOffsetHours: zoned.utcOffsetHours,
      method: this.config.method,
      madhab: this.config.madhab,
      adjustments: this.config.adjustments,
    });

    const times: Record<AdhanPrayerKey | 'sunrise', string> = {
      fajr: formatMinutesAsHHMM(rawMin.fajr),
      sunrise: formatMinutesAsHHMM(rawMin.sunrise),
      dhuhr: formatMinutesAsHHMM(rawMin.dhuhr),
      asr: formatMinutesAsHHMM(rawMin.asr),
      maghrib: formatMinutesAsHHMM(rawMin.maghrib),
      isha: formatMinutesAsHHMM(rawMin.isha),
    };

    const nowMinutes = zoned.hour * 60 + zoned.minute;
    const prayerOrder: AdhanPrayerKey[] = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
    let nextKey: AdhanPrayerKey = 'fajr';
    let inMinutes = 0;
    let foundToday = false;

    for (const key of prayerOrder) {
      if (rawMin[key] > nowMinutes) {
        nextKey = key;
        inMinutes = rawMin[key] - nowMinutes;
        foundToday = true;
        break;
      }
    }

    if (!foundToday) {
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const tmrZoned = getZonedDateParts(tomorrow, this.config.timezone);
      const tmrMin = calculatePrayerMinutes({
        year: tmrZoned.year,
        month: tmrZoned.month,
        day: tmrZoned.day,
        latitude: this.config.latitude,
        longitude: this.config.longitude,
        utcOffsetHours: tmrZoned.utcOffsetHours,
        method: this.config.method,
        madhab: this.config.madhab,
        adjustments: this.config.adjustments,
      });
      nextKey = 'fajr';
      inMinutes = 1440 - nowMinutes + tmrMin.fajr;
    }

    const schedule: PrayerScheduleItem[] = [
      { key: 'fajr', label: 'Fajr', time: times.fajr, minutes: rawMin.fajr, enabled: this.config.prayers.fajr, isNext: foundToday && nextKey === 'fajr' },
      { key: 'sunrise', label: 'Sunrise', time: times.sunrise, minutes: rawMin.sunrise, enabled: false, isNext: false },
      { key: 'dhuhr', label: 'Dhuhr', time: times.dhuhr, minutes: rawMin.dhuhr, enabled: this.config.prayers.dhuhr, isNext: foundToday && nextKey === 'dhuhr' },
      { key: 'asr', label: 'Asr', time: times.asr, minutes: rawMin.asr, enabled: this.config.prayers.asr, isNext: foundToday && nextKey === 'asr' },
      { key: 'maghrib', label: 'Maghrib', time: times.maghrib, minutes: rawMin.maghrib, enabled: this.config.prayers.maghrib, isNext: foundToday && nextKey === 'maghrib' },
      { key: 'isha', label: 'Isha', time: times.isha, minutes: rawMin.isha, enabled: this.config.prayers.isha, isNext: foundToday && nextKey === 'isha' },
    ];

    return {
      date: zoned.dateStr,
      currentTime: zoned.timeStr,
      timezone: this.config.timezone,
      times,
      schedule,
      nextPrayer: {
        key: nextKey,
        label: PRAYER_LABELS[nextKey],
        time: times[nextKey],
        inMinutes,
        countdown: formatCountdown(inMinutes),
      },
    };
  }

  public hasAudioFile(filename: 'adhan.mp3' | 'adhan_fajr.mp3'): boolean {
    return fs.existsSync(path.join(this.audioDir, filename));
  }

  public getAudioFilePath(filename: string): string | null {
    if (!ALLOWED_AUDIO_FILENAMES.has(filename)) {
      return null;
    }
    const fullPath = path.join(this.audioDir, filename);
    return fs.existsSync(fullPath) ? fullPath : null;
  }

  public saveAudioFile(kind: 'default' | 'fajr', base64Data: string): { success: boolean; filename?: string; error?: string } {
    if (typeof base64Data !== 'string' || !base64Data.trim()) {
      return { success: false, error: 'Missing audio base64 payload.' };
    }
    const cleanB64 = base64Data.includes(',') ? base64Data.split(',')[1] : base64Data;
    const buf = Buffer.from(cleanB64.trim(), 'base64');
    if (buf.length < 100) {
      return { success: false, error: 'Audio file appears empty or invalid.' };
    }
    if (buf.length > MAX_AUDIO_UPLOAD_BYTES) {
      return { success: false, error: 'Audio file exceeds maximum size of 10 MB.' };
    }

    const filename = kind === 'fajr' ? 'adhan_fajr.mp3' : 'adhan.mp3';
    try {
      if (!fs.existsSync(this.audioDir)) {
        fs.mkdirSync(this.audioDir, { recursive: true });
      }
      const target = path.join(this.audioDir, filename);
      const tmp = `${target}.tmp`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, target);
      return { success: true, filename };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private resolveAudioUrl(prayer: AdhanPrayerKey, requestOrigin?: string): string {
    const base = (this.config.lanBaseUrl || process.env.NEPTUNE_LAN_URL || requestOrigin || '').trim().replace(/\/+$/, '');
    const localUrl = (filename: 'adhan.mp3' | 'adhan_fajr.mp3'): string =>
      base && this.hasAudioFile(filename) ? `${base}/api/adhan/audio/${filename}` : '';

    if (prayer === 'fajr') {
      return (
        this.config.fajrAudioUrl ||
        localUrl('adhan_fajr.mp3') ||
        this.config.audioUrl ||
        localUrl('adhan.mp3')
      );
    }
    return this.config.audioUrl || localUrl('adhan.mp3');
  }

  private clearPendingVolumeTimers(): void {
    for (const t of this.pendingVolumeTimers) {
      clearTimeout(t);
    }
    this.pendingVolumeTimers = [];
  }

  private async applySpeakerVolume(volumeLevel: number): Promise<{ success: boolean; details: string }> {
    if (!this.haClient) {
      return { success: false, details: 'Home Assistant client is not configured.' };
    }
    const clamped = clampVolume(volumeLevel, 0.7);
    try {
      const res = await this.haClient.callService('media_player', 'volume_set', this.speakerEntityId, {
        volume_level: clamped,
      });
      return { success: res.success, details: res.message };
    } catch (err: unknown) {
      return { success: false, details: err instanceof Error ? err.message : String(err) };
    }
  }

  private schedulePostStartVolume(volumeLevel: number): void {
    this.clearPendingVolumeTimers();
    for (const delayMs of [500, 1500]) {
      const t = setTimeout(() => {
        void this.applySpeakerVolume(volumeLevel);
      }, delayMs);
      if (typeof t.unref === 'function') {
        t.unref();
      }
      this.pendingVolumeTimers.push(t);
    }
  }

  public async setSpeakerVolume(
    levelInput: number,
    kind: 'default' | 'fajr' = 'default'
  ): Promise<{
    success: boolean;
    kind: 'default' | 'fajr';
    volume: number;
    volumePercent: number;
    speech: string;
    details: string;
  }> {
    const fallback = kind === 'fajr' ? this.config.fajrVolume : this.config.volume;
    const normalized = clampVolume(levelInput, fallback);
    this.clearPendingVolumeTimers();

    if (kind === 'fajr') {
      this.config.fajrVolume = normalized;
    } else {
      this.config.volume = normalized;
    }
    this.persistConfig();

    const pct = Math.round(normalized * 100);
    const haRes = await this.applySpeakerVolume(normalized);
    return {
      success: haRes.success,
      kind,
      volume: normalized,
      volumePercent: pct,
      speech: haRes.success
        ? `Set home speaker ${kind === 'fajr' ? 'Fajr ' : ''}volume to ${pct}%.`
        : `Saved ${pct}%, but could not reach Home Assistant speakers.`,
      details: haRes.details,
    };
  }

  public async triggerAdhan(
    prayerInput: string = 'maghrib',
    opts: { requestOrigin?: string; timeStr?: string; volume?: number } = {}
  ): Promise<AdhanTriggerResult> {
    const cleanKey = prayerInput.trim().toLowerCase() as AdhanPrayerKey;
    const prayer: AdhanPrayerKey = PRAYER_LABELS[cleanKey] ? cleanKey : 'maghrib';
    const label = PRAYER_LABELS[prayer];
    const schedule = this.getSchedule();
    const displayTime = opts.timeStr || schedule.times[prayer];

    let tvToastSent = false;
    if (this.config.tvToast && this.webOSManager) {
      try {
        await this.webOSManager.showToast(`🕌 Adhan: Time for ${label} prayer (${displayTime})`);
        tvToastSent = true;
      } catch (err) {
        console.error('[AdhanManager] Failed to send TV toast:', err);
      }
    }

    if (!this.haClient) {
      return {
        success: false,
        prayer,
        label,
        method: 'none',
        tvToastSent,
        speech: `Adhan trigger for ${label} could not reach Home Assistant.`,
        details: 'Home Assistant client is not configured.',
      };
    }

    let targetVolume = prayer === 'fajr' ? this.config.fajrVolume : this.config.volume;
    if (opts.volume !== undefined && Number.isFinite(Number(opts.volume))) {
      targetVolume = clampVolume(opts.volume, targetVolume);
      if (prayer === 'fajr') {
        this.config.fajrVolume = targetVolume;
      } else {
        this.config.volume = targetVolume;
      }
      this.persistConfig();
    }

    this.clearPendingVolumeTimers();
    await this.applySpeakerVolume(targetVolume);

    const audioUrl = this.resolveAudioUrl(prayer, opts.requestOrigin);
    if (audioUrl) {
      try {
        const playRes = await this.haClient.callService('media_player', 'play_media', this.speakerEntityId, {
          media_content_id: audioUrl,
          media_content_type: 'music',
        });
        if (playRes.success) {
          this.schedulePostStartVolume(targetVolume);
          return {
            success: true,
            prayer,
            label,
            method: 'media_player',
            audioUrl,
            tvToastSent,
            speech: `Playing ${label} Adhan on whole-house speakers (${Math.round(targetVolume * 100)}% vol).`,
            details: playRes.message,
          };
        }
        console.warn(`[AdhanManager] play_media failed (${playRes.message}), falling back to TTS.`);
      } catch (err) {
        console.warn('[AdhanManager] play_media error, falling back to TTS:', err);
      }
    }

    const ttsMessage = `Allahu Akbar. It is now time for ${label} prayer.`;
    try {
      const ttsRes = await this.haClient.callService('tts', 'speak', 'tts.google_translate_en_com', {
        media_player_entity_id: this.speakerEntityId,
        message: ttsMessage,
      });
      if (ttsRes.success) {
        this.schedulePostStartVolume(targetVolume);
      }
      return {
        success: ttsRes.success,
        prayer,
        label,
        method: 'tts_fallback',
        tvToastSent,
        speech: ttsRes.success
          ? `Announcing ${label} prayer time on whole-house speakers.`
          : `Failed to announce ${label} prayer time.`,
        details: ttsRes.message,
      };
    } catch (err: unknown) {
      return {
        success: false,
        prayer,
        label,
        method: 'none',
        tvToastSent,
        speech: `Failed to announce ${label} prayer time.`,
        details: err instanceof Error ? err.message : String(err),
      };
    }
  }

  public async stopAdhan(): Promise<{ success: boolean; speech: string; details: string }> {
    this.clearPendingVolumeTimers();
    if (!this.haClient) {
      return { success: false, speech: 'Home Assistant client is not configured.', details: 'No HA client.' };
    }
    const res = await this.haClient.callService('media_player', 'media_stop', this.speakerEntityId);
    return {
      success: res.success,
      speech: res.success ? 'Stopped Adhan playback on home speakers.' : 'Could not stop speaker playback.',
      details: res.message,
    };
  }

  public formatPrayerQuerySpeech(prayerQuery?: string): string {
    const summary = this.getSchedule();
    const clean = (prayerQuery || '').trim().toLowerCase();

    const aliases: Record<string, AdhanPrayerKey> = {
      fajr: 'fajr',
      fajar: 'fajr',
      dhuhr: 'dhuhr',
      zuhr: 'dhuhr',
      asr: 'asr',
      maghrib: 'maghrib',
      magrib: 'maghrib',
      isha: 'isha',
      esha: 'isha',
    };

    if (clean && aliases[clean]) {
      const key = aliases[clean];
      return `${PRAYER_LABELS[key]} prayer today is at ${summary.times[key]}.`;
    }

    if (clean === 'all' || clean === 'today') {
      return `Today's prayer times: Fajr ${summary.times.fajr}, Dhuhr ${summary.times.dhuhr}, Asr ${summary.times.asr}, Maghrib ${summary.times.maghrib}, and Isha ${summary.times.isha}.`;
    }

    const next = summary.nextPrayer;
    return `The next prayer is ${next.label} at ${next.time}, in ${next.countdown}.`;
  }

  public getStatus(now: Date = new Date()) {
    const schedule = this.getSchedule(now);
    return {
      ...schedule,
      config: this.getConfig(),
      hasDefaultAudio: this.hasAudioFile('adhan.mp3'),
      hasFajrAudio: this.hasAudioFile('adhan_fajr.mp3'),
      presets: Object.values(ADHAN_CITY_PRESETS),
      methods: Object.values(ADHAN_METHOD_SPECS).map((m) => ({ id: m.id, label: m.label })),
    };
  }

  public start(pollIntervalMs: number = 15000): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      void this.tick();
    }, pollIntervalMs);
  }

  public stop(): void {
    this.clearPendingVolumeTimers();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public async tick(now: Date = new Date()): Promise<void> {
    if (!this.config.enabled || this.isTicking) {
      return;
    }
    this.isTicking = true;
    try {
      const summary = this.getSchedule(now);
      const prayerKeys: AdhanPrayerKey[] = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
      for (const key of prayerKeys) {
        if (!this.config.prayers[key]) continue;
        if (summary.times[key] === summary.currentTime) {
          const dedupeKey = `${summary.date}:${key}`;
          if (this.lastTriggered[dedupeKey]) continue;
          this.lastTriggered[dedupeKey] = Date.now();
          console.log(`[AdhanManager] Prayer time reached: ${PRAYER_LABELS[key]} (${summary.currentTime} ${summary.timezone})`);
          await this.triggerAdhan(key, { timeStr: summary.times[key] });
        }
      }

      // Prune stale deduplication keys older than 36 hours
      const cutoff = Date.now() - 36 * 60 * 60 * 1000;
      for (const k of Object.keys(this.lastTriggered)) {
        if (this.lastTriggered[k] < cutoff) {
          delete this.lastTriggered[k];
        }
      }
    } finally {
      this.isTicking = false;
    }
  }
}
