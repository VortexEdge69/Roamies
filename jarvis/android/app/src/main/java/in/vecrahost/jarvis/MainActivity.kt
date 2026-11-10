package `in`.vecrahost.jarvis

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import java.net.URI
import java.net.URLEncoder
import kotlin.concurrent.thread

/**
 * Shows the hub's own web client (the JARVIS globe, the brain view, chat) in a locked-down WebView, and adds
 * what a web page can't do: listening in the background with the screen off (JarvisService).
 */
class MainActivity : ComponentActivity() {
    private var web: WebView? = null
    private var hubOrigin: String? = null

    private val askPermissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        if (granted[Manifest.permission.RECORD_AUDIO] == true && pendingStart) { pendingStart = false; startListening() }
        else if (granted[Manifest.permission.RECORD_AUDIO] == false) toast("Jarvis needs the microphone to hear you.")
    }
    private var pendingStart = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.parseColor("#04090D")
        handlePairingLink(intent)
        if (Prefs.isPaired(this)) showWeb() else showSetup(null)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val w = web
                if (w != null && w.canGoBack()) w.goBack() else moveTaskToBack(true)
            }
        })
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (handlePairingLink(intent)) showWeb()
    }

    /** jarvis://pair?url=https://…&token=jh_… (printed by the hub installer). */
    private fun handlePairingLink(intent: Intent?): Boolean {
        val data: Uri = intent?.data ?: return false
        if (data.scheme != "jarvis" || data.host != "pair") return false
        val url = data.getQueryParameter("url") ?: return false
        val token = data.getQueryParameter("token") ?: return false
        if (!Prefs.validUrl(url) || !Prefs.validToken(token)) { toast("That pairing link isn't valid."); return false }
        Prefs.save(this, url, token)
        toast("Paired with ${URI(url).host}")
        return true
    }

    // ---------- setup ----------

    private fun showSetup(error: String?) {
        web?.destroy(); web = null
        val pad = (16 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(pad * 2, pad, pad * 2, pad); setBackgroundColor(Color.parseColor("#04090D"))
        }
        fun label(t: String, size: Float, color: String) = TextView(this).apply { text = t; textSize = size; setTextColor(Color.parseColor(color)); setPadding(0, pad / 2, 0, pad / 2) }
        fun field(hint: String, value: String?, secret: Boolean) = EditText(this).apply {
            this.hint = hint; setText(value ?: ""); setTextColor(Color.parseColor("#D9FBFF")); setHintTextColor(Color.parseColor("#557A82"))
            inputType = if (secret) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD else InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            isSingleLine = true
        }
        root.addView(label("J A R V I S", 22f, "#6FF3FF"))
        root.addView(label("Connect to your hub. Open the pairing link from the installer, or paste the hub address and this phone's token.", 14f, "#7FA9B2"))
        val url = field("https://jarvis.example.com", Prefs.hubUrl(this) ?: BuildConfig.DEFAULT_HUB, false)
        val token = field("jh_…", null, true)
        root.addView(url); root.addView(token)
        val err = label(error ?: "", 13f, "#FF5C6C")
        val go = Button(this).apply { text = "Connect" }
        root.addView(go); root.addView(err)
        go.setOnClickListener {
            val u = url.text.toString().trim().trimEnd('/'); val t = token.text.toString().trim()
            if (!Prefs.validUrl(u)) { err.text = "The hub address must start with https://"; return@setOnClickListener }
            if (!Prefs.validToken(t)) { err.text = "Device tokens start with jh_"; return@setOnClickListener }
            go.isEnabled = false; err.text = "Checking…"
            thread {
                val res = runCatching { HubClient(u, t, "phone").me() }
                runOnUiThread {
                    go.isEnabled = true
                    res.onSuccess { name -> Prefs.save(this, u, t); Prefs.setDeviceName(this, name); showWeb() }
                       .onFailure { e -> err.text = if (e.message?.contains("401") == true) "The hub didn't accept that token." else "Couldn't reach the hub: ${e.message?.take(80)}" }
                }
            }
        }
        setContentView(root)
    }

    // ---------- the web client ----------

    @SuppressLint("SetJavaScriptEnabled")
    private fun showWeb() {
        val url = Prefs.hubUrl(this) ?: return showSetup(null)
        val token = Prefs.token(this) ?: return showSetup(null)
        hubOrigin = URI(url).let { "${it.scheme}://${it.host}${if (it.port > 0) ":${it.port}" else ""}" }
        web?.destroy()
        val w = WebView(this)
        w.setBackgroundColor(Color.parseColor("#04090D"))
        w.layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        w.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
        }
        w.addJavascriptInterface(Bridge(), "JarvisNative")
        w.webViewClient = object : WebViewClient() {
            // Only the hub opens inside the app; any other link goes to the browser (and never sees the bridge).
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if ("${u.scheme}://${u.authority}" == hubOrigin) return false
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, u)) }
                return true
            }
        }
        w.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                val fromHub = request.origin?.let { "${it.scheme}://${it.authority}" } == hubOrigin
                val wantsMic = request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
                if (fromHub && wantsMic && hasMic()) request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                else { request.deny(); if (fromHub && wantsMic) askMic(false) }
            }
        }
        // The token goes in the fragment: it stays on the phone (fragments are never sent to the server).
        val name = URLEncoder.encode(Prefs.deviceName(this), "UTF-8")
        w.loadUrl("$url/#native=1&device=$name&token=${URLEncoder.encode(token, "UTF-8")}")
        web = w
        setContentView(w)
        if (Prefs.wantListening(this) && !JarvisService.running) { if (hasMic()) startListening() else askMic(true) }
        else askMic(false)
    }

    private fun hasMic() = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun askMic(thenStart: Boolean) {
        pendingStart = thenStart
        val want = mutableListOf(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 33) want += Manifest.permission.POST_NOTIFICATIONS
        val missing = want.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) askPermissions.launch(missing.toTypedArray()) else if (thenStart) startListening()
    }

    private fun startListening() {
        JarvisService.start(this)
        // Some phones kill background apps aggressively; ask once to be left alone.
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        if (!pm.isIgnoringBatteryOptimizations(packageName)) {
            runCatching { startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))) }
        }
    }

    private fun toast(t: String) = Toast.makeText(this, t, Toast.LENGTH_LONG).show()

    /** What the web client can ask of the app. Only exposed to pages from the hub (see shouldOverrideUrlLoading). */
    inner class Bridge {
        @JavascriptInterface fun isListening(): Boolean = JarvisService.running
        @JavascriptInterface fun status(): String = JarvisService.status
        @JavascriptInterface fun startListening() = runOnUiThread { if (hasMic()) this@MainActivity.startListening() else askMic(true) }
        @JavascriptInterface fun stopListening() = runOnUiThread { Prefs.setWantListening(this@MainActivity, false); JarvisService.start(this@MainActivity, JarvisService.ACTION_STOP) }
        @JavascriptInterface fun pauseMic() = JarvisService.start(this@MainActivity, JarvisService.ACTION_PAUSE)
        @JavascriptInterface fun resumeMic() = JarvisService.start(this@MainActivity, JarvisService.ACTION_RESUME)
        @JavascriptInterface fun version(): String = BuildConfig.VERSION_NAME
        @JavascriptInterface fun unpair() = runOnUiThread {
            JarvisService.start(this@MainActivity, JarvisService.ACTION_STOP)
            Prefs.clear(this@MainActivity)
            showSetup(null)
        }
    }

    override fun onDestroy() { web?.destroy(); web = null; super.onDestroy() }
}
