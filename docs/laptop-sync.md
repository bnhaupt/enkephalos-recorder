# Laptop-Sync: Google Drive → Enkephalos/inbox/

Die fertigen Markdown-Dateien landen via PWA in `Google Drive:/Enkephalos-Inbox/`. Der Samsung-Laptop synct sie lokal.

## 1. Google Drive Desktop installieren

1. Download: https://www.google.com/drive/download/
2. Installieren, mit demselben Google-Account einloggen, der auch in der PWA verwendet wird
3. Im Setup: "Meine Ablage mit diesem Computer synchronisieren"
4. Pfad merken, typischerweise `C:\Users\<user>\Google Drive\` oder `G:\Meine Ablage\` (je nach Windows-Einstellung "Stream vs. Mirror")
5. **Empfehlung:** Mirror-Modus waehlen (nicht Stream). Damit sind die Dateien offline verfuegbar und koennen ohne Internetverbindung gelesen werden.

Nach der Einrichtung findest du den Ordner `Enkephalos-Inbox` unter:
`<Drive-Pfad>\Enkephalos-Inbox\`

## 2. Option A: Keine Automatisierung (v1)

Fuer v1 reicht es, den Drive-Ordner einfach zu kennen. Beim "Inbox durchgehen" mit Claude Cowork:

1. Neue Dateien in `<Drive-Pfad>\Enkephalos-Inbox\` anschauen
2. Relevante manuell nach `<Enkephalos>\inbox\` kopieren (Claude Cowork kann das auch)
3. Ingest-Workflow (§4.1 der Enkephalos-CLAUDE.md) wird ausgeloest
4. Drive-Original kann anschliessend manuell geloescht werden

## 3. Option B: Automatisierung per PowerShell-Task

Wenn du v1 ein paar Tage genutzt hast und Automatisierung willst: Ein PowerShell-Skript, das alle 5 Min neue .md-Dateien aus dem Drive-Sync-Ordner nach Enkephalos verschiebt.

### Skript: `sync-inbox.ps1`

```powershell
# sync-inbox.ps1
# Verschiebt neue .md-Dateien aus dem Drive-Sync-Ordner nach Enkephalos/inbox/

$DriveInbox = "C:\Users\<user>\Google Drive\Enkephalos-Inbox"
$VaultInbox = "C:\Users\<user>\Documents\Enkephalos\inbox"

if (-not (Test-Path $VaultInbox)) {
    New-Item -ItemType Directory -Path $VaultInbox | Out-Null
}

Get-ChildItem -Path $DriveInbox -Filter "*.md" -File | ForEach-Object {
    $target = Join-Path $VaultInbox $_.Name
    if (-not (Test-Path $target)) {
        Move-Item -Path $_.FullName -Destination $target
        Write-Host "Moved: $($_.Name)"
    }
}
```

Pfade anpassen.

### Als Task Scheduler einrichten

1. Task Scheduler oeffnen (Windows-Taste, "Task Scheduler")
2. "Create Basic Task"
3. Name: `Enkephalos Inbox Sync`
4. Trigger: `Daily`, Start Time: `08:00`, "Recur every 1 day"
5. Advanced: "Repeat task every 5 minutes, for a duration of 24 hours"
6. Action: `Start a program`
   - Program: `powershell.exe`
   - Arguments: `-ExecutionPolicy Bypass -File "C:\path\to\sync-inbox.ps1"`
7. Settings: "Run task as soon as possible after a scheduled start is missed"

## 4. Option C: Drive-Ordner IST Enkephalos-Inbox

Radikaler: Das Vault-`inbox/`-Verzeichnis direkt auf den Drive-Sync-Ordner zeigen lassen.

**Vorteil:** Keine Kopier-Skripte, keine Automatisierung noetig.
**Nachteil:** Wenn du das Enkephalos-Vault selbst syncen willst (z.B. via OneDrive), entsteht ein Sync-Kaskaden-Problem. Auch: Drive-Client-Eigenheiten koennen die Inbox-Verarbeitung stoeren (z.B. Lock-Files, temporaere Ghost-Dateien waehrend Sync).

**Empfehlung:** Nur machen, wenn das Enkephalos-Vault ausschliesslich lokal bleibt.

Umsetzung:
1. Den Drive-Ordner `Enkephalos-Inbox` nach `<Enkephalos>\inbox\` symlinken (via mklink oder Junction Point)
2. In Enkephalos-CLAUDE.md erwaehnen, dass inbox/ ein Mountpoint ist und nicht manuell editiert werden soll

## 5. Datei-Hygiene

Wichtig fuer das Ingest-Pattern:

- **Nach erfolgreichem Ingest** (Datei wurde nach raw/ verschoben oder geloescht laut §4.1) sollte die Datei auch im Drive nicht mehr liegen — sonst resyncht sie beim nächsten Durchlauf wieder.
- Variante 1 (Option B oben): Drive → Lokale Inbox verschieben, dadurch wird Drive automatisch leer.
- Variante 2 (Option A manuell): Nach Ingest auch im Drive manuell loeschen.

## 6. Bandbreite und Speicher

- Eine Idee-Markdown: ~2-5 KB
- Ein 1h-Meeting-Markdown mit Volltranskript: ~30-100 KB
- Audios werden **nicht** in Drive gespeichert (Gemini bekommt sie ephemer)
- Realistisches monatliches Volumen: < 5 MB. Vernachlaessigbar.
