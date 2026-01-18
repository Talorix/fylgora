import express from "express";
import type { Request, Response } from "express";
import { promises as fsPromises } from "fs";
import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { spawn } from "child_process";

const router = express.Router();
const config = JSON.parse(fs.readFileSync(path.join(process.cwd(), "config.json"), "utf8"));
const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, config.servers.folder);
const ARCHIVES_DIR = path.join(ROOT, config.filesystem.archives_folder);

/**
 * Ensure directory exists
 */
async function ensureDir(dir: string) {
    await fsPromises.mkdir(dir, { recursive: true });
}

/**
 * Resolve archive path safely
 */
function resolveArchivePath(idt: string, archiveId: string) {
    const base = path.join(ARCHIVES_DIR, idt);
    const filename = `archive-${idt}-${archiveId}.tar.gz`;
    const full = path.join(base, filename);

    if (!full.startsWith(base)) {
        throw new Error("Invalid archive path");
    }
    return full;
}

/**
 * Resolve data directory safely
 */
function resolveDataDir(idt: string) {
    const dir = path.join(DATA_DIR, idt);
    if (!dir.startsWith(DATA_DIR)) {
        throw new Error("Invalid data path");
    }
    return dir;
}

/**
 * GET /fs/archives/:idt
 * List all archives
 */
router.get("/fs/archives/:idt", async (req: Request, res: Response) => {
    const { idt } = req.params;

    try {
        const dir = path.join(ARCHIVES_DIR, idt as any);
        await ensureDir(dir);

        const files = await fsPromises.readdir(dir);
        const archives = files
            .filter(f => f.startsWith(`archive-${idt}-`) && f.endsWith(".tar.gz"))
            .map(f => ({
                archiveId: f.replace(`archive-${idt}-`, "").replace(".tar.gz", ""),
                filename: f
            }));

        res.json({ idt, archives });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /fs/archives/:idt
 * Create a new archive
 */
router.post("/fs/archives/:idt", async (req: Request, res: Response) => {
    const { idt } = req.params;
    const archiveId = [...randomBytes(7)].map(b => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[b % 62]).join("");

    try {
        const dataDir = resolveDataDir(idt as any);
        const archiveDir = path.join(ARCHIVES_DIR, idt as any);
        await ensureDir(archiveDir);

        const archivePath = resolveArchivePath(idt as any, archiveId);

        const tar = spawn("tar", [
            "-czf",
            archivePath,
            "--ignore-failed-read",
            "-C",
            dataDir,
            "."
        ]);

        tar.stdout.on("data", (data) => console.log("tar stdout:", data.toString()));
        tar.stderr.on("data", (data) => console.error("tar stderr:", data.toString()));

        tar.on("close", code => {
            if (code !== 0) {
                return res.status(500).json({ error: "tar exited with error" });
            }
            res.json({ idt, archiveId });
        });

    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /fs/archives/:idt/:archiveId
 * Download archive
 */
router.get("/fs/archives/:idt/:archiveId", async (req: Request, res: Response) => {
    const { idt, archiveId } = req.params;

    try {
        const archivePath = resolveArchivePath(idt as any, archiveId as any);

        if (!fs.existsSync(archivePath)) {
            return res.status(404).json({ error: "Archive not found" });
        }

        res.download(
            archivePath,
            path.basename(archivePath),
            err => err && console.error(err)
        );
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /fs/archives/:idt/:archiveId
 * Unextract archive into data/:idt
 */
router.post("/fs/archives/:idt/:archiveId", async (req: Request, res: Response) => {
    const { idt, archiveId } = req.params;

    try {
        const archivePath = resolveArchivePath(idt as any, archiveId as any);
        const dataDir = resolveDataDir(idt as any);

        if (!fs.existsSync(archivePath)) {
            return res.status(404).json({ error: "Archive not found" });
        }

        await ensureDir(dataDir);

        const tar = spawn("tar", [
            "-xzf",
            archivePath,
            "-C",
            dataDir
        ]);

        tar.on("error", err => {
            console.error(err);
            res.status(500).json({ error: "Failed to extract archive" });
        });

        tar.on("close", code => {
            if (code !== 0) {
                return res.status(500).json({ error: "tar exited with error" });
            }
            res.json({ idt, archiveId, extracted: true });
        });

    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
