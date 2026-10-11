"use strict";
const $ = (id) => document.getElementById(id);
const COLORS = ["#ff5d6c", "#7a8cff", "#64e3a1", "#ffc86b"];
const KEY_DATA = [
  { note: "C", key: "A", mask: 1 },
  { note: "D", key: "S", mask: 2 },
  { note: "E", key: "D", mask: 4 },
  { note: "F", key: "F", mask: 8 },
  { note: "G", key: "G", mask: 3 },
  { note: "A", key: "H", mask: 6 },
  { note: "B", key: "J", mask: 12 },
  { note: "C+", key: "K", mask: 9 },
];
let status = { espOnline: false, mask: 0, queued: 0 };
let audioUrl = null,
  decodedAudio = null,
  events = [],
  currentFile = null,
  analysisBpm = null;
let audioContext = null,
  analysisBusy = false,
  toastTimer = null;
let activeKeys = new Set(),
  keyStartAt = new Map(),
  keyUpTimers = new Map(),
  latestSentMask = -1;
const audio = $("audio");

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
}
function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "00:00";
  const m = Math.floor(seconds / 60),
    s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function setConnection(isOnline, seen) {
  ["sideDot", "topDot", "pianoDot"].forEach((id) =>
    $(id).classList.toggle("online", isOnline),
  );
  $("sideConnection").textContent = isOnline
    ? "ESP32 connected"
    : "Waiting for ESP32";
  $("topConnection").textContent = isOnline ? "ESP32 online" : "ESP32 offline";
  $("lastSeen").textContent = isOnline
    ? "Heartbeat received"
    : seen
      ? `Last seen ${formatTime((Date.now() - seen) / 1000)} ago`
      : "Waiting for heartbeat";
  $("pianoStatus").textContent = isOnline
    ? "Ready for live input"
    : "Connect ESP32 to play";
  $("channelLink").textContent = isOnline
    ? "Connected over local Wi-Fi"
    : "Not connected";
  $("channelAddress").textContent = isOnline
    ? "Dashboard and ESP32 are exchanging commands."
    : "Check Wi-Fi and the laptop IP in the firmware.";
}
function updateStatus(next) {
  if (!next) return;
  status = { ...status, ...next };
  setConnection(!!status.espOnline, status.lastEspSeen);
  $("eventCount").textContent = String(status.queued ?? 0);
  renderChannels();
}
function connectSocket() {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${scheme}//${location.host}/ws`);
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.status) updateStatus(msg.status);
    } catch {}
  };
  ws.onclose = () => setTimeout(connectSocket, 1500);
  ws.onerror = () => ws.close();
}
async function refreshStatus() {
  try {
    updateStatus(await api("/api/status"));
  } catch (e) {
    toast(e.message);
  }
}
async function sendCommand(mask, durationMs = 0) {
  if (mask === latestSentMask && durationMs === 0) return;
  try {
    await api("/api/command", {
      method: "POST",
      body: JSON.stringify({ mask, durationMs }),
    });
    latestSentMask = mask;
  } catch (e) {
    toast(e.message);
  }
}
async function stopAll(showToast = true) {
  try {
    await api("/api/stop", { method: "POST", body: "{}" });
  } catch (e) {
    toast(e.message);
  }
  try {
    audio.pause();
    audio.currentTime = 0;
  } catch {}
  $("playBtn").textContent = "▶";
  $("seekBar").value = 0;
  $("currentTime").textContent = "00:00";
  activeKeys.clear();
  keyStartAt.clear();
  document
    .querySelectorAll(".piano-key")
    .forEach((k) => k.classList.remove("active"));
  latestSentMask = 0;
  renderChannels();
  if (showToast) toast("Stop command sent · all relays OFF");
}
$("globalStop").addEventListener("click", () => stopAll());
$("stopSongBtn").addEventListener("click", () => stopAll());
$("pianoAllOff").addEventListener("click", () => {
  activeKeys.clear();
  keyStartAt.clear();
  document
    .querySelectorAll(".piano-key")
    .forEach((k) => k.classList.remove("active"));
  sendCommand(0, 0);
});
$("refreshStatus").addEventListener("click", refreshStatus);

// Sidebar view navigation.
document.querySelectorAll(".nav-item").forEach((btn) =>
  btn.addEventListener("click", () => {
    document
      .querySelectorAll(".nav-item")
      .forEach((b) => b.classList.toggle("active", b === btn));
    document
      .querySelectorAll(".view")
      .forEach((v) =>
        v.classList.toggle("active", v.id === `view-${btn.dataset.view}`),
      );
    const titles = {
      studio: "Music studio",
      piano: "Live piano",
      channels: "Relay channels",
    };
    $("pageTitle").innerHTML =
      `${titles[btn.dataset.view]} <span class="live-pill"><i></i> LOCAL</span>`;
  }),
);

function drawWaveform(channel, duration) {
  const canvas = $("waveform"),
    ctx = canvas.getContext("2d");
  const w = canvas.width,
    h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0e1118";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#242b38";
  ctx.lineWidth = 1;
  for (let y = 20; y < h; y += 20) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  const samplesPerPixel = Math.max(1, Math.floor(channel.length / w));
  const middle = h / 2;
  ctx.fillStyle = "#b7f36b";
  for (let x = 0; x < w; x++) {
    const start = x * samplesPerPixel,
      end = Math.min(channel.length, start + samplesPerPixel);
    let max = 0;
    for (let i = start; i < end; i += 4)
      max = Math.max(max, Math.abs(channel[i] || 0));
    const bar = Math.max(1, max * (h * 0.43));
    ctx.globalAlpha = 0.45 + Math.min(0.55, max);
    ctx.fillRect(x, middle - bar, 1, bar * 2);
  }
  ctx.globalAlpha = 1;
  $("waveEmpty").classList.add("hidden");
}
function clearTrack() {
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = null;
  decodedAudio = null;
  events = [];
  currentFile = null;
  analysisBpm = null;
  audio.removeAttribute("src");
  audio.load();
  $("trackMeta").classList.add("hidden");
  $("dropzone").classList.remove("hidden");
  $("analysisStatus").textContent = "Waiting for a track";
  $("analysisProgress").style.width = "0%";
  $("onsetCount").textContent = "—";
  $("bpmValue").textContent = "—";
  $("eventCount").textContent = String(status.queued ?? 0);
  $("analyzeBtn").disabled = true;
  $("playBtn").disabled = true;
  $("stopSongBtn").disabled = true;
  $("playRelaysBtn").disabled = true;
  $("seekBar").disabled = true;
  $("waveEmpty").classList.remove("hidden");
  const ctx = $("waveform").getContext("2d");
  ctx.clearRect(0, 0, 800, 120);
}
$("removeTrack").addEventListener("click", clearTrack);
async function loadFile(file) {
  if (!file) return;
  if (
    !/\.(mp3|wav)$/i.test(file.name) &&
    !["audio/mpeg", "audio/wav", "audio/x-wav", "audio/wave"].includes(
      file.type,
    )
  ) {
    toast("Choose an MP3 or WAV file.");
    return;
  }
  if (file.size > 40 * 1024 * 1024) {
    toast("For this local prototype, keep audio files under 40 MB.");
    return;
  }
  clearTrack();
  currentFile = file;
  audioUrl = URL.createObjectURL(file);
  audio.src = audioUrl;
  audio.load();
  $("dropzone").classList.add("hidden");
  $("trackMeta").classList.remove("hidden");
  $("trackName").textContent = file.name;
  $("trackDetails").textContent =
    `${(file.size / 1024 / 1024).toFixed(1)} MB · decoding locally…`;
  $("analyzeBtn").disabled = true;
  $("playBtn").disabled = true;
  $("stopSongBtn").disabled = false;
  $("seekBar").disabled = false;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx)
      throw new Error("Web Audio API is not available in this browser.");
    if (!audioContext) audioContext = new Ctx();
    const buffer = await file.arrayBuffer();
    decodedAudio = await audioContext.decodeAudioData(buffer.slice(0));
    if (decodedAudio.duration > 600)
      toast(
        "Tracks longer than 10 minutes will be analyzed only for the first 10 minutes.",
      );
    const ch = decodedAudio.getChannelData(0);
    drawWaveform(ch, decodedAudio.duration);
    $("trackDetails").textContent =
      `${formatTime(decodedAudio.duration)} · ${(file.size / 1024 / 1024).toFixed(1)} MB · decoded locally`;
    $("totalTime").textContent = formatTime(decodedAudio.duration);
    $("analyzeBtn").disabled = false;
    $("playBtn").disabled = false;
    $("analysisStatus").textContent = "Ready to analyze";
    toast("Track loaded. Run rhythm analysis when ready.");
  } catch (e) {
    toast(`Could not decode audio: ${e.message}`);
    clearTrack();
  }
}
$("songFile").addEventListener("change", (e) => loadFile(e.target.files[0]));
const dropzone = $("dropzone");
["dragenter", "dragover"].forEach((type) =>
  dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  }),
);
["dragleave", "drop"].forEach((type) =>
  dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  }),
);
dropzone.addEventListener("drop", (e) => loadFile(e.dataTransfer.files[0]));

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
async function analyzeAudio() {
  if (!decodedAudio || analysisBusy) return;
  analysisBusy = true;
  $("analyzeBtn").disabled = true;
  $("playRelaysBtn").disabled = true;
  $("analysisStatus").textContent = "Analyzing energy and onsets…";
  $("analysisProgress").style.width = "5%";
  try {
    const channel = decodedAudio.getChannelData(0);
    const sampleRate = decodedAudio.sampleRate;
    const frameMs = 50,
      frameSize = Math.floor((sampleRate * frameMs) / 1000);
    const totalFrames = Math.min(
      Math.floor(channel.length / frameSize),
      Math.floor(600000 / frameMs),
    );
    const rms = new Float32Array(totalFrames);
    for (let f = 0; f < totalFrames; f++) {
      let sum = 0,
        start = f * frameSize,
        end = Math.min(channel.length, start + frameSize);
      for (let i = start; i < end; i += 2) sum += channel[i] * channel[i];
      rms[f] = Math.sqrt(sum / Math.max(1, Math.ceil((end - start) / 2)));
      if (f % 800 === 0) {
        $("analysisProgress").style.width =
          `${Math.min(55, 5 + (f / totalFrames) * 50)}%`;
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    // Positive spectral-energy proxy: positive RMS change, smoothed over a short window.
    const flux = new Float32Array(totalFrames);
    let mean = 0,
      variance = 0;
    for (let i = 1; i < totalFrames; i++) {
      flux[i] =
        Math.max(0, rms[i] - rms[i - 1]) +
        Math.max(0, rms[i] - rms[Math.max(0, i - 3)]) * 0.35;
      mean += flux[i];
    }
    mean /= Math.max(1, totalFrames - 1);
    for (let i = 1; i < totalFrames; i++) variance += (flux[i] - mean) ** 2;
    const std = Math.sqrt(variance / Math.max(1, totalFrames - 1));
    const sensitivity = Number($("sensitivity").value);
    const threshold = mean + std * (1.8 - sensitivity * 0.22);
    const candidates = [];
    for (let i = 2; i < totalFrames - 2; i++) {
      if (
        flux[i] > threshold &&
        flux[i] >= flux[i - 1] &&
        flux[i] > flux[i + 1] &&
        rms[i] > 0.004
      )
        candidates.push({ frame: i, strength: flux[i] });
    }
    // Keep only well-spaced peaks so mechanical relays do not chatter continuously.
    candidates.sort((a, b) => a.frame - b.frame);
    const minGapFrames = Math.ceil(220 / frameMs),
      chosen = [];
    for (const c of candidates) {
      if (
        !chosen.length ||
        c.frame - chosen[chosen.length - 1].frame >= minGapFrames
      )
        chosen.push(c);
      else if (c.strength > chosen[chosen.length - 1].strength)
        chosen[chosen.length - 1] = c;
    }
    const peak = Math.max(
      ...Array.from(flux).slice(0, Math.min(totalFrames, 12000)),
      0.000001,
    );
    const clickMs = Number($("strength").value);
    events = chosen.slice(0, 1600).map((c, i) => {
      const normalized = c.strength / peak;
      let mask = 1 << (i % 4);
      if (normalized > 0.45) mask |= 1 << ((i + 1) % 4);
      if (normalized > 0.72) mask |= 1 << ((i + 2) % 4);
      return {
        atMs: Math.round(c.frame * frameMs),
        mask,
        durationMs: Math.min(160, Math.max(80, clickMs)),
      };
    });
    // If the file has too few sharp attacks, use the strongest local energy peaks as a fallback.
    if (events.length < 4 && totalFrames > 20) {
      const fallback = [];
      for (let i = 4; i < totalFrames - 4; i += 4) {
        const local = Math.max(
          ...Array.from(
            rms.slice(Math.max(0, i - 2), Math.min(totalFrames, i + 3)),
          ),
        );
        if (rms[i] === local && rms[i] > 0.015)
          fallback.push({ frame: i, strength: rms[i] });
      }
      for (const c of fallback) {
        if (
          !events.length ||
          c.frame * frameMs - events[events.length - 1].atMs >= 220
        )
          events.push({
            atMs: c.frame * frameMs,
            mask: 1 << (events.length % 4),
            durationMs: Math.min(160, Math.max(80, clickMs)),
          });
        if (events.length >= 1600) break;
      }
    }
    const intervals = [];
    for (let i = 1; i < chosen.length; i++) {
      const d = (chosen[i].frame - chosen[i - 1].frame) * frameMs;
      if (d >= 280 && d <= 1000) intervals.push(d);
    }
    analysisBpm = intervals.length
      ? Math.round(60000 / median(intervals))
      : null;
    if (analysisBpm && (analysisBpm < 50 || analysisBpm > 200))
      analysisBpm = null;
    $("onsetCount").textContent = String(events.length);
    $("bpmValue").textContent = analysisBpm ? String(analysisBpm) : "—";
    $("eventCount").textContent = String(events.length);
    $("analysisStatus").textContent = events.length
      ? `Found ${events.length} candidate clicks`
      : "No strong onsets found";
    $("analysisProgress").style.width = "100%";
    $("playRelaysBtn").disabled = !events.length;
    if (!events.length)
      toast(
        "No clear rhythmic peaks found. Try raising sensitivity or choosing a louder track.",
      );
    else toast(`Analysis ready · ${events.length} relay events`);
  } catch (e) {
    toast(`Analysis failed: ${e.message}`);
    $("analysisStatus").textContent = "Analysis failed";
  } finally {
    analysisBusy = false;
    $("analyzeBtn").disabled = !decodedAudio;
  }
}
$("analyzeBtn").addEventListener("click", analyzeAudio);
$("sensitivity").addEventListener("input", () => {
  $("sensitivityValue").textContent = [
    "",
    "Low",
    "Gentle",
    "Balanced",
    "Sensitive",
    "High",
  ][Number($("sensitivity").value)];
});
$("strength").addEventListener("input", () => {
  const n = Number($("strength").value);
  $("strengthValue").textContent =
    n < 115 ? "Short" : n < 160 ? "Medium" : "Long";
});
$("pianoDuration").addEventListener(
  "input",
  () =>
    ($("pianoDurationValue").textContent =
      `${$("pianoDuration").value} ms minimum hold`),
);
$("playBtn").addEventListener("click", async () => {
  if (!audio.src) return;
  if (audio.paused) {
    try {
      await audio.play();
      $("playBtn").textContent = "Ⅱ";
    } catch (e) {
      toast("Browser could not play this file.");
    }
  } else {
    audio.pause();
    $("playBtn").textContent = "▶";
  }
});
audio.addEventListener("timeupdate", () => {
  $("currentTime").textContent = formatTime(audio.currentTime);
  if (audio.duration)
    $("seekBar").value = String(
      Math.round((audio.currentTime / audio.duration) * 1000),
    );
});
audio.addEventListener("ended", () => {
  $("playBtn").textContent = "▶";
  if (status.queued || events.length) stopAll(false);
});
$("seekBar").addEventListener("input", () => {
  if (audio.duration)
    audio.currentTime = (audio.duration * Number($("seekBar").value)) / 1000;
});
$("playRelaysBtn").addEventListener("click", async () => {
  if (!events.length) return;
  if (!status.espOnline) {
    toast("ESP32 is offline. Connect it to the same Wi-Fi as this laptop.");
    return;
  }
  try {
    await stopAll(false);
    const data = await api("/api/song/start", {
      method: "POST",
      body: JSON.stringify({ events }),
    });
    const delay = Math.max(0, data.playbackStartAt - Date.now());
    audio.currentTime = 0;
    setTimeout(async () => {
      try {
        await audio.play();
        $("playBtn").textContent = "Ⅱ";
      } catch {
        toast("Allow audio playback in your browser, then press play.");
      }
    }, delay);
    toast(`Playback scheduled · ${data.eventCount} relay clicks`);
  } catch (e) {
    toast(e.message);
  }
});

// Piano: eight keys map to safe nonzero relay masks. Key releases are held at least 130ms.
function pianoMask() {
  let mask = 0;
  for (const key of activeKeys) {
    const item = KEY_DATA.find((k) => k.key === key);
    if (item) mask |= item.mask;
  }
  return mask;
}
function paintKey(key, on) {
  const el = document.querySelector(`[data-key="${key}"]`);
  if (el) el.classList.toggle("active", on);
}
function pianoDown(key) {
  key = String(key).toUpperCase();
  const item = KEY_DATA.find((k) => k.key === key);
  if (!item || activeKeys.has(key)) return;
  activeKeys.add(key);
  keyStartAt.set(key, performance.now());
  paintKey(key, true);
  sendCommand(pianoMask(), 0);
}
function pianoUp(key) {
  key = String(key).toUpperCase();
  if (!activeKeys.has(key)) return;
  const elapsed = performance.now() - (keyStartAt.get(key) || 0),
    wait = Math.max(0, 130 - elapsed);
  clearTimeout(keyUpTimers.get(key));
  keyUpTimers.set(
    key,
    setTimeout(() => {
      activeKeys.delete(key);
      keyStartAt.delete(key);
      paintKey(key, false);
      sendCommand(pianoMask(), 0);
    }, wait),
  );
}
function buildPiano() {
  const wrap = $("pianoKeys");
  wrap.innerHTML = "";
  KEY_DATA.forEach((item) => {
    const btn = document.createElement("button");
    btn.className = "piano-key";
    btn.dataset.key = item.key;
    btn.innerHTML = `<b>${item.note}</b><small>R${[1, 2, 3, 4].filter((_, i) => item.mask & (1 << i)).join("+R")}</small><span class="key-shortcut">KEY ${item.key}</span>`;
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      pianoDown(item.key);
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach((type) =>
      btn.addEventListener(type, () => pianoUp(item.key)),
    );
    wrap.appendChild(btn);
  });
}
document.addEventListener("keydown", (e) => {
  if (e.repeat || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName))
    return;
  if (KEY_DATA.some((k) => k.key === e.key.toUpperCase())) {
    e.preventDefault();
    pianoDown(e.key);
  }
});
document.addEventListener("keyup", (e) => {
  if (KEY_DATA.some((k) => k.key === e.key.toUpperCase())) {
    e.preventDefault();
    pianoUp(e.key);
  }
});

function renderChannels() {
  const wrap = $("channelGrid");
  if (!wrap.dataset.ready) {
    wrap.innerHTML = "";
    for (let i = 0; i < 4; i++) {
      const card = document.createElement("div");
      card.className = "channel-card";
      card.dataset.channel = String(i);
      card.innerHTML = `<div class="channel-head"><span class="channel-number">OUTPUT 0${i + 1}</span><span class="channel-led"></span></div><h3>Relay ${i + 1}</h3><p>GPIO ${[16, 17, 18, 19][i]} · pulse test</p><button class="button secondary" data-pulse="${i}">Pulse 180 ms ↗</button>`;
      card.querySelector("button").addEventListener("click", async () => {
        if (!status.espOnline) {
          toast("ESP32 offline.");
          return;
        }
        await sendCommand(1 << i, 180);
        toast(`Relay ${i + 1} pulse queued`);
      });
      wrap.appendChild(card);
    }
    wrap.dataset.ready = "1";
  }
  for (let i = 0; i < 4; i++) {
    const card = wrap.querySelector(`[data-channel="${i}"]`);
    if (card) card.classList.toggle("on", !!(status.mask & (1 << i)));
  }
}
buildPiano();
renderChannels();
connectSocket();
refreshStatus();
setInterval(refreshStatus, 2000);
window.addEventListener("beforeunload", () => {
  try {
    navigator.sendBeacon("/api/stop", "{}");
  } catch {}
});
