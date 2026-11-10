package `in`.vecrahost.jarvis

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale
import java.util.UUID

/** Spoken replies with the phone's own voice engine, in a British English voice when there is one. */
class Speaker(ctx: Context, private val onSpeaking: (Boolean) -> Unit) {
    private var ready = false
    private val pending = mutableListOf<String>()
    private val tts: TextToSpeech = TextToSpeech(ctx.applicationContext) { status ->
        if (status == TextToSpeech.SUCCESS) {
            ready = true
            pickVoice()
            synchronized(pending) { pending.forEach { say(it) }; pending.clear() }
        }
    }

    init {
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) = onSpeaking(true)
            override fun onDone(utteranceId: String?) { if (!tts.isSpeaking) onSpeaking(false) }
            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) = onSpeaking(false)
        })
    }

    private fun pickVoice() {
        val gb = Locale.UK
        val voice = runCatching { tts.voices?.filter { it.locale == gb && !it.isNetworkConnectionRequired }?.minByOrNull { it.name } }.getOrNull()
        if (voice != null) tts.voice = voice else tts.language = gb
        tts.setSpeechRate(1.02f)
    }

    fun say(text: String) {
        val clean = text.replace(Regex("[*_#`>]"), "").trim()
        if (clean.isEmpty()) return
        if (!ready) { synchronized(pending) { pending.add(clean) }; return }
        tts.speak(clean, TextToSpeech.QUEUE_ADD, null, UUID.randomUUID().toString())
    }

    fun stop() { tts.stop(); onSpeaking(false) }
    val speaking: Boolean get() = tts.isSpeaking
    fun shutdown() { tts.stop(); tts.shutdown() }
}
