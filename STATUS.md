# Voice Pipeline — Stand 2026-04-18 (produktiv, Phase 5 bewusst zurueckgestellt)

Kurzer Einstieg, um nach Pause weiterzumachen.

## Was laeuft

**Phase 1 — UI-Shell + IndexedDB** [fertig]
- Drei Screens (Home, Meeting, Idee), Hash-Router, History-Liste.
- IndexedDB `enkephalos-recorder`, Stores `config` + `recordings`.
- Icon: stilisiertes Frauengesicht in Claude-Coral, „Claudia"-Schriftzug. Quelle unter `assets/claudia-icon-source.png`, Skalierung auf 192/512 via `scripts/make-icons.py` (bzw. direktes Resize aus der Quelle).
- App-Name im Manifest: `Claudia` (name und short_name) — erscheint so auf dem Pixel-Homescreen.

**Phase 2 — Aufnahme lokal** [fertig]
- `pwa/recorder.js`: MediaRecorder + RMS-Level via Web-Audio.
- Idee: Auto-Stopp nach 3s Stille oder 2 Min, Speech-Gate.
- Meeting: Timer, Live-Pegelmeter-Waveform, Titel-Modal mit Kategorien-Dropdown.
- Dropdown-Optionen (werden als `rec.title` gespeichert): `jf Abteilungsleiter`, `jf Oberaerzte-Reha`, `jf Oberaerzte-Akut`, `jf Therapien, Therapieplanung und Controlling`, `jf Klinikleitung-Interdisziplinaer`, `jf Klinikleitung-Aerzte`, `jf Personal`, `jf SKAI-Team`, `jf Tagesklinik`, `jf Geschaeftsfuehrung`, `Sonstiges Meeting`. Letzte Auswahl wird in `config` persistiert (Key `last_meeting_category`).

**Phase 3 — Gemini 2.5 Flash** [fertig]
- `pwa/gemini.js`: Files API resumable upload, Poll bis ACTIVE, `generateContent`, DELETE. Prompts auf deutsch per `CLAUDE.md`-Template.
- API-Key per `prompt()` einmalig, gespeichert in `config[gemini_api_key]`.
- Safety `BLOCK_ONLY_HIGH`, temp 0.2.
- Status-Fluss `pending → transcribing → uploading`.

**Phase 4 — Google Drive Upload** [fertig]
- `pwa/drive.js`: GIS-Token-Client, `drive.file`-Scope, Folder find-or-create, Multipart-Upload.
- Client-ID per `prompt()` einmalig, in `config[drive_client_id]`.
- Token in `config[drive_token]` (expires ~1h), Folder-ID in `config[drive_folder_id]`.
- Dateinamen: `YYYYMMDD-HHMMSS-idee.md` bzw. `YYYYMMDD-HHMMSS-meeting-<slug>.md`.
- Banner-Flow (zweistufig): 1. Tap speichert Client-ID, 2. Tap oeffnet OAuth-Popup — notwendig wegen Chrome-Popup-Blocker / User-Gesture-Verbrauch durch `prompt()`.
- Retry-Queue im Markdown-Modal (Upload-Retry oder Transkriptions-Retry je nach Fehlerstelle).

## Was noch offen ist

### Laptop-Drive-Sync [fertig 2026-04-18]
- **rclone** statt Google Drive Desktop (Drive Desktop konfligiert mit OneDrive auf demselben Dateisystem).
- `rclone.exe` via winget installiert, Remote `gdrive` via OAuth konfiguriert (Token in `%APPDATA%\rclone\rclone.conf`).
- `scripts/sync-inbox.ps1` ruft `rclone move gdrive:Enkephalos-Inbox → %USERPROFILE%\OneDrive\Enkephalos\inbox --include "*.md"` auf.
- Task Scheduler `"Enkephalos Inbox Sync"` laeuft alle 5 Min im Hintergrund (registriert via `scripts/install-task.cmd`).
- End-to-End getestet: 6 Bestandsaufnahmen sowie eine Dummy-Datei wurden korrekt ins Vault verschoben, Drive-Originale geloescht.

### Phase 5 — Polish [bewusst zurueckgestellt am 2026-04-18]

Entscheidung des Nutzers: App laeuft, Phase 5 ist kein Blocker. Erst angehen, wenn real ein Problem auftritt (verlorene Aufnahme, schlechte Qualitaet am Ende langer Meetings, umstaendliches Onboarding fuer andere Nutzer).

**Wiederaufnahme-Trigger pro Punkt:**

1. **Chunk-Upload + Auto-Split fuer Meetings >30 Min** — trigger: Nutzer meldet, dass Transkript am Ende langer Termine unsauber wird, oder Aufnahme wird von Chrome unterbrochen (Background-Throttling / Akku). ~200 Zeilen in `recorder.js` + `gemini.js`. Besteht aus zwei Teil-Scopes:
   - *Chunk-Recovery*: `MediaRecorder({ timeslice: 60000 })`, Chunks in neuen IDB-Store `recording_chunks` persistieren, beim App-Start auf unvollstaendige Aufnahme pruefen.
   - *Auto-Split*: Bei 30 Min Timer aktiven Recorder stoppen, neuen starten. Zwei Gemini-Calls + Consolidation-Call fuer das Merged-Markdown.
2. **Recovery bei App-Reload waehrend Aufnahme** — trigger: Nutzer meldet, dass eine laufende Aufnahme verloren ging. IndexedDB-Chunks beim Start pruefen (greift in Punkt 1).
3. **Setup-Wizard beim ersten Start** — trigger: Zweiter Nutzer kommt dazu, `prompt()`-Kette ist zu sperrig. 3-Schritt-Flow mit echten Formularen.
4. **Offline-Queue mit Reconnect + Backoff** — trigger: Aufnahmen haengen regelmaessig auf `error` wegen Klinik-WLAN. Aktuell deckt der Retry-Button im Markdown-Modal den Einzelfall.
5. **Update-Prompt bei neuem Service-Worker** — trigger: Auto-Reload beim SW-Update stoert im Alltag (Flash). Ersatz durch „Update verfuegbar"-Banner.

**Wenn der Nutzer zurueckkommt mit „wir wollten an Phase 5 weitermachen":** Ersten Trigger-Grund erfragen (was ist konkret passiert?), dann passenden Punkt aus der Liste anwaehlen. Nicht alles auf einmal.

### Pixel-Deployment [fertig 2026-04-18]
- Repo: https://github.com/bnhaupt/enkephalos-recorder (public)
- GitHub Pages: `main` / `/ (root)`, Live-URL https://bnhaupt.github.io/enkephalos-recorder/
- Root-`index.html` leitet per Meta-Refresh nach `./pwa/` (Pages erlaubt nur `/` oder `/docs`, kein `/pwa`).
- OAuth-Origin `https://bnhaupt.github.io` ist im Google-Cloud-Client hinterlegt.
- Auf dem Pixel installiert und laeuft.

## Bei Problemen

`docs/troubleshooting.md` — Schnell-Checks pro Pipeline-Stufe, Key/Token-Landkarte, haeufige Fehlerbilder, Reset-Pfade.

## Zentrale Datei-Map

```
pwa/
├── index.html       # 3 Screens + Titel-Modal + Markdown-Modal + Drive-Banner
├── app.js           # View-Router, IDB, Lifecycle, Transkription, Upload
├── recorder.js      # MediaRecorder + Silence-Detection
├── gemini.js        # Files API + generateContent + Prompts
├── drive.js         # OAuth + Folder + Multipart-Upload + Slug
├── sw.js            # v9, Network-First auf localhost, Cache-First auf Produktion
├── styles.css
├── manifest.json    # name/short_name = "Claudia"
└── icon-192.png, icon-512.png  # Claudia-Icon (Quelle in assets/)
assets/
└── claudia-icon-source.png  # 1024px, vom Nutzer geliefert
scripts/
├── sync-inbox.ps1      # rclone move aus gdrive:Enkephalos-Inbox ins Vault
├── install-task.cmd    # registriert Scheduled Task "Enkephalos Inbox Sync"
└── make-icons.py       # PIL-Fallback fuer Icons (Quelle manuell ersetzbar)
docs/                   # Setup-Anleitungen + troubleshooting.md
```

## Entschiedene Design-Punkte (nicht aus dem Code erkennbar)

- **Keine config.js-Datei** — alle Keys kommen via IndexedDB `config`-Store (ueber `prompt()` beim ersten Bedarf). `config.example.js` dient nur als Default-Referenz fuer die Konstanten in `app.js`.
- **Drive-Ordner per App erzeugt**, nicht manuell. Grund: `drive.file`-Scope sieht nur selbst erzeugte Dateien. Falls User den Ordner bereits manuell anlegte: umbenennen oder loeschen, sonst entstehen zwei gleichnamige.
- **Testing-Status des OAuth-Consents bleibt** (7-Tage-Token). Production-Review fuer `drive.file`-Scope wurde bewusst vermieden.
- **Service Worker Network-First auf `localhost`/`127.0.0.1`**, sonst Cache-First. So aktualisiert sich die Dev-App ohne Clear-Site-Data.
- **Controller-Change triggert Auto-Reload** — neue SW-Version uebernimmt ohne manuellen Hard-Reload.

## Wo weitermachen

Aktuell: **nirgends** — alle Pipeline-Schritte produktiv, Icon/Branding fertig, Phase 5 bewusst zurueckgestellt (siehe oben).

Wenn der Nutzer zurueckkommt:
- Bei konkretem Problem → `docs/troubleshooting.md`, Schnell-Check pro Pipeline-Stufe.
- Bei „Phase 5 weitermachen" → Trigger-Grund aus dem Abschnitt oben klaeren, passenden Punkt waehlen.

Lokaler Dev-Server: `http://127.0.0.1:8765/pwa/` (Python static server).
Produktiv: https://bnhaupt.github.io/enkephalos-recorder/ (`main` pushen deployed automatisch).
