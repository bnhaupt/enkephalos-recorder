// drive.js — Google Drive v3 Client
//
// Nutzt Google Identity Services (GIS) fuer OAuth-Token (scope: drive.file)
// und die Drive-API v3 fuer Ordner + Multipart-Upload. Alle Funktionen sind
// token-los entworfen: ein gueltiger access_token wird vom Aufrufer uebergeben.

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const DEFAULT_FOLDER_NAME = "Enkephalos-Inbox";

async function readErr(res) {
  try { return (await res.text()).slice(0, 600); } catch { return ""; }
}

// ---------- Token client (GIS) ----------

let _tokenClient = null;
let _tokenClientId = null;
let _tokenCallback = null;
let _tokenErrorCallback = null;

export function hasGis() {
  return typeof window !== "undefined"
    && typeof window.google !== "undefined"
    && window.google.accounts
    && window.google.accounts.oauth2;
}

export function isTokenClientReady() {
  return _tokenClient !== null;
}

export function initTokenClient(clientId, { onToken, onError } = {}) {
  if (!hasGis()) throw new Error("Google Identity Services nicht geladen");
  _tokenCallback = onToken || null;
  _tokenErrorCallback = onError || null;
  if (_tokenClient && _tokenClientId === clientId) return _tokenClient;
  _tokenClientId = clientId;
  _tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: DRIVE_SCOPE,
    callback: (resp) => {
      if (resp && resp.access_token) {
        const expiresAt = Date.now() + ((resp.expires_in || 3600) - 60) * 1000;
        const token = { access_token: resp.access_token, expires_at: expiresAt, scope: resp.scope };
        if (_tokenCallback) _tokenCallback(token);
      } else if (resp && resp.error && _tokenErrorCallback) {
        _tokenErrorCallback(new Error(resp.error_description || resp.error));
      }
    },
    error_callback: (err) => {
      if (_tokenErrorCallback) _tokenErrorCallback(err);
    },
  });
  return _tokenClient;
}

// Muss aus User-Gesture heraus aufgerufen werden.
export function requestAccessToken({ silent = false } = {}) {
  if (!_tokenClient) throw new Error("Token-Client nicht initialisiert");
  _tokenClient.requestAccessToken(silent ? { prompt: "" } : {});
}

export function isTokenValid(stored) {
  return !!stored
    && typeof stored.access_token === "string"
    && typeof stored.expires_at === "number"
    && stored.expires_at > Date.now();
}

// ---------- Folder ----------

export async function findFolder(token, name = DEFAULT_FOLDER_NAME) {
  const q = encodeURIComponent(
    `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
  );
  const res = await fetch(
    `${DRIVE_API}/files?q=${q}&fields=files(id,name)&spaces=drive&pageSize=10`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Drive-List ${res.status}: ${await readErr(res)}`);
  const data = await res.json();
  return data.files && data.files.length ? data.files[0].id : null;
}

export async function createFolder(token, name = DEFAULT_FOLDER_NAME) {
  const res = await fetch(`${DRIVE_API}/files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
    }),
  });
  if (!res.ok) throw new Error(`Drive-Create-Folder ${res.status}: ${await readErr(res)}`);
  const data = await res.json();
  return data.id;
}

export async function ensureFolder(token, name = DEFAULT_FOLDER_NAME) {
  const found = await findFolder(token, name);
  if (found) return found;
  return await createFolder(token, name);
}

// ---------- Upload ----------

export async function uploadMarkdown(token, folderId, filename, markdown) {
  const boundary = "----EnkephalosRecorder" + Math.random().toString(36).slice(2);
  const metadata = {
    name: filename,
    parents: [folderId],
    mimeType: "text/markdown",
  };
  const body =
    `--${boundary}\r\n` +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\n` +
    "Content-Type: text/markdown; charset=UTF-8\r\n\r\n" +
    markdown +
    `\r\n--${boundary}--`;

  const res = await fetch(
    `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,name,webViewLink`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  if (!res.ok) throw new Error(`Drive-Upload ${res.status}: ${await readErr(res)}`);
  return await res.json(); // { id, name, webViewLink }
}

// ---------- Filename builder ----------

export function slugify(s) {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/\u00e4/g, "ae")
    .replace(/\u00f6/g, "oe")
    .replace(/\u00fc/g, "ue")
    .replace(/\u00df/g, "ss")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

export function buildFilename(rec) {
  const d = new Date(rec.createdAt || Date.now());
  const pad = (n) => String(n).padStart(2, "0");
  const ts =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  if (rec.kind === "idea") return `${ts}-idee.md`;
  const slug = slugify(rec.title || "") || "ohne-titel";
  return `${ts}-meeting-${slug}.md`;
}
