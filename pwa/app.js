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
  deleteFile,
  buildIdeaPrompt,
  buildMeetingPrompt,
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
};

const GEMINI_MODEL = "gemini-2.5-flash";
const CONFIG_KEY_GEMINI = "gemini_api_key";
const CONFIG_KEY_LAST_CATEGORY = "last_meeting_category";
const CONFIG_KEY_DRIVE_CLIENT_ID = "drive_client_id";
const CONFIG_KEY_DRIVE_TOKEN = "drive_token";
const CONFIG_KEY_DRIVE_FOLDER_ID = "drive_folder_id";

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
};
const DEFAULT_SCREEN = "home";
const REC_SCREENS = new Set(["idea", "meeting"]);

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
    renderHistory().catch((err) =>
      console.error("History-Render fehlgeschlagen:", err)
    );
  }
}

// ---------- History-Renderer ----------

const STATUS_ICONS = {
  pending: { icon: "\u2026", cls: "is-pending" },
  uploading: { icon: "\u21E7", cls: "is-running" },
  transcribing: { icon: "\u21BB", cls: "is-running" },
  done: { icon: "\u2713", cls: "is-done" },
  error: { icon: "\u2717", cls: "is-error" },
};

const KIND_LABEL = { idea: "Idee", meeting: "Meeting" };

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

async function renderHistory() {
  const list = document.getElementById("history-list");
  if (!list) return;
  const items = await dbGetAll(STORE_RECORDINGS);
  items.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  list.innerHTML = "";
  for (const item of items.slice(0, 20)) {
    const status = STATUS_ICONS[item.status] || STATUS_ICONS.pending;
    const li = document.createElement("li");
    li.className = "history-item" + (item.status === "error" ? " is-errored" : "");
    li.dataset.id = String(item.id);
    li.tabIndex = 0;
    li.innerHTML = `
      <span class="history-status ${status.cls}">${status.icon}</span>
      <span class="history-time">${fmtTime(item.createdAt)}</span>
      <span class="history-kind">${KIND_LABEL[item.kind] || item.kind || ""}</span>
      <span class="history-duration">${fmtDuration(item.durationSec)}</span>
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
  const entered = (window.prompt(
    "Gemini API-Key (einmalig; bleibt lokal in IndexedDB dieses Geraets):",
    "",
  ) || "").trim();
  if (!entered) return null;
  await dbPut(STORE_CONFIG, { key: CONFIG_KEY_GEMINI, value: entered });
  return entered;
}

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

    const displayName = `enkephalos-${rec.kind}-${rec.id}-${Date.now()}`;
    let file = await uploadAudio(apiKey, rec.audioBlob, displayName);
    fileName = file.name;
    file = await waitForFileActive(apiKey, file);

    const meta = {
      isoTimestamp: rec.createdAt,
      durationSec: rec.durationSec,
      title: rec.title,
    };
    const promptText = rec.kind === "idea"
      ? buildIdeaPrompt(meta)
      : buildMeetingPrompt(meta);

    const markdown = await generateContent(apiKey, GEMINI_MODEL, file, promptText);

    await updateRecordingRecord(id, {
      status: "uploading",
      markdown,
      transcriptionModel: GEMINI_MODEL,
      transcribedAt: new Date().toISOString(),
      errorMessage: null,
    });
    toast(rec.kind === "idea" ? "Idee transkribiert" : "Meeting transkribiert");
    // Drive-Upload nach erfolgreicher Transkription triggern.
    uploadRecordingToDrive(id).catch((err) =>
      console.error("Drive-Upload-Start fehlgeschlagen:", err),
    );
  } catch (err) {
    console.error("Transkription fehlgeschlagen:", err);
    await updateRecordingRecord(id, {
      status: "error",
      errorMessage: String(err && err.message ? err.message : err),
    });
    toast("Transkription fehlgeschlagen", { isError: true });
  } finally {
    if (apiKey && fileName) {
      deleteFile(apiKey, fileName).catch(() => {});
    }
    activeTranscriptions.delete(id);
    await renderHistory();
  }
}

// ---------- Drive: OAuth + Upload ----------

async function getStoredDriveClientId() {
  const entry = await dbGet(STORE_CONFIG, CONFIG_KEY_DRIVE_CLIENT_ID);
  return entry && entry.value ? entry.value : null;
}

async function askForDriveClientId() {
  const entered = (window.prompt(
    "Google-OAuth-Client-ID (Format: 123...-abc.apps.googleusercontent.com):",
    "",
  ) || "").trim();
  if (!entered) return null;
  if (!/\.apps\.googleusercontent\.com$/.test(entered)) {
    toast("Client-ID sollte auf .apps.googleusercontent.com enden", { isError: true });
    return null;
  }
  await dbPut(STORE_CONFIG, { key: CONFIG_KEY_DRIVE_CLIENT_ID, value: entered });
  return entered;
}

async function getStoredDriveToken() {
  const entry = await dbGet(STORE_CONFIG, CONFIG_KEY_DRIVE_TOKEN);
  return entry && entry.value ? entry.value : null;
}

async function getValidDriveToken() {
  const tok = await getStoredDriveToken();
  return isTokenValid(tok) ? tok.access_token : null;
}

async function ensureDriveTokenClient() {
  const clientId = await getStoredDriveClientId();
  if (!clientId) return null;
  if (!hasGis()) {
    toast("Google-Login noch nicht geladen", { isError: true });
    return null;
  }
  initTokenClient(clientId, {
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
  return clientId;
}

// Synchroner Handler fuer den Verbinden-Button. KEINE awaits vor
// requestAccessToken, sonst verbraucht das Popup-Blockerverhalten die
// User-Gesture.
function onDriveButtonClick() {
  if (isTokenClientReady()) {
    try {
      requestAccessToken({ silent: false });
    } catch (err) {
      console.error(err);
      toast("Drive-Autorisierung fehlgeschlagen", { isError: true });
    }
    return;
  }
  // Erster Start: Client-ID setup. Das oeffnet KEIN GIS-Popup,
  // sondern bereitet nur den Token-Client vor. Der Nutzer muss danach
  // noch einmal auf Verbinden tippen.
  setupDriveClientIdThenPrepare().catch((err) => {
    console.error(err);
    toast("Drive-Setup fehlgeschlagen", { isError: true });
  });
}

async function setupDriveClientIdThenPrepare() {
  let clientId = await getStoredDriveClientId();
  if (!clientId) {
    clientId = await askForDriveClientId();
    if (!clientId) return;
  }
  await ensureDriveTokenClient();
  await updateDriveBanner();
  toast("Client-ID gespeichert. Erneut auf Verbinden tippen.");
}

async function updateDriveBanner() {
  const banner = document.getElementById("drive-banner");
  const textEl = document.getElementById("drive-banner-text");
  const btn = document.getElementById("drive-connect-btn");
  if (!banner || !textEl || !btn) return;

  const clientId = await getStoredDriveClientId();
  const token = await getStoredDriveToken();

  if (!clientId) {
    textEl.textContent = "Google-Drive-Client-ID einrichten.";
    btn.textContent = "Einrichten";
    banner.hidden = false;
    return;
  }
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

    // Folder-ID cachen.
    let folderId = (await dbGet(STORE_CONFIG, CONFIG_KEY_DRIVE_FOLDER_ID))?.value;
    if (!folderId) {
      folderId = await ensureFolder(token);
      await dbPut(STORE_CONFIG, { key: CONFIG_KEY_DRIVE_FOLDER_ID, value: folderId });
    }

    const filename = buildFilename(rec);
    const uploaded = await uploadMarkdown(token, folderId, filename, rec.markdown);

    await updateRecordingRecord(id, {
      status: "done",
      driveFileId: uploaded.id,
      driveFileName: uploaded.name,
      driveWebViewLink: uploaded.webViewLink || null,
      uploadedAt: new Date().toISOString(),
      errorMessage: null,
    });
    toast("In Drive hochgeladen");
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

// ---------- Recording lifecycle ----------

// currentRec = {
//   kind: "idea" | "meeting",
//   screen: "idea" | "meeting",
//   handle, startTs, timerId, levelEls
// } | null
let currentRec = null;

function clearRecTimer() {
  if (currentRec && currentRec.timerId) {
    clearInterval(currentRec.timerId);
    currentRec.timerId = null;
  }
}

function resetMeetingUi() {
  const stopBtn = document.getElementById("meeting-stop");
  const timerEl = document.getElementById("meeting-timer");
  const note = document.getElementById("meeting-note");
  if (stopBtn) stopBtn.disabled = true;
  if (timerEl) timerEl.textContent = "00:00";
  if (note) note.textContent = "Bildschirm darf dunkel, aber nicht aus.";
  setWaveformLevel(0);
}

function resetIdeaUi() {
  const hint = document.getElementById("idea-hint");
  if (hint) hint.textContent = "Aufnahme laeuft \u2014 einfach sprechen.";
}

function setWaveformLevel(rms) {
  // rms ~ 0..0.3 typisch; auf 0..1 mappen mit sanftem Clipping
  const clipped = Math.min(1, rms / 0.3);
  document.documentElement.style.setProperty("--level", clipped.toFixed(3));
}

function tickTimer() {
  if (!currentRec) return;
  const timerEl = document.getElementById("meeting-timer");
  if (!timerEl) return;
  const sec = Math.floor((performance.now() - currentRec.startTs) / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  timerEl.textContent = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

async function startRecScreen(kind) {
  if (currentRec) return; // bereits aktiv

  const isIdea = kind === "idea";
  const opts = {
    mode: kind,
    maxDurationSec: isIdea
      ? DEFAULTS.IDEA_MAX_DURATION_SEC
      : DEFAULTS.MEETING_MAX_DURATION_SEC,
    onLevel: (rms) => setWaveformLevel(rms),
    onAutoStop: (reason) => {
      // Auto-Stop: Idea speichert; Meeting sollte den Nutzer informieren.
      if (!currentRec) return;
      if (kind === "idea") {
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
  if (isIdea) {
    opts.silence = {
      thresholdRms: DEFAULTS.IDEA_SILENCE_THRESHOLD,
      durationMs: DEFAULTS.IDEA_SILENCE_DURATION_MS,
    };
  }

  try {
    const handle = await startRecording(opts);
    currentRec = {
      kind,
      screen: kind,
      handle,
      startTs: performance.now(),
      timerId: null,
    };

    if (kind === "meeting") {
      const stopBtn = document.getElementById("meeting-stop");
      const note = document.getElementById("meeting-note");
      if (stopBtn) stopBtn.disabled = false;
      if (note) note.textContent = "Bildschirm darf dunkel, aber nicht aus.";
      tickTimer();
      currentRec.timerId = setInterval(tickTimer, 250);
    } else {
      resetIdeaUi();
    }

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

async function finalizeAndSave(titleFromUser = null) {
  if (!currentRec) return;
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

  const newId = await dbAdd(STORE_RECORDINGS, entry);
  toast(rec.kind === "idea" ? "Idee gespeichert" : "Meeting gespeichert");

  // Fire-and-forget Transkription.
  transcribeRecording(Number(newId)).catch((err) =>
    console.error("Transcribe-Start fehlgeschlagen:", err),
  );

  if (rec.kind === "idea") resetIdeaUi();
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
  const title = await askForTitle();
  await finalizeAndSave(title);
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
  if (document.visibilityState === "visible" && currentRec && !wakeLock) {
    requestWakeLock();
  }
});

// ---------- Title modal ----------

async function askForTitle() {
  const modal = document.getElementById("title-modal");
  const categorySel = document.getElementById("meeting-category");
  const input = document.getElementById("title-input");
  const ok = document.getElementById("title-ok");
  if (!modal || !categorySel || !input || !ok) return null;

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
  modal.hidden = false;
  setTimeout(() => categorySel.focus(), 30);

  return new Promise((resolve) => {
    const finish = async () => {
      const category = categorySel.value || "Sonstiges Meeting";
      const suffix = input.value.trim();
      const title = suffix ? `${category} - ${suffix}` : category;

      modal.hidden = true;
      ok.removeEventListener("click", onOk);
      input.removeEventListener("keydown", onKey);
      categorySel.removeEventListener("keydown", onKey);

      try {
        await dbPut(STORE_CONFIG, {
          key: CONFIG_KEY_LAST_CATEGORY,
          value: category,
        });
      } catch {}

      resolve(title);
    };
    const onOk = () => finish();
    const onKey = (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); finish(); }
      else if (ev.key === "Escape") { ev.preventDefault(); finish(); }
    };
    ok.addEventListener("click", onOk);
    input.addEventListener("keydown", onKey);
    categorySel.addEventListener("keydown", onKey);
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
  }

  showScreen(newScreen);

  if (!currentRec && REC_SCREENS.has(newScreen)) {
    startRecScreen(newScreen);
  }
}

function bindButtons() {
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

  const list = document.getElementById("history-list");
  if (list) {
    list.addEventListener("click", (ev) => {
      const li = ev.target.closest(".history-item");
      if (!li) return;
      const id = Number(li.dataset.id);
      if (id) showRecording(id);
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
    || (rec.kind === "idea" ? "Idee" : "Meeting")
    + " \u00b7 " + fmtTime(rec.createdAt);

  body.classList.remove("is-error");
  if (rec.status === "done" && rec.markdown) {
    body.textContent = rec.markdown;
  } else if (rec.status === "transcribing") {
    body.textContent = "Transkription laeuft \u2026";
  } else if (rec.status === "error") {
    body.classList.add("is-error");
    body.textContent = "Fehler bei der Transkription:\n\n" + (rec.errorMessage || "Unbekannter Fehler");
  } else {
    body.textContent = "Noch nicht transkribiert.";
  }

  const needsUpload = !!rec.markdown && !rec.driveFileId;
  const canRetry = rec.status === "error" || needsUpload || (rec.status === "pending" && !rec.markdown);
  if (actions) actions.hidden = !canRetry;
  if (retry) {
    retry.textContent = needsUpload ? "Drive-Upload wiederholen" : "Erneut transkribieren";
    retry.onclick = () => {
      closeMarkdownModal();
      if (needsUpload) {
        uploadRecordingToDrive(id).catch((err) => console.error(err));
      } else {
        transcribeRecording(id).catch((err) => console.error(err));
      }
    };
  }
  modal.hidden = false;
}

document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  const modal = document.getElementById("md-modal");
  if (modal && !modal.hidden) closeMarkdownModal();
});

// ---------- Init ----------

async function init() {
  try {
    await openDb();
  } catch (err) {
    console.error("IndexedDB-Init fehlgeschlagen:", err);
  }
  bindButtons();
  window.addEventListener("hashchange", onHashChange);
  await updateDriveBanner();

  // Token-Client vorbereiten, wenn Client-ID schon konfiguriert ist.
  // (requestAccessToken wird erst bei User-Gesture aufgerufen.)
  try {
    if (await getStoredDriveClientId()) await ensureDriveTokenClient();
  } catch (err) {
    console.debug("Drive-Token-Client-Init:", err);
  }

  // Offene Uploads versuchen (wenn Token noch gueltig).
  if (await getValidDriveToken()) {
    processPendingDriveUploads().catch((err) =>
      console.error("Startup-Uploads fehlgeschlagen:", err),
    );
  }

  const initial = currentScreenId();
  showScreen(initial);
  if (REC_SCREENS.has(initial)) {
    // Direkt-Deeplink auf #idea/#meeting startet Aufnahme.
    startRecScreen(initial);
  }
}

init();
