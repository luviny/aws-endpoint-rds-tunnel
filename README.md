# AWS Endpoint RDS Tunnel

AWS EC2 Instance Connect Endpoint를 사용하여 GitHub Actions Runner와 프라이빗 서브넷에 위치한 RDS 간에 안전한 SSH 터널을 생성하는 Action입니다.

이 Action을 사용하면 Bastion Host(Jump Server)를 별도로 관리할 필요 없이, AWS 관리형 서비스인 EC2 Instance Connect Endpoint를 통해 안전하게 데이터베이스에 접근할 수 있습니다. 마이그레이션, 스키마 변경, 데이터 시딩 등의 작업에 유용합니다.

## 기능 (Features)

- **보안 터널링**: Public IP가 없는 RDS에 안전하게 접속할 수 있습니다.
- **간편한 설정**: Database URL 또는 Host/Port 정보만으로 터널을 구성합니다.
- **AWS 통합**: AWS CLI의 `ec2-instance-connect open-tunnel` 명령어를 내부적으로 사용합니다.

## 사전 요구사항 (Prerequisites)

이 Action을 사용하기 전에 다음 사항들이 준비되어야 합니다.

1.  **AWS Credentials 설정**: 워크플로우 내에서 `aws-actions/configure-aws-credentials` 등을 통해 AWS 권한이 설정되어 있어야 합니다.
2.  **EC2 Instance Connect Endpoint 생성**: VPC 내에 EC2 Instance Connect Endpoint가 생성되어 있어야 하며, 해당 Endpoint에서 RDS로의 접근이 Security Group을 통해 허용되어 있어야 합니다.
3.  **IAM 권한**: Runner가 사용하는 IAM 역할(Role)에 `ec2-instance-connect:OpenTunnel` 권한이 있어야 합니다.

## 사용 방법 (Usage)

### 기본 사용법 (Database URL 사용)

가장 일반적인 사용 패턴입니다. `database-url`을 입력하면 호스트와 포트를 자동으로 추출하여 터널을 연결합니다.

```yaml
steps:
  - name: Checkout code
    uses: actions/checkout@v4

  - name: Configure AWS Credentials
    uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: arn:aws:iam::123456789012:role/my-github-actions-role
      aws-region: ap-northeast-2

  - name: Open RDS Tunnel
    uses: luviny/aws-endpoint-rds-tunnel@v1
    with:
      aws-endpoint-id: eice-0123456789abcdef0  # EC2 Instance Connect Endpoint ID
      database-url: ${{ secrets.DATABASE_URL }} # 예: postgresql://user:pass@rds-host:5432/db
      tunnel-port: '5432' # 로컬에서 사용할 포트 (기본값: 11111)

  - name: Run Migration
    run: |
      # 로컬 포트(5432)를 통해 RDS에 접속 가능
      npx prisma migrate deploy
    env:
      DATABASE_URL: postgresql://user:pass@localhost:5432/db # 로컬 호스트로 변경
```

### 호스트 및 포트 직접 지정

URL 파싱 대신 호스트와 포트를 직접 지정할 수도 있습니다.

```yaml
steps:
  - name: Open RDS Tunnel
    uses: luviny/aws-endpoint-rds-tunnel@v1
    with:
      aws-endpoint-id: eice-0123456789abcdef0
      host: my-rds-instance.cluster-xyz.ap-northeast-2.rds.amazonaws.com
      port: '3306'
      tunnel-port: '3306'
```

## 입력 변수 (Inputs)

| 입력 변수명 | 설명 | 필수 여부 | 기본값 |
| :--- | :--- | :---: | :---: |
| `aws-endpoint-id` | 사용할 EC2 Instance Connect Endpoint의 ID입니다. (예: `eice-xxxx`) | **Yes** | N/A |
| `database-url` | 연결할 데이터베이스의 URL입니다. (Host와 Port 추출용) | No | N/A |
| `host` | RDS 호스트 주소입니다. (`database-url` 미사용 시 필수) | No | N/A |
| `port` | RDS 포트 번호입니다. (`database-url` 미사용 시 필수) | No | N/A |
| `tunnel-port` | 로컬 Runner에서 열 터널링 포트입니다. | No | `11111` |

## 출력 환경 변수 (Output Environment Variables)

이 Action은 다음 단계에서 쉽게 사용할 수 있도록 자동으로 환경 변수를 생성합니다.

| 환경 변수명 | 설명 | 생성 조건 |
| :--- | :--- | :--- |
| `TUNNEL_DATABASE_URL` | 로컬 호스트(`localhost`)와 터널 포트로 변경된 Database URL입니다. | `database-url` 입력 시 |
| `TUNNEL_DB_HOST` | 로컬 호스트 주소 (`localhost`) | `host`/`port` 입력 시 |
| `TUNNEL_DB_PORT` | 터널링된 로컬 포트 번호 | `host`/`port` 입력 시 |

## 사용 예시 업데이트

### Database URL 사용 시

`TUNNEL_DATABASE_URL`을 사용하여 로컬 연결 정보를 별도로 구성할 필요가 없습니다.

```yaml
steps:
  - name: Open RDS Tunnel
    uses: luviny/aws-endpoint-rds-tunnel@v1
    with:
      aws-endpoint-id: eice-xxxx
      database-url: ${{ secrets.DATABASE_URL }}

  - name: Run Migration
    run: npx prisma migrate deploy
    env:
      DATABASE_URL: ${{ env.TUNNEL_DATABASE_URL }} # 자동 생성된 로컬 접속 URL 사용
```

### 호스트 및 포트 사용 시

```yaml
steps:
  - name: Open RDS Tunnel
    uses: luviny/aws-endpoint-rds-tunnel@v1
    with:
      aws-endpoint-id: eice-xxxx
      host: my-rds.xxx.amazonaws.com
      port: '3306'

  - name: Run Script
    run: python script.py
    env:
      DB_HOST: ${{ env.TUNNEL_DB_HOST }} # localhost
      DB_PORT: ${{ env.TUNNEL_DB_PORT }} # 11111 (기본값)
```

## 참고 사항

- 이 Action은 백그라운드 프로세스로 터널을 유지합니다.
- 5초 내에 터널 연결이 수립되지 않으면 다음 단계로 넘어가지만, 에러 로그가 발생할 수 있습니다.
