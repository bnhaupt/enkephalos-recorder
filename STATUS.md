# Voice Pipeline — was laeuft

Zustandsbeschreibung, keine Chronik. **Wann etwas warum geaendert wurde,
steht im `git log`** (`git log --oneline`, bei Bedarf `git log -S "<Symbol>"`,
um die Herkunft einer Zeile zu finden). Dieses Dokument beantwortet nur:
Was ist da, wie greift es ineinander, was ist bewusst nicht da.

---

## Die vier Wege ins Vault

Alles endet in `Enkephalos/inbox/`. Der Ingest ins eigentliche Vault ist
Handarbeit im Dialog und ausdruecklich nicht Teil dieser Pipeline.

| Weg | Erfassung | Verarbeitung | Drive-Ordner |
|---|---|---|---|
| **Notiz** | Pixel, ein Tap, Auto-Stopp nach 3 s Stille oder 2 Min | Gemini, inline | `Enkephalos-Inbox` |
| **Meeting** | Pixel, Start/Stopp, danach Kategorie + Zusatz + Teilnehmer, Deckel 65 Min | Gemini, Files API | `Enkephalos-Inbox` |
| **Auftrag** | Pixel, diktiert, Auto-Stopp nach 5 s Stille oder 5 Min | Gemini strukturiert, **Claude Code headless auf dem Laptop erledigt ihn** | `Enkephalos-Auftraege` |
| **Handschrift** | reMarkable, Export nach Drive | **Claude Code headless** liest die PDF | `Enkephalos-Handschrift` |

Die ersten drei laufen ueber die PWA ("Claudia") auf dem Pixel, der vierte
komplett ohne sie. Details: `docs/auftrag-modus.md`,
`docs/remarkable-integration.md`.

---

## PWA (`pwa/`)

**Startbildschirm:** Historie oben (wird gelesen), Bedienung unten in der
Daumenzone (wird beruehrt). Notiz als grosser Ring, Meeting und Auftrag als
Pills daneben. Dark-Theme, keine Emojis, keine Animationen ausser dem
Statusindikator.

**Aufnahme** (`recorder.js`): MediaRecorder + RMS-Pegel per Web-Audio.
Meeting nimmt mit 96 kbps und **abgeschalteter** Rauschunterdrueckung /
AGC / Echo-Cancellation auf — das erhaelt Sprecher-Cues und leise Stimmen.
Notiz und Auftrag mit 32 kbps und eingeschalteter Aufbereitung.

**Transkription** (`gemini.js`): `gemini-2.5-flash`, `temperature 0`,
Safety durchgaengig `BLOCK_ONLY_HIGH`. Kurze Aufnahmen laufen inline
(1 Request), Meetings ueber die Files API. Prompts sind deutsch und tragen
einen verbindlichen Anti-Halluzinations-Block: nichts erfinden,
`[unverstaendlich]` statt raten, "Keine." statt Ausfuellzwang bei
Entscheidungen und Todos. Meeting bekommt `thinkingBudget: -1` und
`maxOutputTokens: 65536` (Diarisierung und Themen-Synthese sind
Reasoning-Aufgaben), die kurzen Modi `thinkingBudget: 0`.

**Ein Meeting = ein Request, unabhaengig von der Laenge.** Flash fasst rund
eine Stunde. Es gibt bewusst keinen Split (siehe "Bewusst nicht da").

**JF-Zuordnung:** Meeting-Kategorien mit `jf `-Praefix erzeugen
`kind: jf` + `jf_reihe: <slug>` + `quelle: claudia` in der Frontmatter —
dieselbe Konvention wie die Handschrift-Pipeline, damit beide Kanaele
derselben Sitzung beim Ingest zusammenfinden. Der Slug steht als
`data-jf-reihe` an der jeweiligen `<option>` in `index.html`; das Dropdown
ist die einzige Quelle der Wahrheit. `applyJfFrontmatter()` erzwingt den
Kopf nach der Transkription noch einmal deterministisch.

**Upload** (`drive.js`): GIS-Token-Client, Scope `drive.file`, Folder
find-or-create, Multipart. Client-ID hardcoded in `app.js`. Audio-Blobs
werden nach erfolgreichem Upload aus IndexedDB entfernt.

**Speicher:** IndexedDB `enkephalos-recorder`, Stores `config` und
`recordings`, mit `navigator.storage.persist()` gegen Chrome-Eviction.

---

## Laptop (`scripts/`)

Kein Google Drive Desktop — das konfligiert mit OneDrive auf demselben
Dateisystem. Stattdessen **rclone**, Remote `gdrive`, Token in
`%APPDATA%\rclone\rclone.conf`.

| Skript | Tut | Installer |
|---|---|---|
| `sync-inbox.ps1` | `rclone move` aus `gdrive:Enkephalos-Inbox` ins Vault | `install-task.cmd` |
| `process-auftraege.ps1` | Auftrag holen, Claude Code headless, Ergebnis in die Inbox | `install-auftrag-task.cmd` |
| `process-handschrift.ps1` | PDF holen, Claude Code headless, Ergebnis in die Inbox | `install-handschrift-task.cmd` |

Alle drei laufen als Scheduled Task alle 5 Minuten, fensterlos ueber
`../../run-hidden.vbs`.

**Die Startminuten sind gestaffelt und nicht beliebig.** Alle drei Tasks
teilen sich denselben rclone-OAuth-Token; gleichzeitige rclone-Laeufe
kollidieren, und der aufwendigere verliert:

| Minute | Task |
|---|---|
| `:00` | Enkephalos Handschrift |
| `:02` | Enkephalos Inbox Sync |
| `:04` | Enkephalos Auftraege |

Frei sind nur noch `:01` und `:03`, beide direkt neben einem bestehenden
Start. Ein vierter Task auf diesem Raster braucht eine andere Loesung.
Akku-Gating hat nur der Inbox Sync (sekundenkurzer Lauf); die beiden
Claude-Tasks laufen auch auf Akku weiter, weil ein Abschuss mittendrin
Laufzeit verbrennt und eine Sperrdatei hinterlaesst.

---

## Deployment

- Repo `bnhaupt/enkephalos-recorder` (public), GitHub Pages aus `main` / root.
- **`main` pushen deployed automatisch**, Live: https://bnhaupt.github.io/enkephalos-recorder/
- Root-`index.html` leitet per Meta-Refresh nach `./pwa/` (Pages erlaubt nur
  `/` oder `/docs`, kein `/pwa`).
- OAuth-Origin `https://bnhaupt.github.io` ist im Google-Cloud-Client hinterlegt.
- **Bei jeder Aenderung an `pwa/` das `CACHE_NAME` in `sw.js` hochzaehlen**,
  sonst zieht der Service Worker auf dem Pixel die alte Fassung.
- Lokaler Dev-Server: `http://127.0.0.1:8765/pwa/` (Python static server).
  `sw.js` faehrt dort Network-First, auf Produktion Cache-First.

---

## Bewusst nicht da

Nicht vergessen, sondern entschieden. Wer eines dieser Themen anfasst,
sollte den Grund kennen.

- **Kein Auto-Split langer Meetings.** Es gab einen; er schnitt den
  WebM-Container per Byte-Offset, die zweite Haelfte hatte keinen
  EBML-Header und war nicht dekodierbar — Datenverlust bei Meetings
  >30 Min. Ersatzlos entfernt. Falls je wieder noetig: sauberer
  Recorder-Neustart bei 30 Min, **nie wieder Blob-slice**.
- **Keine JF-Zuordnung im Notiz-Modus.** Die Trennlinie der Modi ist nicht
  kurz/lang, sondern "hat schon eine Heimat" (Meeting, mit Dropdown) gegen
  "hat noch keine" (Notiz). Ein Modal wuerde das Sprechen-und-Vergessen
  aufgeben; eine nachtraegliche Zuordnung scheitert am 5-Minuten-Fenster
  des Sync-Tasks. Ausfuehrlich in `docs/remarkable-integration.md`.
- **Keine frei tippbaren JF-Kategorien.** Eine Tippvariante wuerde die
  Sitzung stumm neben statt in ihre Reihe legen. Das Feld "Zusatz" ist
  Freitext und unkritisch — es beruehrt `jf_reihe` nicht.
- **Keine `config.js`.** Gemini-Key kommt per `prompt()` in den
  IndexedDB-`config`-Store, Drive-Client-ID ist hardcoded.
  `config.example.js` ist nur Referenz fuer die Konstanten in `app.js`.
- **Drive-Ordner werden von der App erzeugt**, nicht von Hand. Der
  `drive.file`-Scope sieht nur selbst erzeugte Dateien. Ein manuell
  angelegter Ordner gleichen Namens fuehrt zu zwei gleichnamigen und legt
  die Pipeline stumm lahm.
- **Kein Backend, kein lokales Whisper, keine native App.** Unveraendert
  aus `CLAUDE.md`.

---

## Zurueckgestellt (Phase 5) — mit Wiederaufnahme-Trigger

App laeuft; das hier ist kein Blocker. Jeder Punkt hat eine Bedingung, ab
der er sich lohnt. **Wenn es heisst "wir wollten an Phase 5 weitermachen":
erst fragen, was konkret passiert ist**, dann den passenden Punkt waehlen.
Nicht alles auf einmal.

| Punkt | Trigger |
|---|---|
| Chunk-Recovery (`timeslice: 60000`, Chunks in eigenem IDB-Store) | Eine laufende Aufnahme geht verloren — App-Reload, Chrome-Throttling, Akku |
| Sauberer 30-Min-Split per Recorder-Neustart | Transkript wird am Ende langer Termine unsauber |
| Setup-Wizard beim ersten Start | Ein zweiter Nutzer kommt dazu, die `prompt()`-Kette ist zu sperrig |
| Offline-Queue mit Reconnect + Backoff | Aufnahmen haengen regelmaessig auf `error` wegen Klinik-WLAN |
| Update-Banner statt Auto-Reload beim SW-Update | Der Reload-Flash stoert im Alltag |
| Silent-Token-Refresh, OAuth-Consent auf Production | Drive-Reauth nervt im Alltag |

---

## Wenn etwas klemmt

`docs/troubleshooting.md` — Schnell-Checks pro Pipeline-Stufe,
Key/Token-Landkarte, haeufige Fehlerbilder, Reset-Pfade.
Reset-Pfade in der PWA: `?reset-drive`, `?reset-gemini` (beide mit
Rueckfrage).

---

## Dateien

```
pwa/
├── index.html       # 4 Screens (Home, Meeting, Notiz, Auftrag) + Modals + Drive-Banner
├── app.js           # Router, IndexedDB, Lifecycle, Transkription, Upload, JF-Slug
├── recorder.js      # MediaRecorder + Pegel + Silence-Detection
├── gemini.js        # Files API, generateContent, Prompts, applyJfFrontmatter
├── drive.js         # OAuth, Folder, Multipart-Upload, Dateinamen-Slug
├── sw.js            # CACHE_NAME hochzaehlen bei jeder pwa/-Aenderung
├── styles.css, manifest.json ("Claudia"), icon-192/512.png
assets/              # Icon-Quelle
scripts/             # drei ps1 + drei Task-Installer + make-icons.py
docs/                # Setup, auftrag-modus, remarkable-integration, troubleshooting
logs/                # Laufprotokolle der Laptop-Skripte
```
