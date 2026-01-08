import express from "express";
import type { Request, Response } from "express";
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';

const router = express.Router();
const __dirname = process.cwd();

const DATA_DIR = path.resolve(__dirname, 'data');
const DATA_FILE = path.join(__dirname, 'data.json');

// Ensure the data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

interface ServerEntry {
  dockerimage: string;
  [key: string]: any; // other optional fields
}

interface DataFile {
  [idt: string]: ServerEntry;
}

// ----------------------- helpers -----------------------
const loadData = (): DataFile => {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return (typeof data === 'object' && !Array.isArray(data)) ? data : {};
  } catch {
    return {};
  }
};

const saveData = async (data: DataFile): Promise<void> => {
  try {
    await fsPromises.writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('Failed to save data:', error);
    throw error;
  }
};

// ----------------------- routes -----------------------
router.post('/:idt/set-image', async (req: Request, res: Response) => {
  const { idt } = req.params;
  const { dockerImage } = req.body as { dockerImage?: string };

  if (!dockerImage) {
    return res.status(400).json({ error: 'Docker image field is required' });
  }

  const data = loadData();
  const server = data[idt];

  if (!server) {
    return res.status(404).json({ error: 'Server not found' });
  }

  server.dockerimage = dockerImage;
  data[idt] = server;

  try {
    await saveData(data);
    res.json({ message: 'Image updated successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update image' });
  }
});

export default router;
