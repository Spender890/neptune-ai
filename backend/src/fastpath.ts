export interface IntentResult {
  matched: boolean;
  intent?: string;
  domain?: string;
  service?: string;
  entity_id?: string;
  data?: Record<string, unknown>;
  confirmation_speech?: string;
  requires_confirmation?: boolean;
}

const MAX_COMMAND_LENGTH = 500;

/**
 * Deterministic regex-based intent router evaluated before the LLM fallback.
 * Guarantees sub-10ms predictable routing for standard smart-home, TV, reminder,
 * and intercom commands without consuming LLM CPU cycles.
 */
export class FastPathRouter {
  private tvEntityId: string;
  private speakerEntityId: string;

  constructor(tvEntityId?: string, speakerEntityId?: string) {
    this.tvEntityId =
      tvEntityId || process.env.TV_ENTITY_ID || 'media_player.living_room_lg_webos_tv_qned806qa';
    this.speakerEntityId =
      speakerEntityId || process.env.SPEAKER_ENTITY_ID || 'media_player.living_room_vlc_telnet';
  }

  /**
   * Evaluates text for deterministic fast-path intent matching.
   * Execution target: < 5 ms. Zero LLM inference overhead.
   */
  public match(text: string): IntentResult {
    if (typeof text !== 'string') {
      return { matched: false };
    }

    const raw = text.trim();
    if (!raw || raw.length > MAX_COMMAND_LENGTH) {
      return { matched: false };
    }

    const clean = raw.toLowerCase().replace(/[.,!?;:]/g, '').trim();
    if (!clean) {
      return { matched: false };
    }

    const TV_ENTITY = this.tvEntityId;
    const SPEAKER_ENTITY = this.speakerEntityId;

    // 0. WHOLE-HOUSE SPEAKER BROADCAST (VLC-TELNET)
    const broadcastMatch = clean.match(
      /^(?:please\s+)?(?:broadcast|announce|tell\s+(?:the\s+)?whole\s+house|say\s+(?:to\s+)?(?:the\s+)?whole\s+house)\s+(?:saying\s+|that\s+)?(.+)$/
    );
    if (broadcastMatch) {
      const msg = broadcastMatch[1].trim();
      return {
        matched: true,
        intent: 'whole_house_broadcast',
        domain: 'tts',
        service: 'speak',
        entity_id: 'tts.google_translate_en_com',
        data: {
          media_player_entity_id: SPEAKER_ENTITY,
          message: msg,
        },
        confirmation_speech: `Broadcasting to the whole house: "${msg}".`,
        requires_confirmation: false,
      };
    }

    // 1. TELEPHONY: PROACTIVE OUTBOUND CALL & DELIVER MESSAGE
    const callMsgMatch = clean.match(
      /^(?:please\s+)?(?:call|phone|ring)\s+([a-z0-9_\s]+?)\s+(?:and\s+)?(?:tell\s+(?:them|him|her)\s+|saying\s+|say\s+)(.+)$/
    );
    if (callMsgMatch) {
      const target = callMsgMatch[1].trim();
      const message = callMsgMatch[2].trim();
      return {
        matched: true,
        intent: 'telephony_call_message',
        domain: 'asterisk',
        service: 'originate',
        entity_id: 'asterisk.pbx',
        data: {
          recipient: target,
          message: message,
        },
        confirmation_speech: `Calling ${target} to deliver your message: "${message}".`,
        requires_confirmation: false,
      };
    }

    // 2. INTERCOM DOOR RELAY UNLOCK ("open the door", "unlock front door", "open gate", "open both doors")
    const doorUnlockMatch = clean.match(
      /^(?:please\s+)?(?:open|unlock)\s+(?:the\s+)?(both\s+doors|all\s+doors|front\s+door|gate|side\s+door|back\s+door|door\s*1|door\s*2|door)$/
    );
    if (doorUnlockMatch) {
      const rawTarget = doorUnlockMatch[1].trim();
      let target = 'door1';
      let speech = 'Opening the front door.';
      if (rawTarget.includes('both') || rawTarget.includes('all')) {
        target = 'all';
        speech = 'Opening both doors.';
      } else if (rawTarget.includes('gate') || rawTarget.includes('side') || rawTarget.includes('back') || rawTarget.includes('2')) {
        target = 'door2';
        speech = 'Opening the gate.';
      }
      return {
        matched: true,
        intent: 'intercom_unlock_door',
        domain: 'intercom',
        service: 'unlock_door',
        entity_id: `intercom.${target}`,
        data: { target },
        confirmation_speech: speech,
        requires_confirmation: false,
      };
    }

    // 2B. CONSEQUENTIAL LOCKS & GARAGE / DOOR COVERS (Always deterministic so LLM cannot alter args)
    const lockMatch = clean.match(/^(?:please\s+)?(lock|unlock)\s+(?:the\s+)?([a-z0-9_\s]+)$/);
    if (lockMatch) {
      const action = lockMatch[1];
      let target = lockMatch[2].trim().replace(/\s+(?:lock|locks)$/i, '').trim().replace(/\s+/g, '_');
      if (!target) {
        target = 'front_door';
      }
      const entityId = `lock.${target}`;
      return {
        matched: true,
        intent: 'ha_lock',
        domain: 'lock',
        service: action,
        entity_id: entityId,
        confirmation_speech: `${action === 'lock' ? 'Locking' : 'Unlocking'} the ${target.replace(/_/g, ' ')}.`,
        requires_confirmation: true,
      };
    }

    const coverMatch = clean.match(
      /^(?:please\s+)?(open|close)\s+(?:the\s+)?([a-z0-9_\s]*?\b(?:garage\s+door|garage|front\s+door|door|gate|blinds|shutter|cover))$/
    );
    if (coverMatch) {
      const action = coverMatch[1];
      let target = coverMatch[2].trim().replace(/\s+/g, '_');
      if (target === 'garage') {
        target = 'garage_door';
      }
      const entityId = `cover.${target}`;
      return {
        matched: true,
        intent: 'ha_cover',
        domain: 'cover',
        service: action === 'open' ? 'open_cover' : 'close_cover',
        entity_id: entityId,
        confirmation_speech: `${action === 'open' ? 'Opening' : 'Closing'} the ${target.replace(/_/g, ' ')}.`,
        requires_confirmation: true,
      };
    }

    // 3. TV STATE & "WHAT'S PLAYING ON TV" QUERY
    const tvStateMatch = clean.match(
      /^(?:please\s+)?(?:tell\s+me\s+)?(?:what(?:'s|\s+is)\s+(?:playing\s+on|on)\s+(?:the\s+)?tv|is\s+(?:the\s+)?tv\s+on|(?:check\s+)?tv\s+status|what(?:'s|\s+is)\s+(?:the\s+)?tv\s+playing|whats\s+on\s+(?:the\s+)?tv)$/
    );
    if (tvStateMatch) {
      return {
        matched: true,
        intent: 'tv_state_query',
        domain: 'media_player',
        service: 'state_query',
        entity_id: TV_ENTITY,
        confirmation_speech: 'Checking TV status...',
        requires_confirmation: false,
      };
    }

    // 4. ROUTE TV AUDIO OUTPUT (Home Speakers vs TV Speakers)
    const routeToSpeakersMatch = clean.match(
      /^(?:please\s+)?(?:route|switch|play|send)\s+(?:the\s+)?tv\s+(?:audio|sound)\s+(?:through|to)\s+(?:the\s+)?(home\s+speakers|whole\s+house|amplifier|external\s+speakers|speakers)$/
    );
    if (routeToSpeakersMatch) {
      return {
        matched: true,
        intent: 'tv_sound_output',
        domain: 'webostv',
        service: 'select_sound_output',
        entity_id: TV_ENTITY,
        data: { sound_output: 'external_arc', output_name: 'home speakers' },
        confirmation_speech: 'Routing TV audio through the whole-house speakers amplifier.',
        requires_confirmation: false,
      };
    }

    const routeToTVMatch = clean.match(
      /^(?:please\s+)?(?:(?:route|switch|set)\s+(?:the\s+)?tv\s+(?:audio|sound)?\s*(?:back\s+)?to\s+(?:the\s+)?(?:internal\s+)?tv\s+speakers?|use\s+tv\s+speakers|switch\s+tv\s+(?:sound|audio)\s+back\s+to\s+tv)$/
    );
    if (routeToTVMatch) {
      return {
        matched: true,
        intent: 'tv_sound_output',
        domain: 'webostv',
        service: 'select_sound_output',
        entity_id: TV_ENTITY,
        data: { sound_output: 'tv_speaker', output_name: 'TV speakers' },
        confirmation_speech: 'Switched TV sound back to internal TV speakers.',
        requires_confirmation: false,
      };
    }

    // 4b. TV POWER ON / OFF (Matched before lights/switches so "turn on the tv" never hits light.tv)
    const tvPowerMatch = clean.match(
      /^(?:please\s+)?(?:turn|switch|power)\s+(on|off)\s+(?:the\s+)?(?:(?:living\s+room|main|smart)\s+)?(?:tv|television)$/
    );
    if (tvPowerMatch) {
      const state = tvPowerMatch[1];
      return {
        matched: true,
        intent: 'tv_power',
        domain: 'media_player',
        service: state === 'on' ? 'turn_on' : 'turn_off',
        entity_id: TV_ENTITY,
        confirmation_speech: `Turning ${state} the TV.`,
        requires_confirmation: false,
      };
    }

    // 5. LIGHTS & SWITCHES ON / OFF
    const toggleMatch = clean.match(/^(?:please\s+)?(?:turn|switch)\s+(on|off)\s+(?:the\s+)?([a-z0-9_\s]+)$/);
    if (toggleMatch) {
      const state = toggleMatch[1];
      let target = toggleMatch[2].replace(/\b(?:light|lights|switch|switches|lamp|lamps|fan|fans)\b/gi, '').trim();
      if (!target) {
        target = 'living_room';
      }
      const entityDomain = clean.includes('fan') || clean.includes('switch') ? 'switch' : 'light';
      const entityId = `${entityDomain}.${target.replace(/\s+/g, '_')}`;

      return {
        matched: true,
        intent: 'ha_toggle',
        domain: entityDomain,
        service: state === 'on' ? 'turn_on' : 'turn_off',
        entity_id: entityId,
        confirmation_speech: `Turned ${state} the ${target.replace(/_/g, ' ')} ${entityDomain}.`,
        requires_confirmation: false,
      };
    }

    // 6. TV / MEDIA VOLUME CONTROLS
    const volStepMatch = clean.match(
      /^(?:please\s+)?(?:(turn|volume)\s+(up|down)|(raise|increase|lower|decrease)\s+(?:the\s+)?(?:tv\s+)?volume|turn\s+(up|down)\s+(?:the\s+)?tv)$/
    );
    if (volStepMatch) {
      const isUp = clean.includes('up') || clean.includes('raise') || clean.includes('increase');
      const service = isUp ? 'volume_up' : 'volume_down';
      const actionWord = isUp ? 'Increased' : 'Decreased';
      return {
        matched: true,
        intent: 'media_volume_step',
        domain: 'media_player',
        service: service,
        entity_id: TV_ENTITY,
        confirmation_speech: `${actionWord} TV volume.`,
        requires_confirmation: false,
      };
    }

    const volumeMatch = clean.match(
      /^(?:please\s+)?(?:set\s+)?(?:the\s+)?(?:tv\s+)?volume\s+(?:to\s+)?(\d{1,3})(?:\s*%)?$/
    );
    if (volumeMatch) {
      const level = Math.max(0, Math.min(100, parseInt(volumeMatch[1], 10)));
      return {
        matched: true,
        intent: 'media_volume',
        domain: 'media_player',
        service: 'volume_set',
        entity_id: TV_ENTITY,
        data: { volume_level: level / 100 },
        confirmation_speech: `Volume set to ${level} percent.`,
        requires_confirmation: false,
      };
    }

    // 7. MEDIA / TV PLAYBACK CONTROLS
    const mediaPlaybackMatch = clean.match(
      /^(?:please\s+)?(pause|resume|stop|mute|unmute)\s*(?:the\s+)?([a-z0-9_\s]*)$/
    );
    if (mediaPlaybackMatch) {
      const action = mediaPlaybackMatch[1];
      const target = mediaPlaybackMatch[2].trim() || 'living_room_tv';
      const entityId = target.includes('speaker') ? SPEAKER_ENTITY : TV_ENTITY;

      let service = 'media_play_pause';
      if (action === 'pause') service = 'media_pause';
      if (action === 'resume') service = 'media_play';
      if (action === 'stop') service = 'media_stop';
      if (action === 'mute' || action === 'unmute') service = 'volume_mute';

      return {
        matched: true,
        intent: 'media_control',
        domain: 'media_player',
        service: service,
        entity_id: entityId,
        data: action.includes('mute') ? { is_volume_muted: action === 'mute' } : {},
        confirmation_speech: `${action.charAt(0).toUpperCase() + action.slice(1)}d ${target}.`,
        requires_confirmation: false,
      };
    }

    // 8. TV APP LAUNCHING & INPUT / SOURCE SWITCHING
    const sourceMatch = clean.match(
      /^(?:please\s+)?(?:switch|change|set)\s+(?:the\s+)?(?:source|input)\s+to\s+(?:the\s+)?([a-z0-9_\s+]+)$/
    );
    if (sourceMatch) {
      const rawSource = sourceMatch[1].trim();
      return {
        matched: true,
        intent: 'tv_app',
        domain: 'media_player',
        service: 'select_source',
        entity_id: TV_ENTITY,
        data: { source: rawSource },
        confirmation_speech: `Switching TV input to ${rawSource}.`,
        requires_confirmation: false,
      };
    }

    const appKeywords = [
      'youtube',
      'jellyfin',
      'netflix',
      'apple tv',
      'disney',
      'disney plus',
      'disney+',
      'prime video',
      'prime',
      'amazon prime',
      'twitch',
      'live tv',
      'web browser',
      'browser',
      'ps4',
      'hdmi 2',
      'hdmi 3',
      'hdmi 4',
    ];
    const appRegex = new RegExp(
      `^(?:please\\s+)?(?:launch|open|switch\\s+to|start)\\s+(?:the\\s+)?(${appKeywords
        .map((k) => k.replace('+', '\\+'))
        .join('|')})(?:\\s+on\\s+(?:the\\s+)?tv)?$`
    );
    const directAppMatch = clean.match(appRegex);
    if (directAppMatch) {
      const appName = directAppMatch[1].trim();
      return {
        matched: true,
        intent: 'tv_app',
        domain: 'media_player',
        service: 'select_source',
        entity_id: TV_ENTITY,
        data: { source: appName },
        confirmation_speech: `Opening ${appName} on TV.`,
        requires_confirmation: false,
      };
    }

    const tvToastMatch = clean.match(
      /^(?:please\s+)?(?:show|display|send)\s+(?:a\s+)?(?:toast|notification|alert|message)\s+(?:on\s+tv\s+)?(?:saying\s+)?(.+)$/
    );
    if (tvToastMatch) {
      const msg = tvToastMatch[1].replace(/on\s+(?:the\s+)?tv$/, '').trim();
      return {
        matched: true,
        intent: 'tv_toast',
        domain: 'webostv',
        service: 'command',
        entity_id: TV_ENTITY,
        data: { command: 'system.notifications/createToast', payload: { message: msg } },
        confirmation_speech: `Notification sent to TV: "${msg}".`,
        requires_confirmation: false,
      };
    }

    // 9. MOVIE & SHOW STREAMING (JELLYFIN -> TV)
    const mediaMatch = clean.match(
      /^(?:please\s+)?(?:play|watch)\s+(?:the\s+)?(?:movie|show|series\s+)?(.+?)(?:\s+on\s+(?:the\s+)?tv)?$/
    );
    if (mediaMatch) {
      const title = mediaMatch[1].trim();
      if (appKeywords.includes(title)) {
        return {
          matched: true,
          intent: 'tv_app',
          domain: 'media_player',
          service: 'select_source',
          entity_id: TV_ENTITY,
          data: { source: title },
          confirmation_speech: `Opening ${title} on TV.`,
          requires_confirmation: false,
        };
      }

      return {
        matched: true,
        intent: 'tv_media',
        domain: 'media_player',
        service: 'select_source',
        entity_id: TV_ENTITY,
        data: { media_title: title },
        confirmation_speech: `Searching and playing ${title} on TV via Jellyfin.`,
        requires_confirmation: false,
      };
    }

    // 10. CLIMATE TARGET TEMPERATURE
    const climateMatch = clean.match(
      /^(?:please\s+)?set\s+(?:the\s+)?(?:thermostat|ac|temperature|climate)\s+(?:to\s+)?(\d{1,2})(?:\s*degrees)?$/
    );
    if (climateMatch) {
      const temp = parseInt(climateMatch[1], 10);
      return {
        matched: true,
        intent: 'climate_temp',
        domain: 'climate',
        service: 'set_temperature',
        entity_id: 'climate.thermostat',
        data: { temperature: temp },
        confirmation_speech: `Thermostat set to ${temp} degrees.`,
        requires_confirmation: false,
      };
    }

    // 11. REMINDERS & TIMERS
    const reminderPattern =
      /^(?:please\s+)?(?:remind\s+(?:me\s+)?to|set\s+(?:a\s+)?timer\s+for)\s+(.+?)\s+in\s+(\d+(?:\.\d+)?)\s*(second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|hr|hrs)?$/;
    const timerInvertedPattern =
      /^(?:please\s+)?set\s+(?:a\s+)?timer\s+for\s+(\d+(?:\.\d+)?)\s*(second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|hr|hrs)?\s*(?:for|to)?\s*(.*)$/;

    const match1 = clean.match(reminderPattern);
    const match2 = !match1 ? clean.match(timerInvertedPattern) : null;

    if (match1 || match2) {
      let task = '';
      let value = 1;
      let unit = 'minute';

      if (match1) {
        task = match1[1].trim();
        value = parseFloat(match1[2]);
        unit = match1[3] || 'minute';
      } else if (match2) {
        value = parseFloat(match2[1]);
        unit = match2[2] || 'minute';
        task = (match2[3] || 'timer').trim();
      }

      if (!Number.isFinite(value) || value <= 0) {
        return { matched: false };
      }

      let minutes = value;
      if (unit.startsWith('sec')) minutes = value / 60;
      if (unit.startsWith('h')) minutes = value * 60;

      return {
        matched: true,
        intent: 'set_reminder',
        domain: 'timer',
        service: 'start',
        entity_id: 'timer.neptune_timer',
        data: {
          title: task,
          duration_minutes: minutes,
          duration_seconds: Math.round(minutes * 60),
          ha_duration: Math.round(minutes * 60),
        },
        confirmation_speech: `Timer set for ${value} ${unit} to ${task}.`,
        requires_confirmation: false,
      };
    }

    // No fast-path match: route to local LLM reasoning
    return { matched: false };
  }
}
