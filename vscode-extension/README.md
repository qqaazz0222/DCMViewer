# DCMViewer for Visual Studio Code

VS Code 편집기 탭에서 DICOM 시리즈, NIfTI, NumPy 볼륨을 탐색하는 읽기 전용 뷰어입니다. 기존 DCMViewer의 React 렌더러를 재사용합니다.

## 설치

VS Code의 Extensions 화면에서 `…` → **Install from VSIX…**를 선택하고 `dcmviewer-2.1.0.vsix`를 설치합니다. VS Code 1.85 이상이 필요합니다.

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

설치 패키지는 `release/dcmviewer-2.1.0.vsix`에 생성됩니다. 패키지는 컴파일된 확장 호스트, 웹뷰 번들, 아이콘만 포함하며 Electron과 의료 파일은 포함하지 않습니다.

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

## 원격 슬라이스 로딩 (v2.0.6)

SSH·컨테이너 등 원격 VS Code 창에서는 **서버가 볼륨을 해석하고, 웹뷰에는 메타데이터와 현재 단면의 Float32 픽셀만 전송**합니다. DICOM 시리즈, NIfTI (`.nii.gz` 포함), 2D/3D/채널 우선 4D NPY에 적용됩니다. 별도 서버 프로세스나 포트 설정은 필요하지 않습니다.

- **필요한 단면 우선**: Axial/Coronal/Sagittal 모두 원본 해상도로 요청합니다. 윈도우·색상·플립·줌·팬은 받은 픽셀로 로컬에서 처리하므로 같은 단면에서는 추가 전송이 없습니다. 기존 뷰어와 같은 Float32 값과 NIfTI/DICOM 스케일링을 유지합니다.
- **주변 선읽기**: 단면이 표시되고 180 ms 동안 이동이 없으면 앞뒤 한 장씩 받습니다. 전송은 최대 두 개이며 현재 화면 요청을 대기열에서 우선합니다. 이동 시 이전 대기 요청을 취소하고 오래된 응답의 화면 반영을 막습니다. 이미 진행 중인 전송은 완료될 수 있습니다.
- **라벨·차영상**: 라벨 클래스와 유효성은 서버에서 검사하고 같은 좌표의 라벨 단면을 받습니다. 차영상은 두 원본 단면으로 로컬에서 계산하며 기존 상대 깊이 매핑을 유지합니다. 원격 차영상의 색상 범위는 두 볼륨의 최솟값·최댓값으로 계산한 상한을 사용합니다.
- **메모리와 로컬 저장소**: 단면 LRU 메모리 캐시는 64 MiB, IndexedDB 캐시는 256 MiB입니다. 현재 화면이 참조하는 단면은 렌더링과 hover를 위해 별도 유지됩니다. 캐시 키에는 서버 URI, 파일 크기·수정 시각, 볼륨/채널, 방향, 단면 번호가 반영됩니다. 저장소가 차단되거나 부족하면 캐시 없이 계속 동작합니다.
- **캐시 삭제**: 툴바의 **Clear local cache**로 단면 메모리·IndexedDB 캐시를 삭제합니다. 현재 표시 중인 화면은 유지됩니다. IndexedDB 재사용은 VS Code가 같은 웹뷰 저장소를 유지하는 범위에서 가능하며, 저장소 삭제·용량 퇴출·다른 웹뷰 origin에서는 다시 받습니다.
- **오류 처리**: 단면 전송 실패 시 **Retry slice**로 재시도할 수 있습니다. 서버 준비는 5분, 그 외 요청은 2분 후 타임아웃됩니다. 일부 파일 읽기·파싱 실패는 다른 파일의 로딩을 막지 않습니다.

원격 창에 `release/dcmviewer-2.1.0.vsix`를 설치하고 창을 다시 로드하세요. 설정은 다음과 같습니다.

| 설정 | 기본값 | 동작 |
|---|---|---|
| `dcmviewer.streamRemoteVolumes` | `true` | 원격 호스트에서 단면 로딩. 끄면 기존 전체 파일 전송 사용 |
| `dcmviewer.persistSliceCache` | `true` | 받은 단면을 로컬 IndexedDB에 저장. 변경 후 뷰어 다시 열기 |
| `dcmviewer.compressRemoteFiles` | `true` | 전송 이득이 있는 파일/단면만 무손실 gzip 압축 |

**제한:** 서버는 첫 표시 전에 원본을 읽고 전체 볼륨을 해석합니다. 따라서 서버 디스크·압축 해제·CPU 시간은 여전히 필요합니다. 서버의 준비 요청당 원본 파일 합계와 뷰어당 보관하는 Float32 볼륨은 각각 512 MiB로 제한합니다(파싱 중 임시 메모리는 별도). 한도를 넘으면 오류를 표시하므로 뷰어를 닫거나 `streamRemoteVolumes`를 끄고 기존 경로로 여세요. 서버 데이터는 뷰어를 닫으면 해제됩니다. 열린 볼륨은 읽을 때의 스냅샷이며 파일 변경 반영은 다시 선택해서 불러옵니다. 파일 시스템이 크기와 수정 시각을 모두 유지한 채 내용을 바꿨다면 캐시 삭제 후 뷰어를 다시 여세요.

전체 볼륨의 저해상도 미리보기나 전체 원본의 자동 다운로드는 하지 않습니다. 현재 단면과 주변 단면만 전송해 불필요한 네트워크 사용을 줄입니다. 로컬 VS Code·Electron은 기존 전체 파일 로딩을 사용합니다. 기존 경로의 바이너리 전송, 최대 8개/8 MiB 묶음 요청, 64 MiB 탭 내 파일 캐시는 유지합니다.

`npm --prefix vscode-extension run benchmark:transfer`는 합성 데이터로 payload를 비교합니다. 256×256×128 uint16 NPY에서 기존 gzip 전체 파일 약 10.31 MiB 대신 메타데이터와 첫 axial 단면 약 111 KiB로 표시할 수 있었습니다(약 99% 감소). 주변 선읽기·통신 오버헤드를 제외한 전송량 비교이며 실제 SSH 지연이나 전체 탐색 시간의 개선율은 아닙니다. 원격 UI 검증은 `npm run test:ui:remote`로 실행합니다.
