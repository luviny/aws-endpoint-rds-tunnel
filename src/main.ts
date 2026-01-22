import { getInput, setFailed, info, error as logError, exportVariable } from '@actions/core';
import { spawn } from 'node:child_process';

async function validateAwsSetup() {
    info('Validating AWS CLI setup and credentials...');
    return new Promise<void>((resolve, reject) => {
        const check = spawn('aws', ['sts', 'get-caller-identity'], {
            stdio: 'pipe',
            env: { ...process.env, AWS_PAGER: '' }, // 환경 변수 상속 및 페이저 비활성화
        });

        let stdout = '';
        let stderr = '';

        check.stdout.on('data', (d) => (stdout += d.toString()));
        check.stderr.on('data', (d) => (stderr += d.toString()));

        check.on('close', (code) => {
            if (code === 0) {
                info(`AWS Setup Validated: ${stdout.trim()}`);
                resolve();
            } else {
                reject(
                    new Error(
                        `AWS CLI "sts get-caller-identity" failed with code ${code}.\nStdout: ${stdout}\nStderr: ${stderr}\nCheck if AWS credentials and region are correctly set in the environment.`,
                    ),
                );
            }
        });

        check.on('error', (err) => {
            reject(new Error(`Failed to spawn AWS CLI (check if 'aws' is installed): ${err.message}`));
        });
    });
}

async function bootstrap() {
    try {
        let dbHost: string;
        let dbPort: string;

        const databaseUrl = getInput('database-url');
        const host = getInput('host');
        const port = getInput('port');
        const tunnelPort = getInput('tunnel-port') || '54321'; // 기본값 설정
        const awsEndpointId = getInput('aws-endpoint-id', { required: true });

        // 0. AWS CLI 실행 환경 검증
        await validateAwsSetup();

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
            {
                detached: true,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, AWS_PAGER: '' }, // 중요: 환경 변수 전달 및 페이징 방지
            },
        );

        await new Promise<void>((resolve, reject) => {
            let tunnelEstablished = false;

            // 1. 타임아웃을 CI/CD 환경에 맞춰 15초로 넉넉하게 설정
            const timeout = setTimeout(() => {
                if (!tunnelEstablished) {
                    tunnel.kill();
                    reject(new Error('Tunnel setup timed out (15s). Please check AWS IAM permissions, network connectivity, or missing AWS Credentials.'));
                }
            }, 15000);

            // 성공 여부를 판별하는 공통 로직
            const onData = (data: Buffer) => {
                const message = data.toString();
                // 디버깅을 위해 로그 출력 (줄바꿈 제거)
                info(`[AWS CLI]: ${message.trim()}`);

                if (message.includes('Listening') && !tunnelEstablished) {
                    tunnelEstablished = true;
                    info('Tunnel successfully established.');
                    clearTimeout(timeout);
                    resolve();
                }
            };

            // 2. stdout과 stderr 모두 감시 (AWS CLI의 Listening 메시지는 보통 stderr로 출력됨)
            tunnel.stdout.on('data', onData);

            tunnel.stderr.on('data', (data) => {
                const message = data.toString();

                // stderr 로그도 출력하여 CI에서 에러 확인 가능하게 함
                if (!message.includes('Listening')) {
                    info(`[AWS CLI stderr]: ${message.trim()}`);
                }

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
                    tunnelEstablished = true; // prevent double reject handling in close
                    tunnel.kill();
                    clearTimeout(timeout);
                    reject(new Error(`AWS Tunnel failed: ${message}`));
                }
            });

            // 프로세스 자체가 조기 종료되는 경우 처리 (예: 자격 증명 없음)
            tunnel.on('close', (code) => {
                if (!tunnelEstablished) {
                    clearTimeout(timeout);
                    reject(new Error(`AWS CLI exited unexpectedly with code ${code}. Check logs above for details.`));
                }
            });

            // 프로세스 실행 에러 (명령어 못 찾음 등)
            tunnel.on('error', (err) => {
                if (!tunnelEstablished) {
                    clearTimeout(timeout);
                    reject(new Error(`Failed to execute AWS CLI: ${err.message}`));
                }
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
