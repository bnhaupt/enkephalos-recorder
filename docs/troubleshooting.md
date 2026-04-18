# Troubleshooting-Guide

Kompakter Lageplan fuer den Fall, dass die Pipeline bockt. Lies zuerst `STATUS.md` fuer den Gesamtzustand; dieses Dokument ist das Werkzeug fuer die Diagnose.

## 1. Pipeline-Stufen im Ueberblick

```
[Pixel PWA]  →  [Gemini API]  →  [Google Drive]  →  [rclone Sync]  →  [Vault Inbox]
    (1)            (2)               (3)                 (4)             (5)
```

Bei jeder Stoerung: Zuerst feststellen, auf welcher Stufe der Flow abreisst. Die Schnell-Checks unten zeigen pro Stufe, wie.

## 2. Schnell-Checks

### Stufe 1: PWA laeuft und nimmt auf?

- Pixel-Homescreen-Icon „Enkephalos" antippen → App-Shell laedt?
- Kurze-Idee-Test (5 Sekunden reinsprechen, auto-stopp abwarten)
- In der History: Statusindikator auf dem Listen-Eintrag
  - `⟳` = laeuft (transcribing oder uploading)
  - `✓` = fertig, Markdown in Drive
  - `⚠` oder rot = Fehler → Tap zeigt Retry

Web-Check unabhaengig vom Pixel:
```
curl -I https://bnhaupt.github.io/enkephalos-recorder/pwa/
```
Erwartet: HTTP 200.

### Stufe 2: Gemini-Transkription klappt?

Fehlersymptom: Aufnahme bleibt auf `transcribing` haengen oder kippt auf Fehler mit Gemini-Meldung.

- API-Key pruefen: Chrome DevTools → Application → IndexedDB → `enkephalos-recorder` → `config` → Key `gemini_api_key`
- Quota/Rate-Limit: https://aistudio.google.com/app/apikey → Quota-Status
- Safety-Block: Gemini-Antwort enthaelt leeres Content-Field → oft bei medizinischen Fachbegriffen faelschlich triggernd. Im Zweifel Prompt im `pwa/gemini.js` anpassen (Safety liegt auf `BLOCK_ONLY_HIGH`).

### Stufe 3: Datei in Drive angekommen?

```
rclone lsf gdrive:Enkephalos-Inbox/
```
Erwartet: Liste der Markdown-Dateien (je nach Sync-Stand kurz oder leer).

Im Browser: https://drive.google.com/drive/my-drive → Ordner `Enkephalos-Inbox` muss existieren.

Wenn Drive-Web die Datei zeigt, aber `rclone lsf` nicht: Token abgelaufen.
```
rclone config reconnect gdrive:
```

### Stufe 4: Sync-Task laeuft?

```
cmd //c "schtasks /Query /FO CSV" | grep Enkephalos
```
Erwartet: `"\Enkephalos Inbox Sync","<naechste-Zeit>","Bereit"`.

Manueller Trigger:
```
cmd //c "schtasks /Run /TN \"Enkephalos Inbox Sync\""
```
Oder direkt das Skript:
```
powershell -ExecutionPolicy Bypass -File C:\Users\bjoer\OneDrive\05_Dev\voice-pipeline\scripts\sync-inbox.ps1
```

Log:
```
tail -20 "$USERPROFILE/OneDrive/Enkephalos/sync-inbox.log"
```

### Stufe 5: Datei im Vault?

```
ls "$USERPROFILE/OneDrive/Enkephalos/inbox/"
```
Erwartet: die verschobenen Markdown-Dateien, sortiert nach Timestamp im Dateinamen.

## 3. Wo liegt welcher Key/Token?

| Was                          | Wo                                                                              | Wie regenerieren                                       |
|------------------------------|---------------------------------------------------------------------------------|--------------------------------------------------------|
| Gemini-API-Key               | PWA: IndexedDB `enkephalos-recorder` → `config.gemini_api_key`                  | https://aistudio.google.com/app/apikey → neuer Key; in der PWA `prompt()` abwarten oder manuell im IndexedDB setzen |
| Google-OAuth-Client-ID       | PWA: IndexedDB `enkephalos-recorder` → `config.drive_client_id`                 | https://console.cloud.google.com/apis/credentials      |
| Google-OAuth-Access-Token    | PWA: IndexedDB `enkephalos-recorder` → `config.drive_token` (Expiry ~1h)        | In der PWA: Banner oben → „Verbinden"                   |
| Drive-Folder-ID              | PWA: IndexedDB `enkephalos-recorder` → `config.drive_folder_id`                 | IndexedDB-Eintrag loeschen → Skript legt neuen Ordner an |
| rclone-OAuth-Token (Laptop)  | `%APPDATA%\rclone\rclone.conf`, Remote `gdrive`                                 | `rclone config reconnect gdrive:`                       |
| OAuth-JS-Origin (Cloud-Console) | https://console.cloud.google.com/apis/credentials → Client-ID → „Authorized JavaScript origins" | dort `https://bnhaupt.github.io` ergaenzen/pruefen      |

## 4. Haeufige Fehlerbilder

### „Mikrofon-Zugriff verweigert" beim PWA-Start

- Chrome auf Pixel: Einstellungen → Websites → Mikrofon → muss fuer die Origin erlaubt sein
- Als installierte PWA: Android-Einstellungen → Apps → Enkephalos Recorder → Berechtigungen → Mikrofon aktivieren

### Aufnahme hochladen schlaegt mit „401" oder „invalid_grant" fehl

Drive-OAuth-Token ist abgelaufen (kommt jeden Tag vor, weil OAuth-Consent in Testing-Status ist → 7-Tage-Token). In der PWA: Banner oben erscheint automatisch, „Verbinden" tappen. Zwei-Tap-Flow: erster Tap speichert (falls noetig) Client-ID, zweiter Tap oeffnet den Google-Popup.

### Dateien bleiben in Drive liegen, kommen nicht im Vault an

Reihenfolge der Diagnose:
1. `schtasks /Query` — laeuft der Task? Naechste Zeit sinnvoll?
2. `powershell -File ...\sync-inbox.ps1` manuell — was sagt die Ausgabe?
3. Log pruefen (`sync-inbox.log`) — letzte Zeile
4. `rclone lsf gdrive:Enkephalos-Inbox/` — sieht rclone die Dateien?
5. Wenn rclone leer, obwohl Drive-Web Dateien zeigt → Token abgelaufen → `rclone config reconnect gdrive:`

### PWA laedt nicht mehr nach Code-Push

Service Worker haelt alte Version im Cache. Ist in `sw.js` per Auto-Reload-Flow abgedeckt (Controller-Change triggert `location.reload()`), aber falls der neue SW nicht installiert: Chrome DevTools → Application → Service Workers → „Unregister" → Seite neu laden.

### GitHub Pages zeigt alte Version

Pages braucht ~1-3 Min nach `git push`. Check:
```
curl -s https://bnhaupt.github.io/enkephalos-recorder/pwa/app.js | head -5
```
Wenn alte Version: kurz warten, dann mit Cache-Bust nochmal (`?v=neu` an die URL).

### „rclone: command not found"

Shell muss nach `winget install` neu gestartet werden, damit `%LOCALAPPDATA%\Microsoft\WinGet\Links\` im PATH ist. Oder Binary direkt aufrufen:
```
%LOCALAPPDATA%\Microsoft\WinGet\Links\rclone.exe <args>
```

## 5. Reset-Pfade (im Zweifelsfall)

### PWA-Config komplett zuruecksetzen

Chrome DevTools (Remote Debugging vom Laptop) → Application → IndexedDB → `enkephalos-recorder` → Rechtsklick → Delete. Nach Reload fragt die App wieder nach API-Key und Drive-Client-ID.

### rclone neu konfigurieren

```
rclone config delete gdrive
rclone config create gdrive drive --non-interactive
rclone config reconnect gdrive:
```

### Task Scheduler-Task neu registrieren

```
cmd //c "schtasks /Delete /TN \"Enkephalos Inbox Sync\" /F"
cmd //c "C:\Users\bjoer\OneDrive\05_Dev\voice-pipeline\scripts\install-task.cmd"
```

## 6. Wenn alles nichts hilft

Die PWA speichert **alle** Aufnahmen als Blob in IndexedDB (Store `recordings`), bis der Upload erfolgreich ist. Ein Audio geht also in keinem Szenario verloren, solange der Pixel-Browser-Storage nicht geloescht wird. Im schlimmsten Fall: via Chrome Remote DevTools das Blob extrahieren und manuell durch Gemini/Drive schicken.
