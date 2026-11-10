package `in`.vecrahost.jarvis

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.ToneGenerator
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import org.json.JSONObject
import org.vosk.Model
import org.vosk.Recognizer
import org.vosk.android.StorageService
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max
import kotlin.math.sqrt

/**
 * Always-on Jarvis. Listens for the wake word on the device (Vosk, offline: nothing leaves the phone until you
 * say "Jarvis"), then records your request until you stop talking, sends it to the hub to transcribe and answer,
 * and speaks the reply. Also keeps a live link to the hub so lines meant for this phone (reminders, "say this"
 * from the desktop) are spoken even with the app closed.
 */
class JarvisService : Service(), HubClient.Events {

    companion object {
        private const val TAG = "JarvisService"
        private const val CHANNEL = "jarvis_listening"
        private const val NOTE_ID = 7
        const val ACTION_START = "start"
        const val ACTION_STOP = "stop"
        const val ACTION_TALK = "talk"
        const val ACTION_PAUSE = "pause"
        const val ACTION_RESUME = "resume"
        private const val RATE = 16000
        private val WAKE = Regex("\\b(jarvis|jervis|jarvi)\\b", RegexOption.IGNORE_CASE)

        @Volatile var running = false
            private set
        @Volatile var status = "Off"
            private set

        fun start(ctx: Context, action: String = ACTION_START) {
            val i = Intent(ctx, JarvisService::class.java).setAction(action)
            if (action == ACTION_START) ctx.startForegroundService(i) else if (running) ctx.startService(i)
        }
    }

    private enum class State { WAKE, CAPTURE, BUSY }

    private var hub: HubClient? = null
    private var speaker: Speaker? = null
    private var model: Model? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private val worker = Executors.newSingleThreadExecutor()
    private var audioThread: Thread? = null
    private val stopAudio = AtomicBoolean(false)
    private val paused = AtomicBoolean(false)       // the app's own hold-to-talk has the mic
    private val speaking = AtomicBoolean(false)     // don't listen to ourselves
    @Volatile private var state = State.WAKE
    @Volatile private var wakeDecision: Boolean? = null
    @Volatile private var forceTalk = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> { Prefs.setWantListening(this, false); stopSelf(); return START_NOT_STICKY }
            ACTION_TALK -> { forceTalk = true; return START_NOT_STICKY }
            ACTION_PAUSE -> { paused.set(true); return START_NOT_STICKY }
            ACTION_RESUME -> { paused.set(false); return START_NOT_STICKY }
        }
        if (running) return START_NOT_STICKY
        // A microphone service may only start while the app is on screen (Android 14+). If the system tries to
        // bring it back later on its own, that is refused, so we just stop instead of crashing.
        try {
            val note = notification("Loading…")
            if (Build.VERSION.SDK_INT >= 30) startForeground(NOTE_ID, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            else startForeground(NOTE_ID, note)
        } catch (e: Exception) {
            Log.w(TAG, "could not start in the foreground", e)
            stopSelf(); return START_NOT_STICKY
        }
        val url = Prefs.hubUrl(this); val token = Prefs.token(this)
        if (url == null || token == null) { stopSelf(); return START_NOT_STICKY }
        running = true
        Prefs.setWantListening(this, true)
        wakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "jarvis:listening").apply { setReferenceCounted(false); acquire() }
        speaker = Speaker(this) { on -> speaking.set(on) }
        hub = HubClient(url, token, Prefs.deviceName(this)).also { it.connect(this) }
        loadModel()
        return START_NOT_STICKY
    }

    private fun loadModel() {
        setStatus("Loading wake word…")
        StorageService.unpack(this, "model-en", "model",
            { m: Model -> model = m; startAudio() },
            { e: java.io.IOException ->
                Log.e(TAG, "wake word model", e)
                setStatus("Wake word unavailable · tap Talk")
                startAudio() // still useful: Talk button and spoken replies
            })
    }

    // ---------- audio loop ----------

    @SuppressLint("MissingPermission") // checked by the activity before starting
    private fun startAudio() {
        stopAudio.set(false)
        audioThread = Thread({ audioLoop() }, "jarvis-audio").apply { start() }
    }

    private fun newRecorder(): AudioRecord? = try {
        val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        @SuppressLint("MissingPermission")
        val r = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, max(min, RATE))
        if (r.state == AudioRecord.STATE_INITIALIZED) r else { r.release(); null }
    } catch (e: Exception) { Log.e(TAG, "recorder", e); null }

    private fun audioLoop() {
        val rec = model?.let { runCatching { Recognizer(it, RATE.toFloat(), "[\"jarvis\", \"hey jarvis\", \"okay jarvis\", \"[unk]\"]") }.getOrNull() }
        var recorder: AudioRecord? = null
        val frame = ShortArray(RATE / 10)            // 100 ms
        val captured = ByteArrayOutputStream()
        var noise = 0.01; var heardSpeech = false; var silentMs = 0; var capturedMs = 0
        setStatus(if (rec != null) "Listening for “Jarvis”" else "Tap Talk to speak")
        try {
            while (!stopAudio.get()) {
                // Give the mic up while we talk, while busy, or while the app's own recorder needs it.
                val hold = paused.get() || speaking.get() || state == State.BUSY
                if (hold) {
                    recorder?.let { runCatching { it.stop() }; it.release() }; recorder = null
                    Thread.sleep(150); continue
                }
                var r: AudioRecord? = recorder
                if (r == null) {
                    r = newRecorder()
                    if (r == null) { setStatus("Microphone busy"); Thread.sleep(2000); continue }
                    r.startRecording()
                    rec?.reset()
                    recorder = r
                }
                if (forceTalk) { forceTalk = false; beginCapture(captured); heardSpeech = false; silentMs = 0; capturedMs = 0 }
                val n = r.read(frame, 0, frame.size)
                if (n <= 0) continue
                val level = rms(frame, n)

                when (state) {
                    State.WAKE -> {
                        noise = noise * 0.97 + level * 0.03
                        if (rec == null) continue
                        val fin = rec.acceptWaveForm(frame, n)
                        val text = JSONObject(if (fin) rec.result else rec.partialResult).let { it.optString("text", it.optString("partial", "")) }
                        if (WAKE.containsMatchIn(text)) {
                            rec.reset()
                            if (arbitrate(level)) { beginCapture(captured); heardSpeech = false; silentMs = 0; capturedMs = 0 }
                        }
                    }
                    State.CAPTURE -> {
                        captured.write(toBytes(frame, n))
                        capturedMs += 100
                        val talking = level > max(noise * 3.0, 0.012)
                        if (talking) { heardSpeech = true; silentMs = 0 } else silentMs += 100
                        val done = (heardSpeech && silentMs >= 1200) || (!heardSpeech && capturedMs >= 5000) || capturedMs >= 15000
                        if (done) {
                            val pcm = captured.toByteArray(); captured.reset()
                            if (!heardSpeech) { state = State.WAKE; setStatus("Listening for “Jarvis”"); continue }
                            state = State.BUSY
                            setStatus("Thinking…")
                            worker.execute { handle(pcm) }
                        }
                    }
                    State.BUSY -> Unit
                }
            }
        } catch (_: InterruptedException) {
        } catch (e: Exception) {
            Log.e(TAG, "audio loop", e)
            setStatus("Microphone error")
        } finally {
            recorder?.let { runCatching { it.stop() }; it.release() }
            rec?.close()
        }
    }

    private fun beginCapture(buf: ByteArrayOutputStream) {
        buf.reset()
        state = State.CAPTURE
        setStatus("Listening…")
        runCatching { ToneGenerator(AudioManager.STREAM_NOTIFICATION, 60).apply { startTone(ToneGenerator.TONE_PROP_BEEP, 120) } }
    }

    /** Asks the hub whether this phone should answer (another device may have heard "Jarvis" better). */
    private fun arbitrate(level: Double): Boolean {
        val h = hub ?: return true
        wakeDecision = null
        if (!h.wake(level.coerceIn(0.0, 1.0))) return true // offline: answer locally
        val until = System.currentTimeMillis() + 700
        while (System.currentTimeMillis() < until) { wakeDecision?.let { return it }; Thread.sleep(20) }
        return true
    }

    private fun handle(pcm: ByteArray) {
        val h = hub
        try {
            if (h == null) return
            val heard = h.transcribe(pcm, RATE).replace(Regex("^\\W*(hey|okay|ok)?\\W*jarvis\\W*", RegexOption.IGNORE_CASE), "").trim()
            if (heard.isEmpty()) { speaker?.say("Yes, sir?"); return }
            setStatus("“${heard.take(40)}”")
            val reply = h.chat(heard, voice = true)
            speaker?.say(reply)
        } catch (e: Exception) {
            Log.w(TAG, "request failed", e)
            speaker?.say(if (h?.online == false) "I can't reach the hub right now, sir." else "Something went wrong with that request, sir.")
        } finally {
            state = State.WAKE
            setStatus(if (model != null) "Listening for “Jarvis”" else "Tap Talk to speak")
        }
    }

    // ---------- hub events ----------

    override fun onSay(text: String) { speaker?.say(text) }
    override fun onWake(granted: Boolean, by: String) {
        wakeDecision = granted
        if (!granted && state == State.WAKE) setStatus("$by is answering")
    }
    override fun onOnline(on: Boolean) {
        val base = status.removeSuffix(" · offline")
        setStatus(if (on) base else "$base · offline")
    }

    // ---------- notification ----------

    private fun setStatus(s: String) {
        status = s
        runCatching { (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(NOTE_ID, notification(s)) }
    }

    private fun notification(text: String): Notification {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Jarvis listening", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shown while Jarvis listens for its name"; setShowBadge(false)
            })
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), flags)
        val talk = PendingIntent.getService(this, 1, Intent(this, JarvisService::class.java).setAction(ACTION_TALK), flags)
        val stop = PendingIntent.getService(this, 2, Intent(this, JarvisService::class.java).setAction(ACTION_STOP), flags)
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle("Jarvis")
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "Talk", talk).build())
            .addAction(Notification.Action.Builder(null, "Stop", stop).build())
            .build()
    }

    override fun onDestroy() {
        running = false
        status = "Off"
        stopAudio.set(true)
        audioThread?.interrupt()
        worker.shutdownNow()
        hub?.close(); hub = null
        speaker?.shutdown(); speaker = null
        model?.close(); model = null
        wakeLock?.let { if (it.isHeld) it.release() }
        super.onDestroy()
    }

    // ---------- helpers ----------

    private fun rms(buf: ShortArray, n: Int): Double {
        var sum = 0.0
        for (i in 0 until n) { val v = buf[i] / 32768.0; sum += v * v }
        return sqrt(sum / max(1, n))
    }

    private fun toBytes(buf: ShortArray, n: Int): ByteArray {
        val out = ByteArray(n * 2)
        for (i in 0 until n) { val v = buf[i].toInt(); out[i * 2] = (v and 0xff).toByte(); out[i * 2 + 1] = (v shr 8 and 0xff).toByte() }
        return out
    }
}
