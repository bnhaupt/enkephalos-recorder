# Setup: Google Drive OAuth

Die PWA braucht Schreibzugriff auf Google Drive, um die fertigen Markdown-Dateien im Ordner `/Enkephalos-Inbox/` abzulegen. OAuth 2.0 ist der Weg.

## 1. Google Cloud Projekt

Idealerweise dasselbe Projekt wie der Gemini-Key, das haelt alles zusammen.

1. Gehe zu https://console.cloud.google.com/
2. Projekt auswaehlen (oder das vom Gemini-Setup)
3. "APIs & Services" → "Library"
4. Suche "Google Drive API" → aktivieren

## 2. OAuth Consent Screen

1. "APIs & Services" → "OAuth consent screen"
2. User Type: **External** (weil PWA ohne Google-Workspace-Bindung)
3. App-Info:
   - App name: `Enkephalos Recorder`
   - User support email: deine Adresse
   - Developer contact: dieselbe
4. Scopes: Adding later. Erst mal leer lassen.
5. Test users: deine eigene Google-Adresse. Solange die App im "Testing"-Status ist, reicht das.

**Hinweis:** Im Testing-Status ist das Token alle 7 Tage neu auszuhandeln. Fuer eine private App kannst du das akzeptieren — oder spaeter auf "Production" gehen (erfordert aber kein Google-Review, solange der Scope nur `drive.file` ist).

## 3. OAuth Client ID erstellen

1. "APIs & Services" → "Credentials"
2. "+ Create Credentials" → "OAuth client ID"
3. Application type: **Web application**
4. Name: `Enkephalos Recorder PWA`
5. **Authorized JavaScript origins:**
   - `https://<dein-github-username>.github.io` (wenn GitHub Pages)
   - `http://localhost:8080` (fuer lokale Entwicklung)
6. **Authorized redirect URIs:**
   - Nicht noetig, wenn du den Implicit Flow / PKCE nutzt. Bei Google Identity Services (GIS) ueberhaupt nicht relevant.

## 4. Scope

Nur einen Scope anfordern: `https://www.googleapis.com/auth/drive.file`

Das ist der **minimale** Drive-Scope: Die App sieht und veraendert nur die Dateien, die sie selbst erstellt hat. Sie kann keine anderen Dateien im Drive lesen. Aus Sicht des Nutzers die sicherste Option.

## 5. Google Identity Services (GIS) als Auth-Bibliothek

In der PWA wird Google Identity Services fuer den Login-Flow genutzt. Laden via:

```html
<script src="https://accounts.google.com/gsi/client" async defer></script>
```

Dann in `app.js`:

```javascript
const tokenClient = google.accounts.oauth2.initTokenClient({
  client_id: CONFIG.GOOGLE_OAUTH_CLIENT_ID,
  scope: "https://www.googleapis.com/auth/drive.file",
  callback: (tokenResponse) => {
    // Token in IndexedDB speichern
    storeToken(tokenResponse);
  }
});

// Beim ersten Mal oder nach Token-Expiry:
tokenClient.requestAccessToken();
```

## 6. Drive-Ordner anlegen

Einmal manuell:

1. Im Google Drive (Web oder Desktop) einen Ordner namens `Enkephalos-Inbox` direkt unter "Meine Ablage" anlegen
2. Die Folder-ID aus der URL kopieren (nach `/folders/`)
3. In `config.js` eintragen ODER die App sucht sie beim ersten Start via `drive.files.list` mit `name='Enkephalos-Inbox'` und speichert die ID in IndexedDB

Empfehlung: App sucht selbst. Weniger Setup fuer den Nutzer.

## 7. Upload-API

Die PWA nutzt den **Multipart-Upload** der Drive API v3:

```
POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart
Authorization: Bearer <access_token>
Content-Type: multipart/related; boundary=<boundary>

--<boundary>
Content-Type: application/json

{
  "name": "20260417-143200-idee.md",
  "parents": ["<folder-id>"],
  "mimeType": "text/markdown"
}

--<boundary>
Content-Type: text/markdown

# Idee 2026-04-17 14:32
...Transkript...

--<boundary>--
```

Einfache Funktion in `app.js`, ca. 30 Zeilen.
