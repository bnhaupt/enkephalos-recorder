// app.js — Hauptlogik der PWA
//
// Phase 1: UI-Shell + View-Router + IndexedDB-Setup. [done]
// Phase 2: MediaRecorder, Aufnahme-Modi, History-Eintraege. [current]
// Phase 3: Gemini API (Files API + generateContent).
// Phase 4: Google Drive OAuth + Upload.
// Phase 5: Chunk-Upload, Recovery, Polish.

import { startRecording } from "./recorder.js";
import {
  uploadAudio,
  waitForFileActive,
  generateContent,
  generateContentInline,
  deleteFile,
  validateApiKey,
  buildIdeaPrompt,
  buildMeetingPrompt,
  buildAuftragPrompt,
  applyJfFrontmatter,
} from "./gemini.js";
import {
  hasGis,
  initTokenClient,
  isTokenClientReady,
  requestAccessToken,
  isTokenValid,
  ensureFolder,
  uploadMarkdown,
  buildFilename,
  getFileMeta,
  AUFTRAG_FOLDER_NAME,
} from "./drive.js";

// ---------- Service Worker ----------

if ("serviceWorker" in navigator) {
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./sw.js")
      .then((reg) => {
        console.log("SW registriert:", reg.scope);
        reg.update().catch(() => {});
      })
      .catch((err) => console.error("SW-Registrierung fehlgeschlagen:", err));
  });
}

// ---------- Defaults (bis Phase 3 config.js liest) ----------

const DEFAULTS = {
  IDEA_MAX_DURATION_SEC: 120,
  IDEA_SILENCE_THRESHOLD: 0.02,
  IDEA_SILENCE_DURATION_MS: 3000,
  MEETING_MAX_DURATION_SEC: 3900,
  // Auftraege sind laenger als Notizen und werden waehrend des Sprechens
  // formuliert. Die Denkpause mitten im Satz darf nicht als Ende gelten,
  // daher grosszuegigere Stille-Schwelle als bei der Notiz.
  AUFTRAG_MAX_DURATION_SEC: 300,
  AUFTRAG_SILENCE_DURATION_MS: 5000,
};

const GEMINI_MODEL = "gemini-2.5-flash";
const CONFIG_KEY_GEMINI = "gemini_api_key";
const CONFIG_KEY_LAST_CATEGORY = "last_meeting_category";
// Teilnehmer werden je Kategorie gemerkt: wiederkehrende Jour-Fixe haben
// meist denselben Personenkreis, der so nur einmal getippt werden muss.
const CONFIG_KEY_PARTICIPANTS_PREFIX = "meeting_participants:";
const CONFIG_KEY_DRIVE_CLIENT_ID = "drive_client_id";
const CONFIG_KEY_DRIVE_TOKEN = "drive_token";
const CONFIG_KEY_DRIVE_FOLDER_ID = "drive_folder_id";
const CONFIG_KEY_DRIVE_AUFTRAG_FOLDER_ID = "drive_auftrag_folder_id";

// ---------- IndexedDB ----------

const DB_NAME = "enkephalos-recorder";
const DB_VERSION = 1;
export const STORE_CONFIG = "config";
export const STORE_RECORDINGS = "recordings";

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_CONFIG)) {
        db.createObjectStore(STORE_CONFIG, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(STORE_RECORDINGS)) {
        const store = db.createObjectStore(STORE_RECORDINGS, {
          keyPath: "id",
          autoIncrement: true,
        });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

export async function dbGet(store, key) {
  const db = await openDb();
  return promisify(tx(db, store, "readonly").get(key));
}

export async function dbPut(store, value) {
  const db = await openDb();
  return promisify(tx(db, store, "readwrite").put(value));
}

export async function dbAdd(store, value) {
  const db = await openDb();
  return promisify(tx(db, store, "readwrite").add(value));
}

export async function dbGetAll(store) {
  const db = await openDb();
  return promisify(tx(db, store, "readonly").getAll());
}

export async function dbDelete(store, key) {
  const db = await openDb();
  return promisify(tx(db, store, "readwrite").delete(key));
}

// Record-Update in einer einzelnen Transaction, ohne intermediate await.
async function updateRecordingRecord(id, patch) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_RECORDINGS, "readwrite");
    const store = transaction.objectStore(STORE_RECORDINGS);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const current = getReq.result;
      if (!current) { resolve(null); return; }
      const updated = { ...current, ...patch };
      const putReq = store.put(updated);
      putReq.onsuccess = () => resolve(updated);
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

// ---------- View-Router ----------

const SCREENS = {
  home: "screen-home",
  idea: "screen-idea",
  meeting: "screen-meeting",
  auftrag: "screen-auftrag",
};
const DEFAULT_SCREEN = "home";
const REC_SCREENS = new Set(["idea", "meeting", "auftrag"]);

function currentScreenId() {
  const hash = (location.hash || "").replace(/^#/, "");
  return SCREENS[hash] ? hash : DEFAULT_SCREEN;
}

function showScreen(name) {
  for (const [key, id] of Object.entries(SCREENS)) {
    const el = document.getElementById(id);
    if (!el) continue;
    const active = key === name;
    el.classList.toggle("active", active);
    el.setAttribute("aria-hidden", active ? "false" : "true");
  }
  if (name === "home") {
    renderDateline();
    renderHistory().catch((err) =>
      console.error("History-Render fehlgeschlagen:", err)
    );
    pollAuftragStatusSoon();
  }
}

// Datumszeile im Kopf. Ordnet die Historie darunter zeitlich ein, ohne dass
// jede Zeile das Datum wiederholen muesste.
function renderDateline() {
  const el = document.getElementById("home-date");
  if (!el) return;
  try {
    el.textContent = new Date().toLocaleDateString("de-DE", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  } catch {
    el.textContent = "";
  }
}

// ---------- History-Renderer ----------

// Zustand wird ueber die Form angezeigt (hohler Ring, offener Ring, voller
// Punkt, Quadrat), nicht ueber Ampelfarben \u2014 das SK-System untersagt
// Erfolg/Warnung-Semantik durch Farbe, und im Augenwinkel ist Form ohnehin
// das robustere Signal. Das Label traegt die Bedeutung fuer Screenreader.
const STATUS_ICONS = {
  pending: { cls: "is-pending", label: "wartet" },
  uploading: { cls: "is-running", label: "wird hochgeladen" },
  transcribing: { cls: "is-running", label: "wird transkribiert" },
  done: { cls: "is-done", label: "fertig" },
  error: { cls: "is-error", label: "Fehler" },
  // Nur Auftraege: Der Weg endet nicht beim Drive-Upload, sondern erst,
  // wenn der Rechner im Buero den Auftrag abgearbeitet hat.
  queued: { cls: "is-pending", label: "uebergeben, wartet" },
  working: { cls: "is-running", label: "wird bearbeitet" },
  finished: { cls: "is-done", label: "erledigt" },
  failed: { cls: "is-error", label: "fehlgeschlagen" },
};

// Statuswerte, bei denen sich ein weiterer Blick nach Drive noch lohnt.
const AUFTRAG_OPEN_STATUS = new Set(["queued", "working"]);

const KIND_LABEL = { idea: "Notiz", meeting: "Meeting", auftrag: "Auftrag" };

const HISTORY_ON_HOME = 4;

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString("de-DE", {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "--:--";
  }
}

function fmtDuration(sec) {
  if (sec == null || Number.isNaN(sec)) return "";
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

// Titel kommen aus der Gemini-Antwort, sind also nicht vertrauenswuerdig.
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// Was ein zweiter Versuch bei diesem Datensatz ueberhaupt bewirken wuerde.
// Modal und Listenzeile muessen sich hier einig sein, sonst bietet die eine
// Stelle etwas an, das die andere fuer sinnlos haelt.
function retryTarget(rec) {
  if (!rec) return null;
  if (rec.markdown && !rec.driveFileId) return "upload";
  if (rec.status === "error" || (rec.status === "pending" && !rec.markdown)) return "transcribe";
  return null;
}

function runRetry(id, target) {
  if (target === "upload") {
    uploadRecordingToDrive(id).catch((err) => console.error(err));
  } else if (target === "transcribe") {
    transcribeRecording(id).catch((err) => console.error(err));
  }
}

async function renderHistory() {
  const list = document.getElementById("history-list");
  if (!list) return;
  const items = await dbGetAll(STORE_RECORDINGS);
  items.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  list.innerHTML = "";
  // Nur die letzten vier. Der Startbildschirm beantwortet die Frage "ist das
  // von eben durch?" — dafuer reichen vier Zeilen. Zwanzig haben die
  // Erfassung aus dem Bild geschoben.
  for (const item of items.slice(0, HISTORY_ON_HOME)) {
    const status = STATUS_ICONS[item.status] || STATUS_ICONS.pending;
    const errored = item.status === "error" || item.status === "failed";
    // Fehlerzeilen sind die einzigen, die etwas verlangen — der Griff steht
    // deshalb direkt in der Zeile statt hinter dem Modal.
    const retry = retryTarget(item);
    const li = document.createElement("li");
    li.className = "history-item" + (errored ? " is-errored" : "");
    li.dataset.id = String(item.id);
    li.tabIndex = 0;
    // Beim Auftrag sagt der Titel mehr als die Aufnahmedauer.
    const label = KIND_LABEL[item.kind] || item.kind || "";
    const kindCell = item.kind === "auftrag" && item.title
      ? `${label} &middot; ${esc(item.title)}`
      : esc(label);
    li.innerHTML = `
      <span class="history-status ${status.cls}" role="img" aria-label="${esc(status.label)}"></span>
      <span class="history-time">${fmtTime(item.createdAt)}</span>
      <span class="history-kind">${kindCell}</span>
      <span class="history-duration">${fmtDuration(item.durationSec)}</span>
      ${retry ? `<button type="button" class="history-retry" data-retry="${retry}">${
        retry === "upload" ? "Drive-Upload wiederholen" : "Erneut transkribieren"
      }</button>` : ""}
    `;
    list.appendChild(li);
  }
}

// ---------- Toast ----------

let toastTimer = null;
function toast(msg, { isError = false, durationMs = 3200 } = {}) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("is-error", isError);
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, durationMs);
}

// ---------- Gemini: API-Key + Transkription ----------

async function getOrAskApiKey() {
  const stored = await dbGet(STORE_CONFIG, CONFIG_KEY_GEMINI);
  if (stored && stored.value) return stored.value;
  // Whitespace komplett entfernen — Zeilenumbrueche aus Copy-Paste
  // (Mail, Messenger) sind sonst unsichtbare Fehlerquellen.
  const entered = (window.prompt(
    "Gemini API-Key (einmalig; bleibt lokal in IndexedDB dieses Geraets):",
    "",
  ) || "").replace(/\s+/g, "");
  if (!entered) return null;
  try {
    toast("Pruefe API-Key …");
    const ok = await validateApiKey(entered);
    if (!ok) {
      toast("API-Key von Google abgelehnt — nicht gespeichert. Eingabe pruefen (Copy-Paste statt Abtippen).", { isError: true, durationMs: 6000 });
      return null;
    }
  } catch {
    // Netzfehler: Validierung nicht moeglich, Key trotzdem akzeptieren.
  }
  await dbPut(STORE_CONFIG, { key: CONFIG_KEY_GEMINI, value: entered });
  return entered;
}

// inline_data-Limit: 20MB pro Request inkl. Base64-Overhead (+33%).
const INLINE_MAX_BYTES = 14 * 1024 * 1024;

// Kein Audio-Split mehr: Gemini 2.5 Flash fasst ~1h Audio (~100k Token) in
// einem Request. Die fruehere Byte-Teilung des WebM-Containers erzeugte einen
// nicht dekodierbaren zweiten Teil (kein EBML-Header) -> Datenverlust in der
// hinteren Haelfte. Lange Meetings laufen jetzt als ein einziger Files-API-Call.

const activeTranscriptions = new Set();

async function transcribeRecording(id) {
  if (activeTranscriptions.has(id)) return;
  activeTranscriptions.add(id);
  let apiKey = null;
  let fileName = null;
  try {
    await updateRecordingRecord(id, { status: "transcribing", errorMessage: null });
    await renderHistory();

    apiKey = await getOrAskApiKey();
    if (!apiKey) {
      await updateRecordingRecord(id, { status: "error", errorMessage: "Kein API-Key" });
      toast("Kein API-Key eingegeben", { isError: true });
      return;
    }

    const rec = await dbGet(STORE_RECORDINGS, id);
    if (!rec) return;
    if (!rec.audioBlob) {
      await updateRecordingRecord(id, {
        status: "error",
        errorMessage: "Audio-Rohdaten bereits geloescht (Aufnahme war schon hochgeladen)",
      });
      return;
    }

    const jfReihe = rec.kind === "meeting"
      ? (rec.jfReihe || jfReiheFromTitle(rec.title))
      : null;

    const meta = {
      isoTimestamp: rec.createdAt,
      durationSec: rec.durationSec,
      title: rec.title,
      participants: rec.participants,
      jfReihe,
    };

    const promptText = rec.kind === "auftrag"
      ? buildAuftragPrompt(meta)
      : rec.kind === "idea"
        ? buildIdeaPrompt(meta)
        : buildMeetingPrompt(meta);
    const isShort = rec.kind === "idea" || rec.kind === "auftrag";

    let markdown;
    if (isShort && rec.audioBlob.size <= INLINE_MAX_BYTES) {
      // Kurze Aufnahmen inline: ein Request statt Upload + Poll + Delete.
      markdown = await generateContentInline(apiKey, GEMINI_MODEL, rec.audioBlob, promptText, { kind: rec.kind });
    } else {
      const displayName = `enkephalos-${rec.kind}-${rec.id}-${Date.now()}`;
      let file = await uploadAudio(apiKey, rec.audioBlob, displayName);
      fileName = file.name;
      file = await waitForFileActive(apiKey, file);
      markdown = await generateContent(apiKey, GEMINI_MODEL, file, promptText, { kind: rec.kind });
    }

    const patch = {
      status: "uploading",
      markdown: applyJfFrontmatter(markdown, jfReihe),
      transcriptionModel: GEMINI_MODEL,
      transcribedAt: new Date().toISOString(),
      errorMessage: null,
    };
    // Der Auftragstitel wird nicht getippt, sondern von Gemini aus dem
    // Diktat gebildet. Er traegt den Dateinamen und die History-Zeile.
    if (rec.kind === "auftrag") {
      const m = markdown.match(/^titel:\s*(.+)$/m);
      patch.title = (m ? m[1] : "").trim() || "ohne-titel";
    }
    await updateRecordingRecord(id, patch);
    toast(
      rec.kind === "auftrag" ? "Auftrag erfasst"
        : rec.kind === "idea" ? "Notiz transkribiert"
          : "Meeting transkribiert",
    );
    // Drive-Upload nach erfolgreicher Transkription triggern.
    uploadRecordingToDrive(id).catch((err) =>
      console.error("Drive-Upload-Start fehlgeschlagen:", err),
    );
  } catch (err) {
    console.error("Transkription fehlgeschlagen:", err);
    const msg = String(err && err.message ? err.message : err);
    // Ungueltiger Key → verwerfen, damit der naechste Versuch neu fragt
    // (analog zur 401-Behandlung beim Drive-Token).
    if (/API_KEY_INVALID|API key not valid|API_KEY_EXPIRED|API key expired/i.test(msg)) {
      try { await dbDelete(STORE_CONFIG, CONFIG_KEY_GEMINI); } catch {}
      toast("Gemini-API-Key ungueltig — bei „Erneut transkribieren“ neu eingeben", { isError: true, durationMs: 6000 });
    } else {
      toast("Transkription fehlgeschlagen", { isError: true });
    }
    await updateRecordingRecord(id, {
      status: "error",
      errorMessage: msg,
    });
  } finally {
    if (apiKey && fileName) {
      deleteFile(apiKey, fileName).catch(() => {});
    }
    activeTranscriptions.delete(id);
    await renderHistory();
  }
}

// ---------- Drive: OAuth + Upload ----------

// Fest eingebaut statt manueller Eingabe: OAuth-Web-Client-IDs sind public
// by design (stehen ohnehin im ausgelieferten JS); die Absicherung laeuft
// ueber die Authorized JavaScript Origins in der Cloud Console.
const DRIVE_CLIENT_ID =
  "127995864370-2bh8qaq3k30hadhkolm9covefqcg7vsr.apps.googleusercontent.com";

async function getStoredDriveToken() {
  const entry = await dbGet(STORE_CONFIG, CONFIG_KEY_DRIVE_TOKEN);
  return entry && entry.value ? entry.value : null;
}

async function getValidDriveToken() {
  const tok = await getStoredDriveToken();
  return isTokenValid(tok) ? tok.access_token : null;
}

function ensureDriveTokenClient() {
  if (!hasGis()) {
    toast("Google-Login noch nicht geladen", { isError: true });
    return null;
  }
  initTokenClient(DRIVE_CLIENT_ID, {
    onToken: async (token) => {
      await dbPut(STORE_CONFIG, { key: CONFIG_KEY_DRIVE_TOKEN, value: token });
      await updateDriveBanner();
      toast("Drive verbunden");
      processPendingDriveUploads().catch((err) =>
        console.error("Pending-Uploads fehlgeschlagen:", err),
      );
    },
    onError: (err) => {
      console.warn("Token-Fehler:", err);
      toast("Drive-Autorisierung abgebrochen", { isError: true });
    },
  });
  return DRIVE_CLIENT_ID;
}

// Synchroner Handler fuer den Verbinden-Button. KEINE awaits vor
// requestAccessToken, sonst verbraucht das Popup-Blockerverhalten die
// User-Gesture.
function onDriveButtonClick() {
  if (!isTokenClientReady()) {
    // GIS-Script war beim Init noch nicht geladen — jetzt nachholen.
    // Der Token-Client ist danach bereit, aber die User-Gesture ist
    // verbraucht; der Nutzer tippt einfach nochmal.
    if (ensureDriveTokenClient()) {
      toast("Bereit. Nochmal auf Verbinden tippen.");
    }
    return;
  }
  try {
    requestAccessToken({ silent: false });
  } catch (err) {
    console.error(err);
    toast("Drive-Autorisierung fehlgeschlagen", { isError: true });
  }
}

async function updateDriveBanner() {
  const banner = document.getElementById("drive-banner");
  const textEl = document.getElementById("drive-banner-text");
  const btn = document.getElementById("drive-connect-btn");
  if (!banner || !textEl || !btn) return;

  const token = await getStoredDriveToken();

  if (!isTokenValid(token)) {
    textEl.textContent = "Google Drive verbinden.";
    btn.textContent = "Verbinden";
    banner.hidden = false;
    return;
  }
  banner.hidden = true;
}

const activeUploads = new Set();

async function uploadRecordingToDrive(id) {
  if (activeUploads.has(id)) return;
  activeUploads.add(id);
  try {
    const rec = await dbGet(STORE_RECORDINGS, id);
    if (!rec || !rec.markdown) return;
    if (rec.driveFileId) return;

    const token = await getValidDriveToken();
    if (!token) {
      await updateRecordingRecord(id, {
        status: "error",
        errorMessage: "Drive-Autorisierung ausstehend",
      });
      await updateDriveBanner();
      await renderHistory();
      return;
    }

    await updateRecordingRecord(id, { status: "uploading", errorMessage: null });
    await renderHistory();

    // Auftraege gehen in einen eigenen Drive-Ordner: sync-inbox.ps1 raeumt
    // die Inbox blind leer und wuerde sie sonst wegschieben, bevor
    // process-auftraege.ps1 sie ueberhaupt sieht.
    const isAuftrag = rec.kind === "auftrag";
    const folderCfgKey = isAuftrag
      ? CONFIG_KEY_DRIVE_AUFTRAG_FOLDER_ID
      : CONFIG_KEY_DRIVE_FOLDER_ID;

    let folderId = (await dbGet(STORE_CONFIG, folderCfgKey))?.value;
    if (!folderId) {
      folderId = await ensureFolder(token, isAuftrag ? AUFTRAG_FOLDER_NAME : undefined);
      await dbPut(STORE_CONFIG, { key: folderCfgKey, value: folderId });
    }

    const filename = buildFilename(rec);
    const uploaded = await uploadMarkdown(token, folderId, filename, rec.markdown);

    await updateRecordingRecord(id, {
      // Beim Auftrag ist der Upload nicht das Ende, sondern die Uebergabe:
      // erledigt ist er erst, wenn der Rechner im Buero ihn bearbeitet hat.
      status: isAuftrag ? "queued" : "done",
      driveFileId: uploaded.id,
      driveFileName: uploaded.name,
      driveWebViewLink: uploaded.webViewLink || null,
      uploadedAt: new Date().toISOString(),
      errorMessage: null,
      // Rohaudio nach erfolgreichem Upload verwerfen — sonst waechst die
      // IndexedDB unbegrenzt (30-60 Min Meeting = zweistellige MB) und
      // erhoeht den Eviction-Druck. Das Markdown bleibt erhalten.
      audioBlob: null,
    });
    toast(isAuftrag ? "Auftrag uebergeben" : "In Drive hochgeladen");
  } catch (err) {
    console.error("Drive-Upload fehlgeschlagen:", err);
    const msg = String(err && err.message ? err.message : err);
    // 401 → Token ungueltig, verwerfen + Banner zeigen.
    if (/\b401\b/.test(msg)) {
      try { await dbDelete(STORE_CONFIG, CONFIG_KEY_DRIVE_TOKEN); } catch {}
      await updateDriveBanner();
    }
    await updateRecordingRecord(id, {
      status: "error",
      errorMessage: `Drive-Upload: ${msg}`,
    });
    toast("Drive-Upload fehlgeschlagen", { isError: true });
  } finally {
    activeUploads.delete(id);
    await renderHistory();
  }
}

// Einmalige Bereinigung von Altbestand: Blobs bereits hochgeladener
// Aufnahmen freigeben.
async function cleanupUploadedBlobs() {
  const all = await dbGetAll(STORE_RECORDINGS);
  for (const rec of all) {
    if (rec.driveFileId && rec.audioBlob) {
      await updateRecordingRecord(rec.id, { audioBlob: null });
    }
  }
}

async function processPendingDriveUploads() {
  const all = await dbGetAll(STORE_RECORDINGS);
  for (const rec of all) {
    if (rec.markdown && !rec.driveFileId && rec.status !== "uploading") {
      // Fire-and-forget; Retry-Logik in uploadRecordingToDrive selbst.
      uploadRecordingToDrive(rec.id).catch((err) =>
        console.error("processPending error:", err),
      );
    }
  }
}

// ---------- Auftragsstatus ----------

// Der Rechner im Buero meldet den Bearbeitungsstand ueber den Dateinamen
// zurueck (siehe scripts/process-auftraege.ps1). Wir fragen unsere eigenen
// Auftragsdateien ab — die duerfen wir unter `drive.file` lesen, weil diese
// App sie angelegt hat — und leiten den Status aus dem Namen ab.
const AUFTRAG_SUFFIX_STATUS = [
  [/--arbeit\.md$/, "working"],
  [/--fertig\.md$/, "finished"],
  [/--fehler\.md$/, "failed"],
];

function statusFromDriveName(name) {
  for (const [re, status] of AUFTRAG_SUFFIX_STATUS) {
    if (re.test(name || "")) return status;
  }
  return "queued";
}

let auftragPollRunning = false;

async function refreshAuftragStatus() {
  if (auftragPollRunning) return;
  auftragPollRunning = true;
  try {
    const all = await dbGetAll(STORE_RECORDINGS);
    const offen = all.filter(
      (r) => r.kind === "auftrag" && r.driveFileId && AUFTRAG_OPEN_STATUS.has(r.status),
    );
    if (!offen.length) return;

    const token = await getValidDriveToken();
    if (!token) return;

    let changed = false;
    for (const rec of offen) {
      try {
        const meta = await getFileMeta(token, rec.driveFileId);
        if (meta.trashed) {
          await updateRecordingRecord(rec.id, {
            status: "failed",
            errorMessage: "Auftragsdatei in Drive geloescht",
          });
          changed = true;
          continue;
        }
        const next = statusFromDriveName(meta.name);
        if (next !== rec.status) {
          await updateRecordingRecord(rec.id, { status: next, driveFileName: meta.name });
          changed = true;
          if (next === "finished") {
            toast(`Auftrag erledigt: ${rec.title || ""}`.trim());
          }
        }
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        // 404: Datei endgueltig weg. Alles andere (Netz, Token) beim naechsten Lauf.
        if (/\b404\b/.test(msg)) {
          await updateRecordingRecord(rec.id, {
            status: "failed",
            errorMessage: "Auftragsdatei in Drive nicht mehr auffindbar",
          });
          changed = true;
        } else {
          console.debug("Auftragsstatus nicht abrufbar:", msg);
        }
      }
    }
    if (changed) await renderHistory();
  } finally {
    auftragPollRunning = false;
  }
}

function pollAuftragStatusSoon() {
  refreshAuftragStatus().catch((err) =>
    console.debug("Auftragsstatus-Abfrage fehlgeschlagen:", err),
  );
}

// ---------- Recording lifecycle ----------

// currentRec = {
//   kind: "idea" | "meeting" | "auftrag",
//   screen: gleich kind,
//   handle, timerId, finalizing
// } | null
//
// Kein startTs: die aufgenommene Dauer kommt aus dem Recorder, weil nur der
// weiss, wie lange pausiert wurde.
let currentRec = null;

function clearRecTimer() {
  if (currentRec && currentRec.timerId) {
    clearInterval(currentRec.timerId);
    currentRec.timerId = null;
  }
}

// ---------- Pause ----------
//
// Nur Notiz und Meeting. Der Auftrag bleibt bewusst ohne Pause: er ist ein
// kurzes Diktat mit 5-Minuten-Deckel, kein Termin, in den hineingestoert
// wird.
//
// Wichtig ist nicht die Taste, sondern was sie aussetzt: im Notiz-Modus
// wuerde die Stille-Erkennung sonst genau waehrend der Stoerung zuschlagen
// und die Aufnahme beenden. Das erledigt der Recorder (siehe recorder.js);
// hier steht nur die Anzeige.
const PAUSE_IDS = {
  meeting: "meeting-pause",
  idea: "idea-pause",
};

const PAUSE_HINTS = {
  meeting: {
    laeuft: "Bildschirm darf dunkel, aber nicht aus.",
    pausiert: "Pausiert. Es wird nichts aufgenommen.",
  },
  idea: {
    laeuft: "Aufnahme laeuft — einfach sprechen.",
    pausiert: "Pausiert. Der Auto-Stopp ist ausgesetzt.",
  },
};

function pauseButtonFor(kind) {
  const id = PAUSE_IDS[kind];
  return id ? document.getElementById(id) : null;
}

function setPausedUi(kind, paused) {
  const btn = pauseButtonFor(kind);
  if (btn) {
    btn.textContent = paused ? "Weiter" : "Pause";
    btn.setAttribute("aria-pressed", paused ? "true" : "false");
  }

  const texte = PAUSE_HINTS[kind];
  if (!texte) return;
  const hintEl = document.getElementById(
    kind === "meeting" ? "meeting-note" : "idea-hint",
  );
  if (hintEl) hintEl.textContent = paused ? texte.pausiert : texte.laeuft;

  // Die Zusatzzeile verspricht einen Auto-Stopp, den es waehrend der Pause
  // nicht gibt.
  if (kind === "idea") {
    const sub = document.getElementById("idea-subhint");
    if (sub) {
      sub.textContent = paused
        ? "Weiter antippen, um fortzusetzen."
        : "Stoppt auch automatisch nach 3 Sekunden Stille.";
    }
  }
}

function togglePause(kind) {
  if (!currentRec || currentRec.kind !== kind || currentRec.finalizing) return;
  const handle = currentRec.handle;
  const gewechselt = handle.isPaused() ? handle.resume() : handle.pause();
  if (!gewechselt) {
    toast("Pause nicht moeglich", { isError: true });
    return;
  }
  setPausedUi(kind, handle.isPaused());
}

// Beim Beenden darf die Pausentaste nicht mehr greifen -- weder waehrend
// des Titel-Dialogs noch waehrend des Speicherns.
function lockPauseButton(kind) {
  const btn = pauseButtonFor(kind);
  if (btn) btn.disabled = true;
}

function resetMeetingUi() {
  const stopBtn = document.getElementById("meeting-stop");
  const timerEl = document.getElementById("meeting-timer");
  if (stopBtn) stopBtn.disabled = true;
  if (timerEl) timerEl.textContent = "00:00";
  const pauseBtn = pauseButtonFor("meeting");
  if (pauseBtn) pauseBtn.disabled = true;
  setPausedUi("meeting", false);
  setWaveformLevel(0);
}

function resetIdeaUi() {
  const stopBtn = document.getElementById("idea-stop");
  if (stopBtn) stopBtn.disabled = true;
  const timerEl = document.getElementById("idea-timer");
  if (timerEl) timerEl.textContent = "00:00";
  const pauseBtn = pauseButtonFor("idea");
  if (pauseBtn) pauseBtn.disabled = true;
  setPausedUi("idea", false);
  setWaveformLevel(0);
}

function resetAuftragUi() {
  const hint = document.getElementById("auftrag-hint");
  if (hint) hint.textContent = "Auftrag diktieren — einfach sprechen.";
  const stopBtn = document.getElementById("auftrag-stop");
  if (stopBtn) stopBtn.disabled = true;
  const timerEl = document.getElementById("auftrag-timer");
  if (timerEl) timerEl.textContent = "00:00";
  setWaveformLevel(0);
}

function setWaveformLevel(rms) {
  // rms ~ 0..0.3 typisch; auf 0..1 mappen mit sanftem Clipping
  const clipped = Math.min(1, rms / 0.3);
  document.documentElement.style.setProperty("--level", clipped.toFixed(3));
}

// Jeder Aufnahmemodus hat jetzt einen eigenen Timer. Bei Notiz und Auftrag
// zaehlt er gegen eine harte Obergrenze (2 bzw. 5 Min) — genau dort ist die
// verstrichene Zeit die Information, die fehlte.
const TIMER_IDS = {
  meeting: "meeting-timer",
  idea: "idea-timer",
  auftrag: "auftrag-timer",
};

function tickTimer() {
  if (!currentRec) return;
  const timerEl = document.getElementById(TIMER_IDS[currentRec.kind] || "meeting-timer");
  if (!timerEl) return;
  // Der Recorder rechnet Pausen heraus; er ist damit die einzige Quelle
  // fuer die aufgenommene Dauer. Wanduhrzeit waere hier falsch.
  const sec = Math.floor(currentRec.handle.getDurationSec());
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  timerEl.textContent = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

async function startRecScreen(kind) {
  if (currentRec) return; // bereits aktiv

  // Notiz und Auftrag laufen gleich: Stille beendet die Aufnahme, gespeichert
  // wird ohne Rueckfrage. Nur das Meeting braucht den Titel-Dialog.
  const isAuto = kind === "idea" || kind === "auftrag";
  const maxDurationSec = kind === "idea"
    ? DEFAULTS.IDEA_MAX_DURATION_SEC
    : kind === "auftrag"
      ? DEFAULTS.AUFTRAG_MAX_DURATION_SEC
      : DEFAULTS.MEETING_MAX_DURATION_SEC;

  const opts = {
    mode: kind,
    maxDurationSec,
    onLevel: (rms) => setWaveformLevel(rms),
    onAutoStop: (reason) => {
      if (!currentRec) return;
      if (isAuto) {
        finalizeAndSave().catch((err) => {
          console.error(err);
          toast("Speichern fehlgeschlagen", { isError: true });
          discardAndGoHome();
        });
      } else {
        toast(
          reason === "maxDuration"
            ? "Max. Meeting-Laenge erreicht, stoppe"
            : "Aufnahme automatisch gestoppt",
        );
        finalizeMeetingFlow().catch((err) => {
          console.error(err);
          toast("Speichern fehlgeschlagen", { isError: true });
          discardAndGoHome();
        });
      }
    },
  };
  if (isAuto) {
    opts.silence = {
      thresholdRms: DEFAULTS.IDEA_SILENCE_THRESHOLD,
      durationMs: kind === "auftrag"
        ? DEFAULTS.AUFTRAG_SILENCE_DURATION_MS
        : DEFAULTS.IDEA_SILENCE_DURATION_MS,
    };
  }

  try {
    const handle = await startRecording(opts);
    currentRec = {
      kind,
      screen: kind,
      handle,
      timerId: null,
    };

    if (kind === "meeting") {
      const stopBtn = document.getElementById("meeting-stop");
      if (stopBtn) stopBtn.disabled = false;
      const pauseBtn = pauseButtonFor("meeting");
      if (pauseBtn) pauseBtn.disabled = false;
      setPausedUi("meeting", false);
    } else if (kind === "auftrag") {
      resetAuftragUi();
      const auftragStop = document.getElementById("auftrag-stop");
      if (auftragStop) auftragStop.disabled = false;
    } else {
      resetIdeaUi();
      const ideaStop = document.getElementById("idea-stop");
      if (ideaStop) ideaStop.disabled = false;
      const ideaPause = pauseButtonFor("idea");
      if (ideaPause) ideaPause.disabled = false;
      setPausedUi("idea", false);
    }

    tickTimer();
    currentRec.timerId = setInterval(tickTimer, 250);

    // Request wake lock wo verfuegbar (still optional, Phase 5 haertet)
    requestWakeLock();
  } catch (err) {
    console.error("Recorder-Start fehlgeschlagen:", err);
    const msg = err && err.name === "NotAllowedError"
      ? "Mikrofon-Zugriff verweigert"
      : "Aufnahme konnte nicht starten";
    toast(msg, { isError: true });
    location.hash = "home";
  }
}

async function finalizeAndSave(titleFromUser = null, participantsFromUser = null, jfReiheFromUser = null) {
  // Guard gegen Doppel-Finalisierung (manueller Stopp + Silence-Auto-Stop
  // koennen sich zeitlich ueberlappen).
  if (!currentRec || currentRec.finalizing) return;
  currentRec.finalizing = true;
  lockPauseButton(currentRec.kind);
  const rec = currentRec;
  clearRecTimer();

  let result;
  try {
    result = await rec.handle.stop();
  } catch (err) {
    currentRec = null;
    releaseWakeLock();
    throw err;
  }

  currentRec = null;
  releaseWakeLock();

  const createdAt = new Date().toISOString();
  const entry = {
    kind: rec.kind,
    createdAt,
    durationSec: result.durationSec,
    audioBlob: result.blob,
    mimeType: result.mimeType,
    status: "pending",
  };
  if (titleFromUser && titleFromUser.trim()) entry.title = titleFromUser.trim();
  if (participantsFromUser && participantsFromUser.trim()) {
    entry.participants = participantsFromUser.trim();
  }
  if (jfReiheFromUser) entry.jfReihe = jfReiheFromUser;

  const newId = await dbAdd(STORE_RECORDINGS, entry);
  toast(
    rec.kind === "auftrag" ? "Auftrag aufgenommen"
      : rec.kind === "idea" ? "Notiz gespeichert"
        : "Meeting gespeichert",
  );

  // Fire-and-forget Transkription.
  transcribeRecording(Number(newId)).catch((err) =>
    console.error("Transcribe-Start fehlgeschlagen:", err),
  );

  if (rec.kind === "idea") resetIdeaUi();
  else if (rec.kind === "auftrag") resetAuftragUi();
  else resetMeetingUi();

  if (location.hash.replace(/^#/, "") !== "home") {
    location.hash = "home";
  } else {
    await renderHistory();
  }
}

async function finalizeMeetingFlow() {
  if (!currentRec || currentRec.kind !== "meeting") return;
  clearRecTimer();
  const stopBtn = document.getElementById("meeting-stop");
  if (stopBtn) stopBtn.disabled = true;
  lockPauseButton("meeting");
  const { title, participants, jfReihe } = await askForTitle();
  await finalizeAndSave(title, participants, jfReihe);
}

function discardAndGoHome() {
  if (currentRec) {
    try { currentRec.handle.cancel(); } catch {}
    clearRecTimer();
    currentRec = null;
  }
  releaseWakeLock();
  resetMeetingUi();
  resetIdeaUi();
  resetAuftragUi();
  if (location.hash.replace(/^#/, "") !== "home") {
    location.hash = "home";
  }
}

// ---------- Wake Lock (defensive) ----------

let wakeLock = null;

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
  } catch (err) {
    // Nicht kritisch fuer Phase 2
    console.debug("Wake Lock nicht verfuegbar:", err);
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    try { wakeLock.release(); } catch {}
    wakeLock = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (currentRec && !wakeLock) requestWakeLock();
  // App wieder im Vordergrund: haeufigster Moment, in dem sich am
  // Auftragsstatus zwischenzeitlich etwas getan hat.
  if (!currentRec) pollAuftragStatusSoon();
});

// ---------- Title modal ----------

async function loadParticipantsFor(category) {
  if (!category) return "";
  try {
    const entry = await dbGet(
      STORE_CONFIG,
      CONFIG_KEY_PARTICIPANTS_PREFIX + category,
    );
    return entry && entry.value ? entry.value : "";
  } catch {
    return "";
  }
}

// Slug der JF-Reihe zu einer Kategorie des Meeting-Dropdowns.
//
// Die Zuordnung steht als `data-jf-reihe` an der jeweiligen <option> in
// index.html -- damit ist das Dropdown die einzige Quelle der Wahrheit und
// eine neue Reihe braucht hier keine Code-Aenderung. "Sonstiges Meeting"
// hat bewusst kein Attribut und liefert null.
function jfReiheForCategory(category) {
  if (!category) return null;
  const sel = document.getElementById("meeting-category");
  if (!sel) return null;
  const opt = Array.from(sel.options).find((o) => o.value === category);
  return (opt && opt.dataset.jfReihe) || null;
}

// Fallback fuer Aufnahmen, die vor der Einfuehrung von `jfReihe` entstanden
// sind oder erneut transkribiert werden: der Titel beginnt mit der
// Kategorie, ein optionaler Zusatz haengt als " - <Zusatz>" hinten dran.
function jfReiheFromTitle(title) {
  if (!title) return null;
  const sel = document.getElementById("meeting-category");
  if (!sel) return null;
  const opt = Array.from(sel.options)
    .filter((o) => o.dataset.jfReihe)
    // Laengste Uebereinstimmung zuerst, sonst gewinnt "jf Therapien" gegen
    // "jf Therapien, Therapieplanung und Controlling".
    .sort((a, b) => b.value.length - a.value.length)
    .find((o) => title === o.value || title.startsWith(o.value + " - "));
  return (opt && opt.dataset.jfReihe) || null;
}

async function askForTitle() {
  const modal = document.getElementById("title-modal");
  const categorySel = document.getElementById("meeting-category");
  const input = document.getElementById("title-input");
  const participantsEl = document.getElementById("participants-input");
  const ok = document.getElementById("title-ok");
  if (!modal || !categorySel || !input || !participantsEl || !ok) {
    return { title: null, participants: "", jfReihe: null };
  }

  // Letzte Auswahl vorbelegen.
  try {
    const last = await dbGet(STORE_CONFIG, CONFIG_KEY_LAST_CATEGORY);
    if (last && last.value) {
      const exists = Array.from(categorySel.options).some(
        (o) => o.value === last.value,
      );
      if (exists) categorySel.value = last.value;
    }
  } catch {}

  input.value = "";
  // Gemerkte Teilnehmer der vorbelegten Kategorie laden.
  participantsEl.value = await loadParticipantsFor(categorySel.value);
  modal.hidden = false;
  setTimeout(() => categorySel.focus(), 30);

  return new Promise((resolve) => {
    // Kategoriewechsel: gemerkte Teilnehmer der neuen Kategorie nachladen,
    // aber nur wenn der Nutzer das Feld nicht bereits selbst geaendert hat.
    let participantsTouched = false;
    const onParticipantsInput = () => { participantsTouched = true; };
    const onCategoryChange = async () => {
      if (participantsTouched) return;
      participantsEl.value = await loadParticipantsFor(categorySel.value);
    };

    const finish = async () => {
      const category = categorySel.value || "Sonstiges Meeting";
      const suffix = input.value.trim();
      const title = suffix ? `${category} - ${suffix}` : category;
      const participants = participantsEl.value.trim();

      modal.hidden = true;
      ok.removeEventListener("click", onOk);
      input.removeEventListener("keydown", onKey);
      categorySel.removeEventListener("keydown", onKey);
      categorySel.removeEventListener("change", onCategoryChange);
      participantsEl.removeEventListener("input", onParticipantsInput);

      try {
        await dbPut(STORE_CONFIG, {
          key: CONFIG_KEY_LAST_CATEGORY,
          value: category,
        });
        // Teilnehmer je Kategorie merken (bzw. leeren Eintrag entfernen).
        if (participants) {
          await dbPut(STORE_CONFIG, {
            key: CONFIG_KEY_PARTICIPANTS_PREFIX + category,
            value: participants,
          });
        } else {
          await dbDelete(STORE_CONFIG, CONFIG_KEY_PARTICIPANTS_PREFIX + category);
        }
      } catch {}

      resolve({ title, participants, jfReihe: jfReiheForCategory(category) });
    };
    const onOk = () => finish();
    const onKey = (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); finish(); }
      else if (ev.key === "Escape") { ev.preventDefault(); finish(); }
    };
    ok.addEventListener("click", onOk);
    input.addEventListener("keydown", onKey);
    categorySel.addEventListener("keydown", onKey);
    categorySel.addEventListener("change", onCategoryChange);
    participantsEl.addEventListener("input", onParticipantsInput);
  });
}

// ---------- Event wiring ----------

function onHashChange() {
  const newScreen = currentScreenId();

  // Aktive Aufnahme, Navigation weg vom Aufnahme-Screen → verwerfen.
  if (currentRec && newScreen !== currentRec.screen) {
    try { currentRec.handle.cancel(); } catch {}
    clearRecTimer();
    currentRec = null;
    releaseWakeLock();
    resetMeetingUi();
    resetIdeaUi();
    resetAuftragUi();
  }

  showScreen(newScreen);

  if (!currentRec && REC_SCREENS.has(newScreen)) {
    startRecScreen(newScreen);
  }
}

function bindButtons() {
  for (const kind of Object.keys(PAUSE_IDS)) {
    const btn = pauseButtonFor(kind);
    if (btn) btn.addEventListener("click", () => togglePause(kind));
  }

  const stopBtn = document.getElementById("meeting-stop");
  if (stopBtn) {
    stopBtn.addEventListener("click", () => {
      if (!currentRec || currentRec.kind !== "meeting") return;
      finalizeMeetingFlow().catch((err) => {
        console.error(err);
        toast("Speichern fehlgeschlagen", { isError: true });
        discardAndGoHome();
      });
    });
  }

  const ideaStopBtn = document.getElementById("idea-stop");
  if (ideaStopBtn) {
    ideaStopBtn.addEventListener("click", () => {
      if (!currentRec || currentRec.kind !== "idea") return;
      ideaStopBtn.disabled = true;
      lockPauseButton("idea");
      finalizeAndSave().catch((err) => {
        console.error(err);
        toast("Speichern fehlgeschlagen", { isError: true });
        discardAndGoHome();
      });
    });
  }

  const auftragStopBtn = document.getElementById("auftrag-stop");
  if (auftragStopBtn) {
    auftragStopBtn.addEventListener("click", () => {
      if (!currentRec || currentRec.kind !== "auftrag") return;
      auftragStopBtn.disabled = true;
      finalizeAndSave().catch((err) => {
        console.error(err);
        toast("Speichern fehlgeschlagen", { isError: true });
        discardAndGoHome();
      });
    });
  }

  const list = document.getElementById("history-list");
  if (list) {
    list.addEventListener("click", (ev) => {
      const li = ev.target.closest(".history-item");
      if (!li) return;
      const id = Number(li.dataset.id);
      if (!id) return;
      // Der Griff in der Zeile darf nicht zusaetzlich das Modal oeffnen.
      const retryBtn = ev.target.closest(".history-retry");
      if (retryBtn) {
        ev.stopPropagation();
        runRetry(id, retryBtn.dataset.retry);
        return;
      }
      showRecording(id);
    });
  }

  const mdClose = document.getElementById("md-close");
  if (mdClose) mdClose.addEventListener("click", closeMarkdownModal);
  const mdModal = document.getElementById("md-modal");
  if (mdModal) {
    mdModal.addEventListener("click", (ev) => {
      if (ev.target === mdModal) closeMarkdownModal();
    });
  }

  const driveBtn = document.getElementById("drive-connect-btn");
  if (driveBtn) {
    driveBtn.addEventListener("click", onDriveButtonClick);
  }
}

// ---------- Markdown viewer ----------

let mdCurrentId = null;

function closeMarkdownModal() {
  const modal = document.getElementById("md-modal");
  if (modal) modal.hidden = true;
  mdCurrentId = null;
}

async function showRecording(id) {
  const rec = await dbGet(STORE_RECORDINGS, id);
  if (!rec) return;
  const modal = document.getElementById("md-modal");
  const titleEl = document.getElementById("md-title");
  const body = document.getElementById("md-body");
  const actions = document.getElementById("md-actions");
  const retry = document.getElementById("md-retry");
  if (!modal || !titleEl || !body) return;

  mdCurrentId = id;
  titleEl.textContent = rec.title
    || (KIND_LABEL[rec.kind] || "Aufnahme")
    + " \u00b7 " + fmtTime(rec.createdAt);

  // Beim Auftrag interessiert vor allem, wie weit die Bearbeitung ist.
  const AUFTRAG_HINWEIS = {
    queued: "Uebergeben. Der Rechner im Buero holt den Auftrag beim naechsten Durchlauf.",
    working: "Wird gerade bearbeitet.",
    finished: "Erledigt. Das Ergebnis liegt in Enkephalos/inbox/.",
  };

  body.classList.remove("is-error");
  if (rec.kind === "auftrag" && AUFTRAG_HINWEIS[rec.status]) {
    body.textContent = AUFTRAG_HINWEIS[rec.status]
      + "\n\n" + (rec.markdown || "");
  } else if (rec.kind === "auftrag" && rec.status === "failed") {
    body.classList.add("is-error");
    body.textContent = "Bearbeitung fehlgeschlagen"
      + (rec.errorMessage ? `: ${rec.errorMessage}` : ".")
      + "\n\nEine Fehlernotiz mit dem urspruenglichen Auftrag liegt in Enkephalos/inbox/."
      + "\n\n" + (rec.markdown || "");
  } else if (rec.status === "done" && rec.markdown) {
    body.textContent = rec.markdown;
  } else if (rec.status === "transcribing") {
    body.textContent = "Transkription laeuft \u2026";
  } else if (rec.status === "error") {
    body.classList.add("is-error");
    body.textContent = "Fehler bei der Transkription:\n\n" + (rec.errorMessage || "Unbekannter Fehler");
  } else {
    body.textContent = "Noch nicht transkribiert.";
  }

  const target = retryTarget(rec);
  if (actions) actions.hidden = !target;
  if (retry) {
    retry.textContent = target === "upload"
      ? "Drive-Upload wiederholen"
      : "Erneut transkribieren";
    retry.onclick = () => {
      closeMarkdownModal();
      runRetry(id, target);
    };
  }
  modal.hidden = false;
}

document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  const modal = document.getElementById("md-modal");
  if (modal && !modal.hidden) closeMarkdownModal();
});

// ---------- Config-Reset via ?reset-drive / ?reset-gemini ----------

async function maybeResetGemini() {
  if (!new URLSearchParams(location.search).has("reset-gemini")) return;
  if (!window.confirm("Gespeicherten Gemini-API-Key wirklich loeschen?")) {
    history.replaceState(null, "", location.pathname + location.hash);
    return;
  }
  try {
    await openDb();
    await dbDelete(STORE_CONFIG, CONFIG_KEY_GEMINI);
  } catch {}
  history.replaceState(null, "", location.pathname + location.hash);
}

async function maybeResetDrive() {
  if (!new URLSearchParams(location.search).has("reset-drive")) return;
  if (!window.confirm("Drive-Konfiguration (Client-ID, Token, Ordner) wirklich loeschen?")) {
    history.replaceState(null, "", location.pathname + location.hash);
    return;
  }
  try {
    await openDb();
    await dbDelete(STORE_CONFIG, CONFIG_KEY_DRIVE_CLIENT_ID);
    await dbDelete(STORE_CONFIG, CONFIG_KEY_DRIVE_TOKEN);
    await dbDelete(STORE_CONFIG, CONFIG_KEY_DRIVE_FOLDER_ID);
  } catch {}
  history.replaceState(null, "", location.pathname + location.hash);
}

// ---------- Init ----------

// Persistenten Speicher anfordern, sonst darf Chrome die IndexedDB
// (Keys, Aufnahmen) bei Speicherdruck komplett raeumen. Bei installierten
// PWAs gewaehrt Chrome das ohne Dialog.
async function requestPersistentStorage() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return;
    const already = await navigator.storage.persisted();
    if (already) return;
    const granted = await navigator.storage.persist();
    console.log("Persistent Storage:", granted ? "gewaehrt" : "abgelehnt");
    if (!granted) {
      toast("Achtung: Speicher nicht persistent, Keys koennen verloren gehen", { isError: true });
    }
  } catch (err) {
    console.debug("Persistent-Storage-Anfrage fehlgeschlagen:", err);
  }
}

async function init() {
  try {
    await openDb();
  } catch (err) {
    console.error("IndexedDB-Init fehlgeschlagen:", err);
  }
  await requestPersistentStorage();
  await maybeResetDrive();
  await maybeResetGemini();
  cleanupUploadedBlobs().catch((err) =>
    console.debug("Blob-Cleanup fehlgeschlagen:", err),
  );
  bindButtons();
  window.addEventListener("hashchange", onHashChange);
  await updateDriveBanner();

  // Token-Client vorbereiten. (requestAccessToken wird erst bei
  // User-Gesture aufgerufen.) Falls das GIS-Script noch laedt, holt
  // onDriveButtonClick die Initialisierung nach.
  try {
    if (hasGis()) ensureDriveTokenClient();
  } catch (err) {
    console.debug("Drive-Token-Client-Init:", err);
  }

  // Offene Uploads versuchen (wenn Token noch gueltig).
  if (await getValidDriveToken()) {
    processPendingDriveUploads().catch((err) =>
      console.error("Startup-Uploads fehlgeschlagen:", err),
    );
  }

  // Auftragsstatus nachfuehren. Die Abfrage steigt sofort aus, wenn kein
  // Auftrag offen ist — der Intervall kostet dann praktisch nichts.
  pollAuftragStatusSoon();
  setInterval(() => {
    if (document.visibilityState === "visible" && !currentRec) {
      pollAuftragStatusSoon();
    }
  }, 60000);

  const initial = currentScreenId();
  showScreen(initial);
  if (REC_SCREENS.has(initial)) {
    // Direkt-Deeplink auf #idea/#meeting startet Aufnahme.
    startRecScreen(initial);
  }
}

init();
