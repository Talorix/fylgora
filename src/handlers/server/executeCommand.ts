import * as pty from 'node-pty';
import Docker from 'dockerode';

// Map of containerId -> pty process
const containerStreams = new Map<string, pty.IPty>();

/**
 * Attach to a container if not already attached, or return the existing session.
 */
export const getContainerStream = (container: Docker.Container): pty.IPty => {
    const containerId = container.id;
    if (containerStreams.has(containerId)) {
        return containerStreams.get(containerId)!;
    }
    const term = pty.spawn('docker', ['attach', containerId], {
        name: 'xterm-color',
        cols: 80,
        rows: 30,
        cwd: process.cwd(),
        env: process.env
    });
    containerStreams.set(containerId, term);
    return term;
};

/**
 * Send a command to a container's attached stream.
 */
export const executeCommand = (container: Docker.Container, command: string) => {
    try {
        const term = getContainerStream(container);

        // Send command (\r = Enter)
        term.write(`${command}\r`);
    } catch (err) {
        console.error(`Failed to send command to container ${container.id}:`, err);
    }
};

/**
 * Close a container's stream if needed
 */
export const closeContainerStream = (container: Docker.Container) => {
    const containerId = container.id;
    const term = containerStreams.get(containerId);
    if (!term) return;

    term.write('exit\r'); // optional: tells container stdin main process to exit
    term.kill();          // kills the pty locally
    containerStreams.delete(containerId);
};
