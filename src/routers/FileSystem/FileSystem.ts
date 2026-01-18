import express from "express";
import type { Request, Response } from "express";

// Minimal local Multer file type for memory-storage uploads
interface MulterFile {
  fieldname: string;
  originalname: string;
  encoding?: string;
  mimetype?: string;
  size?: number;
  buffer?: Buffer;
  destination?: string;
  filename?: string;
  path?: string;
}

type RequestWithFile = Request & { file?: MulterFile };
import { promises as fsPromises } from "fs";
import path from "path";
import multer from "multer";
const __dirname = process.cwd();
const router = express.Router();
const DATA_DIR = path.resolve(__dirname, "data");
const upload = multer({ storage: multer.memoryStorage() });

/**
 * Safely resolve a path within a container's folder
 */
function resolvePath(idt: string, relPath: string): string {
  const base = path.join(DATA_DIR, idt);
  const fullPath = path.join(base, relPath);
  if (!fullPath.startsWith(base)) {
    throw new Error("Invalid path"); // prevent path traversal
  }
  return fullPath;
}

/**
 * Convert numeric mode to rwxrwxrwx string
 * @param mode - fs.Stats.mode
 */
function modeToString(mode: number) {
  const perms = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx'];
  const owner = (mode >> 6) & 0o7;
  const group = (mode >> 3) & 0o7;
  const others = mode & 0o7;
  return perms[owner] + perms[group] + perms[others];
}

/**
 * Read a Minecraft server.properties file and return an array of entries
 * Each entry is either a property ({ key, value }) or a comment ({ comment })
 */
export async function separateServerProperties(pathToServerProperties: string) {
  try {
    const content = await fsPromises.readFile(pathToServerProperties, 'utf-8');
    
    const result: Array<{ key: string; value: string | boolean | number } | { comment: string }> = [];

    content.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (!trimmed) {
        result.push({ comment: '' });
        return;
      }

      if (trimmed.startsWith('#')) {
        result.push({ comment: trimmed });
        return;
      }

      const [rawKey, rawValue] = trimmed.split('=');
      if (!rawKey) return;

      let value: string | boolean | number = rawValue?.trim() ?? '';

      if (value === 'true') value = true;
      else if (value === 'false') value = false;
      else if (value !== '' && !isNaN(Number(value))) value = Number(value);

      result.push({ key: rawKey.trim(), value });
    });

    return result;
  } catch (err) {
    return [];
  }
}
/**
 * Save an array of server properties (with comments) back to server.properties
 * @param pathToServerProperties - Path to file
 * @param properties - Array returned from separateServerProperties
 */
export async function saveServerProperties(pathToServerProperties: string, properties: Array<{ key: string; value: string | boolean | number } | { comment: string }>) {
  try {
    const content = properties
      .map(entry => {
        if ('comment' in entry) return entry.comment;
        return `${entry.key}=${entry.value}`;
      })
      .join('\n');

    await fsPromises.writeFile(pathToServerProperties, content, 'utf-8');
    return true;
  } catch (err) {
    return false;
  }
}
/**
 * Get detailed file information
 * @param filePath - Path to the file
 */
async function getFileProperties(filePath: string) {
  try {
    const stats = await fsPromises.stat(filePath);
    return {
      name: path.basename(filePath),
      path: path.resolve(filePath),
      size: stats.size,
      type: stats.isDirectory() ? "folder" : "file",
      isSymbolicLink: stats.isSymbolicLink(),
      isFIFO: stats.isFIFO(),
      isSocket: stats.isSocket(),
      createdAt: stats.birthtime,
      modifiedAt: stats.mtime,
      accessedAt: stats.atime,
      mode: modeToString(stats.mode),
      extension: path.extname(filePath),
    };
  } catch (err) {
    console.error(`Error reading file properties: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Recursively compute folder size
 */
async function getFolderSize(folderPath: string): Promise<number> {
  let total = 0;
  const items = await fsPromises.readdir(folderPath, { withFileTypes: true });
  for (const item of items) {
    const itemPath = path.join(folderPath, item.name);
    if (item.isDirectory()) {
      total += await getFolderSize(itemPath);
    } else {
      const stats = await fsPromises.stat(itemPath);
      total += stats.size;
    }
  }
  return total;
}

/**
 * Get Minecraft server.properties
 * Returns array of { key, value } and comments
 */
router.get("/fs/feature/:idt/properties", async (req: Request, res: Response) => {
  const { idt } = req.params;
  const relPath = req.query.path as string || "server.properties"; // default file

  try {
    const filePath = resolvePath(idt as any, relPath);
    const props = await separateServerProperties(filePath);
    res.json({ properties: props });
  } catch (err: any) {
    res.status(500).json({ properties: [], error: err.message });
  }
});

/**
 * Save Minecraft server.properties
 * Expects body: { properties: Array<{ key, value } | { comment }> }
 */
router.post("/fs/feature/:idt/properties", async (req: Request, res: Response) => {
  const { idt } = req.params;
  const relPath = req.query.path as string || "server.properties"; // default file
  const properties = req.body.properties;

  if (!Array.isArray(properties)) {
    return res.status(400).json({ error: "properties array is required" });
  }

  try {
    const filePath = resolvePath(idt as any, relPath);
    const success = await saveServerProperties(filePath, properties);
    if (success) res.json({ message: "server.properties saved successfully!" });
    else res.status(500).json({ error: "Failed to save server.properties" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * List files/folders in a container directory
 */
router.get("/fs/:idt/files", async (req: Request, res: Response) => {
  const { idt } = req.params;
  const relPath = (req.query.path as string) || "/";

  try {
    const dirPath = resolvePath(idt as string, relPath);
    const items = await fsPromises.readdir(dirPath, { withFileTypes: true });

    const result = await Promise.all(
      items.map(async (item) => {
        const itemPath = path.join(dirPath, item.name);
        try {
          return getFileProperties(itemPath);
        } catch {
          return { name: item.name, error: "Could not read properties" };
        }
      })
    );

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get folder size
 */
router.get("/fs/:idt/size", async (req: Request, res: Response) => {
  const { idt } = req.params;
  try {
    const totalSize = (await getFolderSize(resolvePath(idt as string, "/"))) || 0;
    res.json({ idt, total: totalSize });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Create new file
 */
router.post("/fs/:idt/file/new", async (req: Request, res: Response) => {
  const { idt } = req.params;
  const relPath = (req.query.path as string) || "/";
  const { content = "", filename } = req.body;
  if (!filename) return res.status(400).json({ error: "filename is required" });

  try {
    const filePath = resolvePath(idt as string, path.join(relPath, filename));
    await fsPromises.writeFile(filePath, content, "utf8");
    res.json({ message: "File created", location: filePath });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Create new folder
 */
router.post("/fs/:idt/folder/new", async (req: Request, res: Response) => {
  const { idt } = req.params;
  const relPath = (req.query.path as string) || "/";
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: "filename is required" });

  try {
    const folderPath = resolvePath(idt as string, path.join(relPath, filename));
    await fsPromises.mkdir(folderPath, { recursive: true });
    res.json({ message: "Folder created", location: folderPath });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get file content
 */
router.get("/fs/:idt/file/content", async (req: Request, res: Response) => {
  const { idt } = req.params;
  const relPath = req.query.location as string;

  if (!relPath) return res.status(400).json({ error: "location query param is required" });

  try {
    const filePath = resolvePath(idt as string, relPath);
    const content = await fsPromises.readFile(filePath, "utf8");
    return res.json({ content });
  } catch (err: any) {
    if (err.code === "ENOENT") return res.status(404).json({ error: "File not found" });
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Delete file
 */
router.delete("/fs/:idt/file/delete", async (req: Request, res: Response) => {
  const { idt } = req.params;
  const relPath = req.query.location as string;
  if (!relPath) return res.status(400).json({ error: "location query param is required" });

  try {
    const filePath = resolvePath(idt as string, relPath);
    await fsPromises.unlink(filePath);
    res.json({ message: "File deleted", location: filePath });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Delete folder
 */
router.delete("/fs/:idt/folder/delete", async (req: Request, res: Response) => {
  const { idt } = req.params;
  const relPath = req.query.location as string;
  if (!relPath) return res.status(400).json({ error: "location query param is required" });

  try {
    const folderPath = resolvePath(idt as string, relPath);
    await fsPromises.rm(folderPath, { recursive: true, force: true });
    res.json({ message: "Folder deleted", location: folderPath });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Rename file
 */
router.post("/fs/:idt/file/rename", async (req: Request, res: Response) => {
  const { idt } = req.params;
  const { location, newName } = req.body;
  if (!location) return res.status(400).json({ error: "location is required" });
  if (!newName) return res.status(400).json({ error: "newName is required" });

  try {
    const oldPath = resolvePath(idt as string, location);
    const dir = path.dirname(location);
    const newPath = resolvePath(idt as string, path.join(dir, newName));

    await fsPromises.rename(oldPath, newPath);
    res.json({ message: "File renamed", oldLocation: location, newLocation: path.join(dir, newName) });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Rename folder
 */
router.post("/fs/:idt/folder/rename", async (req: Request, res: Response) => {
  const { idt } = req.params;
  const { location, newName } = req.body;
  if (!location) return res.status(400).json({ error: "location is required" });
  if (!newName) return res.status(400).json({ error: "newName is required" });

  try {
    const oldPath = resolvePath(idt as string, location);
    const dir = path.dirname(location);
    const newPath = resolvePath(idt as string, path.join(dir, newName));

    await fsPromises.rename(oldPath, newPath);
    res.json({ message: "Folder renamed", oldLocation: location, newLocation: path.join(dir, newName) });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Upload file
 */
router.post("/fs/:idt/file/upload", upload.single("file"), async (req: Request, res: Response) => {
  const { idt } = req.params;
  const relPath = (req.query.path as string) || "/";
  const file = (req as RequestWithFile).file;

  if (!file || !file.buffer) return res.status(400).json({ error: "No file uploaded" });

  try {
    const uploadPath = resolvePath(idt as string, path.join(relPath, file.originalname));
    await fsPromises.writeFile(uploadPath, file.buffer);
    res.json({ message: "File uploaded", location: uploadPath });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
