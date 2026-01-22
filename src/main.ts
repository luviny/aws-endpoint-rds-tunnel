import { getInput, setFailed, info, error as logError, exportVariable } from '@actions/core';
import { spawn } from 'node:child_process';

async function bootstrap() {
    try {
        let dbHost: string;
        let dbPort: string;

        const databaseUrl = getInput('database-url');
        const host = getInput('host');
        const port = getInput('port');
        const tunnelPort = getInput('tunnel-port') || '54321'; // 기본값 설정
        const awsEndpointId = getInput('aws-endpoint-id', { required: true });

        // 1. 정보 추출 로직 개선
        if (databaseUrl) {
            const parsedUrl = new URL(databaseUrl);
            if (!parsedUrl.hostname) throw new Error('Could not find host in database-url.');
            dbHost = parsedUrl.hostname;
            dbPort = parsedUrl.port || (parsedUrl.protocol === 'postgresql:' ? '5432' : '3306');
        } else {
            if (!host || !port) throw new Error('Either database-url or host/port information is required.');
            dbHost = host;
            dbPort = port;
        }

        info(`Starting tunnel: ${dbHost}:${dbPort} -> localhost:${tunnelPort}`);

        // 2. 터널 실행
        const tunnel = spawn('aws', [
            'ec2-instance-connect',
            'open-tunnel',
            '--instance-connect-endpoint-id',
            awsEndpointId,
            '--private-ip-address',
            dbHost,
            '--local-port',
            tunnelPort,
            '--remote-port',
            dbPort,
        ]);

        // 3. 로그 모니터링 (문제 발생 시 원인 파악용)
        tunnel.stderr.on('data', (data) => {
            logError(`[Tunnel Error]: ${data.toString()}`);
        });

        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                info('5 second timeout occurred, proceeding to next step.');
                resolve();
            }, 5000);

            tunnel.stdout.on('data', (data) => {
                const message = data.toString();
                if (message.includes('Listening')) {
                    info('Tunnel successfully established.');
                    clearTimeout(timeout);
                    resolve();
                }
            });

            tunnel.on('error', (err) => {
                reject(new Error(`Failed to execute AWS CLI: ${err.message}`));
            });
        });

        if (databaseUrl) {
            const parsedUrl = new URL(databaseUrl);

            parsedUrl.hostname = 'localhost';
            parsedUrl.port = tunnelPort;

            exportVariable('TUNNEL_DATABASE_URL', parsedUrl.toString());
        } else {
            exportVariable('TUNNEL_DB_HOST', 'localhost');
            exportVariable('TUNNEL_DB_PORT', tunnelPort);
        }

        // 부모 프로세스가 종료되어도 터널이 유지되도록 설정 (Background 실행)
        tunnel.unref();
    } catch (error) {
        setFailed(error instanceof Error ? error.message : String(error));
    }
}

bootstrap();
