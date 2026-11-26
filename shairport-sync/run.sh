#!/bin/sh
set -e

AIRPLAY_NAME=$(jq -r '.airplay_name // "Home Speakers"' /data/options.json)
VERBOSE=$(jq -r '.verbose // false' /data/options.json)

set -- -a "$AIRPLAY_NAME" -o alsa
if [ "$VERBOSE" = "true" ]; then
  set -- "$@" -v
fi
set -- "$@" -- -d default

if [ -x /start.sh ]; then
  exec /start.sh "$@"
fi

rm -rf /var/run/dbus /run/dbus /var/run/avahi-daemon
mkdir -p /var/run/dbus /run/dbus /var/run/avahi-daemon
dbus-uuidgen --ensure 2>/dev/null || true
dbus-daemon --system
avahi-daemon --daemonize --no-chroot
nqptp &
exec shairport-sync "$@"
