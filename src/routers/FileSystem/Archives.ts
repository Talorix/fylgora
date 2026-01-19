import express from "express";
import type { Request, Response } from "express";
import { promises as fsPromises } from "fs";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import archiver from "archiver";
import AdmZip from "adm-zip";

const router = express.Router();

// 1. Load Config
const configPath = path.join(process.cwd(), "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const __dirname = process.cwd();

// 2. Define Base Paths
// Where the servers live (Source for backup, Destination for extract)
const SERVERS_DIR = path.resolve(__dirname, config.servers.folder);
// Where the Archives live (Destination for backup, Source for extract)
const ARCHIVES_DIR = path.resolve(__dirname, config.filesystem.archives_folder);

/**
 * Helper: Safely resolve the Server Container path
 */
function resolveServerPath(idt: string): string {
    const base = path.join(SERVERS_DIR, idt);
    if (!base.startsWith(SERVERS_DIR)) {
        throw new Error("Invalid server path traversal detected");
    }
    return base;
}

/**
 * Helper: Safely resolve the Archive Storage path
 */
function resolveArchiveStoragePath(idt: string): string {
    const base = path.join(ARCHIVES_DIR, idt);
    if (!base.startsWith(ARCHIVES_DIR)) {
        throw new Error("Invalid archive path traversal detected");
    }
    return base;
}

/**
 * Helper: Format bytes to human readable string
 */
function formatBytes(bytes: number, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/**
 * GET /fs/:idt/archive
 * Create an archive of the server directory
 * Format: archive-{ArchiveId-12-Letters-Long}.zip
 */
router.get("/fs/:idt/archive", async (req: Request, res: Response) => {
  const { idt } = req.params;

  try {
    const sourceDir = resolveServerPath(idt as any);
    const destDir = resolveArchiveStoragePath(idt as any);
    await fsPromises.mkdir(destDir, { recursive: true });

    const archiveId = crypto.randomBytes(6).toString("hex");
    const archiveName = `archive-${archiveId}.zip`;
    const outputPath = path.join(destDir, archiveName);

    const output = fs.createWriteStream(outputPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.pipe(output);

    // Filter logic to ignore files with no read access (like rw-------)
    archive.directory(sourceDir, false, (entry) => {
      const fullPath = path.join(sourceDir, entry.name);
      try {
        // Check if the current process has READ permission
        // R_OK constants is 4. If this throws, we skip the file.
        fs.accessSync(fullPath, fs.constants.R_OK);
        return entry; 
      } catch (err) {
        console.warn(`Skipping file due to permissions: ${entry.name}`);
        return false; // This ignores the file and continues the zip process
      }
    });

    await archive.finalize();

    res.json({
      message: "Archive created (skipped restricted files)",
      archiveName,
      path: outputPath
    });

  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /fs/:idt/archives
 * Get all archives for a specific server
 */
router.get("/fs/:idt/archives", async (req: Request, res: Response) => {
    const { idt } = req.params;

    try {
        const archiveDir = resolveArchiveStoragePath(idt as any);

        // If folder doesn't exist yet, return empty array
        if (!fs.existsSync(archiveDir)) {
            return res.json([]);
        }

        const files = await fsPromises.readdir(archiveDir);

        // Filter for .zip files and get stats
        const archives = await Promise.all(
            files
                .filter(file => file.endsWith(".zip"))
                .map(async (file) => {
                    const filePath = path.join(archiveDir, file);
                    const stats = await fsPromises.stat(filePath);
                    return {
                        name: file,
                        size: stats.size,
                        sizeHuman: formatBytes(stats.size),
                        createdAt: stats.birthtime,
                        path: filePath
                    };
                })
        );

        // Sort by newest first
        archives.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

        res.json(archives);

    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /fs/:idt/archive
 * Unextract (Unzip) the archive into the server directory
 */
router.post("/fs/:idt/archive", async (req: Request, res: Response) => {
  const { idt } = req.params;
  const { archiveName } = req.body;

  if (!archiveName) {
    return res.status(400).json({ error: "archiveName is required in body" });
  }

  try {
    const archiveDir = resolveArchiveStoragePath(idt as any);
    const archivePath = path.join(archiveDir, archiveName);
    const targetDir = resolveServerPath(idt as any);

    if (!fs.existsSync(archivePath)) {
      return res.status(404).json({ error: "Archive file not found" });
    }

    const zip = new AdmZip(archivePath);
    const zipEntries = zip.getEntries();

    // Iterate through entries manually to avoid chmod/EPERM issues
    for (const entry of zipEntries) {
      if (entry.isDirectory) continue;

      const targetFilePath = path.join(targetDir, entry.entryName);
      const targetSubDir = path.dirname(targetFilePath);

      // Ensure the sub-directory exists
      if (!fs.existsSync(targetSubDir)) {
        await fsPromises.mkdir(targetSubDir, { recursive: true });
      }
      await fsPromises.writeFile(targetFilePath, entry.getData());
    }

    res.json({ message: "Archive extracted successfully (permissions ignored)", target: targetDir });

  } catch (err: any) {
    console.error("Extraction error:", err);
    res.status(500).json({ error: "Failed to extract archive: " + err.message });
  }
});
/**
 * DELETE /fs/:idt/archive
 * Delete the archive
 * Query: ?archiveName=archive-xyz.zip
 */
router.delete("/fs/:idt/archive", async (req: Request, res: Response) => {
    const { idt } = req.params;
    const archiveName = req.query.archiveName as string;

    if (!archiveName) {
        return res.status(400).json({ error: "archiveName query param is required" });
    }

    try {
        const archiveDir = resolveArchiveStoragePath(idt as any);
        const archivePath = path.join(archiveDir, archiveName);

        // Prevent path traversal on the filename itself
        if (path.dirname(archivePath) !== archiveDir) {
            return res.status(400).json({ error: "Invalid filename" });
        }

        await fsPromises.unlink(archivePath);

        res.json({ message: "Archive deleted successfully", archiveName });

    } catch (err: any) {
        if (err.code === 'ENOENT') {
            return res.status(404).json({ error: "Archive not found" });
        }
        res.status(500).json({ error: err.message });
    }
});

export default router;