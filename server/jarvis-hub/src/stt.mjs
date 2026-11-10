// Speech to text for the pendant and the phone: any OpenAI-compatible transcription API.
// Default: Groq's Whisper (fast, cheap). Set in .env:
//   STT_API_KEY      (falls back to GROQ_API_KEY, then OPENAI_API_KEY)
//   STT_BASE_URL     default https://api.groq.com/openai/v1 (OpenAI: https://api.openai.com/v1)
//   STT_MODEL        default whisper-large-v3-turbo (OpenAI: whisper-1)
//   STT_LANGUAGE     optional, e.g. "en" or "te"; leave empty to auto-detect (handy for Tinglish)

export const sttReady = () => !!(process.env.STT_API_KEY || process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY);

/** Raw 16-bit little-endian mono PCM → a WAV file. */
export function pcmToWav(pcm, sampleRate = 16000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Loudness of PCM16 (0..1 RMS), so silent clips are skipped instead of transcribed into nonsense. */
export function rms(pcm) {
  const n = Math.floor(pcm.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i * 2) / 32768; sum += v * v; }
  return Math.sqrt(sum / n);
}

/** Transcribes an audio file (wav, webm, m4a, ogg, mp3). Returns the text ('' for nothing heard). */
export async function transcribe(audio, { filename = 'audio.wav', mime = 'audio/wav' } = {}) {
  const key = process.env.STT_API_KEY || process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) throw new Error('no speech-to-text key: set STT_API_KEY (or GROQ_API_KEY) in .env');
  const usingOpenAI = !process.env.STT_API_KEY && !process.env.GROQ_API_KEY && process.env.OPENAI_API_KEY;
  const base = (process.env.STT_BASE_URL || (usingOpenAI ? 'https://api.openai.com/v1' : 'https://api.groq.com/openai/v1')).replace(/\/+$/, '');
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime }), filename);
  form.append('model', process.env.STT_MODEL || (usingOpenAI ? 'whisper-1' : 'whisper-large-v3-turbo'));
  if (process.env.STT_LANGUAGE) form.append('language', process.env.STT_LANGUAGE);
  form.append('response_format', 'json');
  const res = await fetch(`${base}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`transcription ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const out = await res.json();
  return String(out.text ?? '').trim();
}
