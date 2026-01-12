import express from "express";
import type { Request, Response } from "express";
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import Docker from "dockerode";
import type { Container, ContainerCreateOptions } from "dockerode";
const __dirname = process.cwd();
const router = express.Router();
const docker = new Docker();

const DATA_DIR = path.resolve(__dirname, 'data');
const DATA_FILE = path.resolve(__dirname, 'data.json');

interface ContainerEntry {
  containerId?: string;
  dockerimage: string;
  env?: Record<string, string | number>;
  ram?: number;
  core?: number;
  ports?: number[];
  port?: number;
}

// ----------------------- helpers -----------------------

const objectToEnv = (obj: Record<string, string | number> = {}): string[] =>
  Object.entries(obj).map(([k, v]) => `${k}=${v}`);

const loadData = (): Record<string, ContainerEntry> => {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return {};
  }
};

const saveData = async (data: Record<string, ContainerEntry>) => {
  await fsPromises.writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
};

async function recreateContainerWithPorts(idt: string, ports: number[]): Promise<string> {
  const data = loadData();
  const entry = data[idt];
  if (!entry) throw new Error('Container not found');

  const volumePath = path.join(DATA_DIR, idt);

  // Stop & remove old container
  if (entry.containerId) {
    try {
      const old = docker.getContainer(entry.containerId);
      await old.stop().catch(() => {});
      await old.remove({ force: true }).catch(() => {});
    } catch {}
  }

  const ExposedPorts: Record<string, {}> = {};
  const PortBindings: Record<string, { HostPort: string }[]> = {};

  for (const p of ports) {
    ExposedPorts[`${p}/tcp`] = {};
    PortBindings[`${p}/tcp`] = [{ HostPort: String(p) }];
  }

  const HostConfig = {
    Binds: [`${volumePath}:/app/data`],
    Memory: entry.ram ? entry.ram * 1024 * 1024 : undefined,
    NanoCPUs: entry.core ? entry.core * 1e9 : undefined,
    PortBindings,
    OomKillDisable: true,
  };

  const container: Container = await docker.createContainer({
    Image: entry.dockerimage,
    name: `talorix_${idt}`,
    Env: objectToEnv(entry.env),
    HostConfig,
    ExposedPorts,
    Tty: true,
    OpenStdin: true
  } as ContainerCreateOptions);

  await container.start();

  entry.containerId = container.id;
  entry.ports = ports;
  entry.port = ports[0] ?? null;

  await saveData(data);

  return container.id;
}

// ----------------------- routes -----------------------

/**
 * ADD PORT
 * POST /network/:idt/add/:port
 */
router.post('/network/:idt/add/:port', async (req: Request, res: Response) => {
  try {
    const { idt, port } = req.params;
    const p = Number(port);
    if (!p) return res.status(400).json({ error: 'Invalid port' });

    const data = loadData();
    const entry = data[idt as string];
    if (!entry) return res.status(404).json({ error: 'Container not found' });

    const current = entry.ports || (entry.port ? [entry.port] : []);
    const ports = Array.from(new Set([...current, p]));

    entry.ports = ports;
    const containerId = await recreateContainerWithPorts(idt as string, ports);

    res.json({ message: 'Port added', ports, containerId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * SET PRIMARY PORT
 * POST /network/:idt/setprimary/:port
 */
router.post('/network/:idt/setprimary/:port', async (req: Request, res: Response) => {
  try {
    const { idt, port } = req.params;
    const p = Number(port);
    if (!p) return res.status(400).json({ error: 'Invalid port' });

    const data = loadData();
    const entry = data[idt as string];
    if (!entry) return res.status(404).json({ error: 'Container not found' });

    const currentPorts = entry.ports || (entry.port ? [entry.port] : []);
    const ports = Array.from(new Set([...currentPorts, p]));

    entry.env = entry.env || {};
    entry.env.PORT = p;
    entry.ports = ports;
    entry.port = p;

    const containerId = await recreateContainerWithPorts(idt as string, ports);

    res.json({ message: 'Primary port set', ports, port: p, containerId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * REMOVE PORT
 * POST /network/:idt/remove/:port
 */
router.post('/network/:idt/remove/:port', async (req: Request, res: Response) => {
  try {
    const { idt, port } = req.params;
    const p = Number(port);
    if (!p) return res.status(400).json({ error: 'Invalid port' });

    const data = loadData();
    const entry = data[idt as string];
    if (!entry) return res.status(404).json({ error: 'Container not found' });

    const current = entry.ports || (entry.port ? [entry.port] : []);
    const ports = current.filter(x => x !== p);

    if (ports.length === 0) return res.status(400).json({ error: 'Cannot remove last port' });

    entry.ports = ports;
    entry.port = ports[0]; // Update primary if the removed port was primary
    if (!entry.env) entry.env = {};
    entry.env.PORT = entry.port;

    const containerId = await recreateContainerWithPorts(idt as string, ports);

    res.json({ message: 'Port removed', ports, containerId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
