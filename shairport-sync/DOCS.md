# Shairport Sync (AirPlay 2)

Turns your Home Assistant host audio output into a native **AirPlay 2** receiver so any iPhone, iPad, or Mac on your home Wi-Fi can stream music directly to your whole-house speakers.

## Setup

1. Open the add-on's **Configuration** tab:
   - Set **airplay_name** (default: `Home Speakers`) — this is the name shown in iOS Control Center and AirPlay menus.
   - Under **Audio → Output**, select the same audio output device used by **VLC-Telnet** (Home Assistant Audio shares the output so music and TTS announcements do not conflict).
2. In the **Info** tab, enable **Start on boot** and **Watchdog**, then click **Start**.
3. On any iPhone/iPad connected to your home Wi-Fi, open **Control Center → AirPlay** (the triangle + circles icon) and select **Home Speakers**.
