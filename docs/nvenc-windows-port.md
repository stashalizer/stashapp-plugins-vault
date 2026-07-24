# Porting stash-nvenc-patches to a Native Windows stash-win.exe

> Target audience: stash `develop` branch + current state of [rufftruffles/stash-nvenc-patches](https://github.com/rufftruffles/stash-nvenc-patches) (main branch, 11 Go source patches). The patch repo has no version tags; pull the latest commit each time you use it.

## 1. Overview

**Feasible, but requires recompiling a patched stash-win.exe + switching to an NVENC-enabled ffmpeg.**

`rufftruffles/stash-nvenc-patches` is not a Stash setting, nor a ready-made Windows binary. It is a set of Go source patches that modify how Stash internally constructs ffmpeg command lines, so that all generation tasks (preview videos, sprites, screenshots, phash, marker previews) use NVIDIA NVENC hardware encoding (`h264_nvenc`) and CUDA hardware decoding (`-hwaccel cuda`) instead of the CPU-based `libx264`.

The original repo only provides a Docker build path (compile + run inside a Linux container). This guide explains how to apply the same patches to a native Windows `stash-win.exe` so that your `X:\!stash` installation gets GPU acceleration.

## 2. How it works: what the patches do

Stash's generation tasks (Generate Previews, Generate Sprites, Generate Screenshots, Generate Phash, Generate Markers) **hard-code** ffmpeg arguments in the Go code. Even if you swap ffmpeg for an NVENC-enabled build, Stash will still pass `-c:v libx264` and will not automatically use `h264_nvenc`.

The 11 patch files cover the key code paths in the Stash source that construct ffmpeg command lines:

| Change | Effect |
|--------|--------|
| Exports `HWDeviceInit`, `HWFilterInit`, `HWMaxResFilter`, `HWCanFullHWTranscode`, etc. | Lets other packages call the hardware device initialization logic |
| Adds `HWCodecMP4Compatible()`, `HWCodecHLSCompatible()`, `HWCodecWEBMCompatible()` | Detects whether NVENC supports the target container format |
| Preview video encoding: `getPreviewVideoCodec()` returns `h264_nvenc -rc vbr -cq 21` | Replaces `libx264` |
| Marker preview encoding: `getMarkerVideoCodec()` returns `h264_nvenc -rc vbr -cq 21 -movflags +faststart` | Replaces `libx264` |
| Sprites, screenshots, phash: inserts `-hwaccel cuda` before `ExtraInputArgs` | Decodes input video on the GPU |
| Adds `ExtraInputArgs []string` field to the screenshot options struct | Lets generation tasks pass extra input arguments |
| Adds `GetTranscodeHardwareAcceleration() bool` to the `FFMpegConfig` interface | Lets generation code read the user's hardware acceleration toggle |
| Live stream transcoding (HLS/DASH): uses HW codecs + `fullhw` flag | Streaming transcoding also goes through hardware (not a generation task, but patched together) |
| `phash.go`'s `GenerateWithConfig()` accepts a config parameter | Passes the hardware acceleration setting into the phash generation flow |

**Key takeaway:** simply replacing the ffmpeg binary is not enough. You must recompile Stash itself.

## 3. Prerequisites

- **NVIDIA GPU**: GTX 600 series / Quadro K series or newer, with NVENC support
- **NVIDIA driver**: installed, `nvidia-smi` works
- **Go toolchain**: Go 1.24+ recommended (stash `develop` branch's `go.mod` declares `go 1.24.3`; lower versions will fail to build)
- **C compiler** (CGO required because `mattn/go-sqlite3` needs CGO):
  - Option A (native Windows build): MinGW-w64 (provides `gcc`)
  - Option B (cross-compile): `x86_64-w64-mingw32-gcc` on Linux
- **Git**
- **Node.js + pnpm** (required to build the Stash frontend UI)

## 4. Option A: Native Windows build (recommended)

### 4.1 Install the toolchain

1. Install Go (https://go.dev/dl/); make sure `go version` works.
2. Install MinGW-w64 (https://www.mingw-w64.org/ or via MSYS2 / Chocolatey / Scoop); make sure `gcc --version` works.
3. Install Node.js (https://nodejs.org/) and pnpm:
   ```powershell
   npm install -g pnpm
   ```

### 4.2 Clone the Stash source and switch to the develop branch

```powershell
git clone https://github.com/stashapp/stash.git
cd stash
git checkout develop
```

### 4.3 Download and overwrite the 11 patch files

Download each file from https://github.com/rufftruffles/stash-nvenc-patches/tree/main/patches and overwrite the corresponding path in the stash repo according to this mapping:

| Patch filename | Target path (relative to the stash repo root) |
|----------------|-----------------------------------------------|
| `codec_hardware.go` | `pkg/ffmpeg/codec_hardware.go` |
| `stream_transcode.go` | `pkg/ffmpeg/stream_transcode.go` |
| `stream_segmented.go` | `pkg/ffmpeg/stream_segmented.go` |
| `screenshot.go` | `pkg/ffmpeg/transcoder/screenshot.go` |
| `generator.go` | `pkg/scene/generate/generator.go` |
| `preview.go` | `pkg/scene/generate/preview.go` |
| `sprite.go` | `pkg/scene/generate/sprite.go` |
| `marker_preview.go` | `pkg/scene/generate/marker_preview.go` |
| `screenshot_generate.go` | `pkg/scene/generate/screenshot.go` (note: different filename; overwrites `screenshot.go`) |
| `phash.go` | `pkg/hash/videophash/phash.go` |
| `task_generate_phash.go` | `internal/manager/task_generate_phash.go` |

You can batch the copy with a PowerShell script (assuming the patch files have been downloaded into a `patches/` directory):

```powershell
# Assuming patches/ contains all 11 files
cp patches/codec_hardware.go pkg/ffmpeg/
cp patches/stream_transcode.go pkg/ffmpeg/
cp patches/stream_segmented.go pkg/ffmpeg/
cp patches/screenshot.go pkg/ffmpeg/transcoder/
cp patches/generator.go pkg/scene/generate/
cp patches/preview.go pkg/scene/generate/
cp patches/sprite.go pkg/scene/generate/
cp patches/marker_preview.go pkg/scene/generate/
cp patches/screenshot_generate.go pkg/scene/generate/screenshot.go
cp patches/phash.go pkg/hash/videophash/
cp patches/task_generate_phash.go internal/manager/
```

### 4.4 Verify the patches were placed correctly

```powershell
Select-String "HWCodecMP4Compatible" pkg/ffmpeg/codec_hardware.go
Select-String "ExtraInputArgs" pkg/ffmpeg/transcoder/screenshot.go
Select-String "GetTranscodeHardwareAcceleration" pkg/scene/generate/generator.go
Select-String "getPreviewVideoCodec" pkg/scene/generate/preview.go
Select-String "getMarkerVideoCodec" pkg/scene/generate/marker_preview.go
Select-String "GenerateWithConfig" pkg/hash/videophash/phash.go
```

Each command should return a matching line; otherwise the patch was not placed correctly.

### 4.5 Generate GraphQL code (frontend)

The frontend UI references auto-generated GraphQL types; you must run codegen first, otherwise `npm run build` will fail with `Could not resolve "./core/generated-graphql"`:

```powershell
cd ui/v2.5
pnpm install --frozen-lockfile
pnpm run gqlgen
npm run build
cd ../..
```

If `pnpm install --frozen-lockfile` fails (lockfile mismatch), you can drop `--frozen-lockfile`:

```powershell
cd ui/v2.5
pnpm install
pnpm run gqlgen
npm run build
cd ../..
```

### 4.6 Generate GraphQL code (backend)

Stash's Go backend also depends on gqlgen-generated types (`internal/api/generated_exec.go`, `generated_models.go`); compiling without generating first will fail with `undefined: BulkUpdateIds`, `undefined: GalleryResolver`, etc.:

```powershell
go generate ./cmd/stash
```

### 4.7 Compile the patched stash-win.exe

```powershell
$env:CGO_ENABLED=1
go build -v -tags "sqlite_stat4 sqlite_math_functions" -o stash-win.exe ./cmd/stash
```

Optional: inject version info (to match the official release format):

```powershell
$version = "v0.28.0"  # get the current version with git describe --tags
$stamp = (Get-Date -Format "yyyy-MM-dd")
$hash = (git rev-parse --short HEAD)
$ldflags = "-X 'github.com/stashapp/stash/internal/build.version=$version' -X 'github.com/stashapp/stash/internal/build.buildstamp=$stamp' -X 'github.com/stashapp/stash/internal/build.githash=$hash'"
$env:CGO_ENABLED=1
go build -v -tags "sqlite_stat4 sqlite_math_functions" -ldflags $ldflags -o stash-win.exe ./cmd/stash
```

After the build completes, `stash-win.exe` will be in the current directory.

## 5. Option B: Cross-compile from Linux (when MinGW is unavailable)

If installing MinGW on Windows is inconvenient, you can cross-compile the Windows binary from a Linux machine.

### 5.1 Install the cross-compiler

```bash
# Debian / Ubuntu
sudo apt install gcc-mingw-w64-x86-64

# Verify
x86_64-w64-mingw32-gcc --version
```

### 5.2 Clone and patch (same as Option A)

```bash
git clone https://github.com/stashapp/stash.git
cd stash
git checkout develop
# Download the 11 patch files into a patches/ directory, then:
cp patches/codec_hardware.go pkg/ffmpeg/
cp patches/stream_transcode.go pkg/ffmpeg/
cp patches/stream_segmented.go pkg/ffmpeg/
cp patches/screenshot.go pkg/ffmpeg/transcoder/
cp patches/generator.go pkg/scene/generate/
cp patches/preview.go pkg/scene/generate/
cp patches/sprite.go pkg/scene/generate/
cp patches/marker_preview.go pkg/scene/generate/
cp patches/screenshot_generate.go pkg/scene/generate/screenshot.go
cp patches/phash.go pkg/hash/videophash/
cp patches/task_generate_phash.go internal/manager/
```

### 5.3 Generate GraphQL code and build the frontend UI

```bash
cd ui/v2.5
pnpm install --frozen-lockfile
pnpm run gqlgen
npm run build
cd ../..
```

### 5.4 Generate GraphQL code (backend)

```bash
go generate ./cmd/stash
```

### 5.5 Cross-compile

```bash
export GOOS=windows
export GOARCH=amd64
export CGO_ENABLED=1
export CC=x86_64-w64-mingw32-gcc

go build -v -tags "sqlite_stat4 sqlite_math_functions" -o stash-win.exe ./cmd/stash
```

### 5.6 Copy the built stash-win.exe to Windows

```bash
# On Linux
scp stash-win.exe user@windows-machine:X:\!stash\
```

## 6. Get an NVENC-enabled ffmpeg

The ffmpeg bundled with Stash usually does not have NVENC enabled. You need a Windows ffmpeg build that includes `--enable-nvenc` and `--enable-cuda-nvcc`. `--enable-cuda-nvcc` is the correct build flag for enabling CUDA filters (such as `scale_cuda`, `hwupload_cuda`); do not confuse it with the deprecated `--enable-cuda-sdk` or the decode-only `--enable-cuvid`.

### 6.1 Recommended download sources

| Source | Notes | Link |
|--------|-------|------|
| gyan.dev "full" build | Includes NVENC, recommended | https://www.gyan.dev/ffmpeg/builds/ → `ffmpeg-release-full.7z` |
| BtbN `ffmpeg-master-latest-win64-gpl-shared` | Includes NVENC + CUDA | https://github.com/BtbN/FFmpeg-Builds/releases → `ffmpeg-master-latest-win64-gpl-shared.zip` |

> **Note: you only need the NVIDIA display driver; no separate CUDA Toolkit install is required.** The recommended static builds (gyan.dev full, BtbN) already bundle the CUDA runtime DLLs. If you use a dynamically linked shared build, you may additionally need to install the CUDA runtime redistributable.

### 6.2 Verify ffmpeg support

```powershell
# Check CUDA hardware acceleration support
ffmpeg -hwaccels
# Output should include cuda

# Check the NVENC encoder
ffmpeg -encoders | findstr nvenc
# Output should include h264_nvenc
```

### 6.3 Placement

After extracting, place `ffmpeg.exe` and `ffprobe.exe` somewhere like:

```
X:\!stash\ffmpeg-nvenc\ffmpeg.exe
X:\!stash\ffmpeg-nvenc\ffprobe.exe
```

## 7. Replace and configure Stash

### 7.1 Back up the original files and database

> **Warning:** this guide compiles the stash `develop` branch binary; running it may trigger an automatic database schema migration, and the migrated database may not be readable by the original release binary. Rolling back may require restoring the database as well as the binary.

```powershell
# Back up the binary
copy X:\!stash\stash-win.exe X:\!stash\stash-win.exe.bak

# Back up the database (filename may vary; usually stash-go.sqlite)
copy X:\!stash\stash-go.sqlite X:\!stash\stash-go.sqlite.bak
```

### 7.2 Replace the binary

Copy the compiled `stash-win.exe` to `X:\!stash\`, overwriting the original file.

### 7.3 Start Stash and configure it

1. Start `stash-win.exe` (or restart the Stash service).
2. Go to **Settings → System → Transcoding**.
3. Configure the following:

| Setting | Value |
|---------|-------|
| FFmpeg hardware encoding | On (checked) |
| FFmpeg path | `X:\!stash\ffmpeg-nvenc\ffmpeg.exe` |
| FFprobe path | `X:\!stash\ffmpeg-nvenc\ffprobe.exe` |
| FFmpeg Transcode Input Args | **Leave empty** (the patch automatically inserts hardware initialization arguments **before** the user arguments; if you have special needs you can add them here and they will be appended after the hardware arguments) |
| FFmpeg Transcode Output Args | Keep default or leave empty |

4. Click **Save**.

### 7.4 Environment variables

Stash probes hardware codec capabilities at startup; the probe timeout is controlled by an environment variable:

- `STASH_HW_TEST_TIMEOUT`: hardware codec probe timeout (seconds), default 10s. If the GPU is slow to respond, increase this value.

## 8. Verification

### 8.1 Confirm the GPU is visible

```powershell
nvidia-smi
```

Confirm the GPU model and driver version are displayed correctly.

### 8.2 Confirm ffmpeg hardware capabilities

```powershell
X:\!stash\ffmpeg-nvenc\ffmpeg.exe -hwaccels
# Should include cuda

X:\!stash\ffmpeg-nvenc\ffmpeg.exe -encoders | findstr nvenc
# Should include h264_nvenc
```

### 8.3 Trigger a generation task and monitor the GPU

Manually trigger a generation task in Stash (e.g. regenerate the preview for a video):

```powershell
# Continuously monitor GPU encoder utilization
nvidia-smi -q -d UTILIZATION
```

> Do not assume the GPU index is 0; multi-GPU users can confirm the index with `nvidia-smi --list-gpus` first.

Watch whether `Encoder Utilization` rises from 0%. You can also check the "Video Encode" load in the "GPU" tab of Task Manager.

### 8.4 Check the Stash logs

The Stash startup log should contain hardware codec probe information:

```
HW codecs: h264_nvenc, hevc_nvenc, ...
```

The generation task logs should show arguments such as `-hwaccel cuda` and `-c:v h264_nvenc`.

If the `Supported HW codecs` list in the log does not include `h264_nvenc`, hardware codecs were not detected and Stash will silently fall back to CPU encoding (the user may not notice). Troubleshooting steps: confirm the Stash ffmpeg path points to the NVENC-enabled ffmpeg; run `ffmpeg -encoders | findstr nvenc` to confirm `h264_nvenc` is present; if GPU initialization is slow, try increasing the `STASH_HW_TEST_TIMEOUT` environment variable (e.g. set it to 30).

## 9. Rollback

If something goes wrong, restoring the original state is straightforward:

1. Stop Stash.
2. Restore from the backup:
   ```powershell
   copy /Y X:\!stash\stash-win.exe.bak X:\!stash\stash-win.exe
   ```
3. Optional: change the FFmpeg path back to the ffmpeg bundled with Stash (located under `%APPDATA%\stash\ffmpeg\` or in the config directory).
4. Restart Stash.

## 10. Known limitations

- **NVIDIA GPUs only**: the patches only implement the NVENC/CUDA path. Intel QSV, AMD AMF, VAAPI, and VideoToolbox are not supported.
- **WebP previews are still CPU-encoded**: there is no hardware WebP encoder, so WebP preview generation always uses the CPU (`libwebp`).
- **Every Stash upgrade requires re-patching**: the patches overwrite Stash source files; on upgrade these files are replaced by the new version, so you must re-download the patches and recompile.
- **Patches target the develop branch**: `rufftruffles/stash-nvenc-patches` targets stash's `develop` branch, not the release stable version. If the `develop` branch is refactored, the patches may not apply directly and will need manual adjustment.
- **Patch signature drift (tested)**: at the time of writing, the patched `marker_preview.go`'s `MarkerPreviewVideo` still uses the old 6-parameter signature (`...includeAudio bool`), while the current develop branch has been refactored to an 8-parameter signature (adding `maxDuration, defaultDuration int`) and replaces the old `maxMarkerPreviewDuration` constant with a `markerPreviewDuration()` helper. A direct overwrite will fail to compile with `too many arguments in call to g.MarkerPreviewVideo`. Workaround: do not overwrite `marker_preview.go` wholesale; instead manually merge the patch's NVENC logic (`getMarkerVideoCodec()`, the `hwupload_cuda`/`HWDeviceInit` branches in `markerPreviewVideo`, the `-hwaccel cuda` in `SceneMarkerWebp`/`SceneMarkerScreenshot`) into the current develop version of the same functions, preserving develop's new signature and duration logic. The other patch files (as of this test) can be overwritten directly. After pulling each new develop commit, do a trial `go build` first and merge files one by one when you hit a signature mismatch.
- **The develop branch is unstable**: stash's `develop` branch may contain unfinished features or bugs unrelated to the NVENC patches; assess the risk yourself before using it in production.
- **CGO builds are slow**: because `mattn/go-sqlite3` requires CGO, the first build compiles C code and takes a while (typically 3-10 minutes depending on the machine).


## 11. Comparison with the alternative

| Dimension | Original Docker approach | Native Windows approach |
|-----------|--------------------------|-------------------------|
| Stash binary | Linux ELF compiled in the container | Native-compiled Windows PE |
| ffmpeg | `/usr/bin/ffmpeg` inside the container (jellyfin-ffmpeg7) | User-supplied NVENC-enabled ffmpeg |
| GPU access | NVIDIA Container Toolkit + `runtime: nvidia` | Direct use of the Windows NVIDIA driver |
| Settings | FFmpeg path → `/usr/bin/ffmpeg` | FFmpeg path → `X:\!stash\ffmpeg-nvenc\ffmpeg.exe` |
| HW accel toggle | Settings → Hardware Acceleration | Same |
| Build environment | Docker (Linux container) | Native Windows MinGW or Linux cross-compile |
| Rollback | Switch back to the original Docker image | Switch back to the backed-up `stash-win.exe.bak` |
| Maintenance cost | Low (pull a pre-built image) | Medium (manual compile on each upgrade) |
| Performance | Runs containerized; GPU passthrough has slight overhead | Runs natively; no virtualization overhead |

If you don't want to compile it yourself, you can also use the original repo's pre-built Docker image `ghcr.io/rufftruffles/stash-nvenc-patches:latest` with Docker Desktop (WSL2 backend + NVIDIA Container Toolkit for Windows), but that does not match the "native `stash-win.exe`" premise of this guide and is not covered here.