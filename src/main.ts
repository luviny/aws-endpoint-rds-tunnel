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
        const tunnel = spawn(
            'aws',
            [
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
            ],
            { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
        ); // 입력을 무시하고 파이프 연결

        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                // 1. 타임아웃 발생 시 터널 프로세스를 종료해야 워크플로우가 멈추지 않습니다.
                tunnel.kill();
                logError('5 second timeout occurred. Failed to establish tunnel.');

                // 2. resolve가 아닌 reject를 호출하여 에러 상태로 스텝을 종료합니다.
                // 터널이 열리지 않았는데 다음 스텝(DB 작업 등)으로 넘어가면 결국 거기서 더 큰 에러가 발생합니다.
                reject(new Error('Tunnel setup timed out.'));
            }, 5000);

            tunnel.stdout.on('data', (data) => {
                const message = data.toString();
                if (message.includes('Listening')) {
                    info('Tunnel successfully established.');
                    clearTimeout(timeout);
                    resolve();
                }
            });

            tunnel.stderr.on('data', (data) => {
                const errorMessage = data.toString();
                // 실제 권한이나 네트워크 에러가 발생한 경우 즉시 종료
                if (errorMessage.includes('UnauthorizedOperation') || errorMessage.includes('Error')) {
                    logError(`[Tunnel Error]: ${errorMessage}`);
                    tunnel.kill();
                    clearTimeout(timeout);
                    reject(new Error(`AWS Tunnel failed: ${errorMessage}`));
                }
            });

            tunnel.on('error', (err) => {
                clearTimeout(timeout);
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
