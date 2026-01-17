import path from "path";
import { promises as fsPromises } from "fs";
import Docker from "dockerode";

const docker = new Docker();
const DATA_PATH = path.join(process.cwd(), "data.json");

/* ---- Types ---- */

export interface ContainerEntry {
  dockerimage: string;
  containerId?: string;
  ram?: number;   // MB
  core?: number;  // CPU cores
  port?: number;
  ports?: number[];
  env: Record<string, string>;
  startCmd: string;
}

export type DataFile = Record<string, ContainerEntry>;

let data: DataFile | null = null;
let writeLock: Promise<void> = Promise.resolve();

/**
 * Atomic write + in-memory update + serialized via writeLock
 */
export async function writeData(newData: DataFile): Promise<void> {
  writeLock = writeLock.then(
    async () => {
      const tmp = DATA_PATH + ".tmp";
      await fsPromises.writeFile(tmp, JSON.stringify(newData, null, 2), "utf8");
      await fsPromises.rename(tmp, DATA_PATH);
      data = newData;
    },
    async () => {
      const tmp = DATA_PATH + ".tmp";
      await fsPromises.writeFile(tmp, JSON.stringify(newData, null, 2), "utf8");
      await fsPromises.rename(tmp, DATA_PATH);
      data = newData;
    }
  );

  await writeLock;
}

export async function readData(): Promise<DataFile> {
  try {
    const content = await fsPromises.readFile(DATA_PATH, "utf8");
    return content ? (JSON.parse(content) as DataFile) : {};
  } catch (err: any) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

/**
 * Recreate container for a given IDT
 */
export async function recreateContainer(
  idt: string,
  logFn: (msg: string) => void = () => {}
) {
  const current = await readData();
  const entry = current[idt];
  if (!entry) throw new Error("Data entry not found");
  const __dirname = process.cwd();
  const DATA_DIR = path.resolve(__dirname, "data");
  const volumePath = path.join(DATA_DIR, idt);

  /* ---- Pull image ---- */
  await new Promise<void>((resolve, reject) => {
    docker.pull(entry.dockerimage, (err: any, stream: any) => {
      if (err || !stream) return reject(err);

      docker.modem.followProgress(
        stream,
        (err) => (err ? reject(err) : resolve()),
        (event) => {
          if (event?.status) {
            const idText = event.id ? ` ${event.id}` : "";
            const progressText = event.progress ? ` ${event.progress}` : "";
            logFn(`[Pulling] ${event.status}${idText}${progressText}\n`);
          }
        }
      );
    });
  });

  /* ---- Stop & remove old container ---- */
  if (entry.containerId) {
    try {
      const old = docker.getContainer(entry.containerId);
      await old.stop().catch(() => {});
      await old.remove({ force: true }).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  /* ---- Host config ---- */
  const hostConfig: Docker.ContainerCreateOptions["HostConfig"] = {
    Binds: [`${volumePath}:/app/data`],
    Memory: entry.ram ? entry.ram * 1024 * 1024 : undefined,
    NanoCpus: entry.core ? entry.core * 1e9 : undefined,
    OomKillDisable: true,
  };

  const exposedPorts: Record<string, {}> = {};
  const portBindings: Record<string, { HostPort: string }[]> = {};

  const ports =
    Array.isArray(entry.ports) && entry.ports.length
      ? entry.ports
      : entry.port
      ? [entry.port]
      : [];

  for (const p of ports) {
    exposedPorts[`${p}/tcp`] = {};
    portBindings[`${p}/tcp`] = [{ HostPort: String(p) }];
  }

  if (ports.length) {
    hostConfig.PortBindings = portBindings;
  }

  const startupCommand = entry.startCmd.replace(
    /{{(.*?)}}/g,
    (_, key: string) => entry.env[key] ?? `{{${key}}}`
  );
  const container = await docker.createContainer({
    Image: entry.dockerimage,
    name: `talorix_${idt}`,
    Env: Object.entries(entry.env || {}).map(
      ([k, v]) => `${k}=${v}`
    ),
    HostConfig: hostConfig,
    ExposedPorts: exposedPorts,
    Tty: true,
    Cmd: ["sh", "-c", startupCommand],
    OpenStdin: true
  });

  await container.start();

  const latest = await readData();
  if (!latest[idt]) latest[idt] = entry;
  latest[idt].containerId = container.id;
  await writeData(latest);

  return container;
}

/* ---- Reload watcher ---- */
setInterval(async () => {
  try {
    const diskData = await readData();
    if (JSON.stringify(diskData) !== JSON.stringify(data)) {
      data = diskData;
    }
  } catch (err) {
    console.error("reloadData error:", err);
  }
}, 5000);
