// Saturday Mornings: TV app settings. Profiles, channels and videos are set up on
// the phone (http://<mac-ip>:8790/setup/); this file only says where that
// server lives, for when the app runs installed on the Samsung.
var SATURDAY_TV = {
  // Where the TV app is served from: Cloudflare (or http://<mac-ip>:8790 for the Mac server).
  // The only place the installed TV app learns the Worker's address: the
  // launcher derives its health check and message origin from it. Changing it
  // (e.g. to a custom domain, see docs/SELF-HOSTING.md) means rebuilding and
  // reinstalling with apps/tv-samsung/build-tv.sh (or set TV_SERVER in
  // apps/tv-samsung/.build-tv.local).
  server: "https://your-station.example.com/tv",

  // Show startup progress on the launch screen (and ping it to the server).
  debug: false,

  // How often the TV checks the phone's changes, in seconds.
  syncSeconds: 30,

  // TEST MODE: every profile's first channel is on air for this many
  // minutes after the app opens, ignoring its real times. 0 = real times.
  testMinutes: 0
};

// Previewing on the Mac: ?test=0.5 puts each first channel on air for 30
// seconds; ?offair keeps everything off air.
(function () {
  var m = /[?&]test=([\d.]+)/.exec(location.search);
  if (m) SATURDAY_TV.testMinutes = parseFloat(m[1]);
  if (/[?&]offair/.test(location.search)) SATURDAY_TV.forceOffAir = true;
})();
