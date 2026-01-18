import Docker from 'dockerode';

export const executeCommand = async (container: Docker.Container, command: string): Promise<void> => {
    try {
        const stream = await container.attach({
            stream: true,
            stdin: true,
            stdout: true,
            stderr: true,
            hijack: true
        });
        stream.write(`${command}\n`);
        stream.end();
    } catch (error) {
        console.error(`Failed to send command:`, error);
    }
};