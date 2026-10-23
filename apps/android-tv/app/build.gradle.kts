import java.util.Properties

// Your own settings live in apps/android-tv/local.properties (git-ignored):
//   tv.server=https://tv.example.com/tv        your station's TV page
//   tv.appId=com.example.saturdaymornings      optional: your own app id
//   signing.storeFile=/path/to/upload.jks      for release builds (keep it outside git)
//   signing.keyAlias=upload
// The key's password is never written down: build.sh --release reads it from
// the macOS Keychain and passes it in as SM_SIGNING_PASSWORD.
val local = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun setting(name: String, fallback: String = "") = local.getProperty(name) ?: fallback

plugins {
    id("com.android.application")
}

android {
    namespace = "tv.saturdaymornings.station"
    compileSdk = 36

    defaultConfig {
        applicationId = setting("tv.appId", "tv.saturdaymornings.station")
        minSdk = 22
        targetSdk = 36
        // Every upload to Google Play needs a higher versionCode.
        versionCode = 2
        versionName = "0.6.1"
        buildConfigField("String", "TV_SERVER", "\"" + setting("tv.server", "https://your-station.example.com/tv") + "\"")
    }

    buildFeatures { buildConfig = true }

    signingConfigs {
        val password = System.getenv("SM_SIGNING_PASSWORD")
        if (local.getProperty("signing.storeFile") != null && password != null) {
            create("release") {
                storeFile = file(setting("signing.storeFile"))
                storePassword = password
                keyAlias = setting("signing.keyAlias", "upload")
                keyPassword = password
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    // Lets the web view describe itself to YouTube consistently (user-agent
    // client hints), so YouTube serves its plain player rather than the phone one.
    implementation("androidx.webkit:webkit:1.12.1")
}
