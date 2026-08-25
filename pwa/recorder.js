// recorder.js — MediaRecorder + optionale Silence-Detection
//
// Exports:
//   startRecording(opts) → Promise<Handle>
//     opts: {
//       mode: "idea" | "meeting",
//       maxDurationSec: number,
//       silence?: { thresholdRms: number, durationMs: number },  // nur idea
//       onLevel?: (rms: number) => void,                         // 0..1, ~20/s
//       onAutoStop?: (reason: "silence" | "maxDuration") => void
//     }
//   Handle = {
//     stop(): Promise<{ blob, mimeType, durationSec }>,
//     cancel(): void,    // stream + recorder teardown ohne Blob
//     pause(): boolean,  // true, wenn der Zustand gewechselt hat
//     resume(): boolean,
//     isPaused(): boolean,
//     getDurationSec(): number   // Pausen sind herausgerechnet
//   }

const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

function pickMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  for (const t of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

export async function startRecording(opts) {
  const {
    mode,
    maxDurationSec,
    silence,
    onLevel,
    onAutoStop,
  } = opts;

  // Idee: Diktat aus der Naehe -> DSP-Aufbereitung hilft (NS/AGC an).
  // Meeting: mehrere Sprecher im Raum -> Rohsignal ist besser. NS/AGC
  // schneiden leise/entfernte Sprecher weg und pumpen den Raumpegel, was
  // Sprechertrennung und Vollstaendigkeit verschlechtert.
  const isMeeting = mode === "meeting";
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: isMeeting
      ? {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        }
      : {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
  });

  const mimeType = pickMimeType();
  // Idee: 32 kbps Opus mono ist fuer einen nahen Sprecher transparent.
  // Meeting: 96 kbps erhaelt die Timbre-/Raum-Cues, auf denen Sprecher-
  // trennung und das Erfassen leiser Stimmen beruhen (60 min ~ 43 MB).
  const recorderOpts = { audioBitsPerSecond: isMeeting ? 96000 : 32000 };
  if (mimeType) recorderOpts.mimeType = mimeType;
  const recorder = new MediaRecorder(stream, recorderOpts);

  const chunks = [];
  recorder.addEventListener("dataavailable", (ev) => {
    if (ev.data && ev.data.size > 0) chunks.push(ev.data);
  });

  let stopResolve;
  let stopReject;
  const stopped = new Promise((res, rej) => {
    stopResolve = res;
    stopReject = rej;
  });
  recorder.addEventListener("stop", () => stopResolve());
  recorder.addEventListener("error", (ev) => stopReject(ev.error || new Error("MediaRecorder error")));

  const startTs = performance.now();
  recorder.start(/* timeslice */);

  // ---- Timers / analysis ----
  let audioCtx = null;
  let analyser = null;
  let sourceNode = null;
  let buf = null;
  let rafId = null;

  let maxTimeoutId = null;
  let finished = false;
  let cancelled = false;

  // Pausen-Buchhaltung. MediaRecorder.pause()/resume() liefert einen
  // durchgehenden, gueltigen Container -- anders als ein nachtraeglicher
  // Byte-Schnitt, der genau daran scheiterte.
  let pausedTotalMs = 0;
  let pausedAt = null;

  function getDurationSec() {
    const laufendePause = pausedAt == null ? 0 : performance.now() - pausedAt;
    const netto = performance.now() - startTs - pausedTotalMs - laufendePause;
    return Math.max(0, netto / 1000);
  }

  function cleanupAnalysis() {
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;
    if (sourceNode) {
      try { sourceNode.disconnect(); } catch {}
    }
    if (audioCtx && audioCtx.state !== "closed") {
      audioCtx.close().catch(() => {});
    }
    audioCtx = null;
    analyser = null;
    sourceNode = null;
    buf = null;
  }

  function teardownStream() {
    for (const track of stream.getTracks()) {
      try { track.stop(); } catch {}
    }
  }

  // Hard max duration. Die Obergrenze zaehlt aufgenommene Zeit, nicht
  // Wanduhrzeit -- eine Pause verlaengert das Zeitfenster entsprechend.
  let maxRestMs = maxDurationSec > 0 ? maxDurationSec * 1000 : 0;
  let maxArmedAt = null;

  function armMaxTimer() {
    if (!(maxRestMs > 0) || finished || cancelled) return;
    maxArmedAt = performance.now();
    maxTimeoutId = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { recorder.stop(); } catch {}
      if (onAutoStop) onAutoStop("maxDuration");
    }, maxRestMs);
  }

  function disarmMaxTimer() {
    if (maxTimeoutId == null) return;
    clearTimeout(maxTimeoutId);
    maxTimeoutId = null;
    if (maxArmedAt != null) {
      maxRestMs = Math.max(0, maxRestMs - (performance.now() - maxArmedAt));
      maxArmedAt = null;
    }
  }

  armMaxTimer();

  // Optional live-level + silence detection
  if (onLevel || silence) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
      sourceNode = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.6;
      sourceNode.connect(analyser);
      buf = new Float32Array(analyser.fftSize);

      const thresh = silence?.thresholdRms ?? 0;
      const silenceMs = silence?.durationMs ?? 0;
      let speechSeen = false;
      let silenceStart = null;
      let lastLevelTick = 0;

      const tick = () => {
        if (finished || cancelled) return;

        // Waehrend der Pause liefert der Analyser Stille. Liefe die
        // Stille-Erkennung weiter, beendete sie die Aufnahme genau dann,
        // wenn der Nutzer sie bewusst angehalten hat -- also im Moment der
        // Stoerung, gegen die die Pause gedacht ist.
        if (pausedAt != null) {
          silenceStart = null;
          if (onLevel) { try { onLevel(0); } catch {} }
          rafId = requestAnimationFrame(tick);
          return;
        }

        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);

        if (onLevel) {
          const now = performance.now();
          if (now - lastLevelTick > 50) {
            lastLevelTick = now;
            try { onLevel(rms); } catch {}
          }
        }

        if (silence && thresh > 0 && silenceMs > 0) {
          if (rms >= thresh) {
            speechSeen = true;
            silenceStart = null;
          } else if (speechSeen) {
            if (silenceStart == null) silenceStart = performance.now();
            else if (performance.now() - silenceStart >= silenceMs) {
              finished = true;
              disarmMaxTimer();
              try { recorder.stop(); } catch {}
              if (onAutoStop) onAutoStop("silence");
              return;
            }
          }
        }

        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    } catch (err) {
      console.warn("Audio-Analyse nicht verfuegbar:", err);
      cleanupAnalysis();
    }
  }

  return {
    getDurationSec,

    isPaused() {
      return pausedAt != null;
    },

    // Geben true zurueck, wenn der Zustand tatsaechlich gewechselt hat.
    // Der Aufrufer richtet seine Anzeige danach aus, statt einen eigenen
    // Zustand mitzufuehren, der auseinanderlaufen koennte.
    pause() {
      if (finished || cancelled || pausedAt != null) return false;
      if (recorder.state !== "recording") return false;
      try { recorder.pause(); } catch { return false; }
      pausedAt = performance.now();
      disarmMaxTimer();
      if (onLevel) { try { onLevel(0); } catch {} }
      return true;
    },

    resume() {
      if (finished || cancelled || pausedAt == null) return false;
      try { recorder.resume(); } catch { return false; }
      pausedTotalMs += performance.now() - pausedAt;
      pausedAt = null;
      armMaxTimer();
      return true;
    },

    async stop() {
      if (finished || cancelled) {
        // Falls bereits durch Auto-Stop ausgeloest, auf stopped warten.
      } else {
        finished = true;
        disarmMaxTimer();
        try { recorder.stop(); } catch {}
      }
      await stopped;
      cleanupAnalysis();
      teardownStream();
      const durationSec = getDurationSec();
      const type = recorder.mimeType || mimeType || "audio/webm";
      const blob = new Blob(chunks, { type });
      return { blob, mimeType: type, durationSec };
    },

    cancel() {
      if (cancelled) return;
      cancelled = true;
      finished = true;
      disarmMaxTimer();
      cleanupAnalysis();
      if (recorder.state !== "inactive") {
        try { recorder.stop(); } catch {}
      }
      teardownStream();
    },
  };
}
