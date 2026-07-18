// gemini.js — Google Gemini 2.5 Flash Client
//
// Nutzt die Consumer-API (generativelanguage.googleapis.com):
//   1. Audio-Blob via Files API resumable hochladen
//   2. Auf state = ACTIVE pollen
//   3. generateContent mit file_data + deutschem Prompt
//   4. Datei via DELETE bereinigen (ephemer)

const BASE = "https://generativelanguage.googleapis.com";

const SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_ONLY_HIGH" },
  { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_ONLY_HIGH" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
];

// temperature 0 + thinkingBudget 0: Transkription braucht weder Kreativitaet
// noch Vorab-Reasoning; beides kostet nur Latenz bzw. erhoeht Halluzinationsrisiko.
const GENERATION_CONFIG = {
  temperature: 0,
  topP: 0.95,
  maxOutputTokens: 8192,
  responseMimeType: "text/plain",
  thinkingConfig: { thinkingBudget: 0 },
};

const MEETING_GENERATION_CONFIG = {
  temperature: 0,
  topP: 0.95,
  maxOutputTokens: 32768,
  responseMimeType: "text/plain",
  thinkingConfig: { thinkingBudget: 0 },
};

async function readErr(res) {
  try {
    const txt = await res.text();
    return txt.slice(0, 600);
  } catch {
    return "";
  }
}

// Billiger Live-Check, ob ein API-Key von Google akzeptiert wird.
// Wirft bei Netzfehler; gibt false bei abgelehntem Key zurueck.
export async function validateApiKey(apiKey) {
  const res = await fetch(
    `${BASE}/v1beta/models?pageSize=1&key=${encodeURIComponent(apiKey)}`,
  );
  return res.ok;
}

export async function uploadAudio(apiKey, blob, displayName) {
  const mime = blob.type || "audio/webm";

  const startRes = await fetch(
    `${BASE}/upload/v1beta/files?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(blob.size),
        "X-Goog-Upload-Header-Content-Type": mime,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file: { display_name: displayName } }),
    },
  );
  if (!startRes.ok) {
    throw new Error(`Upload-Init ${startRes.status}: ${await readErr(startRes)}`);
  }
  const uploadUrl =
    startRes.headers.get("X-Goog-Upload-URL") ||
    startRes.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Keine Upload-URL von Gemini");

  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: blob,
  });
  if (!uploadRes.ok) {
    throw new Error(`Upload ${uploadRes.status}: ${await readErr(uploadRes)}`);
  }
  const data = await uploadRes.json();
  if (!data.file) throw new Error("Upload-Antwort ohne file-Objekt");
  return data.file; // { name, uri, mimeType, state, sizeBytes, ... }
}

export async function waitForFileActive(
  apiKey,
  file,
  { timeoutMs = 180000, intervalMs = 1500 } = {},
) {
  const start = Date.now();
  let cur = file;
  while (cur.state !== "ACTIVE") {
    if (cur.state === "FAILED") throw new Error("Gemini-File-Processing FAILED");
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timeout beim Gemini-File-Processing");
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    const res = await fetch(
      `${BASE}/v1beta/${cur.name}?key=${encodeURIComponent(apiKey)}`,
    );
    if (!res.ok) throw new Error(`File-Status ${res.status}: ${await readErr(res)}`);
    cur = await res.json();
  }
  return cur;
}

export async function deleteFile(apiKey, fileName) {
  try {
    await fetch(
      `${BASE}/v1beta/${fileName}?key=${encodeURIComponent(apiKey)}`,
      { method: "DELETE" },
    );
  } catch (err) {
    console.warn("Datei-Loeschung fehlgeschlagen:", err);
  }
}

async function callGenerate(apiKey, model, parts, meeting) {
  const url =
    `${BASE}/v1beta/models/${encodeURIComponent(model)}:generateContent` +
    `?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ parts }],
    generationConfig: meeting ? MEETING_GENERATION_CONFIG : GENERATION_CONFIG,
    safetySettings: SAFETY_SETTINGS,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`generateContent ${res.status}: ${await readErr(res)}`);
  }
  const data = await res.json();
  const candidate = data.candidates?.[0];
  if (!candidate) {
    const block = data.promptFeedback?.blockReason;
    throw new Error(block ? `Gemini-Block: ${block}` : "Keine Kandidaten");
  }
  if (candidate.finishReason === "SAFETY") {
    throw new Error("Gemini-Safety-Filter hat blockiert");
  }
  const respParts = candidate.content?.parts || [];
  const text = respParts.map((p) => p.text || "").join("");
  if (!text.trim()) throw new Error("Leere Transkript-Antwort");
  return text;
}

export async function generateContent(apiKey, model, file, promptText, { meeting = false } = {}) {
  return callGenerate(apiKey, model, [
    { file_data: { file_uri: file.uri, mime_type: file.mimeType } },
    { text: promptText },
  ], meeting);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error || new Error("Blob-Encoding fehlgeschlagen"));
    reader.readAsDataURL(blob);
  });
}

// Fuer kurze Aufnahmen: Audio als inline_data direkt im generateContent-Call.
// Spart Files-API-Upload, ACTIVE-Polling und Delete (3 Requests + Warteschleife).
export async function generateContentInline(apiKey, model, blob, promptText, { meeting = false } = {}) {
  const data = await blobToBase64(blob);
  return callGenerate(apiKey, model, [
    { inline_data: { mime_type: blob.type || "audio/webm", data } },
    { text: promptText },
  ], meeting);
}

// ---------- Prompts ----------

function fmtDe(iso) {
  try {
    return new Date(iso).toLocaleString("de-DE", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

// Verbindlicher Regelblock gegen Halluzination und Fuellprosa — in jedem Prompt.
const PROMPT_RULES = `Regeln (verbindlich):
- Transkribiere ausschliesslich, was tatsaechlich gesagt wurde. Erfinde nichts, ergaenze nichts, interpretiere nichts hinein.
- Unverstaendliche Stellen als [unverstaendlich] markieren, unsichere Woerter als [? wort].
- Wenn das Audio leer, stumm oder durchgehend unverstaendlich ist: schreibe genau das ins Transkript. Rekonstruiere keinen Inhalt aus Vermutungen oder Kontext.
- Medizinische Fachbegriffe exakt so wiedergeben, wie sie gesprochen wurden; bei Unsicherheit [? begriff].
- Stil aller Zusammenfassungen: nuechtern, telegrammartig, streng am Gesagten. Keine Bewertungen, keine Fuellwoerter, kein Management-Jargon.`;

const MEETING_RULES = `${PROMPT_RULES}
- Entscheidungen und Todos: NUR was woertlich als Entscheidung oder Auftrag ausgesprochen wurde. Wenn keine vorhanden: "Keine." Nichts aus dem Gespraechsverlauf ableiten.
- Sprecherlabels (Sprecher 1, Sprecher 2, ...) nur bei eindeutiger akustischer Trennung, sonst Transkript ohne Labels. Namen nur verwenden, wenn sie im Gespraech genannt werden.`;

function buildMetaBlock({ isoTimestamp, durationSec, title }) {
  const lines = [
    `- ISO-Zeitstempel: ${isoTimestamp}`,
    `- Dauer in Sekunden: ${Math.round(durationSec)}`,
  ];
  if (title) lines.push(`- Titel (vom Nutzer): ${title}`);
  return lines.join("\n");
}

export function buildIdeaPrompt(meta) {
  const secs = Math.round(meta.durationSec);
  const human = fmtDe(meta.isoTimestamp);
  return `Du bekommst eine kurze deutschsprachige Sprachnotiz (meist unter 2 Minuten) eines Klinikdirektors (Neurologie/Geriatrie). Typischer Inhalt: fluechtige Idee, Gedanke, To-do, Beobachtung.

${PROMPT_RULES}

Metadaten:
${buildMetaBlock(meta)}

Gib exakt folgendes Markdown zurueck, nichts davor, nichts danach:

---
type: voice-capture
kind: idea
captured: ${meta.isoTimestamp}
duration_sec: ${secs}
transcription_model: gemini-2.5-flash
---

# Notiz ${human}

## Transkript
<woertliches Transkript nach obigen Regeln>

## Worum geht es
<Ein nuechterner Satz, streng aus dem Gesagten. Wenn nicht ableitbar: "Unklar.">

## Moegliche Verortung im Vault
<wiki/entities/..., projects/... oder areas/... NUR wenn der Inhalt es eindeutig hergibt. Sonst exakt: "Unklar, beim Ingest entscheiden.">`;
}

export function buildMeetingPrompt(meta) {
  const secs = Math.round(meta.durationSec);
  const title = meta.title || fmtDe(meta.isoTimestamp);
  return `Du bekommst eine deutschsprachige Meeting-Aufnahme (bis 60 Min) aus einer neurologischen Klinik. Teilnehmer: Aerzte, Therapeuten, Pflegekraefte oder Verwaltung.

${MEETING_RULES}

Metadaten:
${buildMetaBlock(meta)}

Gib exakt folgendes Markdown zurueck, nichts davor, nichts danach:

---
type: voice-capture
kind: meeting
captured: ${meta.isoTimestamp}
duration_sec: ${secs}
title: ${title}
transcription_model: gemini-2.5-flash
---

# Meeting: ${title}

## Kurzueberblick
<2-4 telegrammartige Saetze: Kernthema, Ergebnisse. Nur belegbare Aussagen.>

## Teilnehmer (soweit erkennbar)
<Nur im Gespraech genannte Namen/Rollen. Sonst exakt: "Nicht erkennbar.">

## Entscheidungen
<Nur woertlich ausgesprochene Entscheidungen als Bullets. Sonst: "Keine.">

## Offene Punkte / Todos
<Nur woertlich ausgesprochene Auftraege als "- [ ] Wer? Was? Bis wann?". Sonst: "Keine.">

## Transkript
<vollstaendiges Transkript nach obigen Regeln>`;
}

export function buildMeetingPromptPart1(meta, totalDurationSec) {
  const partMin = Math.round(meta.durationSec / 60);
  const totalMin = Math.round(totalDurationSec / 60);
  const title = meta.title || fmtDe(meta.isoTimestamp);
  const secs = Math.round(meta.durationSec);
  return `Du bekommst den ERSTEN TEIL (Minute 0 bis ca. ${partMin}) einer deutschsprachigen Meeting-Aufnahme von insgesamt ca. ${totalMin} Minuten aus einer neurologischen Klinik. Teilnehmer: Aerzte, Therapeuten, Pflegekraefte oder Verwaltung.

${MEETING_RULES}
- Der Teil kann mitten im Satz enden; transkribiere bis zum Abbruch und markiere das Ende mit [Schnitt].

Metadaten:
${buildMetaBlock({ ...meta, durationSec: totalDurationSec })}

Gib exakt folgendes Markdown zurueck, nichts davor, nichts danach:

---
type: voice-capture
kind: meeting
captured: ${meta.isoTimestamp}
duration_sec: ${Math.round(totalDurationSec)}
title: ${title}
transcription_model: gemini-2.5-flash
---

# Meeting: ${title}

## Kurzueberblick (Teil 1, Minute 0-${partMin})
<2-4 telegrammartige Saetze. Nur belegbare Aussagen aus diesem Teil.>

## Teilnehmer (soweit erkennbar)
<Nur im Gespraech genannte Namen/Rollen. Sonst exakt: "Nicht erkennbar.">

## Entscheidungen (Teil 1)
<Nur woertlich ausgesprochene Entscheidungen als Bullets. Sonst: "Keine.">

## Offene Punkte / Todos (Teil 1)
<Nur woertlich ausgesprochene Auftraege als "- [ ] Wer? Was? Bis wann?". Sonst: "Keine.">

## Transkript (Teil 1 — Minute 0 bis ca. ${partMin})
<vollstaendiges Transkript nach obigen Regeln>`;
}

export function buildMeetingPromptPart2(meta, startSec, totalDurationSec) {
  const startMin = Math.round(startSec / 60);
  const endMin = Math.round(totalDurationSec / 60);
  return `Du bekommst den ZWEITEN TEIL (Minute ca. ${startMin} bis ${endMin}) einer deutschsprachigen Meeting-Aufnahme aus einer neurologischen Klinik. Teilnehmer: Aerzte, Therapeuten, Pflegekraefte oder Verwaltung.

${MEETING_RULES}
- Der Teil kann mitten im Satz beginnen; transkribiere ab dem ersten verstaendlichen Wort und markiere den Anfang mit [Schnitt].

Gib exakt folgendes Markdown zurueck (keine Frontmatter, keine Wiederholung des Titels), nichts davor, nichts danach:

## Entscheidungen (Teil 2)
<Nur woertlich ausgesprochene Entscheidungen als Bullets. Sonst: "Keine.">

## Offene Punkte / Todos (Teil 2)
<Nur woertlich ausgesprochene Auftraege als "- [ ] Wer? Was? Bis wann?". Sonst: "Keine.">

## Transkript (Teil 2 — Minute ca. ${startMin} bis ${endMin})
<vollstaendiges Transkript nach obigen Regeln>`;
}
