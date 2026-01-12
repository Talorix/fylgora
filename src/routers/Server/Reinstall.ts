import express from "express";
import type { Request, Response } from "express";
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import Docker from 'dockerode';
import https from 'https';
import http from 'http';
const __dirname = process.cwd();

const router = express.Router();
const docker = new Docker();
const DATA_DIR = path.resolve(__dirname, 'data');
const DATA_FILE = path.join(__dirname, 'data.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

type EnvRecord = Record<string, string | number | undefined>;
interface FileEntry {
  filename: string;
  url: string;
}
interface ServerEntry {
  containerId?: string;
  dockerimage: string;
  startCmd: string;
  env: EnvRecord;
  files: FileEntry[];
  port?: number;
  ram?: number;
  core?: number;
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const proto = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    proto.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`Failed to download '${url}' (${res.statusCode})`));
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', reject);
    }).on('error', reject);
  });
}

const objectToEnv = (obj: EnvRecord): string[] => Object.entries(obj).map(([k, v]) => `${k}=${v}`);

const loadData = (): Record<string, ServerEntry> => {
  if (!fs.existsSync(DATA_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return {}; }
};

const saveData = async (data: Record<string, ServerEntry>): Promise<void> => {
  await fsPromises.writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
};

async function replacePlaceholders(filePath: string, env: EnvRecord): Promise<void> {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.txt', '.json', '.properties'].includes(ext)) return;
  let content = await fsPromises.readFile(filePath, 'utf8');
  content = content.replace(/{{(.*?)}}/g, (_, key) => String(env[key] ?? `{{${key}}}`));
  await fsPromises.writeFile(filePath, content, 'utf8');
}

router.post('/reinstall/:idt', async (req: Request<any, any, { env?: EnvRecord }>, res: Response) => {
  const { idt } = req.params;
  const data = loadData();
  const existing = data[idt];
  if (!existing) return res.status(404).json({ error: 'Server not found' });

  const incomingEnv = req.body?.env;
  if (incomingEnv && typeof incomingEnv === 'object') existing.env = incomingEnv;

  const volumePath = path.join(DATA_DIR, idt);
  const tmpPath = path.join(DATA_DIR, `${idt}_tmp`);

  try {
    if (existing.containerId) {
      try {
        const container = docker.getContainer(existing.containerId);
        try { await container.stop({ t: 5 }); } catch {}
        await container.remove({ force: true });
      } catch (e: any) { console.log('Could not stop/remove container:', e.message); }
    }

    if (fs.existsSync(tmpPath)) await fsPromises.rm(tmpPath, { recursive: true, force: true });
    if (fs.existsSync(volumePath)) await fsPromises.rename(volumePath, tmpPath);

    const mergedEnv: EnvRecord = { ...existing.env, MEMORY: existing.env.MEMORY || '2G', TID: idt, PORT: existing.port };
    await fsPromises.mkdir(volumePath, { recursive: true });

    for (const file of existing.files) {
      const resolvedUrl = file.url.replace(/{{(.*?)}}/g, (_, key) => String(mergedEnv[key] ?? `{{${key}}}`));
      const dest = path.join(volumePath, file.filename);
      await downloadFile(resolvedUrl, dest);
      await replacePlaceholders(dest, mergedEnv);
    }

    if (fs.existsSync(tmpPath)) {
      const tmpFiles = await fsPromises.readdir(tmpPath);
      await Promise.all(tmpFiles.filter(f => !fs.existsSync(path.join(volumePath, f)))
        .map(f => fsPromises.rename(path.join(tmpPath, f), path.join(volumePath, f)))
      );
      await fsPromises.rm(tmpPath, { recursive: true, force: true });
    }

    const hostConfig: any = {
      Binds: [`${volumePath}:/app/data`],
      Memory: existing.ram ? existing.ram * 1024 * 1024 : undefined,
      NanoCPUs: existing.core ? existing.core * 1e9 : undefined,
      OomKillDisable: true,
    };
    const exposedPorts: Record<string, {}> = {};
    if (existing.port) {
      hostConfig.PortBindings = { [`${existing.port}/tcp`]: [{ HostPort: existing.port.toString() }] };
      exposedPorts[`${existing.port}/tcp`] = {};
    }

    await new Promise<void>((resolve, reject) => {
      docker.pull(existing.dockerimage, (err: Error | null, stream: any) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err2: Error | null) => (err2 ? reject(err2) : resolve()));
      });
    });

    const startupCommand = existing.startCmd.replace(/{{(.*?)}}/g, (_, key) => String(mergedEnv[key] ?? `{{${key}}}`));
    const container = await docker.createContainer({
      Image: existing.dockerimage,
      name: `talorix_${idt}`,
      Env: objectToEnv(mergedEnv),
      HostConfig: hostConfig,
      ExposedPorts: exposedPorts,
      Cmd: ['sh', '-c', startupCommand],
      Tty: true,
      OpenStdin: true
    });

    await container.start();
    existing.containerId = container.id;
    existing.env = mergedEnv;
    await saveData(data);

    res.json({ message: 'Server reinstalled successfully', containerId: container.id });
  } catch (err: any) {
    if (fs.existsSync(tmpPath) && !fs.existsSync(volumePath)) await fsPromises.rename(tmpPath, volumePath);
    res.status(500).json({ error: err.message });
    console.log(err);
  }
});

export default router;
