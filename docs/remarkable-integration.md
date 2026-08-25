# reMarkable-Integration — Stand 25.08.2026: produktiv, laeuft automatisch alle 5 Min

Ziel: Handschriftliche Notizen vom reMarkable in dieselbe Pipeline einspeisen
wie die Sprachnotizen der Claudia-PWA. Eingangsmodalitaet ist PDF
(Handschrift) statt Audio-Blob.

**Architektur-Pivot gegenueber dem urspruenglichen Konzept (Juli 2026):**
Verarbeitung laeuft ueber **Claude Code headless**, nicht Gemini — analog
`scripts/process-auftraege.ps1`. Claude liest die PDF-Seiten direkt per
Read-Werkzeug. Kein zweiter API-Key, kein zweites Betriebsmodell.

## Voraussetzung: reMarkable Connect

Der Nutzer hat ein reMarkable-Connect-Abo und kann damit beliebige
Unterordner in seinem Google Drive ansteuern (bestaetigt 23.08.2026). Ohne
Connect waere nur der kostenlose Einzelexport ("Share -> Google Drive" an
einen festen Ort) verfuegbar — die JF-Ordnerstruktur unten setzt Connect
voraus.

## Drive-Struktur

```
Enkephalos-Handschrift/
├── <datei>.pdf                          # kind: handwriting — alles ohne JF-Bezug,
│                                           spontane Notizen/Ideen. Unveraendert:
│                                           1 Notizbuch pro Gedanke, direkt hier.
├── verarbeitet/                         # erfolgreich verarbeitete Wurzel-Dateien
├── fehler/                              # fehlgeschlagene Wurzel-Dateien
│
└── JF/                                  # Container fuer alle Jour-Fixe-Reihen
    ├── abteilungsleiter/
    ├── oberaerzte-reha/
    ├── oberaerzte-akut/
    ├── oberaerzte-gross/
    ├── therapien/
    ├── klinikleitung-interdisziplinaer/
    ├── klinikleitung-aerzte/
    ├── personal/
    ├── skai-team/
    ├── tagesklinik/
    ├── geschaeftsfuehrung/
    ├── therapieplanung-controlling/
    │     <datei>.pdf                    # kind: jf, jf_reihe: <ordnername>
    │     verarbeitet/
    │     fehler/
    └── ...
```

**Slug-Herkunft:** Die zwoelf JF-Ordnernamen sind bewusst identisch mit den
Kategorien im Meeting-Modus der Claudia-PWA (`pwa/index.html`,
`meeting-category`-Dropdown), nur mechanisch in Kleinbuchstaben-Slugs
uebersetzt (kein `jf `-Praefix, Leerzeichen -> Bindestrich, keine Umlaute).
Eine Ausnahme wurde gekuerzt: PWA-Kategorie
"jf Therapien, Therapieplanung und Controlling" -> Slug
`therapieplanung-controlling` (Nutzerentscheidung 23.08.2026, Komma+"und"
waeren als Ordnername/Slug unhandlich gewesen). Die PWA-Kategorie
"Sonstiges Meeting" ist kein JF und bekommt keinen Ordner — bleibt in der
Wurzel.

**Die Liste driftet, wenn nur eine Seite gepflegt wird.** Am 25.08.2026 fiel
auf, dass `oberaerzte-gross` im Drive schon benutzt wurde (eine verarbeitete
Notiz), im PWA-Dropdown aber fehlte; umgekehrt fuehrte die Doku `therapien`
nicht, obwohl PWA und Drive es beide hatten. Beides nachgezogen. **Beim
Anlegen einer neuen JF-Reihe daher immer alle drei Orte fassen:** Drive-Ordner
`JF/<slug>/`, PWA-Option `jf <Label>` in `pwa/index.html` (plus
`CACHE_NAME`-Bump in `pwa/sw.js`, sonst zieht der Service Worker die alte
Fassung), und diese Liste hier. Zur Kontrolle:
```powershell
rclone lsf "gdrive:Enkephalos-Handschrift/JF" --dirs-only
```

**Ziel dieser Namensgleichheit:** Eine Sitzung derselben JF-Reihe soll beim
spaeteren Vault-Ingest kanalunabhaengig am selben Ort landen — egal ob sie
als reMarkable-Handschrift, kurze PWA-Sprachnotiz oder komplette
PWA-Meetingaufzeichnung erfasst wurde. Der Slug ist der gemeinsame Schluessel
(`jf_reihe:` im Frontmatter). **Die PWA selbst vergibt dieses Feld noch
nicht** — das ist offene Arbeit, siehe TODO unten.

## Bedienung am Geraet

Die JF-Ordner sind **nicht dauerhaft im reMarkable-Dateimanager eingehaengt**,
sondern werden bedarfsweise angesteuert: nach jeder Sitzung Notizbuch
fertigstellen -> Share -> Google Drive -> zum passenden `JF/<reihe>`-Ordner
navigieren -> dort speichern. Fuer alles ohne JF-Bezug bleibt es beim
gewohnten direkten Export in die Wurzel.

**Wichtig — Datum immer im Text, nicht im Dateinamen:** reMarkable vergibt
beim Export keinen zuverlaessigen Dateinamen (Praxistest ergab z.B.
`Notizbuch.pdf` statt eines Datums). Das Datum der Notiz muss daher **oben
auf der Seite geschrieben stehen** (z.B. `23.8.2026`) — das Skript
extrahiert `captured` primaer aus dem Seiteninhalt, nur ersatzweise aus dem
Drive-Aenderungszeitstempel der Datei.

## Komponenten (implementiert und getestet)

| Datei | Rolle |
|---|---|
| `scripts/process-handschrift.ps1` | Holt neue PDFs per rclone, startet Claude Code headless, legt Ergebnis in `Enkephalos/inbox/`, verschiebt Quelle nach `verarbeitet/` bzw. `fehler/` |
| `scripts/handschrift-anweisung.md` | Betriebsanweisung fuer den headless-Lauf: Ausgabeformat, Anti-Halluzinations-Regeln, `kind: handwriting` vs. `kind: jf` |
| `scripts/handschrift-abkuerzungen.md` | Editierbare Abkuerzungslegende, wird in den Prompt eingebettet. Vom Nutzer frei erweiterbar, ohne Skript-Aenderung. |
| `scripts/install-handschrift-task.cmd` | Registriert den Scheduled Task `Enkephalos Handschrift` (alle 5 Min). Einmalig ausfuehren, siehe unten. |

**Frontmatter-Konvention der Ergebnisdatei:**
```yaml
type: voice-capture
kind: handwriting | jf
jf_reihe: <nur bei kind: jf>
captured: <aus dem Text, sonst Datei-Zeitstempel>
quelle: remarkable
transcription_model: claude
```

**Ablage bleibt bewusst `Enkephalos/inbox/`, nicht direkt `areas/jour-fixes/...`:**
Das Vault-Schema (`Enkephalos/CLAUDE.md`) sieht `inbox/` als einzige
Eingangszone vor; die Einsortierung in einen konkreten `areas/`-Ordner
passiert ueber den bestehenden Ingest-Dialog, nicht automatisiert durch das
Skript. Der Bereich `areas/jour-fixes/<reihe>/` existiert noch nicht und
entsteht erst beim ersten tatsaechlichen Ingest einer JF-Notiz.

## Automatischer Lauf (Scheduled Task, eingerichtet 25.08.2026)

Registriert per `scripts\install-handschrift-task.cmd` (einmalig, als der
Benutzer, dem der rclone-Token gehoert):

| Einstellung | Wert |
|---|---|
| Taskname | `Enkephalos Handschrift` |
| Rhythmus | alle 5 Minuten, Startminute `:00` |
| Aufruf | `wscript.exe //B ..\..\run-hidden.vbs scripts\process-handschrift.ps1` (fensterlos, wartet auf Prozessende) |
| `ExecutionTimeLimit` | `PT1H` |
| `DisallowStartIfOnBatteries` | `False` |
| `StopIfGoingOnBatteries` | `False` |

**Phasenlage im Fuenf-Minuten-Raster — nicht beliebig waehlbar.** Alle drei
Tasks sprechen dasselbe Drive-Konto ueber denselben rclone-OAuth-Token an.
Laufen zwei rclone-Prozesse gleichzeitig, verliert zuverlaessig der
aufwendigere (Vorfall 2026-08-10 bis 2026-08-24, siehe
`scripts/install-auftrag-task.cmd`). Die Startminuten sind deshalb so
gestaffelt, dass der rclone-Anteil jedes Tasks in die Claude- bzw. Ruhephase
der anderen faellt:

| Minute | Task | rclone-Anteil |
|---|---|---|
| `:00` | Enkephalos Handschrift | ein `lsjson`, danach Claude (Minuten) |
| `:02` | Enkephalos Inbox Sync | ein `move`, Sekunden |
| `:04` | Enkephalos Auftraege | `mkdir` + zwei `lsf`, danach Claude (Minuten) |

**Wird ein vierter Task auf dieses Raster gelegt, ist die Tabelle oben
zuerst zu pruefen** — freie Minuten sind nur noch `:01` und `:03`, und beide
liegen eine Minute neben einem bestehenden Start.

**Akku bewusst nicht gegated** — anders als beim Inbox Sync, gleiche
Begruendung wie beim Auftraege-Task: ein Lauf, der mitten in der
Transkription abgeschossen wird, verbrennt Claude-Laufzeit und hinterlaesst
eine Sperrdatei (`%LOCALAPPDATA%\voice-pipeline\handschrift\.lock`), die
erst nach 30 Minuten als verwaist gilt und uebernommen wird.

**Ueberlappungsschutz** doppelt: der Scheduler startet keine zweite Instanz,
solange die alte laeuft (`run-hidden.vbs` wartet auf das Prozessende), und
das Skript selbst haelt die genannte Sperrdatei.

**Log:** `logs/handschrift.log`. Ein Lauf ohne neue PDFs schreibt bewusst
nichts — Stille im Log heisst "nichts zu tun", nicht "Task laeuft nicht".
Zur Kontrolle stattdessen:
```powershell
Get-ScheduledTaskInfo -TaskName 'Enkephalos Handschrift' |
  Select-Object LastRunTime, LastTaskResult, NextRunTime
```
`LastTaskResult` `0` = ok, `267009` = laeuft gerade.

## Kalender — bewusst kein Pipeline-Feature

JF-Reihen werden vom Nutzer einmalig als wiederkehrende Termine angelegt
(z.B. Klinikleitung 14-taegig Freitag 12 Uhr), bisher in Outlook. Das ist
vollstaendig von der technischen Architektur entkoppelt — die Pipeline legt
keine Kalendertermine an.

## Praxistest — Ergebnis (23.08.2026)

Zwei Testseiten gelesen, ueber `process-handschrift.ps1` end-to-end
verarbeitet (Download -> Transkription -> Inbox-Ablage -> Quelle nach
`verarbeitet/`):

1. **Sauber geschriebene Testseite:** fehlerfreie Transkription, Datum
   korrekt aus dem Text.
2. **Schnell/knapp geschriebene Arbeitsnotiz** ("Therapieplanung Fedder"):
   ca. 15-20% der Woerter mit `[unsicher]`/`[unleserlich]`/`[Name unklar]`
   markiert statt geraten — Anti-Halluzinations-Prompt greift wie gedacht.

**Verdikt: Go**, mit der Einschraenkung, dass Qualitaet stark mit
Schreibsorgfalt schwankt, nicht mit fachlicher Komplexitaet.

**Zwei beobachtete Kleinigkeiten, noch nicht behoben:**
- Marker kamen teils englisch (`[Name unclear: ...]`) statt wie in der
  Anweisung spezifiziert deutsch (`[Name unklar: ...]`) — kosmetisch, aber
  relevant, falls spaeter nach diesen Markern gesucht werden soll.
- Bei der unordentlichen Testseite enthielt die automatisierte Transkription
  ein Wort ("woechentl.") ohne Unsicherheitsmarkierung, das bei einem
  manuellen Gegenlese-Versuch zuvor nicht sicher herauslesbar war — Beleg,
  dass auch mit Anti-Halluzinations-Prompt ein Restrisiko bei unordentlicher
  Schrift bleibt.

## TODO (Stand 25.08.2026, nichts davon blockiert den produktiven Einsatz)

- [x] `kind: jf`-Pfad end-to-end getestet (25.08.2026): zwei Notizen aus
      `JF/oberaerzte-gross/` und `JF/personal/` sauber verarbeitet, Ergebnis
      als `...-jf-<reihe>.md` in der Inbox, Quellen in `verarbeitet/`
      (`logs/handschrift.log`, 17:30-17:32).
- [ ] Marker-Sprache im Prompt schaerfen, damit `[Name unklar: ...]`
      durchgaengig deutsch herauskommt.
- [x] Scheduled Task `Enkephalos Handschrift` eingerichtet (25.08.2026,
      5-Minuten-Rhythmus auf Minute `:00`) — siehe Abschnitt "Automatischer
      Lauf". Abweichend von der urspruenglichen Notiz **ohne** Akku-Gating:
      die Begruendung des Auftraege-Tasks (abgeschossene Claude-Laufzeit,
      verwaiste Sperrdatei) gilt hier gleichermassen, das Akku-Gating des
      Inbox-Sync passt nur zu dessen sekundenkurzem Lauf.
- [ ] Offene Abkuerzungen aus dem ersten Praxistest ggf. aufloesen
      (`KTL-BS`, `KCSR`, `ETH4`, "Doejter Schule") — aktuell in
      `handschrift-abkuerzungen.md` bewusst offen gelassen.
- [ ] Claudia-PWA um JF-Zuordnung im Meeting-Modus erweitern (`kind: jf` /
      `jf_reihe:` analog zur Handschrift-Pipeline), damit alle drei Kanaele
      (reMarkable, Kurznotiz, PWA-Meetingaufzeichnung) derselben JF-Reihe
      beim Ingest am selben Ort landen. Bisher nur die Handschrift-Seite
      steht; die PWA-Seite ist unveraendert.
- [ ] `areas/jour-fixes/<reihe>/` entsteht bewusst erst beim ersten
      tatsaechlichen Ingest — keine Vorab-Anlage durch die Pipeline.

## Bekannte Grenzen (unveraendert aus dem Juli-Konzept)

- Skizzen/Diagramme werden nicht uebernommen, bestenfalls beschrieben.
- Handschrift-OCR bei engen Fachtermini und Eigennamen ist die
  Hauptfehlerquelle, nicht Fliesstext.
