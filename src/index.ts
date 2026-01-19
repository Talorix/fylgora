#!/usr/bin/env node
import fs from "fs";
import path from "path";
const config = JSON.parse(fs.readFileSync(path.join(process.cwd(), "config.json"), "utf8"));
process.env.dockerSocket = config.docker.socket;
import express, { Request, Response, NextFunction } from "express";
import http from "http";
import WebSocket from "ws";
import { WebSocketServer } from "ws";
import Docker from "dockerode";
import os from "os";
import { promises as fsPromises } from "fs";
import { pathToFileURL } from "url";
import { readData, recreateContainer, writeData } from "./handlers/recreateContainer.js";
import { executeCommand as runCommand } from "./handlers/server/executeCommand.js";
const docker = new Docker({ socketPath: process.env.dockerSocket });
import { spawnSync } from "child_process";
function isTarInstalled(): boolean {
  try {
    const res = spawnSync("tar", ["--version"], { stdio: "ignore" });
    return res.status === 0;
  } catch {
    return false;
  }
}

/* Start FTP server shortly after startup to allow other initialization to complete. */
setTimeout(() => {
  require(path.join(process.cwd(), "src/routers/Utils/Ftp.ts")).startFtpServer();
}, 1000);

const dataPath = path.join(process.cwd(), "data.json");

if (!isTarInstalled()) {
  throw new Error("tar is not installed on this system, please install tar to run fylgora");
}

/* Ensure the data.json file exists; create an empty object file if missing. */
async function ensureDataFile(): Promise<string> {
  try {
    await fsPromises.access(dataPath);
    return "File exists";
  } catch (err) {
    await writeData({});
    return "File created";
  }
}

/* Load data.json into memory and keep `data` up-to-date. */
interface DataEntry {
  containerId?: string;
  disk?: number;
  stopCmd?: string;
  env?: Record<string, string>;
  [key: string]: any;
}

let data: Record<string, DataEntry> | null = null;
(async () => {
  try {
    await ensureDataFile();
    data = await readData();
  } catch (err) {
    console.error("Failed to initialize data.json:", err);
    process.exit(1);
  }
})();

/* Periodically reload data.json from disk if it changed. */
setInterval(async () => {
  try {
    const diskData = await readData();
    if (JSON.stringify(diskData) !== JSON.stringify(data)) {
      data = diskData;
    }
  } catch (err) {
    console.error("reloadData error:", err);
  }
}, 1000);

const app = express();
app.use(express.json());

/* ANSI color helpers for console output. */
const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
} as const;

function ansi(tag: string, color: keyof typeof ANSI, message: string) {
  return `${ANSI[color] || ""}[${tag}]${ANSI.reset} ${message}`;
}

// Decode caret-style control sequences (e.g. '^C') into actual control characters.
// '^X' -> single control character (charCode & 0x1F). Leaves other text intact.
function decodeControlSequences(s: string | undefined | null): string | undefined {
  if (typeof s !== "string") {
    return undefined;
  }
  if (s.length === 0) {
    return s;
  }
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "^" && i + 1 < s.length) {
      const next = s[i + 1];
      const code = next.charCodeAt(0);
      out += String.fromCharCode(code & 0x1f);
      i++; // skip next char
    } else {
      out += ch;
    }
  }
  return out;
}

/* Check if Docker daemon is available. */
async function isDockerRunning(): Promise<boolean> {
  try {
    // docker.ping returns a promise
    // @ts-ignore - dockerode typings may vary depending on version
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

/* Verify that the external panel URL is reachable; exit if not. */
async function isPanelRunning(panelUrl: string): Promise<boolean> {
  try {
    await fetch(panelUrl, {
      method: "GET", // timeout not standard on fetch; keep minimal
    });
    return true;
  } catch (err) {
    console.error(ansi("System", "red", `Cannot reach panel at ${panelUrl}, is it running?`));
    process.exit(1);
  }
}

// start checking panel (don't await here to mimic original behavior)
void isPanelRunning((config as any).panel);

/* Middleware: validate API key on all HTTP routes. */
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.query.key !== (config as any).key) return res.status(401).json({ error: "Invalid key" });
  next();
});

async function loadRoutes(dirPath: string, routePrefix = "/server") {
  const files = fs.readdirSync(dirPath);

  for (const file of files) {
    const fullPath = path.join(dirPath, file);
    const stat = fs.statSync(fullPath);
    if (file === "Ftp.ts") continue; // skip FTP module
    if (stat.isDirectory()) {
      await loadRoutes(fullPath, routePrefix);
    } else if (file.endsWith('.js') || file.endsWith('.ts')) {
      try {
        const url = pathToFileURL(fullPath).href;
        const module = await import(url);
        if (module.default) {
          app.use(routePrefix, module.default);
        }
      } catch (err) {
        console.error(`Failed to load ${fullPath}:`, err);
      }
    }
  }
}

void loadRoutes(path.join(process.cwd(), 'src/routers'));

/* Create HTTP and WebSocket servers. */
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

/* In-memory maps for connected clients, attached log streams, and stats intervals. */
const clients = new Map<string, Set<WebSocket>>();
const logStreams = new Map<string, { stream: any; refCount: number; stopped?: boolean }>();
const statsIntervals = new Map<string, { intervalId: NodeJS.Timeout; refCount: number }>();

/* Recursively compute size (bytes) of a folder. Returns 0 for missing folders. */
async function getFolderSize(dir: string): Promise<number> {
  let total = 0;
  try {
    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) total += await getFolderSize(full);
      else if (entry.isFile()) total += (await fsPromises.stat(full)).size;
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") console.error("getFolderSize error:", err);
  }
  return total;
}

/* Resolve a data.json entry either by full/partial container ID or by idt key. */
function findDataEntryByContainerOridt(containerOridt: string): { idt: string; entry: DataEntry } | null {
  if (!data) return null;
  if (data[containerOridt]) return { idt: containerOridt, entry: data[containerOridt] };
  return null;
}

/* Return container storage usage in GB (number). */
async function getContainerDiskUsage(containerIdOridt: string): Promise<number> {
  const resolved = findDataEntryByContainerOridt(containerIdOridt);
  if (!resolved) return 0;
  const { idt } = resolved;
  const dir = path.join(__dirname, config.servers.folder, idt);
  const bytes = await getFolderSize(dir);
  return bytes / 1e9;
}

/* Send a structured event to a single WebSocket client (JSON payload). */
function sendEvent(ws: WebSocket | null | undefined, event: string, payload: any) {
  if (!ws || (ws as any).readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({ event, payload, ts: new Date().toISOString() }));
  } catch (e) {
    console.error("sendEvent error:", e);
  }
}

/* Broadcast a structured event to all clients attached to an idt or container id. */
function broadcastToContainer(containeridtOrId: string, event: string, payload: any) {
  const recipients = new Set<WebSocket>();
  const directSet = clients.get(containeridtOrId);
  if (directSet) for (const ws of directSet) recipients.add(ws);
  const resolved = findDataEntryByContainerOridt(containeridtOrId);
  if (resolved) {
    const resolvedSet = clients.get(resolved.idt);
    if (resolvedSet) for (const ws of resolvedSet) recipients.add(ws);
  }
  for (const ws of recipients) sendEvent(ws, event, payload);
}

/* Add a WebSocket client under a specific idt key. */
function addClientKey(key: string, ws: WebSocket) {
  const set = clients.get(key) || new Set<WebSocket>();
  set.add(ws);
  clients.set(key, set);
}

/* Remove a WebSocket client from all idt maps and perform cleanup if sets become empty. */
function removeClient(ws: WebSocket) {
  for (const [key, set] of clients.entries()) {
    if (set.has(ws)) {
      set.delete(ws);
      if (set.size === 0) {
        clients.delete(key);
        cleanupLogStreamsByKey(key);
        cleanupStatsByKey(key);
      }
    }
  }
}

/* Destroy and remove stored log stream by containerId. */
function cleanupLogStreamsByContainerId(containerId: string) {
  const entry = logStreams.get(containerId);
  if (!entry) return;
  try { entry.stream.destroy(); } catch (e) { /* ignore destroy errors */ }
  logStreams.delete(containerId);
}

/* Clear and remove stats interval by containerId. */
function cleanupStatsByContainerId(containerId: string) {
  const entry = statsIntervals.get(containerId);
  if (!entry) return;
  clearInterval(entry.intervalId as NodeJS.Timeout);
  statsIntervals.delete(containerId);
}

/* Decrement refCounts and cleanup log streams for either a containerId or idt key. */
function cleanupLogStreamsByKey(key: string) {
  const entry = logStreams.get(key);
  if (entry) {
    entry.refCount--;
    if (entry.refCount <= 0) {
      try { entry.stream.destroy(); } catch (e) { }
      logStreams.delete(key);
    }
    return;
  }

  const resolved = findDataEntryByContainerOridt(key);
  if (resolved) {
    const cid = resolved.entry.containerId;
    const e2 = logStreams.get(cid || "");
    if (e2) {
      e2.refCount--;
      if (e2.refCount <= 0) {
        try { e2.stream.destroy(); } catch (e) { }
        logStreams.delete(cid || "");
      }
    }
  }
}

/* Decrement refCounts and cleanup stats intervals for either a containerId or idt key. */
function cleanupStatsByKey(key: string) {
  const entry = statsIntervals.get(key);
  if (entry) {
    entry.refCount--;
    if (entry.refCount <= 0) {
      clearInterval(entry.intervalId);
      statsIntervals.delete(key);
    }
    return;
  }

  const resolved = findDataEntryByContainerOridt(key);
  if (resolved) {
    const cid = resolved.entry.containerId;
    const e2 = statsIntervals.get(cid || "");
    if (e2) {
      e2.refCount--;
      if (e2.refCount <= 0) {
        clearInterval(e2.intervalId);
        statsIntervals.delete(cid || "");
      }
    }
  }
}

/*
 * Track last log timestamps and content per container to avoid duplicates
 */
const lastContainerLogs = new Map<string, { time: number; content: Set<string> }>();

/*
 * Attach container logs and broadcast raw log chunks to all clients for the idt.
 * Performs disk quota check before attaching and handles reference counting so multiple
 * clients don't create duplicate streams. Includes deduplication logic.
 */
async function streamLogs(ws: WebSocket, container: any, requestedContainerId: string) {
  const resolved = findDataEntryByContainerOridt(requestedContainerId);
  const idt = resolved ? resolved.idt : requestedContainerId;
  const currentContainerId = resolved ? resolved.entry.containerId : requestedContainerId;
  if (!currentContainerId) return sendEvent(ws, "error", "Container ID not found");
  container = docker.getContainer(currentContainerId as any);
  const usage = await getContainerDiskUsage(idt);
  const allowed = resolved && resolved.entry && typeof resolved.entry.disk === "number"
    ? resolved.entry.disk
    : Infinity;

  addClientKey(idt, ws);

  if (usage >= allowed) {
    const info = await container.inspect().catch(() => null);
    if (info && info.State && info.State.Running) {
      try { await container.kill(); } catch (e) { /* ignore */ }
      broadcastToContainer(idt, "power", ansi("Node", "red", "Server disk exceed — container stopped."));
    } else {
      broadcastToContainer(idt, "power", ansi("Node", "red", "Server disk exceed — container blocked."));
    }
    return;
  }

  if (logStreams.has(currentContainerId)) {
    logStreams.get(currentContainerId)!.refCount++;
    return;
  }

  // Initialize deduplication tracking for this container
  if (!lastContainerLogs.has(currentContainerId)) {
    lastContainerLogs.set(currentContainerId, { time: 0, content: new Set<string>() });
  }

  container.logs({ follow: true, stdout: true, stderr: true, tail: 100 }, (err: any, stream: NodeJS.ReadableStream) => {
    if (err) return sendEvent(ws, "error", `Failed to attach logs: ${err.message || err}`);

    logStreams.set(currentContainerId, {
      stream,
      refCount: (clients.get(idt) || new Set()).size,
    });

    const onData = (chunk: Buffer) => {
      const raw = chunk.toString("utf8");
      const now = Date.now();
      const logTracker = lastContainerLogs.get(currentContainerId)!;

      // Check if enough time has passed since last log (800ms threshold)
      if (now - logTracker.time < 800) {
        // Within time window - check if this is a duplicate
        if (logTracker.content.has(raw)) {
          return; // Skip duplicate log
        }
      } else {
        // Time window passed - clear the set for fresh tracking
        logTracker.content.clear();
      }

      // Update tracker
      logTracker.time = now;
      logTracker.content.add(raw);

      // Broadcast to clients
      const set = clients.get(idt) || new Set<WebSocket>();
      for (const client of set) {
        if ((client as any).readyState === WebSocket.OPEN) {
          try { client.send(raw); } catch (e) { /* ignore per-client send errors */ }
        }
      }
    };

    stream.on("data", onData);

    stream.on("error", (err: any) => broadcastToContainer(idt, "error", `Log error: ${err.message}`));

    stream.on("end", () => {
      broadcastToContainer(idt, "power", ansi("Node", "gray", "Log stream ended."));
      if (logStreams.has(currentContainerId)) logStreams.delete(currentContainerId);
      // Clean up deduplication tracker
      if (lastContainerLogs.has(currentContainerId)) {
        lastContainerLogs.delete(currentContainerId);
      }
    });

    if (!logStreams.get(currentContainerId)!.stopped) logStreams.get(currentContainerId)!.stopped = true;

    ws.once("close", () => cleanupLogStreamsByKey(idt));
  });
}

/*
 * Periodically fetch non-streaming container stats and broadcast them to connected clients.
 * Uses a single interval per container and reference counting to avoid duplicate intervals.
 */
async function streamStats(ws: WebSocket, container: any, requestedContainerId: string) {
  const resolved = findDataEntryByContainerOridt(requestedContainerId);
  const idt = resolved ? resolved.idt : requestedContainerId;
  const currentContainerId = resolved ? resolved.entry.containerId : requestedContainerId;

  if (!currentContainerId) return sendEvent(ws, "error", "Container ID not found");
  container = docker.getContainer(currentContainerId);

  addClientKey(idt, ws);

  if (statsIntervals.has(currentContainerId)) {
    statsIntervals.get(currentContainerId)!.refCount++;
    return;
  }

  function formatUptime(seconds: number) {
    seconds = Math.max(0, Math.floor(seconds));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const parts: string[] = [];
    if (h) parts.push(`${h}h`);
    if (m) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(" ");
  }

  const intervalId = setInterval(async () => {
    const set = clients.get(idt);
    if (!set || set.size === 0) return;

    try {
      const stats = await new Promise((resolve, reject) =>
        container.stats({ stream: false }, (err: any, s: any) => (err ? reject(err) : resolve(s)))
      );

      let uptimeSeconds = 0;
      let uptime = "0s";
      try {
        const info = await container.inspect();
        const startedAt = info?.State?.StartedAt;
        if (startedAt && startedAt !== "0001-01-01T00:00:00Z") {
          const startedMs = Date.parse(startedAt);
          if (!Number.isNaN(startedMs)) {
            uptimeSeconds = Math.floor((Date.now() - startedMs) / 1000);
            if (uptimeSeconds < 0) uptimeSeconds = 0;
            uptime = formatUptime(uptimeSeconds);
          }
        }
      } catch (inspectErr) {
        /* ignore inspect error */
      }

      broadcastToContainer(idt, "stats", { stats, uptimeSeconds, uptime });
    } catch (err: any) {
      if (err && err.statusCode === 404) {
        cleanupStatsByContainerId(currentContainerId);
        return;
      }
      broadcastToContainer(idt, "error", `Stats error: ${err.message}`);
    }
  }, 2000);

  statsIntervals.set(currentContainerId, {
    intervalId,
    refCount: (clients.get(idt) || new Set()).size,
  });

  ws.on("close", () => cleanupStatsByKey(idt));
}

/*
 * Execute a single command inside the container (via attach). Prevent execution if disk quota is exceeded.
 */
async function executeCommand(ws: WebSocket, container: any, command: string, requestedContainerId: string) {
  try {
    const resolved = findDataEntryByContainerOridt(requestedContainerId);
    const idt = resolved ? resolved.idt : requestedContainerId;
    const currentContainerId = resolved ? resolved.entry.containerId : requestedContainerId;
    if (!currentContainerId) {
      console.error("Error: Container ID missing");
      return sendEvent(ws, "error", "Container ID not found");
    }
    container = docker.getContainer(currentContainerId);
    const [info, usage] = await Promise.all([
      container.inspect().catch(() => null),
      getContainerDiskUsage(idt)
    ]);
    const allowed = resolved && resolved.entry && typeof resolved.entry.disk === "number" ? resolved.entry.disk : Infinity;
    console.log(`[disk-check] exec for ${currentContainerId} (idt=${idt}): usage=${usage.toFixed(3)}GB allowed=${allowed === Infinity ? "∞" : allowed}`);
    if (!info || !info.State || !info.State.Running) {
      console.log('DEBUG: Container is NOT running. Cannot attach.');
      return sendEvent(ws, "error", "Container is not running");
    }
    if (usage >= allowed) {
      try { await container.kill(); } catch (e) { /* ignore */ }
      broadcastToContainer(idt, "power", ansi("Node", "red", "Server disk exceed — commands blocked."));
      return;
    }
    runCommand(container, command);
  } catch (err: any) {
    console.error(`[EXEC ERROR] Failed to exec command:`, err);
    sendEvent(ws, "error", `Failed to exec command: ${err.message}`);
  }
}
/*
 * Perform power actions (start/restart/stop) for a container. Handles disk quota checks and
 * recreating the container when starting/restarting.
 */
async function performPower(ws: WebSocket, container: any, action: "start" | "restart" | "stop" | "kill", requestedContainerId: string) {
  try {
    const resolved = findDataEntryByContainerOridt(requestedContainerId);
    const idt = resolved ? resolved.idt : requestedContainerId;
    const entry = resolved ? resolved.entry : null;

    if (!entry) return sendEvent(ws, "error", "Data entry not found");

    const currentContainerId = entry.containerId;
    if (!currentContainerId) return sendEvent(ws, "error", "Container ID not found");
    container = docker.getContainer(currentContainerId);

    const usage = await getContainerDiskUsage(idt);
    const allowed = entry?.disk ?? Infinity;
    const info = await container.inspect().catch(() => null);
    if ((action === "start" || action === "restart") && usage >= allowed) {
      broadcastToContainer(idt, "power", ansi("Node", "red", "Server disk exceed — container will not be started."));
      return;
    }
    if (action === "kill") {
      if (!info?.State?.Running) {
        return sendEvent(ws, "power", ansi("Node", "red", "Container already stopped."));
      }
      await container.kill();
      broadcastToContainer(idt, "power", ansi("Node", "red", "Container killed."));
      return;
    }
    if (action === "start" || action === "restart") {
      broadcastToContainer(idt, "power", ansi("Node", "yellow", "Pulling the latest docker image..."));

      if (currentContainerId) {
        cleanupLogStreamsByContainerId(currentContainerId);
        cleanupStatsByContainerId(currentContainerId);
      }
      const newContainer = await recreateContainer(idt, (logMessage: string) => {
        broadcastToContainer(idt, 'docker-log', logMessage);
      });
      for (const c of clients.get(idt) || []) {
        void streamLogs(c, newContainer, newContainer.id);
      }
      for (const c of clients.get(idt) || []) {
        void streamStats(c, newContainer, newContainer.id);
      }

      broadcastToContainer(idt, "power", ansi("Node", "green", "Starting the container."));
    } else if (action === "stop") {
      if (!info?.State?.Running) {
        return sendEvent(ws, "power", ansi("Node", "red", "Container already stopped."));
      }
      const stopCommand = (entry.stopCmd || "").replace(/{{(.*?)}}/g, (_, key: string) => entry.env?.[key] ?? `{{${key}}}`);
      if (stopCommand === "^C") {
        await container.kill();
        await container.wait();
        await container.remove({ force: true });
        return;
      }
      await container.attach({ stream: true, stdin: true, stdout: true, stderr: true, hijack: true }, (err: any, stream: any) => {
        if (err) return sendEvent(ws, "error", `Failed to attach for stop: ${err.message}`);
        try {
          const decoded = decodeControlSequences(stopCommand);
          if (decoded && decoded.length === 1 && decoded.charCodeAt(0) < 0x20) {
            stream.write(decoded);
          } else {
            stream.write((entry.stopCmd || "") + "\n");
          }
        } catch (e) {
          stream.write((entry.stopCmd || "") + "\n");
        }
      });
      await container.wait();
      await container.remove({ force: true });
      broadcastToContainer(idt, "power", ansi("Node", "red", "Container Stopping."));
    }
  } catch (err: any) {
    console.log(err);
    sendEvent(ws, "error", `Power action failed: ${err.message}`);
  }
}
/* WebSocket authentication timeout and connection handling. */
const AUTH_TIMEOUT = 5000;

wss.on("connection", (ws: WebSocket) => {
  // attach custom fields (ws typings do not include these by default)
  (ws as any).isAuthenticated = false;
  (ws as any).isAlive = true;

  const authTimer = setTimeout(() => { if (!(ws as any).isAuthenticated) (ws as any).terminate(); }, AUTH_TIMEOUT);
  ws.on("pong", () => ((ws as any).isAlive = true));

  /* Handle incoming messages: auth, logs, stats, cmd, power actions. */
  ws.on("message", async (raw: WebSocket.Data) => {
    let msg: any;
    try {
      if (typeof raw === "string") msg = JSON.parse(raw);
      else msg = JSON.parse(raw.toString());
    } catch {
      return sendEvent(ws, "error", "Invalid JSON");
    }

    if (!(ws as any).isAuthenticated) {
      if (msg.event === "auth" && msg.payload?.key === (config as any).key) {
        (ws as any).isAuthenticated = true;
        clearTimeout(authTimer);
        return sendEvent(ws, "auth", { success: true });
      } else {
        // 1008 = policy violation
        return (ws as any).close?.(1008, "Unauthorized");
      }
    }

    const { event, payload } = msg;
    const providedContainerId = payload?.containerId;
    if (!providedContainerId) return sendEvent(ws, "error", "containerId required");

    if (typeof providedContainerId !== "string" || !/^[a-zA-Z0-9_.-]+$/.test(providedContainerId))
      return sendEvent(ws, "error", "Invalid containerId");

    const resolved = findDataEntryByContainerOridt(providedContainerId);
    const idt = resolved ? resolved.idt : providedContainerId;
    const currentContainerId = resolved ? resolved.entry.containerId : providedContainerId;
    const container = docker.getContainer(currentContainerId as any);

    try {
      switch (event) {
        case "logs":
          await streamLogs(ws, container, providedContainerId);
          break;
        case "stats":
          await streamStats(ws, container, providedContainerId);
          break;
        case "cmd":
          await executeCommand(ws, container, payload.command, providedContainerId);
          break;
        case "power:start":
        case "power:stop":
        case "power:restart":
        case "power:kill":
          await performPower(ws, container, event.split(":")[1] as any, providedContainerId);
          break;
        default:
          sendEvent(ws, "error", "Unknown event");
      }
    } catch (err: any) {
      sendEvent(ws, "error", `Handler error: ${err.message}`);
    }
  });

  ws.on("close", () => removeClient(ws));
  ws.on("error", () => removeClient(ws));
});

/* Periodic heartbeat to detect dead WebSocket clients. */
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!((ws as any).isAlive)) return (ws as any).terminate();
    (ws as any).isAlive = false;
    try { ws.ping(); } catch (e) { /* ignore ping errors */ }
  });
}, 30000);

/* Handle HTTP -> WebSocket upgrade requests. */
server.on("upgrade", (req, socket, head) =>
  wss.handleUpgrade(req, socket as any, head, (ws) => wss.emit("connection", ws, req))
);

/* Simple REST endpoints for health/version/stats. */
app.get("/health", async (req: Request, res: Response) => {
  const dockerRunning = await isDockerRunning();
  res.json({
    status: dockerRunning ? "online" : "dockernotrunning",
    uptime: process.uptime(),
    node: "alive",
  });
});

app.get("/version", async (req: Request, res: Response) => {
  const version = "0.1-alpha-dev";
  res.json({ version });
});

app.get("/stats", (req: Request, res: Response) => {
  try {
    const totalRam = os.totalmem();
    const freeRam = os.freemem();
    const cpus = os.cpus();
    const load = os.loadavg();
    const uptime = os.uptime();
    res.json({
      stats: {
        totalRamGB: (totalRam / 1e9).toFixed(2),
        usedRamGB: ((totalRam - freeRam) / 1e9).toFixed(2),
        totalCpuCores: cpus.length,
        cpuModel: cpus[0]?.model || "unknown",
        cpuSpeed: cpus[0]?.speed || "unknown",
        // cpuUsagePercent,
        osType: os.type(),
        osPlatform: os.platform(),
        osArch: os.arch(),
        osRelease: os.release(),
        uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
        load1: load[0].toFixed(2),
        load5: load[1].toFixed(2),
        load15: load[2].toFixed(2),
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

async function getVersion() {
  try {
    const version = '1.0.0-dev'
    const ascii = `
   ____     __                  
  / __/_ __/ /__ ____  _______ _
 / _// // / / _ \`/ _ \\/ __/ _ \`    ${version}
/_/  \\_, /_/\\_, /\\___/_/  \\_,_/ 
    /___/  /___/                 

Copyright © %s ma4z and contributors

Website:  https://talorix.io
Source:   https://github.com/talorix/fylgora
`;

    const gray = '\x1b[90m';
    const reset = '\x1b[0m';
    const asciiWithColor = ascii.replace(version, reset + version + gray);
    console.log(gray + asciiWithColor + reset, new Date().getFullYear());
  } catch (err) {
    console.error('Failed to fetch version:', err);
  }
}

/* Start the HTTP server after printing version/banner. */
async function start() {
  await getVersion();
  server.listen((config as any).port, () => console.log("\x1b[32mFylgora has been booted on " + (config as any).port));
}
void start();
