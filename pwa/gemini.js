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

const GENERATION_CONFIG = {
  temperature: 0.2,
  topP: 0.95,
  maxOutputTokens: 8192,
  responseMimeType: "text/plain",
};

async function readErr(res) {
  try {
    const txt = await res.text();
    return txt.slice(0, 600);
  } catch {
    return "";
  }
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

export async function generateContent(apiKey, model, file, promptText) {
  const url =
    `${BASE}/v1beta/models/${encodeURIComponent(model)}:generateContent` +
    `?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [
      {
        parts: [
          { file_data: { file_uri: file.uri, mime_type: file.mimeType } },
          { text: promptText },
        ],
      },
    ],
    generationConfig: GENERATION_CONFIG,
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
  const parts = candidate.content?.parts || [];
  const text = parts.map((p) => p.text || "").join("");
  if (!text.trim()) throw new Error("Leere Transkript-Antwort");
  return text;
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
  return `Du bekommst eine kurze deutschsprachige Sprachnotiz (meist unter 2 Minuten). Der Sprecher ist Klinikdirektor, Neurologe und Geriater. Der Inhalt ist typischerweise eine fluechtige Idee, ein Gedanke, eine Erinnerung, eine To-do-Notiz oder eine Beobachtung.

Metadaten:
${buildMetaBlock(meta)}

Deine Aufgabe:
1. Transkribiere woertlich. Medizinische Fachbegriffe korrekt setzen.
2. Erstelle ein strukturiertes Markdown mit folgendem Aufbau:

---
type: voice-capture
kind: idea
captured: ${meta.isoTimestamp}
duration_sec: ${secs}
transcription_model: gemini-2.5-flash
---

# Idee ${human}

## Transkript
<Woertliches Transkript>

## Worum geht es
<Ein Satz, maximal zwei>

## Moegliche Verortung im Vault
<Vorschlag: wiki/entities/..., projects/..., areas/..., nur wenn aus dem Inhalt ableitbar. Sonst: "Unklar, beim Ingest entscheiden".>

Gib ausschliesslich das Markdown zurueck, keine Umschweife.`;
}

export function buildMeetingPrompt(meta) {
  const secs = Math.round(meta.durationSec);
  const title = meta.title || fmtDe(meta.isoTimestamp);
  return `Du bekommst eine deutschsprachige Meeting-Aufnahme (bis 60 Min). Teilnehmer sind typischerweise Aerzte, Therapeuten, Pflegekraefte, oder administratives Personal einer neurologischen Klinik.

Metadaten:
${buildMetaBlock(meta)}

Deine Aufgabe:
1. Transkribiere mit Sprecher-Unterscheidung (Sprecher 1, Sprecher 2 etc.), wenn akustisch trennbar. Sonst durchgehend. Medizinische Fachbegriffe korrekt.
2. Erstelle ein strukturiertes Markdown:

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
<2-4 Saetze Kernthema und wichtigste Ergebnisse>

## Teilnehmer (soweit erkennbar)
- Sprecher 1: <falls benannt im Gespraech>
- Sprecher 2: ...

## Entscheidungen
- <Jede getroffene Entscheidung als Bullet>

## Offene Punkte / Todos
- [ ] <Wer?> <Was?> <Bis wann, falls genannt?>

## Transkript
<Vollstaendiges Transkript mit Sprecherzuordnung>

Gib ausschliesslich das Markdown zurueck.`;
}
