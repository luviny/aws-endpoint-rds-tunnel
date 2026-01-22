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
            // 1. 타임아웃을 CI/CD 환경에 맞춰 15초로 넉넉하게 설정
            const timeout = setTimeout(() => {
                tunnel.kill();
                reject(new Error('Tunnel setup timed out (15s). Please check AWS IAM permissions or network connectivity.'));
            }, 15000);

            // 성공 여부를 판별하는 공통 로직
            const onData = (data: Buffer) => {
                const message = data.toString();
                if (message.includes('Listening')) {
                    info('Tunnel successfully established.');
                    clearTimeout(timeout);
                    resolve();
                }
            };

            // 2. stdout과 stderr 모두 감시 (AWS CLI의 Listening 메시지는 보통 stderr로 출력됨)
            tunnel.stdout.on('data', onData);

            tunnel.stderr.on('data', (data) => {
                const message = data.toString();

                // 메시지에 성공 키워드가 있다면 처리
                if (message.includes('Listening')) {
                    onData(data);
                    return;
                }

                // 3. 실제 에러 발생 시 처리
                // UnauthorizedOperation: 권한 부족 / Error: 일반 에러
                if (message.includes('UnauthorizedOperation') || message.toLowerCase().includes('error')) {
                    logError(`[AWS CLI Error]: ${message}`);
                    // 치명적인 에러인 경우 즉시 종료하고 reject
                    tunnel.kill();
                    clearTimeout(timeout);
                    reject(new Error(`AWS Tunnel failed: ${message}`));
                }
            });

            // 프로세스 자체의 실행 에러 (명령어 못 찾음 등)
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
