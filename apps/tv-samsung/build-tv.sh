#!/bin/bash
# Build, sign and install the Saturday Mornings TV app on a Samsung TV.
#   apps/tv-samsung/build-tv.sh [TV-IP | --package-only]
#
# The installed app is a small launcher (launch.html) that opens your
# station's /tv/ page full screen, so only the launcher is packaged; the TV
# screens themselves (apps/tv) are served by your station.
#
# Your own settings can live in apps/tv-samsung/.build-tv.local (git-ignored):
#   TV_IP=192.168.1.50                    your TV's address
#   TIZEN_PROFILE=MyProfile               your Tizen certificate profile
#   TV_SERVER=https://tv.example.com/tv   your station (else apps/tv/js/config.js)
#   TIZEN_APP_ID=Abc123Def4.SaturdayMornings   optional: keep the id of an app
#                                         you already installed (package = before the dot)
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
export PATH=$HOME/tizen-studio/tools/ide/bin:$HOME/tizen-studio/tools:$PATH
[ -f "$HERE/.build-tv.local" ] && . "$HERE/.build-tv.local"
TV=${1:-$TV_IP}
[ "$TV" = "--package-only" ] && TV=
[ -n "$TV" ] || [ "$1" = "--package-only" ] ||
  { echo "Pass your TV's IP address: $0 192.168.1.50 (or set TV_IP in .build-tv.local), or --package-only"; exit 1; }
PROFILE=${TIZEN_PROFILE:-SaturdayMornings}

# Stage just what the launcher needs.
STAGE="$HERE/.stage"
rm -rf "$STAGE" "$HERE/.buildResult"
mkdir -p "$STAGE/js" "$STAGE/assets"
cp "$HERE/launch.html" "$HERE/config.xml" "$HERE/icon.png" "$STAGE/"
cp "$REPO/apps/tv/js/config.js" "$STAGE/js/config.js"
cp "$REPO/shared/assets/logo.svg" "$STAGE/assets/logo.svg"
if [ -n "$TV_SERVER" ]; then
  sed -i '' "s#server: \"[^\"]*\"#server: \"$TV_SERVER\"#" "$STAGE/js/config.js"
fi
if [ -n "$TIZEN_APP_ID" ]; then
  sed -i '' "s#<tizen:application id=\"[^\"]*\" package=\"[^\"]*\"#<tizen:application id=\"$TIZEN_APP_ID\" package=\"${TIZEN_APP_ID%%.*}\"#" "$STAGE/config.xml"
fi
if grep -q 'your-station.example.com' "$STAGE/js/config.js"; then
  echo "Set your station's address: TV_SERVER in .build-tv.local, or server in apps/tv/js/config.js"; exit 1
fi

tizen build-web -- "$STAGE"
tizen package -t wgt -s "$PROFILE" -- "$STAGE/.buildResult"
mkdir -p "$HERE/.buildResult"
mv "$STAGE/.buildResult/Saturday Mornings.wgt" "$HERE/.buildResult/SaturdayMornings.wgt"   # the TV rejects names with spaces
rm -rf "$STAGE"
echo "built $HERE/.buildResult/SaturdayMornings.wgt"

[ -z "$TV" ] && exit 0
sdb devices | grep -q "$TV" || sdb connect "$TV"
tizen install -n SaturdayMornings.wgt -s "$TV:26101" -- "$HERE/.buildResult"
