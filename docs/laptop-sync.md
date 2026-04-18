# Laptop-Sync: Google Drive → Enkephalos/inbox/

Die fertigen Markdown-Dateien landen via PWA in `Google Drive:/Enkephalos-Inbox/`. Der Samsung-Laptop holt sie via **rclone** ins Vault.

## Warum rclone, nicht Google Drive Desktop?

Google Drive Desktop konkurriert auf dem Laptop mit OneDrive am selben Dateisystem — das hat beim Nutzer schon zu zerschossenen Dateien gefuehrt. rclone umgeht das: spricht die Drive-API direkt an, braucht keinen Desktop-Client, kein G:-Laufwerk, keine Sync-Kaskaden.

## 1. Einmaliges Setup

### rclone installieren

```
winget install Rclone.Rclone
```

Binary landet unter `%LOCALAPPDATA%\Microsoft\WinGet\Links\rclone.exe` und ist damit im `PATH` (nach Shell-Neustart).

### OAuth-Remote konfigurieren

```
rclone config reconnect gdrive:
```

- Erste Frage „Use web browser?" → `y`
- Browser oeffnet, Google-Account auswaehlen, rclone-Zugriff bestaetigen
- Bei „unverifizierte App"-Warnung: „Erweitert" → „Fortfahren"
- Zweite Frage „Shared Drive?" → `n`

Token landet in `%APPDATA%\rclone\rclone.conf`. Halbwertszeit: unbegrenzt (Refresh-Token), solange der Google-Account den Zugriff nicht widerruft.

### Test

```
rclone lsf gdrive:Enkephalos-Inbox/
```

Listet die .md-Dateien im Drive-Ordner.

## 2. Sync-Skript

`scripts/sync-inbox.ps1` im Repo. Konfiguration oben im Skript:

- `$RcloneRemote` — Drive-Quelle (Standard: `gdrive:Enkephalos-Inbox`)
- `$VaultInbox`  — lokales Ziel (Standard: `%USERPROFILE%\OneDrive\Enkephalos\inbox`)
- `$LogFile`     — Log (`%USERPROFILE%\OneDrive\Enkephalos\sync-inbox.log`)

Lauf:

```
powershell -ExecutionPolicy Bypass -File C:\Users\bjoer\OneDrive\05_Dev\voice-pipeline\scripts\sync-inbox.ps1
```

Verhalten: `rclone move --include "*.md"` — verschiebt jede .md-Datei einzeln und loescht das Drive-Original nach erfolgreichem Transfer. Bei einem Fehler bleibt das Original in Drive und wird beim naechsten Lauf erneut versucht.

## 3. Automatisierung per Task Scheduler

Alle 5 Min laufen lassen — so landen frisch transkribierte Aufnahmen in wenigen Minuten im Vault.

### Per Befehlszeile

```
schtasks /Create /TN "Enkephalos Inbox Sync" /TR "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"C:\Users\bjoer\OneDrive\05_Dev\voice-pipeline\scripts\sync-inbox.ps1\"" /SC MINUTE /MO 5 /RL LIMITED /F
```

Task laeuft im Hintergrund (kein Fenster-Popup), alle 5 Minuten, mit den Rechten des aktuellen Users.

### Task entfernen

```
schtasks /Delete /TN "Enkephalos Inbox Sync" /F
```

### Task manuell triggern

```
schtasks /Run /TN "Enkephalos Inbox Sync"
```

## 4. Troubleshooting

**„rclone nicht gefunden"**
- `winget install Rclone.Rclone` neu laufen lassen
- Pruefen: `%LOCALAPPDATA%\Microsoft\WinGet\Links\rclone.exe` vorhanden?

**„Token expired"**
- `rclone config reconnect gdrive:` erneut durchlaufen lassen
- Sollte selten noetig sein, Refresh-Token haelt langfristig

**Dateien bleiben in Drive liegen trotz Sync**
- `sync-inbox.log` pruefen (`%USERPROFILE%\OneDrive\Enkephalos\sync-inbox.log`)
- Manueller Lauf mit `-v` an rclone: `rclone move gdrive:Enkephalos-Inbox ...\inbox --include "*.md" -v`

**Bandbreite und Speicher**
- Idee-Markdown: ~2-5 KB. Meeting-Markdown mit Volltranskript: ~30-100 KB.
- Realistisches Monatsvolumen: <5 MB. Vernachlaessigbar.
