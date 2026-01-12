import express from "express";
import type { Request, Response } from "express";
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import Docker from 'dockerode';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
const __dirname = process.cwd();
const router = express.Router();
const docker = new Docker();
const DATA_DIR = path.resolve(__dirname, 'data');
const DATA_FILE = path.join(__dirname, 'data.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

type EnvRecord = Record<string, string | number | boolean | undefined>;

interface FileEntry {
  filename: string;
  url: string;
}

interface CreateBody {
  dockerimage: string;
  env?: EnvRecord;
  name?: string;
  ram?: number; // MB
  core?: number; // CPUs (float accepted)
  disk?: number;
  port?: number | string;
  files?: FileEntry[];
  startCmd?: string;
  stopCmd?: string;
}

interface EditBody {
  idt: string;
  dockerimage?: string;
  env?: EnvRecord;
  name?: string;
  ram?: number;
  core?: number;
  disk?: number;
  port?: number | string;
  files?: FileEntry[];
}

interface StoredEntry {
  containerId: string;
  dockerimage?: string;
  ftpPassword?: string;
  startCmd?: string;
  stopCmd?: string;
  env?: Record<string, string>;
  name?: string;
  ram?: number;
  core?: number;
  disk?: number;
  port?: number | string;
  files?: FileEntry[];
  status?: string;
  error?: string;
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const proto = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    proto.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`Failed to download '${url}' (${res.statusCode})`));
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', (err) => reject(err));
    }).on('error', reject);
  });
}

const objectToEnv = (obj: EnvRecord | Record<string, any>): string[] =>
  Object.entries(obj || {}).map(([k, v]) => `${k}=${typeof v === 'string' ? v : String(v)}`);

const loadData = (): Record<string, StoredEntry> => {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) as Record<string, StoredEntry>;
    return (typeof data === 'object' && !Array.isArray(data)) ? data : {};
  } catch {
    return {};
  }
};

const saveData = async (data: Record<string, StoredEntry>): Promise<void> => {
  try {
    await fsPromises.writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('Failed to save data:', error);
    throw error;
  }
};

async function replacePlaceholders(filePath: string, env: Record<string, string | number | boolean | undefined>): Promise<void> {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.txt', '.json', '.properties'].includes(ext)) return;
  let content = await fsPromises.readFile(filePath, 'utf8');
  content = content.replace(/{{(.*?)}}/g, (_, key: string) => {
    const val = env[key];
    return typeof val !== 'undefined' ? String(val) : `{{${key}}}`;
  });
  await fsPromises.writeFile(filePath, content, 'utf8');
}

function genPass(length = 12): string {
  const chars = 'abcdef0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

const si = new Set<string>();

// Create container
router.post('/create', async (req: Request<any, any, CreateBody>, res: Response) => {
  const idt = Math.random().toString(36).substring(2, 12);
  const volumePath = path.join(DATA_DIR, idt);
  const fcid = 'pending_' + crypto.randomBytes(16).toString('hex');
  const ftpPassword = genPass();
  si.add(idt);

  res.json({
    containerId: fcid,
    idt,
    ftppass: ftpPassword,
    message: 'Container Creation Started!'
  });

  (async () => {
    try {
      await fsPromises.mkdir(volumePath, { recursive: true });

      const body = req.body || ({} as CreateBody);
      const {
        dockerimage,
        env = {},
        name,
        ram,
        core,
        disk,
        port,
        files = [],
        startCmd,
        stopCmd
      } = body;

      const containerEnv: Record<string, string> = {
        ...(Object.fromEntries(Object.entries(env || {}).map(([k, v]) => [k, v === undefined ? undefined : String(v)])) as Record<string, string>),
        MEMORY: ram ? `${ram}M` : '',
        TID: idt,
        PORT: typeof port !== 'undefined' ? String(port) : ''
      };

      for (const file of files) {
        const resolvedUrl = file.url.replace(/{{(.*?)}}/g, (_, key) => containerEnv[key] ?? `{{${key}}}`);
        const dest = path.join(volumePath, file.filename);
        await downloadFile(resolvedUrl, dest);
        await replacePlaceholders(dest, containerEnv);
      }

      const hostConfig: any = {
        Binds: [`${volumePath}:/app/data`],
        Memory: ram ? ram * 1024 * 1024 : undefined,
        NanoCPUs: core ? core * 1e9 : undefined,
        OomKillDisable: true,
      };

      const exposedPorts: Record<string, {}> = {};
      if (port) {
        hostConfig.PortBindings = {
          [`${port}/tcp`]: [{ HostPort: String(port) }]
        };
        exposedPorts[`${port}/tcp`] = {};
      }

      await new Promise<void>((resolve, reject) => {
        docker.pull(dockerimage, (err: Error | null, stream: any) => {
          if (err) return reject(err);
          // followProgress accepts (stream, onFinished)
          docker.modem.followProgress(stream, (err2: Error | null) => (err2 ? reject(err2) : resolve()));
        });
      });

      const startupCommand = (startCmd ?? '').replace(/{{(.*?)}}/g, (_, key) => containerEnv[key] ?? `{{${key}}}`);

      const container = await docker.createContainer({
        Image: dockerimage,
        name: `talorix_${idt}`,
        Env: objectToEnv(containerEnv),
        HostConfig: hostConfig,
        ExposedPorts: exposedPorts,
        Tty: true,
        Cmd: ['sh', '-c', startupCommand],
        OpenStdin: true,
      });

      await container.start();

      const data = loadData();
      data[idt] = {
        containerId: (container as any).id || (container as any).Id || '',
        dockerimage,
        ftpPassword,
        startCmd,
        stopCmd,
        env: containerEnv,
        name,
        ram,
        core,
        disk,
        port,
        files,
        status: 'running'
      };
      await saveData(data);
      si.delete(idt);
    } catch (err: any) {
      if (fs.existsSync(volumePath)) {
        fs.rmSync(volumePath, { recursive: true, force: true });
      }

      const data = loadData();
      data[idt] = {
        containerId: fcid,
        ftpPassword,
        status: 'failed',
        error: err?.message ?? String(err)
      };
      console.log('DEBUG: Saving error state for', idt);
      await saveData(data);
      console.log('DEBUG: Error state saved for', idt);
      si.delete(idt);
    }
  })();
});

router.get('/:idt/state', (req: Request, res: Response) => {
  const { idt } = req.params;
  if (si.has(idt as string)) {
    return res.json({ idt, state: 'installing' });
  }
  const data = loadData();
  const container = data[idt as string];

  if (!container) {
    return res.status(404).json({ idt, state: 'not_found' });
  }
  res.json({ idt, state: container.status });
});

router.post('/edit', async (req: Request<any, any, EditBody>, res: Response) => {
  const {
    idt,
    dockerimage: newImage,
    env: newEnv = {},
    name: newName,
    ram: newRam,
    core: newCore,
    disk: newDisk,
    port: newPort,
    files: newFiles = []
  } = req.body as EditBody;

  if (!idt) return res.status(400).json({ error: 'Missing idt in request body' });

  const data = loadData();
  const existing = data[idt];
  if (!existing) return res.status(404).json({ error: `No entry found for id ${idt}` });

  const volumePath = path.join(DATA_DIR, idt);
  if (!fs.existsSync(volumePath)) await fsPromises.mkdir(volumePath, { recursive: true });

  try {
    const finalDockerImage = newImage || existing.dockerimage;
    const finalRam = typeof newRam !== 'undefined' ? newRam : existing.ram;
    const finalCore = typeof newCore !== 'undefined' ? newCore : existing.core;
    const finalPort = typeof newPort !== 'undefined' ? newPort : existing.port;
    const finalName = typeof newName !== 'undefined' ? newName : existing.name;
    const finalDisk = typeof newDisk !== 'undefined' ? newDisk : existing.disk;

    const mergedEnv: Record<string, string> = {
      ...(existing.env || {}),
      ...(Object.fromEntries(Object.entries(newEnv || {}).map(([k, v]) => [k, v === undefined ? undefined : String(v)])) as Record<string, string>)
    };

    if (finalRam) mergedEnv.MEMORY = `${finalRam}M`;
    mergedEnv.TID = idt;
    if (finalPort) mergedEnv.PORT = String(finalPort);

    for (const file of newFiles) {
      const resolvedUrl = file.url.replace(/{{(.*?)}}/g, (_, key) => mergedEnv[key] ?? `{{${key}}}`);
      const dest = path.join(volumePath, file.filename);
      await downloadFile(resolvedUrl, dest);
      await replacePlaceholders(dest, mergedEnv);
    }

    const hostConfig: any = {
      Binds: [`${volumePath}:/app/data`],
      Memory: finalRam ? finalRam * 1024 * 1024 : undefined,
      NanoCPUs: finalCore ? finalCore * 1e9 : undefined,
      OomKillDisable: true,
    };

    const exposedPorts: Record<string, {}> = {};
    if (finalPort) {
      hostConfig.PortBindings = { [`${finalPort}/tcp`]: [{ HostPort: String(finalPort) }] };
      exposedPorts[`${finalPort}/tcp`] = {};
    }

    await new Promise<void>((resolve, reject) => {
      docker.pull(finalDockerImage as string, (err: Error | null, stream: any) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err2: Error | null) => (err2 ? reject(err2) : resolve()));
      });
    });

    if (existing.containerId) {
      try {
        const oldContainer = docker.getContainer(existing.containerId);
        await oldContainer.stop().catch(() => { });
        await oldContainer.remove({ force: true }).catch(() => { });
      } catch (err) {
        console.warn(`Failed to stop/remove previous container ${existing.containerId}:`, (err as any)?.message ?? String(err));
      }
    }

    const startupCommand = (existing.startCmd ?? '').replace(/{{(.*?)}}/g, (_, key) => mergedEnv[key] ?? `{{${key}}}`);
    const container = await docker.createContainer({
      Image: finalDockerImage,
      name: `talorix_${idt}`,
      Env: objectToEnv(mergedEnv),
      HostConfig: hostConfig,
      ExposedPorts: exposedPorts,
      Cmd: ['sh', '-c', startupCommand],
      Tty: true,
      OpenStdin: true,
    });

    await container.start();

    data[idt] = {
      containerId: (container as any).id || (container as any).Id || '',
      dockerimage: finalDockerImage,
      env: mergedEnv,
      name: finalName,
      startCmd: existing.startCmd,
      ftpPassword: existing.ftpPassword,
      stopCmd: existing.stopCmd,
      ram: finalRam,
      core: finalCore,
      disk: finalDisk,
      port: finalPort,
      files: (() => {
        const existingFiles = Array.isArray(existing.files) ? existing.files : [];
        if (!Array.isArray(newFiles) || newFiles.length === 0) return existingFiles;
        const map: Record<string, FileEntry> = Object.fromEntries(existingFiles.map(f => [f.filename, f]));
        for (const f of newFiles) map[f.filename] = f;
        return Object.values(map);
      })()
    };

    await saveData(data);

    res.json({ containerId: data[idt].containerId, idt, message: 'Container edited, new container started and saved' });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

export default router;
