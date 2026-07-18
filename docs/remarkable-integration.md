# reMarkable-Integration — Konzept (Stand 2026-07-18, noch nicht umgesetzt)

Ziel: Handschriftliche Notizen vom reMarkable in dieselbe Pipeline einspeisen
wie die Sprachnotizen der Claudia-PWA. Es aendert sich nur die
Eingangsmodalitaet: PDF (Handschrift) statt Audio-Blob. Gemini 2.5 Flash
uebernimmt OCR + Strukturierung, gleicher Key, gleiches Prompt-Muster.

## Recherche-Ergebnis (verifiziert 2026-07-18)

1. **Native Google-Drive-Integration:** Am Geraet lassen sich Notizbuecher
   oder einzelne Seiten als PDF in einen Drive-Ordner exportieren
   (Share → Google Drive). Seit Software 3.x fuer alle Nutzer frei, kein
   Connect-Abo noetig. Manueller Export pro Notiz (2-3 Taps), kein Auto-Sync.
2. **Inoffizielle Cloud-API fragil:** `rmapi` (juruen) ist archiviert und
   inkompatibel mit dem aktuellen Sync-Protokoll. Einziger gepflegter Fork:
   https://github.com/ddvk/rmapi — keine Basis fuer eine Dauerloesung.
3. **Eingebaute Handschrifterkennung** (MyScript, Convert-to-Text am Geraet):
   ohne Abo nutzbar, liefert aber unstrukturierten Text und muesste per
   E-Mail transportiert werden. Wird nicht gebraucht — Gemini liest die
   Handschrift-PDFs direkt.

Quellen:
- https://support.remarkable.com/s/article/Integrations
- https://support.remarkable.com/s/article/Exporting-files
- https://support.remarkable.com/s/article/Convert-handwritten-notes-into-text
- https://github.com/juruen/rmapi (archiviert)

## Optionen

| Option | Weg | Aufwand | Risiko |
|---|---|---|---|
| **A: Drive-Export + Laptop-Skript (EMPFOHLEN)** | reMarkable → Drive-Ordner → Skript ruft Gemini, schreibt .md in Vault-Inbox | 1 Skript (~150 Zeilen) | Niedrig, nur offizielle Schnittstellen |
| B: PWA erweitern | PDF am Pixel in Claudia importieren | Mittel | `drive.file`-Scope sieht fremde PDFs nicht; File-Picker noetig, klobig |
| C: Convert-to-Text + E-Mail | Geraet wandelt selbst, mailt Text | Kein Code | E-Mail als Transportkanal, unstrukturiert, Ingest-Luecke bleibt |
| D: ddvk/rmapi-Fork | Vollautomatischer Pull ohne manuellen Export | Mittel | Inoffiziell, bricht bei Protokoll-Updates; spaeteres Upgrade moeglich |

## Empfohlenes Setup (Option A)

```
reMarkable ──(Share→Drive, manuell)──► Drive:/Enkephalos-Handschrift/   (PDF, roh)
                                              │  Google Drive Desktop synct
                                              ▼
Laptop: PowerShell-Skript (Scheduled Task oder manuell beim Arbeitsstart)
        1. neue PDFs im Sync-Ordner finden
        2. Gemini 2.5 Flash: Handschrift transkribieren + strukturieren
           (Prompt analog Notiz-Prompt, frontmatter kind: handwriting)
        3. JJJJMMTT-HHMMSS-handschrift.md → Enkephalos/inbox/
        4. verarbeitetes PDF in Unterordner "verarbeitet" verschieben
```

Begruendung: Der Laptop hat Drive-Sync und Vault bereits lokal — das Skript
schreibt das Markdown direkt in die Vault-Inbox, ohne Umweg ueber den
Drive-Inbox-Ordner. Kein Backend, kein Abo, keine inoffizielle API.
Der manuelle Export ist zugleich ein Filter: nur bewusst exportierte
Notizen landen im Vault (nicht jede Paper-Annotation).

## Konventionen

- Dediziertes Notizbuch "Inbox" auf dem reMarkable fuer alles, was ins
  Vault soll; es werden nur neue Seiten exportiert.
- Meeting-Mitschriften als eigenes Notizbuch mit sprechendem Titel
  exportieren; das Skript reicht den PDF-Dateinamen als Titel-Hint an
  Gemini durch (analog Kategorien-Dropdown der PWA).

## Bekannte Grenzen

- Skizzen/Diagramme werden nicht uebernommen, bestenfalls beschrieben.
  Falls relevant: Original-PDF zusaetzlich ins Vault legen und im
  Markdown verlinken.
- Handschrift-OCR bei engen Fachtermini gut, aber nicht fehlerfrei.
  Anti-Halluzinations-Prompt wie bei Sprachnotizen ist Pflicht
  (nichts erfinden, Unleserliches als `[unleserlich]` markieren).

## Offene Punkte vor Umsetzung

- [ ] Lokaler Pfad des Enkephalos-Vaults auf dem Laptop (vom Nutzer)
- [ ] Drive-Ordnername festlegen (Vorschlag: `Enkephalos-Handschrift`)
- [ ] Gemini-Key-Ablage fuer das Laptop-Skript klaeren (env var vs. Datei)
- [ ] Scheduled Task vs. manueller Start beim Arbeitsbeginn
