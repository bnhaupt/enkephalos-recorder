// config.example.js
//
// Kopiere diese Datei als config.js und trage deine Keys ein.
// config.js ist in .gitignore und wird NICHT committet.
//
// Der Gemini-API-Key kann auch beim ersten Start der PWA abgefragt
// und in IndexedDB gespeichert werden — das ist die sicherere Option.
// Dieses Template ist nur der Fallback fuer lokale Entwicklung.

export const CONFIG = {
  // Gemini API
  GEMINI_API_KEY: "DEIN_GEMINI_API_KEY_HIER",
  GEMINI_MODEL: "gemini-2.5-flash",

  // Google Drive OAuth
  GOOGLE_OAUTH_CLIENT_ID: "DEINE_CLIENT_ID.apps.googleusercontent.com",
  GOOGLE_DRIVE_FOLDER_NAME: "Enkephalos-Inbox",

  // Aufnahme-Parameter
  IDEA_MAX_DURATION_SEC: 120,       // Kurze Idee: Max 2 Minuten
  IDEA_SILENCE_THRESHOLD: 0.02,     // RMS-Schwelle fuer Silence Detection
  IDEA_SILENCE_DURATION_MS: 3000,   // 3s Stille = Stop

  MEETING_MAX_DURATION_SEC: 3900,   // Meeting: Max 65 Minuten (Puffer)
  MEETING_AUTO_SPLIT_MIN: 30,       // Bei >30 Min fuer Gemini splitten

  // Upload
  UPLOAD_RETRY_ATTEMPTS: 3,
  UPLOAD_RETRY_DELAY_MS: 2000,
};
