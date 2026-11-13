export interface IntentResult {
  matched: boolean;
  intent?: string;
  domain?: string;
  service?: string;
  entity_id?: string;
  data?: Record<string, any>;
  confirmation_speech?: string;
  requires_confirmation?: boolean;
}

export class FastPathRouter {
  /**
   * Evaluates text for deterministic fast-path intent matching.
   * Execution target: < 5 ms. Zero LLM inference overhead.
   */
  public match(text: string): IntentResult {
    const raw = text.trim();
    const clean = raw.toLowerCase().replace(/[.,!?;:]/g, '').trim();

    const TV_ENTITY = 'media_player.living_room_lg_webos_tv_qned806qa';
    const SPEAKER_ENTITY = 'media_player.living_room_vlc_telnet';

    // 0. WHOLE-HOUSE SPEAKER BROADCAST (VLC-TELNET)
    // Matches: "broadcast dinner is ready", "announce guests are here", "tell the whole house time to eat", "say to the whole house hello"
    const broadcastMatch = clean.match(/^(?:please\s+)?(?:broadcast|announce|tell\s+(?:the\s+)?whole\s+house|say\s+(?:to\s+)?(?:the\s+)?whole\s+house)\s+(?:saying\s+|that\s+)?(.+)$/);
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
    // Matches: "call sultan and tell him dinner is ready", "call desk and tell them meeting in 5 minutes",
    // "phone family saying package arrived", "ring desk and tell them dinner is ready", "call 1002 and say hello"
    const callMsgMatch = clean.match(/^(?:please\s+)?(?:call|phone|ring)\s+([a-z0-9_\s]+?)\s+(?:and\s+)?(?:tell\s+(?:them|him|her)\s+|saying\s+|say\s+)(.+)$/);
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

    // 2. TV STATE & "WHAT'S PLAYING ON TV" QUERY
    // Matches: "what is playing on tv", "what's playing on tv", "what is on tv", "what's on tv",
    // "is the tv on", "is tv on", "tv status", "what is the tv playing", "tell me what is playing on tv"
    const tvStateMatch = clean.match(/^(?:please\s+)?(?:tell\s+me\s+)?(?:what(?:'s|\s+is)\s+(?:playing\s+on|on)\s+(?:the\s+)?tv|is\s+(?:the\s+)?tv\s+on|(?:check\s+)?tv\s+status|what(?:'s|\s+is)\s+(?:the\s+)?tv\s+playing|whats\s+on\s+(?:the\s+)?tv)$/);
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

    // 3. ROUTE TV AUDIO OUTPUT (Home Speakers vs TV Speakers)
    // A. Route to Home Speakers / Amplifier / Whole House:
    // "route tv audio through home speakers", "route tv audio to home speakers", "route tv sound to home speakers",
    // "switch tv sound to whole house", "switch tv audio to amplifier", "play tv audio through home speakers"
    const routeToSpeakersMatch = clean.match(/^(?:please\s+)?(?:route|switch|play|send)\s+(?:the\s+)?tv\s+(?:audio|sound)\s+(?:through|to)\s+(?:the\s+)?(home\s+speakers|whole\s+house|amplifier|external\s+speakers|speakers)$/);
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

    // B. Route back to internal TV speakers:
    // "switch tv audio back to tv speakers", "route tv audio to tv speakers", "switch tv sound back to tv", "use tv speakers"
    const routeToTVMatch = clean.match(/^(?:please\s+)?(?:(?:route|switch|set)\s+(?:the\s+)?tv\s+(?:audio|sound)?\s*(?:back\s+)?to\s+(?:the\s+)?(?:internal\s+)?tv\s+speakers?|use\s+tv\s+speakers|switch\s+tv\s+(?:sound|audio)\s+back\s+to\s+tv)$/);
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

    // 4. LIGHTS & SWITCHES ON / OFF
    // Example: "turn off the kitchen light", "switch on living room", "turn off the light"
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

    // 5. TV / MEDIA VOLUME CONTROLS
    // A. Step Volume: "lower the volume", "turn down the tv", "volume down", "raise the volume", "turn up the tv", "volume up"
    const volStepMatch = clean.match(/^(?:please\s+)?(?:(turn|volume)\s+(up|down)|(raise|increase|lower|decrease)\s+(?:the\s+)?(?:tv\s+)?volume|turn\s+(up|down)\s+(?:the\s+)?tv)$/);
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

    // B. Set Volume Level: "set volume to 40 percent", "volume 50", "set tv volume to 30"
    const volumeMatch = clean.match(/^(?:please\s+)?(?:set\s+)?(?:the\s+)?(?:tv\s+)?volume\s+(?:to\s+)?(\d{1,3})(?:\s*%)?$/);
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

    // 6. MEDIA / TV PLAYBACK CONTROLS
    // Example: "pause tv", "resume playback", "stop", "mute tv", "unmute"
    const mediaPlaybackMatch = clean.match(/^(?:please\s+)?(pause|resume|stop|mute|unmute)\s*(?:the\s+)?([a-z0-9_\s]*)$/);
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

    // 7. TV APP LAUNCHING & INPUT / SOURCE SWITCHING
    // A. Switch Source / Input: "switch source to HDMI 2", "change input to HDMI 3", "switch source to Live TV"
    const sourceMatch = clean.match(/^(?:please\s+)?(?:switch|change|set)\s+(?:the\s+)?(?:source|input)\s+to\s+(?:the\s+)?([a-z0-9_\s+]+)$/);
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

    // B. Direct App Launching: "launch youtube", "open jellyfin on tv", "open netflix", "launch apple tv"
    const appKeywords = ['youtube', 'jellyfin', 'netflix', 'apple tv', 'disney', 'disney plus', 'disney+', 'prime video', 'prime', 'amazon prime', 'twitch', 'live tv', 'web browser', 'browser', 'ps4', 'hdmi 2', 'hdmi 3', 'hdmi 4'];
    const appRegex = new RegExp(`^(?:please\\s+)?(?:launch|open|switch\\s+to|start)\\s+(?:the\\s+)?(${appKeywords.map(k => k.replace('+', '\\+')).join('|')})(?:\\s+on\\s+(?:the\\s+)?tv)?$`);
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

    // C. TV On-Screen Toast Notifications
    const tvToastMatch = clean.match(/^(?:please\s+)?(?:show|display|send)\s+(?:a\s+)?(?:toast|notification|alert|message)\s+(?:on\s+tv\s+)?(?:saying\s+)?(.+)$/);
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

    // 8. MOVIE & SHOW STREAMING (JELLYFIN -> TV)
    // Example: "play zootopia on tv", "play the movie interstellar", "watch stranger things on tv", "play breaking bad"
    const mediaMatch = clean.match(/^(?:please\s+)?(?:play|watch)\s+(?:the\s+)?(?:movie|show|series\s+)?(.+?)(?:\s+on\s+(?:the\s+)?tv)?$/);
    if (mediaMatch) {
      const title = mediaMatch[1].trim();
      // Check if it's an app that fell through
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

    // 9. CLIMATE TARGET TEMPERATURE
    // Example: "set thermostat to 22 degrees", "set temperature to 21"
    const climateMatch = clean.match(/^(?:please\s+)?set\s+(?:the\s+)?(?:thermostat|ac|temperature|climate)\s+(?:to\s+)?(\d{1,2})(?:\s*degrees)?$/);
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

    // 10. REMINDERS & TIMERS (Home Assistant native timer/todo compatible)
    // Matches: "remind me to check the oven in 1 minute", "set timer for 10 minutes", "timer 5 min"
    const reminderPattern = /^(?:please\s+)?(?:remind\s+(?:me\s+)?to|set\s+(?:a\s+)?timer\s+for)\s+(.+?)\s+in\s+(\d+(?:\.\d+)?)\s*(second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|hr|hrs)?$/;
    const timerInvertedPattern = /^(?:please\s+)?set\s+(?:a\s+)?timer\s+for\s+(\d+(?:\.\d+)?)\s*(second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|hr|hrs)?\s*(?:for|to)?\s*(.*)$/;

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

      // Normalize to minutes
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

    // No fast-path match: route to Qwen 2.5 LLM reasoning
    return { matched: false };
  }
}
