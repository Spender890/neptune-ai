import { HomeAssistantClient } from './homeassistant';
import { JellyfinClient, type JellyfinSession } from './jellyfin';

export interface TVActionResult {
  success: boolean;
  action: string;
  speech: string;
  details?: string;
}

export interface TVPlaybackState {
  success: boolean;
  power: 'off' | 'on' | 'playing' | 'paused' | 'idle';
  source?: string;
  title?: string;
  seriesTitle?: string;
  volumePercent: number;
  isMuted: boolean;
  soundOutput: string;
  speech: string;
  details?: Record<string, unknown>;
}

export class LGWebOSManager {
  private haClient: HomeAssistantClient;
  private jellyfinClient: JellyfinClient;
  private tvEntityId: string;

  constructor(
    haClient: HomeAssistantClient,
    jellyfinClient: JellyfinClient,
    tvEntityId: string = 'media_player.living_room_lg_webos_tv_qned806qa'
  ) {
    this.haClient = haClient;
    this.jellyfinClient = jellyfinClient;
    this.tvEntityId = tvEntityId;
  }

  /**
   * Normalizes colloquial app or source names to exact webOS source strings.
   */
  public normalizeSourceName(input: string): string {
    const clean = input.trim().toLowerCase();
    const map: Record<string, string> = {
      'youtube': 'YouTube',
      'jellyfin': 'Jellyfin',
      'netflix': 'Netflix',
      'apple tv': 'Apple TV',
      'appletv': 'Apple TV',
      'disney': 'Disney+',
      'disney+': 'Disney+',
      'disney plus': 'Disney+',
      'prime': 'Prime Video',
      'prime video': 'Prime Video',
      'amazon prime': 'Prime Video',
      'twitch': 'Twitch',
      'live tv': 'Live TV',
      'tv': 'Live TV',
      'web browser': 'Web Browser',
      'browser': 'Web Browser',
      'ps4': 'PS4 Game Console',
      'ps4 game console': 'PS4 Game Console',
      'playstation': 'PS4 Game Console',
      'hdmi 1': 'HDMI 1',
      'hdmi1': 'HDMI 1',
      'hdmi 2': 'HDMI 2',
      'hdmi2': 'HDMI 2',
      'hdmi 3': 'HDMI 3',
      'hdmi3': 'HDMI 3',
      'hdmi 4': 'HDMI 4',
      'hdmi4': 'HDMI 4',
    };
    return map[clean] || input;
  }

  /**
   * Power on LG TV via Home Assistant (Wake-on-LAN + Network Standby).
   */
  public async powerOn(): Promise<TVActionResult> {
    const res = await this.haClient.callService('media_player', 'turn_on', this.tvEntityId);
    return {
      success: res.success,
      action: 'power_on',
      speech: 'Turning on the TV.',
      details: res.message,
    };
  }

  /**
   * Power off LG TV.
   */
  public async powerOff(): Promise<TVActionResult> {
    const res = await this.haClient.callService('media_player', 'turn_off', this.tvEntityId);
    return {
      success: res.success,
      action: 'power_off',
      speech: 'Turning off the TV.',
      details: res.message,
    };
  }

  /**
   * Set volume on TV (level: 0 - 100).
   */
  public async setVolume(level: number): Promise<TVActionResult> {
    const normalized = Math.max(0, Math.min(100, level)) / 100;
    const res = await this.haClient.callService('media_player', 'volume_set', this.tvEntityId, {
      volume_level: normalized,
    });
    return {
      success: res.success,
      action: 'set_volume',
      speech: `TV volume set to ${level} percent.`,
      details: res.message,
    };
  }

  /**
   * Step volume up.
   */
  public async volumeUp(): Promise<TVActionResult> {
    const res = await this.haClient.callService('media_player', 'volume_up', this.tvEntityId);
    return {
      success: res.success,
      action: 'volume_up',
      speech: 'Turned up the TV volume.',
      details: res.message,
    };
  }

  /**
   * Toggle TV power (turns on if off, turns off if on).
   */
  public async togglePower(): Promise<TVActionResult> {
    const state = await this.getPlaybackState();
    if (state.power === 'off') {
      return this.powerOn();
    } else {
      return this.powerOff();
    }
  }

  /**
   * Set mute or toggle mute on TV.
   */
  public async setMute(mute?: boolean): Promise<TVActionResult> {
    const targetMute = mute ?? true;
    const res = await this.haClient.callService('media_player', 'volume_mute', this.tvEntityId, {
      is_volume_muted: targetMute,
    });
    return {
      success: res.success,
      action: 'mute',
      speech: targetMute ? 'Muted the TV volume.' : 'Unmuted the TV volume.',
      details: res.message,
    };
  }

  /**
   * Step volume down.
   */
  public async volumeDown(): Promise<TVActionResult> {
    const res = await this.haClient.callService('media_player', 'volume_down', this.tvEntityId);
    return {
      success: res.success,
      action: 'volume_down',
      speech: 'Turned down the TV volume.',
      details: res.message,
    };
  }

  /**
   * Play, pause, or resume TV media playback.
   */
  public async controlPlayback(action: 'play' | 'pause' | 'stop'): Promise<TVActionResult> {
    const service = action === 'pause' ? 'media_pause' : action === 'play' ? 'media_play' : 'media_stop';
    const res = await this.haClient.callService('media_player', service, this.tvEntityId);
    return {
      success: res.success,
      action,
      speech: `${action.charAt(0).toUpperCase() + action.slice(1)}ing TV playback.`,
      details: res.message,
    };
  }

  /**
   * Launch a specific webOS application or select an input.
   * e.g. "YouTube", "Netflix", "Jellyfin", "HDMI 2", "HDMI 3"
   */
  public async launchAppOrSource(sourceName: string): Promise<TVActionResult> {
    const targetSource = this.normalizeSourceName(sourceName);
    const res = await this.haClient.callService('media_player', 'select_source', this.tvEntityId, {
      source: targetSource,
    });
    return {
      success: res.success,
      action: 'select_source',
      speech: `Opening ${targetSource} on TV.`,
      details: res.message,
    };
  }

  /**
   * Send an on-screen toast alert banner to the LG TV.
   * Uses Home Assistant's native webostv.command endpoint: system.notifications/createToast.
   */
  public async showToast(message: string): Promise<TVActionResult> {
    const res = await this.haClient.callService('webostv', 'command', this.tvEntityId, {
      command: 'system.notifications/createToast',
      payload: { message },
    });
    return {
      success: res.success,
      action: 'show_toast',
      speech: 'Notification sent to TV.',
      details: res.message,
    };
  }

  /**
   * Queries the live state of the LG webOS TV and what is currently playing.
   * Combines Home Assistant media_player state and active Jellyfin sessions.
   */
  public async getPlaybackState(): Promise<TVPlaybackState> {
    try {
      const haState = await this.haClient.getState(this.tvEntityId);
      if (!haState.success || !haState.state || haState.state === 'off' || haState.state === 'standby' || haState.state === 'unavailable') {
        return {
          success: true,
          power: 'off',
          volumePercent: 0,
          isMuted: false,
          soundOutput: 'tv_speaker',
          speech: 'The living room TV is currently off.',
        };
      }

      const attrs = haState.attributes || {};
      const source = typeof attrs.source === 'string' && attrs.source ? attrs.source : 'Live TV';
      const rawVol = typeof attrs.volume_level === 'number' ? attrs.volume_level : undefined;
      const volumeLevel = rawVol !== undefined ? Math.round(rawVol * 100) : 30;
      const isMuted = Boolean(attrs.is_volume_muted);
      const soundOutput =
        typeof attrs.sound_output === 'string' && attrs.sound_output ? attrs.sound_output : 'tv_speaker';
      let title = typeof attrs.media_title === 'string' ? attrs.media_title : '';
      let seriesTitle = typeof attrs.media_series_title === 'string' ? attrs.media_series_title : '';

      // If media_title is empty and source is Jellyfin, check Jellyfin server sessions directly
      if (!title && source.toLowerCase().includes('jellyfin')) {
        try {
          const sessions = await this.jellyfinClient.getSessions();
          if (Array.isArray(sessions) && sessions.length > 0) {
            const tvSession = sessions.find(
              (s: JellyfinSession) => s.DeviceName === 'LG Smart TV' || (s.Client && s.Client.includes('Jellyfin'))
            );
            if (tvSession && tvSession.NowPlayingItem) {
              title = tvSession.NowPlayingItem.Name || '';
              if (tvSession.NowPlayingItem.SeriesName) {
                seriesTitle = tvSession.NowPlayingItem.SeriesName;
              }
            }
          }
        } catch {
          // Soft ignore Jellyfin session query error
        }
      }

      const rawState = haState.state.toLowerCase();
      let power: 'off' | 'on' | 'playing' | 'paused' | 'idle' = 'on';
      let speech = '';

      const soundDesc = soundOutput === 'external_arc' ? 'home speakers via ARC' : soundOutput === 'optical' ? 'home speakers via Optical' : 'TV speakers';

      if (rawState === 'playing') {
        power = 'playing';
        if (title) {
          speech = `The TV is currently playing "${title}" on ${source} at ${volumeLevel}% volume using ${soundDesc}.`;
        } else {
          speech = `The TV is currently playing on ${source} at ${volumeLevel}% volume.`;
        }
      } else if (rawState === 'paused') {
        power = 'paused';
        if (title) {
          speech = `The TV is currently paused on "${title}" (${source}).`;
        } else {
          speech = `The TV is currently paused on ${source}.`;
        }
      } else {
        power = 'idle';
        if (title) {
          speech = `The TV is currently on ${source}, showing "${title}" at ${volumeLevel}% volume.`;
        } else {
          speech = `The TV is currently on ${source} at ${volumeLevel}% volume.`;
        }
      }

      return {
        success: true,
        power,
        source,
        title: title || undefined,
        seriesTitle: seriesTitle || undefined,
        volumePercent: volumeLevel,
        isMuted,
        soundOutput,
        speech,
        details: attrs,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        power: 'off',
        volumePercent: 0,
        isMuted: false,
        soundOutput: 'unknown',
        speech: `Unable to read TV status: ${message}`,
      };
    }
  }

  /**
   * Route TV audio output:
   * - 'external_arc': HDMI ARC / eARC to Soundbar / AVR / Home Speakers amplifier
   * - 'optical': Digital Optical out
   * - 'tv_speaker': Internal TV speakers
   */
  public async selectSoundOutput(soundOutput: string): Promise<TVActionResult> {
    const validOutputs = ['external_arc', 'optical', 'tv_speaker', 'tv_external_speaker', 'lineout', 'headphone'];
    const target = validOutputs.includes(soundOutput) ? soundOutput : 'external_arc';

    const res = await this.haClient.callService('webostv', 'select_sound_output', this.tvEntityId, {
      sound_output: target,
    });

    const isHomeSpeakers = target === 'external_arc' || target === 'optical';
    const speech = isHomeSpeakers
      ? 'Routing TV audio through the whole-house speakers amplifier.'
      : 'Switched TV sound back to internal TV speakers.';

    return {
      success: res.success,
      action: 'select_sound_output',
      speech,
      details: res.message,
    };
  }

  /**
   * Convenience helper to route TV audio to whole-house speakers.
   */
  public async routeAudioToHomeSpeakers(): Promise<TVActionResult> {
    return this.selectSoundOutput('external_arc');
  }

  /**
   * Convenience helper to switch TV audio back to TV internal speakers.
   */
  public async routeAudioToTVSpeakers(): Promise<TVActionResult> {
    return this.selectSoundOutput('tv_speaker');
  }

  /**
   * End-to-end intelligent entertainment command: "Neptune, play Zootopia on TV".
   * 1. Searches WD Sentinel Jellyfin server for media title.
   * 2. Launches Jellyfin on the LG webOS TV.
   * 3. Sends confirmation speech.
   */
  public async playMediaOnTV(title: string): Promise<TVActionResult> {
    // Step 1: Query Jellyfin for the media title
    const searchRes = await this.jellyfinClient.searchMedia(title);
    if (!searchRes.found || !searchRes.item) {
      return {
        success: false,
        action: 'play_media',
        speech: `I could not find "${title}" in your Jellyfin media library.`,
        details: searchRes.message,
      };
    }

    // Step 2: Ensure TV is on and launch Jellyfin on the TV
    await this.launchAppOrSource('Jellyfin');

    // Step 3: Trigger remote playback on the TV session
    const playRes = await this.jellyfinClient.playItemOnTV(searchRes.item.Id);

    return {
      success: true,
      action: 'play_media',
      speech: `Playing ${searchRes.item.Name} on TV via Jellyfin.`,
      details: `Found Jellyfin ID: ${searchRes.item.Id} (${searchRes.item.Type}) - ${playRes.message}`,
    };
  }
}
