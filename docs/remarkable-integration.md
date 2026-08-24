# reMarkable-Integration — Stand 23.08.2026: Kanal gebaut und getestet, Go

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

**Slug-Herkunft:** Die zehn JF-Ordnernamen sind bewusst identisch mit den
Kategorien im Meeting-Modus der Claudia-PWA (`pwa/index.html:110-120`,
`meeting-category`-Dropdown), nur mechanisch in Kleinbuchstaben-Slugs
uebersetzt (kein `jf `-Praefix, Leerzeichen -> Bindestrich, keine Umlaute).
Eine Ausnahme wurde gekuerzt: PWA-Kategorie
"jf Therapien, Therapieplanung und Controlling" -> Slug
`therapieplanung-controlling` (Nutzerentscheidung 23.08.2026, Komma+"und"
waeren als Ordnername/Slug unhandlich gewesen). Die PWA-Kategorie
"Sonstiges Meeting" ist kein JF und bekommt keinen Ordner — bleibt in der
Wurzel.

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

## TODO (Stand 23.08.2026, nichts davon blockiert den produktiven Einsatz)

- [ ] `kind: jf`-Pfad end-to-end testen (bisher nur `kind: handwriting`
      getestet, da beide Testdateien in der Wurzel lagen) — Testnotiz in
      einen `JF/<reihe>/`-Ordner legen und Lauf wiederholen.
- [ ] Marker-Sprache im Prompt schaerfen, damit `[Name unklar: ...]`
      durchgaengig deutsch herauskommt.
- [ ] Scheduled Task einrichten (5-Minuten-Rhythmus, analog "Enkephalos
      Inbox Sync"), inkl. Akku-Gating (`DisallowStartIfOnBatteries`) wie bei
      den bestehenden Tasks.
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
