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

        stream.on('error', (error: Error) => {
            console.error(`Stream error:`, error);
        });

        stream.on('end', () => {
            console.debug(`Command stream ended.`);
        });
    } catch (error) {
        console.error(`Failed to send command:`, error);
    }
};