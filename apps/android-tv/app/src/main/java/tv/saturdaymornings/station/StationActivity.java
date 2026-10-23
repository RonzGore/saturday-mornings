package tv.saturdaymornings.station;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Saturday Mornings on Android TV / Google TV: one full-screen web view of the
 * station's /tv/ page (apps/tv), the same page the Samsung launcher shows.
 * YouTube's player only plays on a page with a real web address, so the
 * screens are served by the station rather than packaged here.
 *
 * The remote's keys are handed to the page as the Samsung key codes it already
 * understands, and the page asks this app to exit or keep the screen awake
 * through the small SaturdayAndroid bridge.
 */
public class StationActivity extends Activity {

    private static final String SERVER = BuildConfig.TV_SERVER;
    private static final long RETRY_MS = 10_000;

    private WebView web;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean offline = false;
    private int failures = 0;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        // Debug builds: inspect the page from a computer (chrome://inspect).
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        web.setBackgroundColor(0xFF000000);
        web.setFocusable(true);
        setContentView(web);
        hideSystemBars();

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                 // the TV's link token lives in localStorage
        s.setMediaPlaybackRequiresUserGesture(false); // shows start by themselves
        s.setUseWideViewPort(true);                   // the page is 1920x1080 (its viewport meta)
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setUserAgentString(desktopAgent(s.getUserAgentString()));
        // The browser name alone isn't enough: Chrome also sends "client hints"
        // (platform: Android, mobile: true), and YouTube trusts those. Say the same thing there.
        if (androidx.webkit.WebViewFeature.isFeatureSupported(androidx.webkit.WebViewFeature.USER_AGENT_METADATA)) {
            androidx.webkit.UserAgentMetadata now = androidx.webkit.WebSettingsCompat.getUserAgentMetadata(s);
            androidx.webkit.WebSettingsCompat.setUserAgentMetadata(s, new androidx.webkit.UserAgentMetadata.Builder(now)
                .setPlatform("Linux").setPlatformVersion("").setMobile(false).setModel("").build());
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true); // YouTube's player

        web.addJavascriptInterface(new Bridge(), "SaturdayAndroid");
        web.setWebViewClient(new StationClient());
        open();
    }

    /**
     * An Android web view tells YouTube it's a phone browser, and YouTube's
     * embed then draws its touch overlay (title bar, previous/pause/next and
     * "More videos") over the show, ignoring controls=0. Describing the same
     * engine as desktop Chrome gets the plain player the Samsung app gets: no
     * overlay and no way to wander off to other videos.
     */
    static String desktopAgent(String webViewAgent) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("Chrome/([0-9.]+)").matcher(webViewAgent);
        String chrome = m.find() ? m.group(1) : "141.0.0.0";
        return "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + chrome
            + " Safari/537.36 SaturdayMorningsTV/" + BuildConfig.VERSION_NAME;
    }

    private void open() {
        offline = false;
        String extra = "";
        // Debug builds only: adb shell am start -n <app>/.StationActivity --es query test=5
        // passes the TV page's own test switches (test=<minutes>, offair).
        if (BuildConfig.DEBUG && getIntent() != null && getIntent().getStringExtra("query") != null) {
            extra = "&" + getIntent().getStringExtra("query").replaceAll("[^A-Za-z0-9=&.]", "");
        }
        web.loadUrl(SERVER + "/?tv=1" + extra);
    }

    // ---------- Remote ----------

    /** Samsung key codes, which the page already handles (apps/tv/js/app.js KEY). */
    private static int pageKey(int code) {
        switch (code) {
            case KeyEvent.KEYCODE_DPAD_LEFT: return 37;
            case KeyEvent.KEYCODE_DPAD_UP: return 38;
            case KeyEvent.KEYCODE_DPAD_RIGHT: return 39;
            case KeyEvent.KEYCODE_DPAD_DOWN: return 40;
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_NUMPAD_ENTER: return 13;
            case KeyEvent.KEYCODE_BACK: return 10009;
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE: return 10252;
            case KeyEvent.KEYCODE_MEDIA_PLAY: return 415;
            case KeyEvent.KEYCODE_MEDIA_PAUSE: return 19;
            case KeyEvent.KEYCODE_MEDIA_STOP: return 413;
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD: return 417;
            case KeyEvent.KEYCODE_MEDIA_REWIND: return 412;
            case KeyEvent.KEYCODE_CHANNEL_UP: return 427;
            case KeyEvent.KEYCODE_CHANNEL_DOWN: return 428;
            default: return 0;
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int k = pageKey(e.getKeyCode());
        if (k == 0) return super.dispatchKeyEvent(e);
        if (offline) {
            if (e.getAction() == KeyEvent.ACTION_DOWN && k == 10009) finish();
            else if (e.getAction() == KeyEvent.ACTION_DOWN && k == 13) open();
            return true;
        }
        // One path for every key: the page's own message listener (which also
        // serves the Samsung launcher), so nothing arrives twice.
        if (e.getAction() == KeyEvent.ACTION_DOWN) {
            web.evaluateJavascript("window.postMessage({type:'key',keyCode:" + k + "},'*')", null);
        }
        return true;
    }

    // ---------- Bridge for the page ----------

    private class Bridge {
        @JavascriptInterface
        public void exit() { handler.post(StationActivity.this::finish); }

        @JavascriptInterface
        public void keepScreenOn(boolean on) {
            handler.post(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }
    }

    // ---------- Pages ----------

    private class StationClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            // Stay on the station: a link elsewhere (say, a YouTube title) goes nowhere.
            return !sameOrigin(req.getUrl());
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (!offline) failures = 0;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
            if (req.isForMainFrame()) {
                android.util.Log.w("SaturdayMornings", "page failed: " + err.getErrorCode() + " " + err.getDescription() + " " + req.getUrl());
                showOffline();
            }
        }
    }

    private static boolean sameOrigin(Uri u) {
        Uri s = Uri.parse(SERVER);
        return s.getScheme().equals(u.getScheme()) && s.getHost().equals(u.getHost()) && s.getPort() == u.getPort();
    }

    private void showOffline() {
        offline = true;
        String html = "<html><body style=\"margin:0;background:#0b1033;color:#fff;font-family:sans-serif;"
            + "display:flex;align-items:center;justify-content:center;height:100vh;text-align:center\"><div>"
            + "<div style=\"font-size:44px;font-weight:800\">Can't reach the station</div>"
            + "<div style=\"font-size:26px;opacity:.8;margin-top:14px\">Check the TV is online. Trying again in a moment&hellip;<br>"
            + "OK tries now, Back closes.</div></div></body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
        handler.removeCallbacksAndMessages(null);
        // The first retry comes quickly: right after the TV wakes, its network
        // often isn't ready for a second or two.
        handler.postDelayed(() -> { if (offline) open(); }, failures++ == 0 ? 3_000 : RETRY_MS);
    }

    // ---------- Window ----------

    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    @Override
    protected void onPause() {
        super.onPause();
        // Leaving the app (Home button) stops the show, as switching channels would.
        if (!offline) web.evaluateJavascript("window.postMessage({type:'key',keyCode:19},'*')", null); // Pause
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        web.destroy();
        super.onDestroy();
    }
}
