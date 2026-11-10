package `in`.vecrahost.jarvis

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Talks to the Jarvis Hub: REST for transcription and chat, a WebSocket for live events. */
class HubClient(private val base: String, private val token: String, private val deviceName: String) {
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(90, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .pingInterval(25, TimeUnit.SECONDS)
        .build()
    private val jsonType = "application/json".toMediaType()

    @Volatile private var ws: WebSocket? = null
    @Volatile private var closed = false
    @Volatile var online = false
        private set
    private var backoffMs = 2_000L
    private val reconnect = java.util.concurrent.Executors.newSingleThreadScheduledExecutor()

    private fun req(path: String) = Request.Builder().url(base + path).header("Authorization", "Bearer $token").header("X-Device", deviceName)

    private fun call(r: Request): JSONObject {
        http.newCall(r).execute().use { res: Response ->
            val body = res.body?.string() ?: ""
            if (!res.isSuccessful) throw IOException("hub ${res.code}: ${body.take(200)}")
            return JSONObject(body.ifBlank { "{}" })
        }
    }

    /** Checks the token; returns the device name the hub knows it as. */
    fun me(): String = call(req("/v1/me").get().build()).optString("device", deviceName)

    /** 16-bit mono PCM → text. */
    fun transcribe(pcm: ByteArray, rate: Int = 16000): String =
        call(req("/v1/transcribe?rate=$rate").post(pcm.toRequestBody("application/octet-stream".toMediaType())).build()).optString("text", "").trim()

    fun chat(text: String, voice: Boolean = true): String {
        val body = JSONObject().put("text", text).put("voice", voice).toString().toRequestBody(jsonType)
        return call(req("/v1/chat").post(body).build()).optString("reply", "")
    }

    fun sendToDesktop(text: String): Boolean = runCatching {
        val body = JSONObject().put("text", text).put("target", "desktop").toString().toRequestBody(jsonType)
        call(req("/v1/chat").post(body).build()); true
    }.getOrDefault(false)

    // ---------- live socket ----------

    interface Events {
        fun onSay(text: String)
        fun onWake(granted: Boolean, by: String)
        fun onOnline(on: Boolean)
    }

    fun connect(events: Events) {
        closed = false
        val wsUrl = base.replaceFirst("https://", "wss://") + "/v1/live"
        val r = Request.Builder().url(wsUrl)
            .header("Authorization", "Bearer $token")
            .header("Sec-WebSocket-Protocol", "jarvis.v1")
            .build()
        ws = http.newWebSocket(r, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                online = true; backoffMs = 2_000L
                webSocket.send(JSONObject().put("type", "hello").put("kind", "phone").put("canSpeak", true).put("native", true).toString())
                events.onOnline(true)
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                val m = runCatching { JSONObject(text) }.getOrNull() ?: return
                when (m.optString("type")) {
                    "say" -> events.onSay(m.optString("text"))
                    "wake_granted" -> events.onWake(true, m.optString("by"))
                    "wake_yield" -> events.onWake(false, m.optString("by"))
                }
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = lost(events)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = lost(events)
        })
    }

    private fun lost(events: Events) {
        online = false
        events.onOnline(false)
        if (closed) return
        reconnect.schedule(Runnable { if (!closed) connect(events) }, backoffMs, TimeUnit.MILLISECONDS)
        backoffMs = (backoffMs * 2).coerceAtMost(60_000L)
    }

    /** Tells the hub this phone heard the wake word, so other devices that heard it stay quiet. */
    fun wake(score: Double): Boolean = ws?.send(JSONObject().put("type", "wake").put("score", score).toString()) ?: false

    fun close() {
        closed = true
        ws?.close(1000, "bye")
        ws = null
        reconnect.shutdownNow()
    }
}
