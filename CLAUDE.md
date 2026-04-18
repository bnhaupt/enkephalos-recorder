# Voice Pipeline — Projekt-Briefing fuer Claude Code

**Du baust eine Progressive Web App (PWA) fuer das Pixel 7 Pro, die zwei Arten von Sprachaufnahmen erfasst, sie mit Gemini 2.5 Flash transkribiert und strukturiert, und die fertigen Markdown-Dateien via Google Drive ins Enkephalos-Vault des Nutzers einspeist.**

Der Nutzer ist Klinikdirektor Neurologie/Geriatrie, Professor. Kontext: Deutsch, medizinisch, EU/DSGVO.

---

## Ziel-Architektur

```
Pixel 7 Pro (PWA)        →   Gemini 2.5 Flash API   →   Google Drive    →   Samsung Laptop
- Aufnahme WebMediaRec       - Transkription            - /Enkephalos-      - Google Drive Desktop
- Zwei Modi                  - Strukturierung             Inbox/              synct lokal
- Direkt-Upload              - Markdown-Output          - Fertige .md-      - Optional: Skript
                                                          Dateien             verschiebt nach
                                                                              Enkephalos/inbox/
```

**Kein Backend.** Keine serverseitige Komponente. Das Pixel spricht direkt mit Gemini und Google Drive. Der Laptop ist nur Sync-Ziel, keine Verarbeitung.

---

## Projektstruktur

```
voice-pipeline/
├── CLAUDE.md                   # Dieses Dokument
├── README.md                   # Nutzer-Setup-Anleitung
│
├── pwa/                        # Die Pixel-App (das Kernstueck)
│   ├── index.html              # Einstieg, UI
│   ├── app.js                  # Aufnahme-Logik, API-Calls
│   ├── styles.css              # Dark-Theme, mobile-first
│   ├── sw.js                   # Service Worker fuer Offline/Install
│   ├── manifest.json           # PWA-Manifest
│   └── config.example.js       # Template fuer API-Keys
│
└── docs/
    ├── setup-gemini.md         # Google Cloud, API-Key, Safety Settings
    ├── setup-drive.md          # OAuth Client ID, Scopes
    ├── install-pixel.md        # PWA auf Pixel installieren
    └── laptop-sync.md          # Google Drive Desktop + optional Move-Skript
```

---

## Technische Randbedingungen

### Hardware/Software des Nutzers
- **Pixel 7 Pro** (Android 14+, Chrome als PWA-Host)
- **Samsung Laptop**, Windows, keine GPU, Google Drive Desktop installiert
- **Enkephalos-Vault** liegt lokal auf dem Laptop unter `C:\Users\<user>\...\Enkephalos\` (genauer Pfad kommt vom Nutzer im Setup)

### APIs
- **Gemini 2.5 Flash** via `generativelanguage.googleapis.com` (nicht Vertex AI — der Konsumenten-Endpunkt reicht, ist einfacher einzurichten)
- **Google Drive API v3** fuer Upload der fertigen .md-Dateien
- **OAuth 2.0** fuer Drive, API-Key fuer Gemini (Gemini unterstuetzt beide; fuer minimalen Setup API-Key nehmen)

### Sprachmodus
- Aufnahmen sind **deutsch**, medizinisch-klinisch. System-Prompts an Gemini explizit Deutsch formulieren.

---

## UI-Spezifikation der PWA

### Bildschirm 1: Hauptansicht

```
┌─────────────────────────────┐
│  Enkephalos Recorder        │
├─────────────────────────────┤
│                             │
│      ┌───────────────┐      │
│      │               │      │
│      │  KURZE IDEE   │      │   ← Tap = sofort Aufnahme,
│      │               │      │     Auto-Stop nach 3s Stille,
│      └───────────────┘      │     Max 2 Min
│                             │
│      ┌───────────────┐      │
│      │               │      │
│      │   MEETING     │      │   ← Tap = Aufnahme-Screen,
│      │               │      │     Start/Stop, Timer
│      └───────────────┘      │
│                             │
├─────────────────────────────┤
│  Zuletzt:                   │
│  ✓ 14:32 Idee · 0:42        │   ← Status: pending|uploading|
│  ⟳ 13:15 Meeting · 34:12    │     transcribing|done|error
│  ✓ 09:00 Idee · 1:15        │
└─────────────────────────────┘
```

### Bildschirm 2: Meeting-Aufnahme

```
┌─────────────────────────────┐
│  ← Zurueck                  │
├─────────────────────────────┤
│                             │
│         ● REC               │
│                             │
│        34:12                │   ← grosser Timer
│                             │
│     ▁▂▃▅▆▅▃▂▁▂▃▅▆▅▃▂        │   ← Waveform oder Pegelmeter
│                             │
│   ┌───────────────────┐     │
│   │     STOPP         │     │
│   └───────────────────┘     │
│                             │
├─────────────────────────────┤
│  Bildschirm darf dunkel,    │
│  aber nicht aus.            │
└─────────────────────────────┘
```

Nach Stopp: Modal "Titel?" — einzeiliger Textinput, optional. Default = Zeitstempel.

### Bildschirm 3: Kurze-Idee-Aufnahme

Minimal. Nur ein Pulsating-Indicator und ein Abbrechen-Button. Auto-Stopp. Modal entfaellt.

### Design-Prinzipien
- **Dark mode default** (Klinikumgebung, spaete Stunden, Batterieschonung OLED).
- **Grosse Touch-Targets** (min. 64px, auch mit Handschuhen bedienbar).
- **Kein Login-Screen** nach erstem Auth. OAuth-Token persistiert.
- **Keine unnoetigen Uebergaenge oder Animationen** ausser Statusindikator.
- **Keine Emojis** in UI-Texten.

---

## Verarbeitungslogik

### Kurze Idee
1. User tippt "KURZE IDEE" → sofort MediaRecorder start
2. Silence-Detection: RMS-Schwelle ueberpruefen, 3s unter Schwelle = Stop
3. Bei Stop oder Max 2 Min:
   - Audio als `webm` oder `mp4` Blob
   - Gemini-Call: siehe Prompt-Template unten (Mode: `idea`)
   - Resultat (Markdown) an Drive hochladen
   - UI-Status aktualisieren

### Meeting
1. User tippt "MEETING" → Aufnahme-Screen
2. Start/Stop explizit
3. **Chunk-Upload:** alle 60s den bisher aufgenommenen Blob via Gemini Files API hochladen (Recovery bei Crash). Alternative fuer v1: erst am Ende hochladen, einfacher.
4. Bei Stop:
   - Titel-Prompt
   - Wenn Audio > 30 Min: automatisch splitten in 2 Haelften fuer Gemini (Kontextlaengen-Pragmatik)
   - Gemini-Call mit Mode: `meeting`
   - Resultat an Drive

### Gemini-Prompt-Templates

**Mode `idea`:**
```
Du bekommst eine kurze deutschsprachige Sprachnotiz (meist unter 2 Minuten).
Der Sprecher ist Klinikdirektor, Neurologe und Geriater. Der Inhalt ist
typischerweise eine fluechtige Idee, ein Gedanke, eine Erinnerung, eine
To-do-Notiz oder eine Beobachtung.

Deine Aufgabe:
1. Transkribiere woertlich. Medizinische Fachbegriffe korrekt setzen.
2. Erstelle ein strukturiertes Markdown mit folgendem Aufbau:

---
type: voice-capture
kind: idea
captured: <ISO-8601 Zeitstempel aus den Metadaten>
duration_sec: <Dauer>
transcription_model: gemini-2.5-flash
---

# Idee <Zeitstempel lesbar>

## Transkript
<Woertliches Transkript>

## Worum geht es
<Ein Satz, maximal zwei>

## Moegliche Verortung im Vault
<Vorschlag: wiki/entities/..., projects/..., areas/...,
 nur wenn aus dem Inhalt ableitbar. Sonst: "Unklar, beim Ingest entscheiden".>

Gib ausschliesslich das Markdown zurueck, keine Umschweife.
```

**Mode `meeting`:**
```
Du bekommst eine deutschsprachige Meeting-Aufnahme (bis 60 Min).
Teilnehmer sind typischerweise Aerzte, Therapeuten, Pflegekraefte, oder
administratives Personal einer neurologischen Klinik.

Deine Aufgabe:
1. Transkribiere mit Sprecher-Unterscheidung (Sprecher 1, Sprecher 2 etc.),
   wenn akustisch trennbar. Sonst durchgehend. Medizinische Fachbegriffe korrekt.
2. Erstelle ein strukturiertes Markdown:

---
type: voice-capture
kind: meeting
captured: <ISO-8601>
duration_sec: <Dauer>
title: <Titel vom Nutzer, oder Zeitstempel>
transcription_model: gemini-2.5-flash
---

# Meeting: <Titel>

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

Gib ausschliesslich das Markdown zurueck.
```

---

## Dateiablage

### Auf dem Pixel (PWA)
- IndexedDB als lokaler Puffer fuer Uploads, die scheitern (WLAN weg)
- Auto-Retry bei naechster Session

### In Google Drive
- Ordner: `/Enkephalos-Inbox/` (muss existieren, Setup-Schritt)
- Dateiname:
  - Idee: `JJJJMMTT-HHMMSS-idee.md`
  - Meeting: `JJJJMMTT-HHMMSS-meeting-<slug>.md` (slug = kebab-case aus Titel)
- Audio-Original: **nicht** in Drive speichern. Gemini bekommt es ephemer via Files API, danach wird es gelöscht.

### Auf dem Laptop
- Google Drive Desktop synct `/Enkephalos-Inbox/` lokal
- **Optional:** Ein Windows-Powershell-Skript verschiebt neue .md-Dateien aus dem Drive-Sync-Ordner nach `<Enkephalos>/inbox/`. Kann als geplanter Task alle 5 Min laufen, oder manuell beim Arbeitsstart.
- V1: manuell kopieren reicht. Automatisierung ist Nice-to-have fuer v2.

---

## Auth-Flow

**Einmal beim ersten Start der PWA:**
1. Google OAuth 2.0 Popup: Nutzer waehlt Google-Account
2. Scope: `https://www.googleapis.com/auth/drive.file` (nur Dateien, die diese App erstellt — keine Zugriff auf andere Drive-Inhalte)
3. Token + Refresh-Token in IndexedDB speichern
4. Bei Expiry automatisch refreshen

**Gemini API-Key:**
- Bei erstem Start einmalig abfragen und in IndexedDB speichern
- Keine Weitergabe, bleibt lokal im Browser

---

## Implementierungsreihenfolge fuer Claude Code

Arbeite in dieser Reihenfolge, weil jede Phase die naechste testbar macht:

1. **Phase 1 — Gerust + UI-Shell:** Statisches HTML/CSS, zwei Buttons, Navigations-Logik zwischen den drei Bildschirmen, IndexedDB-Setup fuer Config. Installierbar als PWA.

2. **Phase 2 — Aufnahme lokal:** MediaRecorder-API, Kurze-Idee-Modus mit Silence-Detection, Meeting-Modus mit Start/Stop/Timer. Blob in IndexedDB speichern. Liste der Aufnahmen im UI anzeigen. Noch keine API-Calls.

3. **Phase 3 — Gemini-Integration:** Files API fuer Audio-Upload, generateContent-Call mit Prompt-Template. Parse Markdown aus Response. Anzeige im UI (oder Drei-Punkte-Menu mit "Transkript anzeigen").

4. **Phase 4 — Drive-Upload:** OAuth, Upload der .md in `/Enkephalos-Inbox/`. Status-Icons. Retry-Logik.

5. **Phase 5 — Polish:** Chunk-Upload bei Meetings >30 Min, Recovery bei App-Reload waehrend Aufnahme, Fehlerbehandlung, Setup-Wizard beim ersten Start.

Nach Phase 3 ist die App theoretisch nutzbar (Transkript einfach copy-paste). Nach Phase 4 ist sie vollstaendig. Phase 5 ist Haerteln.

---

## Was ausdruecklich NICHT in v1 gehoert

- Keine Editier-Funktion fuer Transkripte in der App
- Keine Tags, keine Kategorisierung in der App — das macht Claude Cowork beim Ingest
- Keine Suche in vergangenen Aufnahmen
- Keine Mehrsprachigkeit (nur Deutsch)
- Keine Android-native App, keine Kotlin-Zeile
- Kein lokales Whisper auf dem Laptop
- Keine serverseitige Komponente irgendeiner Art

---

## Risiken und Limitierungen

- **Chrome Background Tab Throttling:** Bei Bildschirm aus und Tab im Hintergrund kann die Aufnahme nach einigen Minuten suspendiert werden. Mitigation: Screen Wake Lock API anfordern, Bildschirm darf dunkel, aber nicht aus.
- **Gemini-Kontextlaengen:** 1h Audio = ca. 100k Tokens. Flash kann das, aber bei maximaler Laenge sinkt die Qualitaet am Ende. Daher Auto-Split bei >30 Min.
- **OAuth-Token-Expiry:** Google-Tokens halten ~1h. Refresh-Token-Flow muss sauber implementiert sein, sonst muss der Nutzer staendig neu einloggen.
- **Mikrofonqualitaet des Pixel** in groesseren Besprechungsraeumen kann schwach sein. Fuer v1 akzeptabel, fuer v2 eventuell externes Mic via USB-C.

---

## Nutzerpraeferenzen

- Kommunikation: Deutsch, professionell, praezise, executive-level
- Keine Buzzwords, kein Coaching-Ton
- Iteratives Arbeiten, klaerende Fragen zuerst stellen, wenn unklar
- Bei technischen Entscheidungen: Optionen aufzeigen, dann empfehlen

Bei Unsicherheit im Verlauf: **nachfragen, nicht raten.**
