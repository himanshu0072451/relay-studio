"use strict";
require("dotenv").config();
const express = require("express");
const http = require("http");
const os = require("os");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 8787);
const ESP_TOKEN = process.env.ESP_TOKEN;
const MIN_EVENT_GAP_MS = 220;
const MAX_EVENTS = 1600;
const MAX_PLAN_MS = 10 * 60 * 1000;

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public", { extensions: ["html"] }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

let immediateQueue = [];
let scheduledEvents = [];
let playbackStartAt = 0;
let lastCommandAt = 0;
let latestMask = 0;
let lastEspSeen = 0;
let droppedEvents = 0;

function maskValid(mask) {
  return Number.isInteger(mask) && mask >= 0 && mask <= 15;
}
function publicStatus() {
  return {
    espOnline: Date.now() - lastEspSeen < 3500,
    lastEspSeen: lastEspSeen || null,
    mask: latestMask,
    queued: immediateQueue.length + scheduledEvents.length,
    playbackScheduled: scheduledEvents.length > 0,
    droppedEvents,
  };
}
function broadcast(type, extra = {}) {
  const msg = JSON.stringify({ type, status: publicStatus(), ...extra });
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(msg);
}
function safeCommand(body) {
  if (!body || !maskValid(body.mask)) return null;
  const durationMs =
    body.durationMs === undefined ? 0 : Number(body.durationMs);
  if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > 500)
    return null;
  return { mask: body.mask, durationMs };
}
function queueImmediate(command) {
  // Keep queues bounded; a stop command is always allowed to clear backlog.
  if (immediateQueue.length >= 80)
    immediateQueue.splice(0, immediateQueue.length - 40);
  immediateQueue.push({ ...command, dueAt: Date.now() });
}
function requireEsp(req, res, next) {
  const supplied = req.header("x-esp-token") || req.query.token;
  if (!ESP_TOKEN || supplied !== ESP_TOKEN)
    return res.status(401).json({ error: "ESP authentication failed" });
  next();
}

app.get("/api/health", (_req, res) =>
  res.json({ ok: true, name: "Relay Studio", status: publicStatus() }),
);
app.get("/api/status", (_req, res) => res.json(publicStatus()));
app.post("/api/command", (req, res) => {
  const command = safeCommand(req.body);
  if (!command)
    return res.status(400).json({
      error: "Invalid command. mask must be 0..15 and durationMs 0..500.",
    });
  if (Date.now() - lastCommandAt < 12)
    return res.status(429).json({ error: "Command rate limited." });
  lastCommandAt = Date.now();
  // Immediate manual/piano commands cancel queued song events to prevent overlap.
  scheduledEvents = [];
  playbackStartAt = 0;
  queueImmediate(command);
  broadcast("status");
  res.json({ ok: true, status: publicStatus() });
});
app.post("/api/song/start", (req, res) => {
  const events = req.body && req.body.events;
  if (
    !Array.isArray(events) ||
    events.length < 1 ||
    events.length > MAX_EVENTS
  ) {
    return res
      .status(400)
      .json({ error: `events must contain 1..${MAX_EVENTS} entries.` });
  }
  const parsed = [];
  let prevAt = -1;
  for (const item of events) {
    const atMs = Number(item.atMs);
    const mask = Number(item.mask);
    const durationMs =
      item.durationMs === undefined ? 110 : Number(item.durationMs);
    if (
      !Number.isInteger(atMs) ||
      atMs < 0 ||
      atMs > MAX_PLAN_MS ||
      (prevAt >= 0 && atMs < prevAt + MIN_EVENT_GAP_MS) ||
      !maskValid(mask) ||
      mask === 0 ||
      !Number.isInteger(durationMs) ||
      durationMs < 80 ||
      durationMs > 220
    ) {
      return res.status(400).json({
        error:
          "Invalid events: events must be spaced at least 220ms apart; use nonzero masks and 80..220ms pulses.",
      });
    }
    parsed.push({ atMs, mask, durationMs });
    prevAt = atMs;
  }
  immediateQueue = [];
  playbackStartAt = Date.now() + 500;
  scheduledEvents = parsed;
  droppedEvents = 0;
  broadcast("playback", { playbackStartAt, eventCount: parsed.length });
  res.json({ ok: true, playbackStartAt, eventCount: parsed.length });
});
app.post("/api/stop", (_req, res) => {
  scheduledEvents = [];
  playbackStartAt = 0;
  immediateQueue = [{ mask: 0, durationMs: 0, dueAt: Date.now() }];
  latestMask = 0;
  broadcast("stopped");
  res.json({ ok: true });
});
app.get("/api/esp/next", requireEsp, (req, res) => {
  lastEspSeen = Date.now();
  let command = null;
  if (immediateQueue.length) command = immediateQueue.shift();
  else if (
    scheduledEvents.length &&
    playbackStartAt &&
    Date.now() >= playbackStartAt + scheduledEvents[0].atMs
  ) {
    const e = scheduledEvents.shift();
    command = { mask: e.mask, durationMs: e.durationMs, dueAt: Date.now() };
    if (!scheduledEvents.length) playbackStartAt = 0;
  }
  if (command) latestMask = command.mask;
  broadcast("status");
  res.json(
    command
      ? { mask: command.mask, durationMs: command.durationMs }
      : { mask: -1, durationMs: 0 },
  );
});
app.post("/api/esp/report", requireEsp, (req, res) => {
  lastEspSeen = Date.now();
  if (maskValid(req.body && req.body.mask)) latestMask = req.body.mask;
  broadcast("status");
  res.json({ ok: true });
});
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "status", status: publicStatus() }));
});
function lanAddresses() {
  const found = [];
  for (const entries of Object.values(os.networkInterfaces()))
    for (const item of entries || []) {
      if (item.family === "IPv4" && !item.internal) found.push(item.address);
    }
  return found;
}
server.listen(PORT, "0.0.0.0", () => {
  console.log("\nRelay Studio is running.");
  console.log(`Dashboard: http://localhost:${PORT}`);
  for (const ip of lanAddresses())
    console.log(`LAN:       http://${ip}:${PORT}`);
  console.log(
    `ESP token: ${ESP_TOKEN === "change-this-local-token" ? "DEFAULT — change before use" : "configured"}\n`,
  );
  console.log(
    "Keep this server on a trusted private LAN. Do not port-forward it to the internet.",
  );
});
