# Setup: Gemini API

## 1. Google Cloud Projekt

1. Gehe zu https://aistudio.google.com/app/apikey
2. Melde dich mit deinem Google-Account an (am besten derselbe, den du fuer Drive nutzt)
3. Klick auf "Create API Key" → "Create API key in new project"
4. Kopiere den Key (sieht aus wie `AIzaSyD...`)

## 2. Key sicher ablegen

**Empfehlung:** Den Key nicht in den Quellcode committen, sondern beim ersten Start der PWA einmalig eingeben — die App speichert ihn dann in IndexedDB (nur auf dem Pixel, geht nicht woanders hin).

Fuer lokale Entwicklung kannst du `pwa/config.example.js` als `pwa/config.js` kopieren und den Key eintragen. `config.js` ist in `.gitignore`.

## 3. Quota pruefen

Der kostenlose Gemini-Tier reicht fuer dein Nutzungsprofil deutlich aus:
- Flash: 1.500 Requests pro Tag kostenlos
- Pro 1 Stunde Meeting: 1 Request (inkl. Transkription)
- Pro Idee: 1 Request

Bei Dauernutzung (z.B. taeglich 5+ Meetings) kann es sinnvoll sein, auf den bezahlten Tier umzustellen. Kosten pro Meeting liegen im einstelligen Cent-Bereich.

## 4. Modell-Parameter in der PWA

Standard-Einstellung in `app.js`:

```javascript
const generationConfig = {
  temperature: 0.2,          // Konservativ, wenig Halluzination
  topP: 0.95,
  maxOutputTokens: 8192,
  responseMimeType: "text/plain"
};
```

Bei Bedarf `temperature` weiter runter (z.B. 0.1), wenn Transkripte zu "kreativ" werden.

## 5. Safety Settings

Medizinische Inhalte koennen Gemini-Safety-Filter triggern ("Verletzungen", "Medikamente"). In der PWA explizit alle Safety-Kategorien auf `BLOCK_ONLY_HIGH` setzen:

```javascript
const safetySettings = [
  { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_ONLY_HIGH" },
  { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_ONLY_HIGH" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" }
];
```

## 6. Region/Datenschutz

Wichtig fuer DSGVO-Kontext: Die Consumer-Gemini-API (`generativelanguage.googleapis.com`) speichert Prompts standardmaessig zur Modellverbesserung. Wenn das ein Problem ist, stattdessen **Vertex AI Gemini** nutzen (mehr Setup, aber Daten bleiben kundenseitig). Fuer v1 mit nicht-patientenbezogenen Inhalten ist die Consumer-API akzeptabel.

**Faustregel:** Keine unpseudonymisierten Patientendaten ueber diese Pipeline. Meetings, die konkrete Patienten betreffen, nicht ueber diese App — oder vorher Pseudonymisierung im Postprocessing.
