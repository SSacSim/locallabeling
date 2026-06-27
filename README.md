# 이미지 라벨링 프로토타입

FastAPI 기반 내부망 라벨링 서버입니다. 로그인 후 관리자가 프로젝트를 만들고, 프로젝트별 라벨 목록과 YOLO 폴더를 등록한 뒤 작업자에게 폴더를 배정합니다.

## 실행

가상환경은 `sharelabeling`을 사용합니다.

```powershell
conda activate sharelabeling
python server.py --host 0.0.0.0 --port 8000
```

환경 활성화 없이 실행:

```powershell
C:\Users\sim\anaconda3\envs\sharelabeling\python.exe server.py --host 0.0.0.0 --port 8000
```

또는:

```powershell
.\run_server.ps1
```

## 초기 로그인

처음 실행하면 기본 관리자 계정이 생성됩니다.

```text
아이디: admin
비밀번호: admin
```

운영에 쓰기 전 관리자 비밀번호 변경 기능을 별도로 붙이는 것이 좋습니다. 현재는 프로토타입입니다.

## 데이터 구조

```text
data/
  app_state.json        # 사용자, 프로젝트, 라벨 목록, YOLO 폴더, 배정 정보
  yolo/                 # 기본 작업 루트 예시
```

등록하는 YOLO 폴더는 아래 구조여야 합니다.

```text
A/
  subset_01/
    images/
      0001.jpg
    labels/
      0001.txt
  subset_02/
    images/
    labels/
```

관리자 화면에서 `A`를 등록하면, 바로 아래의 `subset_01`, `subset_02`처럼 `images`와 `labels`를 가진 폴더들이 프로젝트의 YOLO 폴더로 등록됩니다. `A` 자체가 `images`와 `labels`를 가지는 경우에도 등록됩니다.

## 프로젝트와 라벨 목록

프로젝트 생성 시 라벨 목록을 한 줄에 하나씩 입력합니다.

```text
person
car
defect
```

라벨을 비워두면 기본값이 등록됩니다.

```text
positive
negative
uncertain
```

라벨 ID는 입력 순서대로 `0, 1, 2...`가 됩니다. 프로젝트에 YOLO 폴더를 등록하면 각 YOLO 루트에 `classes.txt`도 생성됩니다.

## 라벨 저장 방식

현재 프로토타입은 박스 드로잉 UI가 없으므로 선택한 클래스를 전체 이미지 박스로 저장합니다.

```text
<class_id> 0.5 0.5 1.0 1.0
```

예:

```text
0 0.5 0.5 1.0 1.0
```

메모, 작업자, claim 정보는 YOLO labels 폴더 아래 `.meta`에 JSON sidecar로 저장됩니다.

```text
labels/
  0001.txt
  .meta/
    0001.json
```

## 관리자 흐름

1. `admin / admin`으로 로그인합니다.
2. 작업자 계정을 생성합니다. 임시 작업자는 `임시 계정 생성` 버튼으로 아이디/비밀번호를 바로 만들 수 있습니다.
3. 프로젝트를 생성하고 라벨 목록을 등록합니다.
4. 프로젝트에 YOLO 루트 경로를 등록합니다.
5. 작업자 배정 영역에서 작업자와 프로젝트를 선택합니다.
6. 표시된 YOLO 폴더 체크박스 중 작업할 폴더를 선택하고 `선택 폴더 배정 저장`을 누릅니다.

## 작업자 흐름

1. 관리자가 만든 계정으로 로그인합니다.
2. `이미지 받기`를 누릅니다.
3. 배정된 프로젝트/YOLO 폴더에서 아직 라벨이 없는 이미지가 선점됩니다.
4. 프로젝트 라벨 목록에서 라벨을 선택합니다.
5. `라벨 저장`을 누르면 해당 YOLO 폴더의 `labels` 아래에 `.txt`가 저장됩니다.

## 주요 API

- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `GET /api/admin/config`
- `POST /api/admin/users`
- `POST /api/admin/projects`
- `POST /api/admin/projects/remove`
- `POST /api/admin/projects/labels`
- `POST /api/admin/projects/folders`
- `POST /api/admin/projects/folders/remove`
- `POST /api/admin/assignments`
- `POST /api/admin/assignments/bulk`
- `POST /api/admin/unassign`
- `GET /api/worker/config`
- `GET /api/images`
- `GET /api/stats`
- `POST /api/claim`
- `POST /api/labels`
- `POST /api/release`
- `GET /docs`

## 현재 한계

- 인증은 메모리 토큰 기반입니다. 서버 재시작 시 다시 로그인해야 합니다.
- 비밀번호 변경/삭제 UI는 아직 없습니다.
- 박스 드로잉은 아직 없고, 선택 클래스가 전체 이미지 YOLO 박스로 저장됩니다.
- 서버를 여러 프로세스로 띄우면 claim 상태가 공유되지 않습니다.
