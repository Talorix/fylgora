#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const args = process.argv.slice(2);
const command = args[0];

const rootDir = process.cwd();
const dataFile = path.join(rootDir, "data.json");

function run(cmd, cmdArgs = []) {
    const child = spawn(cmd, cmdArgs, {
        stdio: "inherit",
        shell: true,
    });

    child.on("exit", (code) => {
        process.exit(code ?? 0);
    });
}

function showHelp() {
    console.log(`
fylgora - CLI

Usage:
  fylgora [--debug]        Run main application
  fylgora configure       Run configuration
  fylgora servers         List all servers
  fylgora help            Show this help

Options:
  --debug                 Enable debug mode
`);
}

function showServers() {
    if (!fs.existsSync(dataFile)) {
        console.error("❌ data.json not found");
        process.exit(1);
    }

    const raw = fs.readFileSync(dataFile, "utf8");
    const data = JSON.parse(raw);

    const ids = Object.keys(data);

    if (ids.length === 0) {
        console.log("No servers found.");
        return;
    }

    console.log("\nServers:\n");

    for (const id of ids) {
        const server = data[id];
        console.log(`• ${server.name}`);
        console.log(`  ID: ${id}`);
        console.log(`  Status: ${server.status}`);
        console.log(`  RAM: ${server.ram} MB`);
        console.log(`  Cores: ${server.core}`);
        console.log(`  Disk: ${server.disk} GB`);
        console.log(`  Port: ${server.port}`);
        console.log("");
    }
}

switch (command) {
    case "help":
        showHelp();
        break;

    case "configure":
        run("npm", ["run", "configure"]);
        break;

    case "servers":
        showServers();
        break;

    default: {
        const debug = args.includes("--debug");
        const entryFile = "dist/index.js";
        const distDir = path.join(rootDir, "dist");

        let child = null;
        let restarting = false;

        function killChild() {
            return new Promise((resolve) => {
                if (!child || child.killed) return resolve();

                const pid = child.pid;

                child.once("exit", () => resolve());

                if (process.platform === "win32") {
                    spawn("taskkill", ["/PID", pid, "/T", "/F"]);
                } else {
                    child.kill("SIGTERM");
                    setTimeout(() => child.kill("SIGKILL"), 500);
                }
            });
        }

        function start() {
            child = spawn("node", [entryFile], {
                stdio: "inherit",
                shell: false,
                env: {
                    ...process.env,
                    DEBUG: debug ? "true" : undefined,
                },
            });

            child.on("exit", () => {
                child = null;
            });
        }

        async function restart() {
            if (restarting) return;
            restarting = true;

            console.log("\n🔁 Restarting app...\n");

            await killChild();
            await new Promise((r) => setTimeout(r, 200));
            start();

            restarting = false;
        }

        if (debug) {
            console.log("🐛 Debug mode enabled");
            console.log("👀 Watching dist/ for changes...\n");

            start();

            let debounce;
            fs.watch(distDir, { recursive: true }, () => {
                clearTimeout(debounce);
                debounce = setTimeout(restart, 300);
            });

            process.on("SIGINT", async () => {
                await killChild();
                process.exit(0);
            });
        } else {
            run("node", [entryFile]);
        }

        break;
    }

}
