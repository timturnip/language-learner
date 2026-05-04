// Vercel serverless function: POST /api/tts
//
// Body: { text: string, voice?: string, languageCode?: string }
// Auth: Authorization: Bearer <Supabase access token>
//
// Validates the caller's Supabase JWT, then calls Google Cloud Text-to-Speech
// and returns the MP3 binary. The TTS API key never touches the client.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const GOOGLE_TTS_API_KEY = process.env.GOOGLE_TTS_API_KEY;

const DEFAULT_VOICE = "ko-KR-Chirp3-HD-Aoede";
const DEFAULT_LANG = "ko-KR";
const MAX_INPUT_CHARS = 2000;

// Chirp 3 HD voices can have a 30-60s cold start. Allow up to 60s.
// (Hobby plan max is 60s; Pro/Enterprise can go higher.)
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method not allowed" });
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !GOOGLE_TTS_API_KEY) {
    return res.status(500).json({ error: "server not configured" });
  }

  // 1. Authenticate via Supabase JWT
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return res.status(401).json({ error: "missing auth" });

  let userId = null;
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON_KEY,
      },
    });
    if (!userRes.ok) {
      return res.status(401).json({ error: "invalid auth" });
    }
    const user = await userRes.json();
    userId = user?.id;
    if (!userId) return res.status(401).json({ error: "no user" });
  } catch (err) {
    return res.status(401).json({ error: "auth check failed" });
  }

  // 2. Parse body
  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
  } catch {
    return res.status(400).json({ error: "bad json" });
  }
  const text = (body.text || "").toString().trim();
  const voice = (body.voice || DEFAULT_VOICE).toString();
  const languageCode = (body.languageCode || DEFAULT_LANG).toString();

  if (!text) return res.status(400).json({ error: "missing text" });
  if (text.length > MAX_INPUT_CHARS) {
    return res.status(400).json({ error: "text too long" });
  }
  // Whitelist voice prefix to keep abuse surface tight.
  if (!/^[a-z]{2}-[A-Z]{2}-[A-Za-z0-9-]+$/.test(voice)) {
    return res.status(400).json({ error: "bad voice" });
  }

  // 3. Call Google Cloud TTS
  let ttsRes;
  try {
    ttsRes = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode, name: voice },
          audioConfig: { audioEncoding: "MP3" },
        }),
      }
    );
  } catch (err) {
    return res.status(502).json({ error: "tts request failed" });
  }

  if (!ttsRes.ok) {
    const errText = await ttsRes.text().catch(() => "");
    return res.status(502).json({
      error: "tts failed",
      status: ttsRes.status,
      detail: errText.slice(0, 500),
    });
  }

  const json = await ttsRes.json().catch(() => null);
  if (!json?.audioContent) {
    return res.status(502).json({ error: "no audio content" });
  }

  const buf = Buffer.from(json.audioContent, "base64");
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.status(200).send(buf);
}
