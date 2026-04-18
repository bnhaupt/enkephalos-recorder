# PWA auf dem Pixel 7 Pro installieren

## 1. Wo ist die App gehostet?

Die PWA muss ueber HTTPS erreichbar sein (Mikrofon- und Storage-APIs funktionieren nur in sicheren Kontexten). Zwei empfohlene Wege:

### Option A: GitHub Pages (empfohlen fuer v1)
1. Ordner `pwa/` in ein GitHub-Repo pushen
2. Repo → Settings → Pages → Source: `main` branch, Folder: `/pwa`
3. Nach ~1 Min ist die App verfuegbar unter `https://<username>.github.io/<repo>/`
4. Kostenlos, HTTPS automatisch, kein Server-Hosting-Drama

### Option B: Netlify / Cloudflare Pages
Wenn du mehr Kontrolle willst — aber fuer v1 Overkill.

### Option C: Lokaler Rechner ueber WLAN
Wenn du die App nur zu Hause/im Buero nutzt und Privacy maximal halten willst:
- Auf dem Samsung Laptop: `python -m http.server 8080 --bind 0.0.0.0`
- Pixel im selben WLAN, URL: `http://<laptop-ip>:8080/pwa/`
- ACHTUNG: HTTP geht nur fuer `localhost`. Fuer Mikrofonzugriff von einem anderen Geraet brauchst du HTTPS. Workaround: mit `mkcert` ein lokales Zertifikat erzeugen.
- Fuer v1: nimm GitHub Pages, das ist einfacher.

## 2. Installation auf dem Pixel

1. Chrome auf dem Pixel oeffnen
2. URL der gehosteten PWA eingeben
3. Chrome zeigt ein Install-Banner an → "Installieren"
4. Falls das Banner nicht erscheint: Chrome-Menu → "App installieren" oder "Zum Startbildschirm hinzufuegen"
5. Die App erscheint als eigenes Icon auf dem Homescreen

## 3. Erster Start: Setup-Wizard

Beim ersten Start fuehrt die App durch:

1. **Gemini API-Key eingeben** → wird in IndexedDB gespeichert
2. **Google-Account verbinden** → OAuth-Popup, Scope `drive.file` bestaetigen
3. **Drive-Ordner finden** → App sucht automatisch `Enkephalos-Inbox`, legt ihn an falls noch nicht vorhanden
4. **Mikrofon-Permission** → einmal genehmigen, Android merkt sich das

Danach ist die App sofort einsatzbereit.

## 4. Berechtigungen auf dem Pixel

Die PWA braucht:
- **Mikrofon**: Android fragt beim ersten Aufnahme-Versuch
- **Storage**: implizit via IndexedDB, keine Extra-Permission
- **Background-Activity**: Android kann eine installierte PWA im Hintergrund pausieren. Fuer unser Design aber okay, weil wir Screen Wake Lock anfordern — Screen bleibt formal aktiv, nur der Display darf dunkel werden.

## 5. Energieverwaltung

Damit Android die PWA nicht im Hintergrund toetet:

1. Einstellungen → Apps → Enkephalos Recorder
2. "Akku" → "Nicht eingeschraenkt"
3. Unter "Berechtigungen" → Mikrofon aktiviert

Optional: In den Entwickleroptionen "Hintergrundprozess-Limit" auf "Standardlimit" belassen.

## 6. Updates der App

Wenn du Code-Aenderungen pusht und GitHub Pages neu deployed:
- Der Service Worker in der PWA prueft beim naechsten App-Start, ob eine neue Version verfuegbar ist
- Zeigt einen unauffaelligen "Update verfuegbar"-Banner
- Nach Tap wird neu geladen

Fuer die Entwicklung: `sw.js` aggressiver machen oder per DevTools-Chrome Application Tab Service Worker zwangsaktualisieren.

## 7. Troubleshooting

**"Mikrofon-Zugriff verweigert":**
- Chrome-Einstellungen pruefen: `chrome://settings/content/microphone`
- Bei installierter PWA: Android-Einstellungen → Apps → Enkephalos → Berechtigungen

**"Aufnahme bricht bei laengeren Meetings ab":**
- Wake Lock pruefen (Console-Log in Chrome DevTools via Remote Debugging)
- Chrome-Flag `#stop-in-background-tab` auf "Disabled" (nur als Workaround; Screen-on Strategie ist der Hauptschutz)

**"Upload scheitert":**
- WLAN/Mobilfunk pruefen
- Token moeglicherweise abgelaufen → App fordert neuen Login an
- Bei persistenten Fehlern: IndexedDB inspizieren via Chrome Remote DevTools

## 8. Chrome Remote Debugging vom Laptop

Nuetzlich zum Debuggen:

1. Auf dem Pixel: Entwickleroptionen → USB-Debugging aktivieren
2. Pixel per USB an Laptop
3. Im Chrome auf dem Laptop: `chrome://inspect/#devices`
4. Das Pixel erscheint, Tabs und PWAs sind direkt inspectable
