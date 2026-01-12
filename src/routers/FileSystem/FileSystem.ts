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
        let size: number | null = null;
        if (item.isFile()) {
          const stats = await fsPromises.stat(itemPath);
          size = stats.size;
        } else if (item.isDirectory()) {
          size = await getFolderSize(itemPath);
        }

        const stats = await fsPromises.stat(itemPath);

        return {
          name: item.name,
          type: item.isDirectory() ? "folder" : "file",
          createdAt: stats.birthtime,
          size,
          extension: item.isFile() ? path.extname(item.name) : null,
        };
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
