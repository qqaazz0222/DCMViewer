# DCMViewer for Visual Studio Code

VS Code 편집기 탭에서 DICOM 시리즈, NIfTI, NumPy 볼륨을 탐색하는 읽기 전용 뷰어입니다. 기존 DCMViewer의 React 렌더러를 재사용합니다.

## 설치

VS Code의 Extensions 화면에서 `…` → **Install from VSIX…**를 선택하고 `dcmviewer-2.0.5.vsix`를 설치합니다. VS Code 1.85 이상이 필요합니다.

## 사용

- `.dcm`, `.dicom`, `.nii`, `.nii.gz`, `.npy` 파일을 클릭하면 DCMViewer 편집기가 열립니다. 다른 편집기가 기본값이면 **Open With… → DCMViewer**를 선택합니다.
- DICOM 전체 시리즈는 폴더를 우클릭하고 **DCMViewer: Open Medical Folder / DICOM Series**로 엽니다. 하위 폴더의 지원 파일도 수집합니다. 파일 하나를 열면 해당 파일만 로드합니다.
- 명령 팔레트에서 **DCMViewer: Open Viewer**, **Open Medical Files**, **Open Medical Folder / DICOM Series**를 실행할 수 있습니다.
- 뷰어의 **Open** 버튼에서는 파일 또는 폴더를 선택할 수 있습니다.
- Axial / Coronal / Sagittal, 슬라이스, WL/WW, 컬러맵, 멀티뷰, 비교 모드와 메타데이터 탐색을 사용할 수 있습니다. 작은 탭에서는 좌측 패널을 접어 영상 공간을 확보하세요.

JPEG/JPEG-LS/JPEG2000 압축 DICOM과 Fortran-order NPY는 현재 지원하지 않습니다. 원본 파일을 수정하지 않으며 영상은 확장 호스트와 로컬 웹뷰 사이에서만 전달합니다. SSH / 컨테이너 작업 공간에서는 확장 호스트가 접근하는 파일 시스템의 파일을 선택합니다. 브라우저 전용 VS Code용 확장은 아닙니다.

## 소스에서 빌드

저장소 루트에서 실행합니다. Node.js 22 이상을 권장합니다.

```sh
npm ci
npm ci --prefix vscode-extension
npm run build:vscode
npm run test:vscode
npm --prefix vscode-extension run test:integration
npm run package:vscode
```

설치 패키지는 `release/dcmviewer-2.0.5.vsix`에 생성됩니다. 패키지는 컴파일된 확장 호스트, 웹뷰 번들, 아이콘만 포함하며 Electron과 의료 파일은 포함하지 않습니다.

저장소를 VS Code로 열고 **DCMViewer VS Code Extension** 디버그 구성을 선택한 뒤 F5를 누르면 Extension Development Host가 실행됩니다. Marketplace 게시에는 실제 publisher 계정이 별도로 필요합니다. 현재 publisher 식별자는 저장소 소유자 이름을 사용하며 이 패키지는 Marketplace에 게시하지 않습니다.

## 영상 플립과 라벨 오버레이

각 뷰포트 상단의 **Flip left / right**, **Flip up / down** 버튼으로 화면을 좌우·상하 반전합니다. 영상과 라벨이 함께 반전되며 마우스 복셀 좌표는 원본 볼륨 좌표를 표시합니다. 연결된 뷰포트와 비교 모드에서는 플립 방향이 동기화됩니다.

1. 영상을 열고 라벨을 올릴 뷰포트를 선택합니다.
2. 좌측 **Label Overlay → Load label**에서 NIfTI (`.nii`, `.nii.gz`), NPY 또는 비압축 DICOM 마스크를 선택합니다. DICOM 라벨 시리즈는 폴더로 선택합니다.
3. 여러 마스크 또는 다채널 NPY를 불러왔으면 **Mask**에서 표시할 마스크를 선택합니다.
4. **Show overlay**, **Opacity**로 표시 여부와 투명도를 조절하고, **Remove label**로 제거합니다.

라벨 값은 비음수 정수여야 하며 **0은 투명한 배경**, 양의 정수는 클래스별 색상으로 표시됩니다. 영상과 라벨의 크기는 정확히 같아야 하며 축 순서·복셀 간격·공간 방향도 동일한 격자로 미리 맞춰야 합니다. 자동 정합이나 리샘플링은 수행하지 않습니다. 2D NPY는 깊이 1인 영상에, 4D NPY는 `(channel, depth, height, width)` 순서로 채널별 마스크를 불러옵니다. 각 라벨은 불러올 때 선택한 영상에 연결되며 다른 영상으로 전환하면 표시하지 않습니다.

렌더링 검증: 저장소 루트에서 `npm run test:rendering`.

## 탐색과 작업 흐름 개선 (v2.0.4)

- **확대·이동**: `+` / `−`, 확대 버튼 또는 Ctrl/⌘ + 휠로 25–800% 확대합니다. 좌클릭 드래그로 이동하고 **Fit image** / `0`으로 화면에 맞춥니다. 라벨과 복셀 좌표도 함께 이동합니다.
- **빠른 슬라이스 탐색**: 영상에 포커스를 둔 상태에서 방향키, Shift + 방향키(10장), Home/End로 탐색합니다. 하단 번호는 1부터 입력하며 Enter로 적용, Escape로 취소합니다.
- **단축키**: `H` / `V` 플립, `L` 라벨 표시 전환, `R` 뷰 초기화. **Controls**에서 조작법을 확인합니다. 텍스트 입력 중에는 영상 단축키가 적용되지 않습니다.
- **라벨 확인**: Fill/Outline 전환, 클래스별 표시/숨김과 전체 표시/숨김을 지원합니다. 클래스 필터는 뷰포트별로 유지됩니다.
- **파일 찾기**: 환자·Study·파일 이름·형식으로 검색합니다. 같은 볼륨 ID의 반복 로드는 중복 표시하지 않습니다.
- **비교**: 두 개 이상의 영상을 불러온 후 Compare를 선택하면 서로 다른 두 케이스를 기본 선택합니다. 깊이가 다른 영상은 상대 위치로 슬라이스를 연결하며, 라벨·확대 조작은 다른 뷰의 슬라이스를 움직이지 않습니다. 차이 영상은 비교 모드에서만 계산합니다.
- **작은 화면**: 폭이 900px 이하인 편집기에서는 뷰포트를 세로로 배치하고 스크롤합니다. 일반 멀티뷰도 최소 영상 공간을 확보하도록 스크롤할 수 있습니다.
- **오류 확인**: 일부 파일을 읽지 못해도 나머지를 불러옵니다. **Details**에서 모든 오류를 확인하고 ×로 안내를 닫을 수 있습니다.

개발 검증은 `npm run test:rendering`, `npm run test:vscode`, `npm run test:ui`로 실행합니다. UI 테스트는 Chrome이 필요하며 가상 영상과 라벨만 사용합니다. 다른 설치된 Chromium 계열 브라우저는 `DCMVIEWER_BROWSER_CHANNEL`로 지정할 수 있습니다. UI 테스트의 미리보기 실행과 브라우저 자동화 API는 [Playwright 공식 문서](https://playwright.dev/docs/api/class-browsertype)를 따릅니다.

## 원격 최초 로딩 최적화 (v2.0.5)

원격 호스트의 파일을 읽은 후 **ArrayBuffer 바이너리**로 전달합니다. Base64의 약 33% 크기 팽창을 제거하여, 압축하지 않아도 이전 Base64 payload보다 약 25% 작습니다. 파일 크기와 네트워크 프로토콜 오버헤드는 별도입니다.

- **선택적 무손실 압축**: 원격 실행 시 4 KiB 이상의 파일은 앞 64 KiB를 샘플링합니다. 압축 이득이 있으면 gzip level 1로 압축하고, 전체 압축 결과가 원본보다 5% 이상 작을 때만 전송합니다. `.nii.gz`는 다시 압축하지 않습니다. 영상·라벨의 원본 바이트는 그대로 복원되며 다운샘플링하지 않습니다.
- **묶음 요청**: 최대 8개, 원본 크기 합계 8 MiB 이하의 파일을 한 번에 요청합니다. 큰 단일 볼륨은 별도로 요청합니다. 서버는 파일 두 개씩 읽고 압축해 동시 작업 수를 제한하며, 파일별 오류를 개별 반환합니다.
- **탭 내 메모리 캐시**: 복원된 파일을 최대 64 MiB까지 LRU 방식으로 보관합니다. 같은 탭에서 파일을 다시 선택할 때 서버에서 조회한 수정 시각·크기가 같으면 재전송하지 않습니다. 파일 변경, 캐시 퇴출, 탭 닫기 후에는 다시 전송합니다. 파일 시스템이 변경 시각을 정확히 갱신하지 않는 환경에서는 탭을 닫고 다시 열어 새로 불러오세요. 디스크에 캐시를 저장하지 않습니다.
- **설정**: 서버 CPU 사용을 줄이고 싶으면 VS Code 설정의 `dcmviewer.compressRemoteFiles`를 끕니다. 로컬 실행에서는 gzip 전송 압축을 생략합니다.

원격 창에서 v2.0.5 VSIX를 설치하고 창을 다시 로드해 확장 호스트와 웹뷰의 버전을 함께 갱신하세요. 별도 서버 프로세스나 포트 설정은 필요하지 않습니다. 큰 단일 파일은 여전히 전체 파일을 전송·복원한 뒤 파싱하므로 전송 시간은 실제 파일 압축률과 회선 속도에 따라 달라집니다. 슬라이스 단위 스트리밍은 구현하지 않습니다.

전송 벤치마크는 `npm --prefix vscode-extension run benchmark:transfer`로 실행합니다. 가상 16비트 데이터에서 기존 Base64 21.33 MiB 대비 gzip 바이너리 약 10.31 MiB(약 52% 감소), 이미 gzip 압축된 데이터는 약 25% 감소를 확인했습니다. 작은 파일 300개는 각 묶음이 8 MiB 이하일 때 요청 수가 300회에서 38회로 줄어듭니다. 실제 의료영상이나 SSH 회선에서 측정한 속도는 아닙니다.

압축은 [Node.js zlib](https://nodejs.org/api/zlib.html), 웹뷰 복원은 [DecompressionStream](https://developer.mozilla.org/en-US/docs/Web/API/DecompressionStream)을 사용합니다.
