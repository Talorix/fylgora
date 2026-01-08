import express from "express";
import type { Request, Response } from "express";
import fs from 'fs/promises';
import path from 'path';
import Docker from "dockerode";
import type { Container, ContainerCreateOptions } from "dockerode";
const __dirname = process.cwd();
const router = express.Router();
const docker = new Docker();

const DATA_FILE = path.join(__dirname, 'data.json');

interface ContainerEntry {
  containerId?: string;
  [key: string]: any;
}

interface DataFile {
  [idt: string]: ContainerEntry;
}

// ----------------------- helpers -----------------------
async function ensureDataFile(): Promise<void> {
  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.writeFile(DATA_FILE, JSON.stringify({}), 'utf8');
  }
}

const loadData = async (): Promise<DataFile> => {
  await ensureDataFile();
  const raw = await fs.readFile(DATA_FILE, 'utf8');
  return JSON.parse(raw || '{}') as DataFile;
};

const saveData = async (data: DataFile): Promise<void> => {
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
};

async function deleteServerData(idt: string): Promise<void> {
  const containerDataPath = path.join(__dirname, `data/${idt}`);
  try {
    await fs.rm(containerDataPath, { recursive: true, force: true });
  } catch (err) {
    console.error(`Failed to delete container data at ${containerDataPath}:`, err);
  }
}

// ----------------------- routes -----------------------
router.delete('/delete/:idt', async (req: Request, res: Response) => {
  try {
    const { idt } = req.params;
    const data = await loadData();

    const entry = data[idt];
    if (!entry) return res.status(404).json({ error: 'Unknown ID' });

    // Delete container folder
    await deleteServerData(idt);

    if (entry.containerId) {
      const container: Container = docker.getContainer(entry.containerId);

      // Stop container if running
      try {
        const info = await container.inspect();
        if (info.State.Running) {
          await container.stop();
        }
      } catch {
        // ignore if container cannot be inspected
      }

      // Remove container
      try {
        await container.remove({ force: true });
      } catch {
        // ignore if already removed
      }
    }

    // Remove from data.json
    delete data[idt];
    await saveData(data);

    res.json({ status: 'ok', idt });
  } catch (err: any) {
    console.error('Error deleting server:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
