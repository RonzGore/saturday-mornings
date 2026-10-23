#!/bin/bash
# Build the Saturday Mornings Android TV / Google TV app, and install it.
#   apps/android-tv/build.sh [TV-IP]        debug build; installs if given an IP
#   apps/android-tv/build.sh --release      signed release bundle for Google Play (and an APK)
#
# Settings live in apps/android-tv/local.properties (git-ignored):
#   sdk.dir=/Users/you/Library/Android/sdk
#   tv.server=https://tv.example.com/tv
#   tv.ip=192.168.1.60                      your TV's address, for installs
# On the TV: Settings > Device Preferences > About > press Build 7 times, then
# Developer options > Network debugging (or USB debugging) on.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
[ -d /opt/homebrew/opt/openjdk@17 ] && export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}
prop() { [ -f local.properties ] && sed -n "s/^$1=//p" local.properties | head -1; }
if [ "$1" = "--release" ]; then
  # The upload key's password comes from the macOS Keychain (item below), so
  # it never sits in a file. Store it once with:
  #   security add-generic-password -a "$USER" -s saturday-mornings-upload -w
  [ -n "$(prop signing.storeFile)" ] || { echo "Set signing.storeFile in local.properties"; exit 1; }
  if [ -z "$SM_SIGNING_PASSWORD" ]; then
    SM_SIGNING_PASSWORD=$(security find-generic-password -a "$USER" -s "${KEYCHAIN_ITEM:-saturday-mornings-upload}" -w 2>/dev/null) ||
      { echo "No signing password in the Keychain (item saturday-mornings-upload)"; exit 1; }
  fi
  export SM_SIGNING_PASSWORD
  ./gradlew -q bundleRelease assembleRelease
  echo "built $HERE/app/build/outputs/bundle/release/app-release.aab   (upload this to Google Play)"
  echo "built $HERE/app/build/outputs/apk/release/app-release.apk     (signed, for sideloading)"
  exit 0
fi
./gradlew -q assembleDebug
APK="$HERE/app/build/outputs/apk/debug/app-debug.apk"
echo "built $APK"
TV=${1:-$(prop tv.ip)}
[ -z "$TV" ] && exit 0
case "$TV" in *:*) ;; *) TV="$TV:5555" ;; esac
adb connect "$TV" | tail -1
adb -s "$TV" install -r "$APK"
PKG=$(prop tv.appId); PKG=${PKG:-tv.saturdaymornings.station}
adb -s "$TV" shell monkey -p "$PKG" -c android.intent.category.LEANBACK_LAUNCHER 1 >/dev/null 2>&1 && echo "opened on $TV"
