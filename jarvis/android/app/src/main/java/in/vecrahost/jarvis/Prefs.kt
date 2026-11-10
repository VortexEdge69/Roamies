package `in`.vecrahost.jarvis

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKeys

/** Hub URL and device token, encrypted with a key kept in the Android Keystore. */
object Prefs {
    @Volatile private var prefs: SharedPreferences? = null

    private fun get(ctx: Context): SharedPreferences = prefs ?: synchronized(this) {
        prefs ?: EncryptedSharedPreferences.create(
            "jarvis_secure",
            MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC),
            ctx.applicationContext,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        ).also { prefs = it }
    }

    fun hubUrl(ctx: Context): String? = get(ctx).getString("hub_url", null)
    fun token(ctx: Context): String? = get(ctx).getString("token", null)
    fun deviceName(ctx: Context): String = get(ctx).getString("device_name", null) ?: "phone"
    fun wantListening(ctx: Context): Boolean = get(ctx).getBoolean("want_listening", false)

    fun save(ctx: Context, url: String, token: String) {
        get(ctx).edit().putString("hub_url", url.trimEnd('/')).putString("token", token).apply()
    }
    fun setDeviceName(ctx: Context, name: String) { get(ctx).edit().putString("device_name", name).apply() }
    fun setWantListening(ctx: Context, on: Boolean) { get(ctx).edit().putBoolean("want_listening", on).apply() }
    fun clear(ctx: Context) { get(ctx).edit().clear().apply() }

    fun isPaired(ctx: Context) = !hubUrl(ctx).isNullOrBlank() && !token(ctx).isNullOrBlank()

    /** Accepts only https:// hub URLs (http:// is refused: the token would travel in the clear). */
    fun validUrl(url: String): Boolean {
        val u = runCatching { java.net.URI(url.trim()) }.getOrNull() ?: return false
        return u.scheme == "https" && !u.host.isNullOrBlank()
    }
    fun validToken(t: String) = t.trim().matches(Regex("^jh_[A-Za-z0-9_-]{20,100}$"))
}
