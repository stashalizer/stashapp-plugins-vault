# stash-nvenc-patches 移植到 Windows 本机 stash-win.exe 指南

> 适用对象：stash `develop` 分支 + [rufftruffles/stash-nvenc-patches](https://github.com/rufftruffles/stash-nvenc-patches) 当前状态（main 分支，11 个 Go 源码补丁）。补丁仓库无版本标签，每次使用请拉取最新提交。

## 1. 概述

**可行，但需要重新编译打了补丁的 stash-win.exe + 换用 NVENC 版 ffmpeg。**

`rufftruffles/stash-nvenc-patches` 不是 Stash 的设置项，也不是现成的 Windows 二进制。它是一个 Go 源码补丁集，修改 Stash 内部构造 ffmpeg 命令行的方式，使所有生成任务（预览视频、精灵图、截图、phash、标记预览）使用 NVIDIA NVENC 硬件编码（`h264_nvenc`）和 CUDA 硬件解码（`-hwaccel cuda`），而非 CPU 的 `libx264`。

原仓库仅提供 Docker 构建方案（Linux 容器内编译 + 运行）。本指南说明如何将同样的补丁应用到 Windows 本机 `stash-win.exe`，使你的 `X:\!stash` 安装获得 GPU 加速。

## 2. 原理：补丁做了什么

Stash 的生成任务（Generate Previews、Generate Sprites、Generate Screenshots、Generate Phash、Generate Markers）在 Go 代码中**硬编码**了 ffmpeg 参数。即使你把 ffmpeg 换成支持 NVENC 的版本，Stash 仍然会传 `-c:v libx264`，不会自动使用 `h264_nvenc`。

这 11 个补丁文件覆盖了 Stash 源码中构造 ffmpeg 命令行的关键路径：

| 改动点 | 作用 |
|--------|------|
| 导出 `HWDeviceInit`、`HWFilterInit`、`HWMaxResFilter`、`HWCanFullHWTranscode` 等函数 | 让其他包能调用硬件设备初始化逻辑 |
| 新增 `HWCodecMP4Compatible()`、`HWCodecHLSCompatible()`、`HWCodecWEBMCompatible()` | 检测 NVENC 是否支持目标容器格式 |
| 预览视频编码：`getPreviewVideoCodec()` 返回 `h264_nvenc -rc vbr -cq 21` | 替代 `libx264` |
| 标记预览编码：`getMarkerVideoCodec()` 返回 `h264_nvenc -rc vbr -cq 21 -movflags +faststart` | 替代 `libx264` |
| 精灵图、截图、phash：在 `ExtraInputArgs` 前插入 `-hwaccel cuda` | 用 GPU 解码输入视频 |
| 截图选项结构体增加 `ExtraInputArgs []string` 字段 | 允许生成任务传入额外输入参数 |
| `FFMpegConfig` 接口增加 `GetTranscodeHardwareAcceleration() bool` | 让生成代码读取用户设置的硬件加速开关 |
| 直播流转码（HLS/DASH）：使用 HW 编解码 + `fullhw` 标志 | 流媒体转码也走硬件（非生成任务，但一并补丁） |
| `phash.go` 的 `GenerateWithConfig()` 接受配置参数 | 将硬件加速设置传递到 phash 生成流程 |

**关键结论**：仅替换 ffmpeg 二进制是不够的。必须重新编译 Stash 本体。

## 3. 前提条件

- **NVIDIA GPU**：GTX 600 系列 / Quadro K 系列或更新，支持 NVENC
- **NVIDIA 驱动**：已安装，`nvidia-smi` 可正常输出
- **Go 工具链**：建议 Go 1.24+（stash `develop` 分支的 `go.mod` 声明 `go 1.24.3`，更低版本会构建失败）
- **C 编译器**（CGO 必需，因为 `mattn/go-sqlite3` 需要 CGO）：
  - 方案 A（Windows 本机编译）：MinGW-w64（提供 `gcc`）
  - 方案 B（交叉编译）：Linux 上的 `x86_64-w64-mingw32-gcc`
- **Git**
- **Node.js + pnpm**（构建 Stash 前端 UI 需要）

## 4. 方案 A：Windows 本机编译（推荐）

### 4.1 安装工具链

1. 安装 Go（https://go.dev/dl/），确保 `go version` 可用。
2. 安装 MinGW-w64（https://www.mingw-w64.org/ 或通过 MSYS2 / Chocolatey / Scoop），确保 `gcc --version` 可用。
3. 安装 Node.js（https://nodejs.org/）和 pnpm：
   ```powershell
   npm install -g pnpm
   ```

### 4.2 克隆 Stash 源码并切换到 develop 分支

```powershell
git clone https://github.com/stashapp/stash.git
cd stash
git checkout develop
```

### 4.3 下载并覆盖 11 个补丁文件

从 https://github.com/rufftruffles/stash-nvenc-patches/tree/main/patches 下载每个文件，按以下映射覆盖到 stash 仓库对应路径：

| 补丁文件名 | 目标路径（相对于 stash 仓库根目录） |
|------------|--------------------------------------|
| `codec_hardware.go` | `pkg/ffmpeg/codec_hardware.go` |
| `stream_transcode.go` | `pkg/ffmpeg/stream_transcode.go` |
| `stream_segmented.go` | `pkg/ffmpeg/stream_segmented.go` |
| `screenshot.go` | `pkg/ffmpeg/transcoder/screenshot.go` |
| `generator.go` | `pkg/scene/generate/generator.go` |
| `preview.go` | `pkg/scene/generate/preview.go` |
| `sprite.go` | `pkg/scene/generate/sprite.go` |
| `marker_preview.go` | `pkg/scene/generate/marker_preview.go` |
| `screenshot_generate.go` | `pkg/scene/generate/screenshot.go`（注意：文件名不同，覆盖 `screenshot.go`） |
| `phash.go` | `pkg/hash/videophash/phash.go` |
| `task_generate_phash.go` | `internal/manager/task_generate_phash.go` |

可以用 PowerShell 脚本批量下载（假设补丁文件已下载到 `patches/` 目录）：

```powershell
# 假设 patches/ 目录下有所有 11 个文件
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

### 4.4 验证补丁已正确覆盖

```powershell
Select-String "HWCodecMP4Compatible" pkg/ffmpeg/codec_hardware.go
Select-String "ExtraInputArgs" pkg/ffmpeg/transcoder/screenshot.go
Select-String "GetTranscodeHardwareAcceleration" pkg/scene/generate/generator.go
Select-String "getPreviewVideoCodec" pkg/scene/generate/preview.go
Select-String "getMarkerVideoCodec" pkg/scene/generate/marker_preview.go
Select-String "GenerateWithConfig" pkg/hash/videophash/phash.go
```

每个命令应返回匹配行，否则说明补丁未正确放置。

### 4.5 生成 GraphQL 代码（前端）

前端 UI 引用了自动生成的 GraphQL 类型，必须先跑 codegen，否则 `npm run build` 会报 `Could not resolve "./core/generated-graphql"`：

```powershell
cd ui/v2.5
pnpm install --frozen-lockfile
pnpm run gqlgen
npm run build
cd ../..
```

如果 `pnpm install --frozen-lockfile` 失败（lockfile 不匹配），可以去掉 `--frozen-lockfile`：

```powershell
cd ui/v2.5
pnpm install
pnpm run gqlgen
npm run build
cd ../..
```

### 4.6 生成 GraphQL 代码（后端）

Stash 的 Go 后端同样依赖 gqlgen 生成的类型（`internal/api/generated_exec.go`、`generated_models.go`），不生成直接编译会报 `undefined: BulkUpdateIds`、`undefined: GalleryResolver` 等：

```powershell
go generate ./cmd/stash
```

### 4.7 编译 patched stash-win.exe

```powershell
$env:CGO_ENABLED=1
go build -v -tags "sqlite_stat4 sqlite_math_functions" -o stash-win.exe ./cmd/stash
```

可选：注入版本号信息（与官方发布格式一致）：

```powershell
$version = "v0.28.0"  # 用 git describe --tags 获取当前版本号
$stamp = (Get-Date -Format "yyyy-MM-dd")
$hash = (git rev-parse --short HEAD)
$ldflags = "-X 'github.com/stashapp/stash/internal/build.version=$version' -X 'github.com/stashapp/stash/internal/build.buildstamp=$stamp' -X 'github.com/stashapp/stash/internal/build.githash=$hash'"
$env:CGO_ENABLED=1
go build -v -tags "sqlite_stat4 sqlite_math_functions" -ldflags $ldflags -o stash-win.exe ./cmd/stash
```

编译完成后，当前目录下会生成 `stash-win.exe`。

## 5. 方案 B：从 Linux 交叉编译（无 MinGW 时）

如果你在 Windows 上不方便安装 MinGW，可以从一台 Linux 机器交叉编译 Windows 二进制。

### 5.1 安装交叉编译器

```bash
# Debian / Ubuntu
sudo apt install gcc-mingw-w64-x86-64

# 验证
x86_64-w64-mingw32-gcc --version
```

### 5.2 克隆并打补丁（同方案 A）

```bash
git clone https://github.com/stashapp/stash.git
cd stash
git checkout develop
# 下载 11 个补丁文件到 patches/ 目录，然后：
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

### 5.3 生成 GraphQL 代码并构建前端 UI

```bash
cd ui/v2.5
pnpm install --frozen-lockfile
pnpm run gqlgen
npm run build
cd ../..
```

### 5.4 生成 GraphQL 代码（后端）

```bash
go generate ./cmd/stash
```

### 5.5 交叉编译

```bash
export GOOS=windows
export GOARCH=amd64
export CGO_ENABLED=1
export CC=x86_64-w64-mingw32-gcc

go build -v -tags "sqlite_stat4 sqlite_math_functions" -o stash-win.exe ./cmd/stash
```

### 5.6 将生成的 stash-win.exe 拷贝到 Windows

```bash
# 在 Linux 上
scp stash-win.exe user@windows-machine:X:\!stash\
```

## 6. 获取 NVENC 版 ffmpeg

Stash 自带的 ffmpeg 通常未启用 NVENC。你需要一个包含 `--enable-nvenc` 和 `--enable-cuda-nvcc` 的 Windows ffmpeg 构建。`--enable-cuda-nvcc` 是启用 CUDA 滤镜（如 `scale_cuda`、`hwupload_cuda`）的正确编译标志，不要与已弃用的 `--enable-cuda-sdk` 或仅用于解码的 `--enable-cuvid` 混淆。

### 6.1 推荐下载源

| 来源 | 说明 | 链接 |
|------|------|------|
| gyan.dev "full" 构建 | 包含 NVENC，推荐 | https://www.gyan.dev/ffmpeg/builds/ → `ffmpeg-release-full.7z` |
| BtbN `ffmpeg-master-latest-win64-gpl-shared` | 含 NVENC + CUDA | https://github.com/BtbN/FFmpeg-Builds/releases → `ffmpeg-master-latest-win64-gpl-shared.zip` |

> **注意：仅需安装 NVIDIA 显示驱动，无需单独安装 CUDA Toolkit。** 上述推荐的静态构建（gyan.dev full、BtbN）已内置 CUDA 运行时 DLL。若使用动态链接的 shared 构建，可能需要额外安装 CUDA 运行时 redistributable。

### 6.2 验证 ffmpeg 支持

```powershell
# 检查 CUDA 硬件加速支持
ffmpeg -hwaccels
# 输出应包含 cuda

# 检查 NVENC 编码器
ffmpeg -encoders | findstr nvenc
# 输出应包含 h264_nvenc
```

### 6.3 放置位置

解压后，将 `ffmpeg.exe` 和 `ffprobe.exe` 放到例如：

```
X:\!stash\ffmpeg-nvenc\ffmpeg.exe
X:\!stash\ffmpeg-nvenc\ffprobe.exe
```

## 7. 替换并配置 Stash

### 7.1 备份原文件与数据库

> **警告**：本指南编译的是 stash `develop` 分支二进制，运行它可能触发数据库 schema 自动迁移，迁移后的数据库可能无法被原 release 版本二进制读取。回滚时仅恢复二进制可能不够，需同时恢复数据库。

```powershell
# 备份二进制
copy X:\!stash\stash-win.exe X:\!stash\stash-win.exe.bak

# 备份数据库（文件名以实际为准，通常为 stash-go.sqlite）
copy X:\!stash\stash-go.sqlite X:\!stash\stash-go.sqlite.bak
```

### 7.2 替换二进制

将编译好的 `stash-win.exe` 复制到 `X:\!stash\`，覆盖原文件。

### 7.3 启动 Stash 并配置

1. 启动 `stash-win.exe`（或重启 Stash 服务）。
2. 进入 **Settings → System → Transcoding**。
3. 配置以下项：

| 设置项 | 值 |
|--------|-----|
| FFmpeg hardware encoding | 开启（勾选） |
| FFmpeg path | `X:\!stash\ffmpeg-nvenc\ffmpeg.exe` |
| FFprobe path | `X:\!stash\ffmpeg-nvenc\ffprobe.exe` |
| FFmpeg Transcode Input Args | **留空**（补丁会自动在用户参数**之前**插入硬件初始化参数；如有特殊需求可在此添加，会被追加在硬件参数之后） |
| FFmpeg Transcode Output Args | 保持默认或留空 |

4. 点击 **Save**。

### 7.4 环境变量

Stash 在启动时会检测硬件编解码能力，检测超时由环境变量控制：

- `STASH_HW_TEST_TIMEOUT`：硬件编解码检测超时（秒），默认 10s。如果 GPU 响应慢可适当调大。

## 8. 验证

### 8.1 确认 GPU 可见

```powershell
nvidia-smi
```

确认 GPU 型号和驱动版本正常显示。

### 8.2 确认 ffmpeg 硬件能力

```powershell
X:\!stash\ffmpeg-nvenc\ffmpeg.exe -hwaccels
# 应包含 cuda

X:\!stash\ffmpeg-nvenc\ffmpeg.exe -encoders | findstr nvenc
# 应包含 h264_nvenc
```

### 8.3 触发生成任务并监控 GPU

在 Stash 中手动触发一个生成任务（例如对某个视频重新生成预览）：

```powershell
# 持续监控 GPU 编码器利用率
nvidia-smi -q -d UTILIZATION
```

> 不假设 GPU 索引为 0；多 GPU 用户可先用 `nvidia-smi --list-gpus` 确认索引。

观察 `Encoder Utilization` 是否从 0% 上升。也可以在任务管理器的 "GPU" 标签页中查看 "Video Encode" 负载。

### 8.4 检查 Stash 日志

Stash 启动日志中应包含硬件编解码检测信息：

```
HW codecs: h264_nvenc, hevc_nvenc, ...
```

生成任务日志中应出现 `-hwaccel cuda` 和 `-c:v h264_nvenc` 等参数。

如果日志中 `Supported HW codecs` 列表不包含 `h264_nvenc`，说明硬件编解码未被检测到，Stash 会静默回退到 CPU 编码（用户可能察觉不到）。排查步骤：确认 Stash 设置中 ffmpeg 路径指向 NVENC 版 ffmpeg；运行 `ffmpeg -encoders | findstr nvenc` 确认 `h264_nvenc` 存在；若 GPU 初始化较慢，尝试调大 `STASH_HW_TEST_TIMEOUT` 环境变量（如设为 30）。

## 9. 回滚

如果出现问题，恢复原状非常简单：

1. 停止 Stash。
2. 用备份文件恢复：
   ```powershell
   copy /Y X:\!stash\stash-win.exe.bak X:\!stash\stash-win.exe
   ```
3. 可选：将 FFmpeg 路径改回 Stash 自带的 bundled ffmpeg（位于 `%APPDATA%\stash\ffmpeg\` 或配置目录下）。
4. 重新启动 Stash。

## 10. 已知限制

- **仅 NVIDIA GPU**：补丁仅实现了 NVENC/CUDA 路径。Intel QSV、AMD AMF、VAAPI、VideoToolbox 均不受支持。
- **WebP 预览仍为 CPU 编码**：不存在硬件 WebP 编码器，WebP 预览生成始终使用 CPU（`libwebp`）。
- **每次 Stash 升级需重新打补丁**：补丁覆盖了 Stash 源码文件，升级时这些文件会被新版本覆盖，需要重新下载补丁并编译。
- **补丁基于 develop 分支**：`rufftruffles/stash-nvenc-patches` 针对 stash 的 `develop` 分支，非 release 稳定版。如果 `develop` 分支的代码发生重构，补丁可能无法直接应用，需要手动调整。
- **补丁签名漂移（已实测）**：本指南编写时实测发现，补丁版 `marker_preview.go` 的 `MarkerPreviewVideo` 仍是旧的 6 参数签名（`...includeAudio bool`），而当前 develop 已重构为 8 参数（新增 `maxDuration, defaultDuration int`）并用 `markerPreviewDuration()` helper 替代了旧的 `maxMarkerPreviewDuration` 常量。直接覆盖会编译失败：`too many arguments in call to g.MarkerPreviewVideo`。应对方法：不要整文件覆盖 `marker_preview.go`，而是把补丁的 NVENC 逻辑（`getMarkerVideoCodec()`、`markerPreviewVideo` 里的 `hwupload_cuda`/`HWDeviceInit` 分支、`SceneMarkerWebp`/`SceneMarkerScreenshot` 的 `-hwaccel cuda`）手动合并到 develop 当前版本的同名函数中，保留 develop 的新签名和 duration 逻辑。其他补丁文件（截至本次实测）可直接覆盖。每次拉取新 develop 提交后，建议先 `go build` 试编译，遇到签名不匹配再逐个合并。
- **develop 分支不稳定**：`stash` 的 `develop` 分支可能包含未完成功能或与 NVENC 补丁无关的 bug，生产环境使用需自行评估风险。
- **CGO 编译较慢**：由于 `mattn/go-sqlite3` 需要 CGO，首次编译会编译 C 代码，耗时较长（取决于机器性能，通常 3-10 分钟）。


## 11. 替代方案对比

| 维度 | Docker 原方案 | 本机 Windows 方案 |
|------|-------------|-------------------|
| Stash 二进制 | 容器内编译的 Linux ELF | 本机编译的 Windows PE |
| ffmpeg | 容器内 `/usr/bin/ffmpeg`（jellyfin-ffmpeg7） | 用户自行下载的 NVENC 版 ffmpeg |
| GPU 访问 | NVIDIA Container Toolkit + `runtime: nvidia` | 直接使用 Windows NVIDIA 驱动 |
| 设置项 | FFmpeg path → `/usr/bin/ffmpeg` | FFmpeg path → `X:\!stash\ffmpeg-nvenc\ffmpeg.exe` |
| HW accel 开关 | Settings → Hardware Acceleration | 同上 |
| 编译环境 | Docker（Linux 容器） | Windows 本机 MinGW 或 Linux 交叉编译 |
| 回滚 | 换回原 Docker 镜像 | 换回备份的 `stash-win.exe.bak` |
| 维护成本 | 低（拉取预构建镜像） | 中（每次升级需手动编译） |
| 性能 | 容器化运行，GPU 直通有轻微开销 | 本机运行，无虚拟化开销 |

如果你不想自己编译，也可以考虑使用原仓库的预构建 Docker 镜像 `ghcr.io/rufftruffles/stash-nvenc-patches:latest` 配合 Docker Desktop（WSL2 后端 + NVIDIA Container Toolkit for Windows），但这与本指南的 "本机 `stash-win.exe`" 前提不符，此处不展开。
