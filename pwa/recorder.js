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
//     getDurationSec(): number
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

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const mimeType = pickMimeType();
  const recorderOpts = mimeType ? { mimeType } : undefined;
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

  function getDurationSec() {
    return Math.max(0, (performance.now() - startTs) / 1000);
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

  function clearMaxTimer() {
    if (maxTimeoutId != null) clearTimeout(maxTimeoutId);
    maxTimeoutId = null;
  }

  // Hard max duration
  if (maxDurationSec > 0) {
    maxTimeoutId = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { recorder.stop(); } catch {}
      if (onAutoStop) onAutoStop("maxDuration");
    }, maxDurationSec * 1000);
  }

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
              clearMaxTimer();
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

    async stop() {
      if (finished || cancelled) {
        // Falls bereits durch Auto-Stop ausgeloest, auf stopped warten.
      } else {
        finished = true;
        clearMaxTimer();
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
      clearMaxTimer();
      cleanupAnalysis();
      if (recorder.state !== "inactive") {
        try { recorder.stop(); } catch {}
      }
      teardownStream();
    },
  };
}
