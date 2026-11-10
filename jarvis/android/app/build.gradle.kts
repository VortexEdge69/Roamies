// Jarvis for Android: a thin native shell around the hub's web client (the same JARVIS globe and brain view),
// plus a foreground service that listens for "Jarvis" with the screen off, records the request, sends it to
// your hub and speaks the answer.
//
// Versions come from CI (JARVIS_VERSION_CODE / JARVIS_VERSION_NAME) so every build can install over the last.
// Release signing: CI decodes the JARVIS_ANDROID_KEYSTORE secret to JARVIS_KEYSTORE_PATH; JARVIS_SIGNING_PASSWORD unlocks it.
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val signingPassword: String? = System.getenv("JARVIS_SIGNING_PASSWORD")?.takeIf { it.isNotBlank() }
val keystoreFile = System.getenv("JARVIS_KEYSTORE_PATH")?.let { file(it) }

android {
    namespace = "in.vecrahost.jarvis"
    compileSdk = 35

    defaultConfig {
        applicationId = "in.vecrahost.jarvis"
        minSdk = 26
        targetSdk = 35
        versionCode = (System.getenv("JARVIS_VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("JARVIS_VERSION_NAME") ?: "0.1.0-dev"
        buildConfigField("String", "DEFAULT_HUB", "\"${System.getenv("JARVIS_DEFAULT_HUB") ?: "https://jarvis.vecrahost.in"}\"")
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a") }
    }

    signingConfigs {
        if (signingPassword != null && keystoreFile != null && keystoreFile.exists()) {
            create("release") {
                storeFile = keystoreFile
                storePassword = signingPassword
                keyAlias = "jarvis"
                keyPassword = signingPassword
                storeType = "pkcs12"
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    // The Vosk wake-word model is big and already compressed.
    androidResources { noCompress += listOf("mdl", "fst", "int", "conf", "carpa") }
    packaging { jniLibs { useLegacyPackaging = true } }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.security:security-crypto:1.0.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("net.java.dev.jna:jna:5.18.1@aar")
    implementation("com.alphacephei:vosk-android:0.3.75@aar")
}
