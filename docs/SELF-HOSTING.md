# Self-hosting Saturday Mornings

Run your own TV station for your kids, free. This is the whole road, with every account, key, setting and TV trick the free edition needs. Plan a
weekend the first time, and about an evening each time you update.

Don't want to tinker? The home-delivery edition at
[saturdaymornings.tv](https://saturdaymornings.tv) does all of this for you:
sign in on your phone, type the code your TV shows, done.

---

## What you'll end up with

- **A Cloudflare Worker** (`cloud/`) that serves the parent web app (`/`, `/app/`),
  the TV app (`/tv/`) and the API, with a **D1 database** for your family's data.
- **A TV app** that opens your Worker's `/tv` page, either the Samsung app (`apps/tv-samsung`) or the Android TV app (`apps/android-tv`).

Where things live in the repository:

| Folder | What it is |
|---|---|
| `apps/parent` | the parent app (PWA) your phone opens at `/app/` |
| `apps/tv` | the TV screens (channel picker, guide, player, sign-off), served at `/tv/` |
| `apps/tv-samsung` | the Samsung (Tizen) launcher that opens `/tv/` full screen, and its build script |
| `shared` | the schedule logic and logo used by all of the above |
| `cloud` | the Cloudflare Worker, API and database migrations |
| `home-server` | the no-cloud mode for one computer at home |
- Email sign-in codes (Resend), passkeys, YouTube lookups (YouTube Data API) and a
  daily job that keeps YouTube titles fresh.

Platforms: **Samsung Smart TVs (Tizen)** today; **Android TV / Google TV**
(NVIDIA Shield, Sony, TCL, Hisense, Chromecast with Google TV) too;
Fire TV, LG webOS and Hisense VIDAA planned. Not Roku: Roku apps can't host
YouTube's player, so the station couldn't sign off (a Google TV or Fire TV stick
works on any TV with HDMI). Parts 1–3 and 5–6 are the same for every TV;
Part 4 is one lane per kind of TV.

## Before you start

| You need | Why |
|---|---|
| A computer with Node.js 20+ and npm | builds and deploys everything |
| A **Cloudflare** account (free plan is enough) | hosting + database |
| A **Resend** account | sends sign-in codes by email |
| A **Google Cloud** project | the YouTube Data API key |
| Samsung lane: a **Samsung account** + **Tizen Studio** with TV Extensions | the certificate a retail Samsung TV insists on; builds and installs the app |
| Android TV lane: **Android Studio** (or the SDK platform tools for `adb`) | builds, signs and installs the app |
| Optional: a **domain** you control | real email sending, nicer addresses, passkeys you keep |
| Your TV and computer on the **same Wi-Fi** | for installing the TV app |

---

## Part 1 · The server (Cloudflare)

1. **Clone and install.**
   ```bash
   git clone https://github.com/RonzGore/saturday-mornings.git saturday-mornings && cd saturday-mornings/cloud && npm install
   ```
2. **Log in to Cloudflare.** `npx wrangler login` (opens a browser).
3. **Create the database.** `npx wrangler d1 create saturday-morning`, and copy the
   `database_id` it prints.
4. **Make the settings yours.** Copy `cloud/wrangler.jsonc` to
   `cloud/wrangler.local.jsonc` and edit the copy. Git ignores it, so your
   database id and emails never end up in a commit, and every `npm run`
   script uses it when it exists. (Editing `wrangler.jsonc` itself works too.)
   - `d1_databases[0].database_id`: your id from step 3.
   - `vars.RP_ID`: your domain (or leave it empty to use the workers.dev address; see passkeys below).
   - `vars.EMAIL_FROM`: leave the Resend test sender for now (Part 2).
   - `vars.APP_NAME`: whatever you'd like the app called.
5. **Set your contact email** in the same file (`vars.CONTACT_EMAIL`). It
   appears on the Privacy and Terms pages.
6. **Add the secrets** (each asks you to paste a value). `npm run wrangler --`
   is wrangler with your settings file:
   ```bash
   npm run wrangler -- secret put CODE_PEPPER      # any long random string
   npm run wrangler -- secret put RESEND_API_KEY   # Part 2
   npm run wrangler -- secret put YOUTUBE_API_KEY  # Part 2
   ```
   Without `RESEND_API_KEY` nobody can sign in; without `YOUTUBE_API_KEY`, channel
   links and search fail (single videos and playlists still work).
7. **Deploy.** `npm run deploy` builds the site, applies the database migrations
   and publishes the Worker. Note the `https://<name>.<you>.workers.dev` address.
8. **Check it.** Open `https://<your-worker>/api/health`; it should answer.

> Trying it locally first? `npm run dev` serves http://localhost:8787. Put
> `DEV_ECHO_CODES=1` (and optionally `YOUTUBE_API_KEY=...`) in `cloud/.dev.vars`
> and sign-in codes show on screen instead of being emailed.

## Part 2 · The keys

9. **YouTube Data API key.** In Google Cloud Console: create a project › enable
   **YouTube Data API v3** › Credentials › Create API key. Restrict it to that
   API. The default quota is 10,000 units a day; a search costs 100, a lookup 1.
   The app caps search at 30 a day per parent and 80 a day in total, caches for
   6 hours, and says "Search is resting until tomorrow" when you run out.
10. **Resend API key.** Create one in Resend. With the test sender
    (`onboarding@resend.dev`) Resend only delivers to **your own** Resend email.
    That's fine for a household of one; for anyone else you need Part 3's
    sending domain.

## Part 3 · Your domain (optional, but you'll want it)

11. **Point a domain at Cloudflare** (or use a subdomain of one you have).
12. **Attach the Worker:** add a route in your settings file, e.g.
    `{ "pattern": "tv.example.com", "custom_domain": true }`, then `npm run deploy`.
    Wait for the certificate (minutes, occasionally longer).
13. **Passkeys:** set `RP_ID` to your domain. Passkeys only work on the host they
    were made on, so making them on workers.dev and moving later means
    re-registering. Email codes always work.
14. **A sending domain for email:** in Resend add e.g. `send.example.com`, add the
    MX, SPF (TXT) and DKIM (`resend._domainkey.send`) records it shows to your
    DNS (plus an optional `_dmarc`), wait for "Verified", then set
    `EMAIL_FROM` to `Your Station <hello@send.example.com>` and redeploy.
    Debug with `npm run wrangler -- tail`; failures show as `resend failed <status>`.

The thumbnail proxy (`/api/thumb`) only caches at Cloudflare's edge on a custom
domain, not on workers.dev.

## Part 4a · Samsung TV (Tizen)

15. **Install Tizen Studio** with the **TV Extensions** (Package Manager ›
    Extension SDK). `apps/tv-samsung/build-tv.sh` expects it in `~/tizen-studio`.
16. **Turn on developer mode on the TV:** open **Apps**, press **1 2 3 4 5** on
    the remote, switch Developer mode **On**, type your computer's IP address,
    then restart the TV (hold the power button until it reboots).
17. **Find the TV's IP** (Settings › General › Network › Network status) and
    connect: `~/tizen-studio/tools/sdb connect <TV-IP>`.
18. **Make a Samsung certificate:** Tizen Studio › Certificate Manager › new
    **Samsung** certificate (type TV), sign in with your Samsung account, and add
    the TV's DUID (Certificate Manager can read it from the connected TV).
    Retail TVs refuse apps signed any other way. Name the profile anything,
    then put it in `apps/tv-samsung/.build-tv.local` as
    `TIZEN_PROFILE=YourProfile` (with `TV_IP=<TV-IP>`; the file is git-ignored). Keep the `.p12` files safe
    and out of git, because future updates must be signed with the same author key.
19. **Point the TV app at your server:** add
    `TV_SERVER=https://<your-worker-or-domain>/tv` to `.build-tv.local` (or set
    `server` in `apps/tv/js/config.js`).
20. **Make the app yours:** a unique app id, e.g.
    `TIZEN_APP_ID=MyFamilyTV.SaturdayMornings` in `.build-tv.local` (the part
    before the dot is a 10-character package id), or edit
    `apps/tv-samsung/config.xml`.
21. **Build and install:** `apps/tv-samsung/build-tv.sh <TV-IP>` (builds, signs,
    packages, installs; `--package-only` just builds the `.wgt`). The app
    appears in **Apps**.

Samsung gotchas we learned the hard way:
- Never add `<tizen:allow-navigation>` to `apps/tv-samsung/config.xml`: the TV shows a black screen.
- No spaces in the `.wgt` file name.
- Changing the app icon? Uninstall first; a reinstall keeps the old icon.
- The installed app is a small launcher (`launch.html`) that opens your server's
  page in a full-screen frame, because YouTube's player refuses to play on a page
  without a web address (error 153).

## Part 4b · Android TV & Google TV

The illustrated version: [Android TV, step by step](guides/android-tv-step-by-step.pdf).

The app (`apps/android-tv`) is a small launcher, like the Samsung one, that shows a full-screen web view of your station's `/tv/` page. Tested on an NVIDIA Shield
(Android 11).

1. **Turn on developer options:** Settings › Device Preferences › About (on
   Google TV: Settings › System › About), then select **Build** seven times
   until it says you are now a developer.
2. **Allow debugging:** Settings › Device Preferences › Developer options ›
   turn on **USB debugging** and **Network debugging** (Shield) or **Wireless
   debugging** (newer Google TV, which pairs with a code). Note the TV's IP.
3. **Install the tools** on your computer: Java 17, Android's command-line
   tools and `adb`. On a Mac with Homebrew:
   ```bash
   brew install openjdk@17
   brew install --cask android-commandlinetools android-platform-tools
   sdkmanager --sdk_root=$HOME/Library/Android/sdk "platforms;android-35" "build-tools;35.0.0"
   ```
   (Or install Android Studio, which brings all of it.)
4. **Your settings:** create `apps/android-tv/local.properties` (git-ignored):
   ```
   sdk.dir=/Users/you/Library/Android/sdk
   tv.server=https://<your-worker-or-domain>/tv
   tv.ip=<TV-IP>
   tv.appId=com.yourname.saturdaymornings
   ```
5. **Build and install:** `apps/android-tv/build.sh` builds the app, connects
   to the TV, installs and opens it. The first time, accept **Allow network
   debugging?** on the TV (tick "Always allow from this computer").
6. **Link it** like any TV (Part 5). It appears in the TV's apps row with the
   Saturday Mornings banner.

For Google Play, make your own **upload key** once, outside the repository,
and keep its password in the macOS Keychain (it never goes in a file):
```bash
mkdir -p ~/Keys/saturday-mornings
keytool -genkeypair -v -keystore ~/Keys/saturday-mornings/upload.jks -storetype PKCS12 \
  -keyalg RSA -keysize 4096 -validity 10000 -alias upload -dname "CN=Your Name, O=Your Station, C=CA"
security add-generic-password -a "$USER" -s saturday-mornings-upload -w
```
Add `signing.storeFile=/Users/you/Keys/saturday-mornings/upload.jks` and
`signing.keyAlias=upload` to `local.properties`, then
`apps/android-tv/build.sh --release` builds the bundle to upload
(`app-release.aab`) and a signed APK. Raise `versionCode` in
`app/build.gradle.kts` for every upload. Back the key up. With Play App Signing, Google can reset a lost upload key, but it takes a while.

Android gotchas:
- YouTube decides which player to show from how the browser describes
  itself, including its "client hints". An Android web view says "Android,
  mobile", which gets YouTube's phone player with its own touch controls and
  a "More videos" button. The app describes itself as desktop Chrome (same
  engine version) so YouTube serves its plain player, as on Samsung.
- Debug builds can be opened in test mode and inspected from a computer:
  `adb shell am start -n <app id>/tv.saturdaymornings.station.StationActivity --es query test=5`
  puts each kid's first channel on air for 5 minutes; with `adb forward` the
  page shows up in Chrome at `chrome://inspect`.
- When Android updates its web engine (Android System WebView), it closes
  every app that uses it, this one included. Just reopen it; a TV that was
  being linked picks the link up again.
- Updates to the TV screens need no reinstall, because they come from your station.
  Reinstall only when something in `apps/android-tv` changes.

## Part 5 · Your station

22. **Sign in** at your server address with your email (a 6-digit code), and add
    a passkey if you like.
23. **Add kids, shows and times:** each kid becomes a channel; add YouTube
    channels, playlists or videos to the library, then put them in time slots.
24. **Link the TV:** open the app on the TV; it shows a code (and a QR). On your
    phone, *Your TVs › Link a TV* and type it. The TV checks for changes every
    30 seconds.
25. **Invite the other parent** (optional). They join only when they tap Join.

## Part 6 · Keeping it running

- **Updates:** `git pull`, `cd cloud && npm run deploy`. If anything in the TV
  launcher changed (`apps/tv-samsung`, `apps/tv/js/config.js`), rebuild and
  reinstall the TV app too, with the TV on and still in developer mode.
- **Moving to a new address:** rebuild the TV app and link the TV again. Keep the
  old address serving (`workers_dev: true`) until every TV has moved; *Your TVs*
  shows when each last checked in. Don't redirect it, because old launchers only
  accept messages from the address they were built with.
- **The daily job** (cron `17 9 * * *`) refreshes YouTube titles after 20 days
  and deletes cached YouTube data at 30 days, as YouTube's policies require.
  Test locally: `npm run wrangler -- dev --test-scheduled`, then open `/__scheduled`.
- **Developer mode** must stay on for reinstalls. If it's ever off (say, after a
  TV reset), turn it back on with the 1-2-3-4-5 trick on Samsung, seven taps on
  "Build" on Android TV.
- **Costs:** Cloudflare's free plan covers a household comfortably. Resend's and
  YouTube's free tiers do too.

## Without the cloud (one computer at home)

For a quick look without Cloudflare: `node home-server/server.js` on your
computer, open `http://<computer-ip>:8790/setup/` on your phone, and set
`TV_SERVER=http://<computer-ip>:8790` in `apps/tv-samsung/.build-tv.local`
before building the TV app. The computer must stay on; data lives in
`home-server/data/household.json`.

## Help

Stuck? Open an issue with what you ran and what it said. And if this list made
you tired just reading it, that's what the
[home-delivery edition](https://saturdaymornings.tv/#subscribe) is for.
