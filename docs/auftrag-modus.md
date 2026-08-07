# Auftrags-Modus

Diktierte Arbeitsauftraege vom Pixel, bearbeitet vom Rechner im Buero,
Ergebnis in der Vault-Inbox.

Das Szenario, fuer das der Modus gebaut ist: Waehrend der Visite entsteht eine
Frage. Auftrag diktieren, weiterarbeiten. Beim Zurueckkommen ins Buero liegt
das Ergebnis in `Enkephalos/inbox/`.

---

## Ablauf

```
08:15  Pixel: "Auftrag" antippen, diktieren
       Gemini transkribiert und strukturiert -> Drive/Enkephalos-Auftraege/
08:20  Bueroechner, Task alle 5 Min: findet den Auftrag, benennt ihn auf
       "--arbeit" um, startet Claude Code headless
08:35  Ergebnis nach Enkephalos/inbox/, Drive-Datei auf "--fertig"
       Das Pixel zeigt beim naechsten Blick den Haken
09:30  Rueckkehr ins Buero. Liegt da.
```

**Voraussetzung:** Der Rechner laeuft, waehrend du auf Station bist. Er muss
nicht entsperrt sein, aber eingeschaltet und nicht im Ruhezustand.

---

## Die vier Auftragsarten

Gemini klassifiziert die Art aus dem Diktat; die Art bestimmt, welche
Werkzeuge der unbeaufsichtigte Lauf bekommt.

| kind | Wofuer | Werkzeuge |
|---|---|---|
| `recherche` | Evidenzlage, Leitlinien, Literatur | Websuche, kein Dateizugriff |
| `klinisch` | Konkrete Fachfrage, kurze belegte Antwort | Websuche, kein Dateizugriff |
| `vault` | Arbeit auf eigenen Notizen und Protokollen | **Leserecht** auf das Vault |
| `dokument` | Brief, Bericht, Praesentation entwerfen | Eigener Sandkasten, Python fuer .docx/.pptx |

---

## Schreibgrenzen

Ein Assistent, der ohne Aufsicht arbeitet, braucht harte Grenzen. Sie sind
nicht als Regeltext formuliert, sondern durch die aufrufenden Parameter
erzwungen:

- **Das Vault ist in keinem Profil beschreibbar.** Das Ergebnis kommt ueber
  die Standardausgabe zurueck; die Datei schreibt `process-auftraege.ps1`.
  Bei `vault`-Auftraegen sind Schreibwerkzeuge und Shell komplett abgeschaltet,
  das Leserecht bleibt.
- **Ablage immer in `Enkephalos/inbox/`.** Nichts wird an einen endgueltigen
  Ort geschrieben, nichts Bestehendes veraendert. Du sichtest wie bei Notizen
  und Meetings.
- **Binaerartefakte nach `OneDrive/00_INBOX/`.** Format entscheidet ueber die
  Ablage, nicht das Thema — entsprechend der Grundregel im Ablagesystem.
- **Keine Aussenwirkung.** Keine Mails, keine Kalendereintraege, kein Versand.

Restrisiko: Beim Profil `dokument` ist Python erlaubt, weil ohne Shell keine
.docx/.pptx entsteht. Der Lauf arbeitet in einem eigenen Verzeichnis ohne
Vault-Zugriff, ein absoluter Pfad im Skript waere aber technisch erreichbar.
Wer das nicht will, entfernt die beiden `Bash(...)`-Eintraege aus dem
`dokument`-Profil; dann liefert diese Auftragsart nur noch Markdown.

---

## Statusrueckmeldung ans Handy

Die PWA laeuft mit dem Drive-Scope `drive.file` und sieht damit
ausschliesslich Dateien, die sie selbst angelegt hat. Ordner, die das
Laptop-Skript anlegt, kann sie nicht einmal aufloesen — ein Status ueber
Unterordner waere also nicht lesbar.

Deshalb laeuft die Rueckmeldung ueber den **Dateinamen**. rclone benennt
serverseitig um, die Datei-ID bleibt erhalten, und ihre eigene Auftragsdatei
darf die App jederzeit abfragen:

| Dateiname in Drive | Anzeige in der PWA |
|---|---|
| `<stamm>.md` | ○ uebergeben |
| `<stamm>--arbeit.md` | ⟳ in Arbeit |
| `<stamm>--fertig.md` | ✓ erledigt |
| `<stamm>--fehler.md` | ✗ fehlgeschlagen |

Das Umbenennen auf `--arbeit` ist zugleich die Beanspruchung: ein parallel
startender Lauf sieht den Auftrag dann nicht mehr als offen.

Erledigte Auftragsdateien bleiben 14 Tage in Drive liegen, damit die PWA den
Status weiter ablesen kann, und werden danach automatisch aufgeraeumt.

---

## Einrichtung auf dem Rechner

Voraussetzungen sind dieselben wie beim Inbox-Sync (`rclone` mit
konfiguriertem Remote `gdrive`), zusaetzlich das Claude Code CLI im PATH und
angemeldet.

```
scripts\install-auftrag-task.cmd
```

Registriert den Task `Enkephalos Auftraege`, alle 5 Minuten. Anders als beim
Inbox-Sync laeuft er auch im Akkubetrieb weiter — ein Lauf, der mitten in der
Bearbeitung abgeschossen wird, hinterlaesst sonst einen haengenden Auftrag.

Manuell testen:

```
powershell -ExecutionPolicy Bypass -File .\scripts\process-auftraege.ps1
```

Protokoll: `logs/auftraege.log`

---

## Wenn etwas haengt

**Auftrag bleibt auf „uebergeben".** Der Task laeuft nicht. Pruefen:
`schtasks /Query /TN "Enkephalos Auftraege"`. Haeufigste Ursache ist ein
Rechner im Ruhezustand.

**Auftrag bleibt auf „in Arbeit".** Ein Lauf ist abgestuerzt. Der naechste
Durchlauf erkennt das an der fehlenden Sperrdatei und gibt den Auftrag von
selbst wieder frei.

**Auftrag steht auf „fehlgeschlagen".** In `Enkephalos/inbox/` liegt eine
Fehlernotiz mit Ursache und dem urspruenglichen Auftragstext — es geht also
nichts verloren. Prompt und Fehlerausgabe des gescheiterten Laufs bleiben
unter `%LOCALAPPDATA%\voice-pipeline\auftraege\<stamm>\` liegen.

**Alles steht.** Verwaiste Sperrdatei:
`%LOCALAPPDATA%\voice-pipeline\auftraege\.lock`. Sie wird nach 45 Minuten
automatisch uebernommen, kann aber auch von Hand geloescht werden.
