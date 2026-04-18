# Enkephalos Voice Pipeline

Eine Progressive Web App fuer das Pixel 7 Pro, die kurze Ideen und Meetings bis 1 Stunde aufzeichnet, per Gemini 2.5 Flash transkribiert und strukturiert, und die Ergebnisse in das Enkephalos-Vault einspeist.

## Was es macht

- **Kurze Idee aufnehmen:** Tippen, sprechen, Auto-Stop nach Stille. Landet als strukturierte Markdown-Notiz im Vault-Inbox.
- **Meeting aufzeichnen:** Start-Stopp bis 60 Min. Transkript mit Sprecher-Trennung, Entscheidungen und Todos extrahiert, als Protokoll im Vault-Inbox.
- **Ein-Weg-Pipeline:** Pixel → Gemini → Google Drive → Laptop. Kein Server, keine Cloud-Backend-Komplexitaet.

## Architektur in einem Satz

Die PWA auf dem Pixel ruft direkt die Gemini-API auf, lädt das fertige Markdown via Drive-API nach Google Drive, und der Google-Drive-Desktop-Client auf dem Samsung-Laptop synct es lokal ins Enkephalos-Vault.

## Setup-Reihenfolge

Im Detail in `docs/`, hier der grobe Flow:

1. **Google Cloud Projekt anlegen** → Gemini API aktivieren, API-Key generieren. Siehe `docs/setup-gemini.md`.
2. **OAuth Client ID anlegen** fuer Drive-Zugriff. Siehe `docs/setup-drive.md`.
3. **Google Drive** → Ordner `/Enkephalos-Inbox/` anlegen.
4. **PWA hosten** (GitHub Pages reicht, muss HTTPS sein wegen Mikrofon-Zugriff).
5. **PWA auf Pixel installieren**: Chrome oeffnet Seite → "Zum Startbildschirm hinzufuegen". Siehe `docs/install-pixel.md`.
6. **Erster Start**: OAuth-Flow einmal durchlaufen, Gemini-Key einmal eingeben. Fertig.
7. **Auf dem Laptop**: Google Drive Desktop installieren und Sync fuer `/Enkephalos-Inbox/` aktivieren. Siehe `docs/laptop-sync.md`.

## Arbeiten mit Claude Code

Dieses Projekt ist so aufgebaut, dass du mit Claude Code Phase fuer Phase vorgehen kannst. Die komplette Arbeits-Briefing-Datei ist `CLAUDE.md` im Projekt-Root — lies sie **zuerst**, wenn du Claude Code startest. Die 5 Implementierungsphasen sind dort beschrieben.

Empfohlener Einstieg in Claude Code:

```
Lies CLAUDE.md vollstaendig. Dann starte mit Phase 1 (Geruest + UI-Shell).
Stelle mir Rueckfragen, bevor du mit anderen Phasen beginnst.
```

## Verzeichnisstruktur

```
voice-pipeline/
├── CLAUDE.md                   # Projekt-Briefing fuer Claude Code (wichtigste Datei)
├── README.md                   # Dieses Dokument
├── pwa/                        # Die App selbst
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   ├── sw.js                   # Service Worker
│   ├── manifest.json
│   └── config.example.js       # Template — als config.js kopieren und Keys eintragen
└── docs/
    ├── setup-gemini.md
    ├── setup-drive.md
    ├── install-pixel.md
    └── laptop-sync.md
```

## Nicht-Ziele (bewusst ausgeschlossen)

- Kein lokales Whisper
- Kein eigener Server
- Keine Android-native App
- Keine Edit-Funktion im UI
- Keine Kategorisierung in der App (passiert spaeter im Vault per Claude Cowork)

## Lizenz / Privates Projekt

Private Nutzung. Medizinische Inhalte — Verarbeitung ueber Gemini API ist eine bewusste Architekturentscheidung unter den Randbedingungen des Nutzers. Keine Patientendaten ohne vorherige Pseudonymisierung.
