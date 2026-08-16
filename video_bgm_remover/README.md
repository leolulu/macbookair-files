# Video BGM Remover

保留视频中的人声并移除背景音乐。视频画面直接复制，不重新编码。

脚本会在项目内的 `.runtime` 临时提取无损 PCM 音轨供 AI 模型处理，完成后自动删除；用户只需提供输入视频。

默认使用适合 CPU 的 `Kim_Vocal_2.onnx` 轻量人声分离模型。

## 初始化

在本目录打开 PowerShell：

```powershell
uv sync
```

依赖会安装到本目录的 `.venv`，下载缓存保存在本目录的 `.uv-cache`。AI 模型在首次处理视频时下载到本目录的 `models`。

## 使用

```powershell
uv run python .\remove_bgm.py "D:\视频\input.mp4"
```

默认输出到输入视频旁边：

```text
input_去背景音乐.mp4
```

指定输出文件：

```powershell
uv run python .\remove_bgm.py "input.mp4" -o "output.mp4"
```

覆盖已有输出：

```powershell
uv run python .\remove_bgm.py "input.mp4" --force
```

同时保留分离后的人声音轨：

```powershell
uv run python .\remove_bgm.py "input.mp4" --keep-temp
```

## 目录说明

```text
video_bgm_remover\
├─ .venv\          # uv 创建的项目虚拟环境
├─ .uv-cache\       # uv 的依赖下载缓存
├─ models\         # AI 模型
├─ bin\            # 可选：放置 ffmpeg.exe
├─ pyproject.toml   # Python 依赖
├─ uv.lock          # 锁定的依赖版本
└─ remove_bgm.py    # 主程序
```

脚本优先使用 `bin\ffmpeg.exe`，不存在时使用 PATH 中的 `ffmpeg`。
