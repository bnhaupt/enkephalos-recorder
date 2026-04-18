# Voice Pipeline — Stand 2026-04-18 (Pixel live)

Kurzer Einstieg, um nach Pause weiterzumachen.

## Was laeuft

**Phase 1 — UI-Shell + IndexedDB** [fertig]
- Drei Screens (Home, Meeting, Idee), Hash-Router, History-Liste.
- IndexedDB `enkephalos-recorder`, Stores `config` + `recordings`.
- Platzhalter-Icons (192/512, Buchstabe E).

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

### Laptop-Drive-Sync (manuelle Einrichtung)
- **Google Drive Desktop** auf dem Samsung-Laptop installieren (Mirror-Modus), mit demselben Google-Account wie in der PWA.
- **`scripts/sync-inbox.ps1`** existiert. Pfade `$DriveInbox` und `$VaultInbox` oben anpassen, einmal manuell testen.
- Optional: Task Scheduler alle 5 Min (Anleitung in `docs/laptop-sync.md §3`).

### Phase 5 — Polish (reihenfolge nach Impact)
1. **Chunk-Upload + Auto-Split fuer Meetings >30 Min** — Qualitaet + Recovery bei Netz-Drop. Grosster funktionaler Gewinn.
2. **Recovery bei App-Reload waehrend Aufnahme** — IndexedDB-Chunks beim Start pruefen.
3. **Setup-Wizard beim ersten Start** — `prompt()`-Kette durch 3-Schritt-Flow ersetzen.
4. **Offline-Queue mit Reconnect + Backoff** — fuer unzuverlaessiges WLAN in der Klinik.
5. **Update-Prompt bei neuem Service-Worker** — statt Auto-Reload.

### Pixel-Deployment [fertig 2026-04-18]
- Repo: https://github.com/bnhaupt/enkephalos-recorder (public)
- GitHub Pages: `main` / `/ (root)`, Live-URL https://bnhaupt.github.io/enkephalos-recorder/
- Root-`index.html` leitet per Meta-Refresh nach `./pwa/` (Pages erlaubt nur `/` oder `/docs`, kein `/pwa`).
- OAuth-Origin `https://bnhaupt.github.io` ist im Google-Cloud-Client hinterlegt.
- Auf dem Pixel installiert und laeuft.

## Zentrale Datei-Map

```
pwa/
├── index.html       # 3 Screens + Titel-Modal + Markdown-Modal + Drive-Banner
├── app.js           # View-Router, IDB, Lifecycle, Transkription, Upload
├── recorder.js      # MediaRecorder + Silence-Detection
├── gemini.js        # Files API + generateContent + Prompts
├── drive.js         # OAuth + Folder + Multipart-Upload + Slug
├── sw.js            # v8, Network-First auf localhost, Cache-First auf Produktion
├── styles.css
├── manifest.json
└── icon-192.png, icon-512.png  # Platzhalter
scripts/
└── sync-inbox.ps1   # Laptop-Sync (noch zu aktivieren)
docs/                # Setup-Anleitungen (alle fertig)
```

## Entschiedene Design-Punkte (nicht aus dem Code erkennbar)

- **Keine config.js-Datei** — alle Keys kommen via IndexedDB `config`-Store (ueber `prompt()` beim ersten Bedarf). `config.example.js` dient nur als Default-Referenz fuer die Konstanten in `app.js`.
- **Drive-Ordner per App erzeugt**, nicht manuell. Grund: `drive.file`-Scope sieht nur selbst erzeugte Dateien. Falls User den Ordner bereits manuell anlegte: umbenennen oder loeschen, sonst entstehen zwei gleichnamige.
- **Testing-Status des OAuth-Consents bleibt** (7-Tage-Token). Production-Review fuer `drive.file`-Scope wurde bewusst vermieden.
- **Service Worker Network-First auf `localhost`/`127.0.0.1`**, sonst Cache-First. So aktualisiert sich die Dev-App ohne Clear-Site-Data.
- **Controller-Change triggert Auto-Reload** — neue SW-Version uebernimmt ohne manuellen Hard-Reload.

## Wo weitermachen

Nach Pause an einer dieser Stellen ansetzen:

- **„Drive-Desktop-Sync abschliessen"** (manueller Schritt, ca. 10 Min) — dann ist der End-to-End-Flow bis ins Vault geschlossen.
- **„Phase 5 #1 Chunk-Upload fuer Meetings >30 Min"** (~200 Zeilen, in `recorder.js` + `gemini.js`) — Qualitaetsschub fuer lange Termine.

Lokaler Dev-Server laeuft auf `http://127.0.0.1:8765/pwa/` (Python static server).
Produktiv: https://bnhaupt.github.io/enkephalos-recorder/ (auf `main` pushen deployed automatisch).
