# 이미지 라벨링 프로토타입

FastAPI 기반 내부망 라벨링 서버입니다. 로그인 후 관리자가 프로젝트를 만들고, 프로젝트별 라벨 목록과 YOLO 폴더를 등록한 뒤 작업자에게 폴더를 배정합니다.

## 실행

가상환경은 `sharelabeling`을 사용합니다.

```powershell
conda activate sharelabeling
python -m pip install -r requirements.txt
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

프로젝트 생성·수정과 이미지 추출 화면에서 다른 프로젝트를 선택하고 `라벨 가져오기`를 누르면 편집 중인 라벨 목록이 원본의 이름, 순서, 색상으로 교체됩니다. 가져온 목록은 개별 편집할 수 있으며, 프로젝트를 저장하거나 추출을 시작할 때 반영됩니다.

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

프로젝트 목록은 저장된 설정과 폴더 상태로 표시합니다. 프로젝트 카드의 `진행상황`을 누르거나 할당 탭에서 프로젝트를 선택하면 해당 프로젝트의 이미지 통계를 집계합니다. 같은 프로젝트를 다시 열면 조회한 통계를 재사용하며, `새로고침`으로 최신 값을 확인할 수 있습니다.

### 영상에서 이미지 추출

1. 관리자 프로젝트 탭에서 `이미지 추출`을 열고 프로젝트 이름과 라벨 이름·색상을 설정합니다.
2. 서버의 영상 폴더에서 파일을 하나 이상 선택하고 저장 폴더, 추출 FPS, 폴더당 최대 이미지 수를 지정합니다. 기본값은 1 FPS와 1,000장입니다.
3. `추출 시작`을 누르면 프로젝트 목록에 `이미지 추출 중`인 행이 생깁니다. 현재 영상, 추출한 이미지 수, 폴더 수가 자동으로 갱신됩니다. 완료되면 같은 행에 `추출 완료`가 표시되고, 할당 탭에서 폴더를 작업자에게 배정할 수 있습니다. 실패하면 해당 행에 원인이 표시됩니다.

예를 들어 폴더당 500장으로 설정하고 한 영상에서 1,200장을 추출하면 500장, 500장, 200장씩 나뉩니다. 각 분할 폴더에는 이미지가 담긴 `images/`, 빈 `labels/`, 지정한 라벨 순서로 작성된 `classes.txt`가 생성됩니다.

### 추출한 이미지 자동 라벨링

1. 프로젝트 카드에서 `자동 라벨링`을 누르면 기존 라벨과 작업자가 선점한 이미지를 확인합니다. 해당 이미지가 있으면 전체 대상 수와 덮어쓰기 안내를 확인하고 `설정 계속`을 누릅니다. 실제 추론은 `자동 라벨링 시작`을 누르면 시작합니다.
2. 서버에 있는 Ultralytics 객체 탐지 모델의 `.pt` 경로, 사용할 GPU 수, 장치당 배치 크기를 지정합니다. GPU 0개는 CPU 모드입니다. GPU 2개와 배치 8을 선택하면 두 GPU가 이미지를 나눠 각자 최대 8장씩 추론합니다. CUDA GPU를 사용하려면 서버의 드라이버와 호환되는 CUDA 지원 PyTorch를 설치하세요. [PyTorch 설치 안내](https://pytorch.org/get-started/locally/)
3. 시작 후 카드에서 처리 이미지 수, 저장한 라벨과 박스 수, 미검출 및 건너뛴 이미지 수를 확인합니다. 모델 경로와 실행 설정은 프로젝트별로 저장됩니다.

서버는 Ultralytics의 `YOLO(model_path)`로 모델을 엽니다. 출처를 신뢰하는 `.pt` 파일을 지정하세요. 모델에 Albumentations 객체가 저장된 경우 서버의 Python 환경에 학습 때 사용한 Albumentations 버전이 필요합니다.

추론 이미지 크기(`imgsz`)는 처음에 640px로 입력됩니다. 다른 양의 정수로 바꾸거나 입력칸을 비워 모델 기본값으로 실행할 수 있습니다. 최소 신뢰도(`conf`)는 0부터 1까지 설정할 수 있고 기본값은 0.25입니다. 두 값은 프로젝트별로 저장됩니다.

설정한 신뢰도 기준을 통과한 박스를 모델의 원래 클래스 번호와 정규화된 YOLO 좌표로 `labels/`에 저장합니다. 이미지별 모델 클래스 이름은 `labels/.meta/`에 함께 기록합니다. 같은 번호의 프로젝트 라벨 이름이 다르거나 번호가 없으면 관리자 카드와 작업자의 박스 목록에 경고가 표시됩니다. 이름 비교 시 대소문자는 구분하지 않습니다. 작업자가 박스 위치만 수정하면 모델 클래스가 유지되고, 직접 라벨을 선택하면 해당 프로젝트 라벨로 바뀝니다.

매번 프로젝트의 전체 이미지를 추론합니다. 이미지별 추론이 끝나면 수동·자동 라벨을 이번 결과로 교체하며, 검출된 박스가 0개면 같은 이름의 빈 `.txt` 파일을 저장합니다. 작업자가 선점한 이미지도 재라벨링 대상입니다.

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
- `GET /api/admin/config` (관리자 화면은 `?include_stats=false`로 이미지 집계를 생략)
- `GET /api/admin/projects/{project_id}/progress`
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
