# Claude Code Launcher 설치 가이드

## 전달 파일 목록

```
claude-code-launcher/
├── extension.js          # 확장 메인 코드
├── package.json          # 확장 설정 + 의존성
├── package-lock.json     # 의존성 버전 고정
├── install.sh            # 자동 설치 스크립트
├── icons/                # 탭 상태 아이콘
│   ├── claude-idle.svg
│   ├── claude-running.svg
│   ├── claude-done.svg
│   ├── claude-error.svg
│   └── claude-robot.svg
└── 260322 INSTALL.md     # 이 문서
```

> `node_modules/` 폴더는 전달하지 않습니다. 설치 스크립트가 자동으로 받습니다.

---

## 사전 요구 사항

| 항목 | 필요 버전 | 확인 방법 |
|------|----------|----------|
| Node.js | 18 이상 | `node -v` |
| VS Code 또는 Antigravity | 1.80 이상 | IDE 버전 확인 |
| Claude Code CLI | 최신 | `claude --version` |

### Claude Code CLI 미설치 시

```bash
npm install -g @anthropic-ai/claude-code
```

---

## 설치 방법

### 1단계: 폴더 준비

`claude-code-launcher` 폴더를 원하는 위치에 복사합니다.
(USB, 공유 폴더, 메일 등 어떤 방법이든 상관없음)

### 2단계: 설치 스크립트 실행

**Git Bash**를 열고 복사한 폴더로 이동합니다.

```bash
cd claude-code-launcher
bash install.sh
```

VS Code에 설치됩니다. Antigravity IDE를 사용하는 경우:

```bash
bash install.sh antigravity
```

설치 스크립트가 자동으로 처리하는 것:
1. Node.js 버전 확인
2. `npm install` (node-pty 네이티브 빌드 포함)
3. 확장 파일을 IDE 확장 폴더에 복사
4. 설치 검증

### 3단계: IDE 재시작

1. VS Code에서 `Ctrl + Shift + P` 입력
2. `Reload Window` 선택
3. 하단 상태바에 `Claude Code` 표시 확인

---

## 사용법

| 단축키 | 기능 |
|--------|------|
| `Ctrl+Shift+Enter` | 새 Claude Code 탭 열기 |
| `Ctrl+F` | 터미널 내 검색 |
| `Ctrl+=` / `Ctrl+-` | 글자 크기 조절 (1px 단위, 8~22px) |
| `Ctrl+0` | 글자 크기 리셋 (11px) |
| `Ctrl+?` | 전체 단축키 보기 |
| `Ctrl+Shift+Enter` | 입력 패널 토글 |
| `/` | 슬래시 명령어 메뉴 (입력 패널 내) |
| 우클릭 | 컨텍스트 메뉴 (복사/붙여넣기/검색/줌 등) |

---

## 트러블슈팅

### "node-pty 빌드 실패"

Windows에서 C++ 빌드 도구가 필요합니다:

```bash
npm install -g windows-build-tools
```

또는 Visual Studio Build Tools를 설치합니다.

Mac에서는 Xcode Command Line Tools가 필요합니다:

```bash
xcode-select --install
```

설치 후 다시 실행:

```bash
rm -rf node_modules
bash install.sh
```

### "Claude CLI를 찾지 못하는 경우"

```bash
# CLI 위치 확인
which claude
# 또는
claude --version
```

`~/.local/bin/claude` 또는 `~/.local/bin/claude.exe`가 있어야 합니다.
없으면 `npm install -g @anthropic-ai/claude-code`로 설치합니다.

### "확장이 로드되지 않는 경우"

1. `Ctrl + Shift + I` 로 개발자 도구 열기
2. Console 탭에서 에러 메시지 확인
3. node-pty 바이너리 확인:

```bash
# VS Code
ls ~/.vscode/extensions/rockuen.claude-code-launcher-2.0.0/node_modules/node-pty/build/Release/
# pty.node 파일이 있어야 함
```

---

## 업데이트

새 버전 파일을 받은 후:

```bash
cd claude-code-launcher
bash install.sh
```

IDE에서 `Ctrl + Shift + P` → `Reload Window` 실행.
