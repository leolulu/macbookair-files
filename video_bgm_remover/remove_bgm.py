#!/usr/bin/env python3
"""Remove background music from a video while keeping speech."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


PROJECT_DIR = Path(__file__).resolve().parent
MODEL_DIR = PROJECT_DIR / "models"
RUNTIME_DIR = PROJECT_DIR / ".runtime"
DEFAULT_MODEL = "Kim_Vocal_2.onnx"
AUDIO_SUFFIXES = {".aac", ".flac", ".m4a", ".mp3", ".ogg", ".wav"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="保留视频中的人声并移除背景音乐。",
    )
    parser.add_argument("input", type=Path, help="输入视频路径")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        help="输出视频路径；默认在原文件名后添加“_去背景音乐”",
    )
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"audio-separator 模型文件名（默认：{DEFAULT_MODEL}）",
    )
    parser.add_argument(
        "--bitrate",
        default="192k",
        help="输出人声音轨的 AAC 码率（默认：192k）",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="允许覆盖已经存在的输出文件",
    )
    parser.add_argument(
        "--keep-temp",
        action="store_true",
        help="把分离后的人声音轨保存到输出视频旁边",
    )
    return parser.parse_args()


def find_ffmpeg() -> str:
    bundled_names = ("ffmpeg.exe", "ffmpeg")
    for name in bundled_names:
        bundled = PROJECT_DIR / "bin" / name
        if bundled.is_file():
            return str(bundled)

    command = shutil.which("ffmpeg")
    if command is None:
        raise RuntimeError(
            "找不到 ffmpeg。请将 ffmpeg.exe 放入项目的 bin 目录，"
            "或把 ffmpeg 加入 PATH。"
        )
    return command


def default_output_path(input_path: Path) -> Path:
    return input_path.with_name(f"{input_path.stem}_去背景音乐{input_path.suffix}")


def run(command: list[str], stage: str) -> None:
    print(f"\n[{stage}]")
    subprocess.run(command, check=True)


def extract_audio(ffmpeg: str, input_path: Path, temp_dir: Path) -> Path:
    audio_path = temp_dir / "source_audio.wav"
    command = [
        ffmpeg,
        "-y",
        "-i",
        str(input_path),
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "2",
        "-ar",
        "44100",
        "-c:a",
        "pcm_s16le",
        str(audio_path),
    ]
    run(command, "1/3 提取临时音轨")
    return audio_path


def separate_vocals(
    audio_path: Path,
    temp_dir: Path,
    model_name: str,
    bitrate: str,
) -> list[str]:
    try:
        from audio_separator.separator import Separator
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            f"导入 audio-separator 失败，缺少模块：{exc.name}。"
            "请在项目目录重新运行：uv sync"
        ) from exc
    except ImportError as exc:
        raise RuntimeError(
            f"导入 audio-separator 失败：{exc}"
        ) from exc

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    os.environ["AUDIO_SEPARATOR_MODEL_DIR"] = str(MODEL_DIR)

    separator = Separator(
        model_file_dir=str(MODEL_DIR),
        output_dir=str(temp_dir),
        output_format="M4A",
        output_bitrate=bitrate,
        output_single_stem="Vocals",
    )
    separator.load_model(model_filename=model_name)
    return separator.separate(
        str(audio_path),
        custom_output_names={"Vocals": "voice_only"},
    )


def locate_vocal_file(temp_dir: Path, output_files: list[str]) -> Path:
    expected = temp_dir / "voice_only.m4a"
    if expected.is_file():
        return expected

    for output_file in output_files:
        candidate = Path(output_file)
        if not candidate.is_absolute():
            candidate = temp_dir / candidate
        if (
            candidate.is_file()
            and candidate.stem == "voice_only"
            and candidate.suffix.lower() in AUDIO_SUFFIXES
        ):
            return candidate

    names = ", ".join(path.name for path in temp_dir.iterdir() if path.is_file()) or "无"
    raise RuntimeError(
        "AI 分离没有生成预期的人声音轨 voice_only.m4a。"
        f"临时目录中的文件：{names}"
    )


def main() -> int:
    args = parse_args()

    input_path = args.input.expanduser().resolve()
    if not input_path.is_file():
        print(f"错误：输入视频不存在：{input_path}", file=sys.stderr)
        return 2

    output_arg = args.output.expanduser() if args.output else default_output_path(input_path)
    output_path = output_arg.resolve()

    if output_path == input_path:
        print("错误：输出路径不能与输入视频相同。", file=sys.stderr)
        return 2
    if output_path.exists() and not args.force:
        print(
            f"错误：输出文件已经存在：{output_path}\n"
            "如需覆盖，请添加 --force。",
            file=sys.stderr,
        )
        return 2

    kept_path = output_path.with_name(f"{output_path.stem}_人声.m4a")
    if args.keep_temp and kept_path.exists() and not args.force:
        print(
            f"错误：需要保留的人声音轨已经存在：{kept_path}\n"
            "请改名、删除旧文件或添加 --force。",
            file=sys.stderr,
        )
        return 2

    output_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        ffmpeg = find_ffmpeg()
    except RuntimeError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    temp_context = tempfile.TemporaryDirectory(prefix="remove-bgm-", dir=RUNTIME_DIR)
    temp_dir = Path(temp_context.name)

    try:
        audio_path = extract_audio(ffmpeg, input_path, temp_dir)

        print("\n[2/3 AI 分离人声]")
        output_files = separate_vocals(
            audio_path=audio_path,
            temp_dir=temp_dir,
            model_name=args.model,
            bitrate=args.bitrate,
        )
        vocal_path = locate_vocal_file(temp_dir, output_files)

        ffmpeg_command = [
            ffmpeg,
            "-y" if args.force else "-n",
            "-i",
            str(input_path),
            "-i",
            str(vocal_path),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-map",
            "0:s?",
            "-map_metadata",
            "0",
            "-map_chapters",
            "0",
            "-c:v",
            "copy",
            "-c:a",
            "copy",
            "-c:s",
            "copy",
            str(output_path),
        ]
        run(ffmpeg_command, "3/3 写回视频")

        if args.keep_temp:
            shutil.copy2(vocal_path, kept_path)
            print(f"人声音轨：{kept_path}")

    except subprocess.CalledProcessError as exc:
        print(f"\n处理失败，命令退出码：{exc.returncode}", file=sys.stderr)
        return exc.returncode or 1
    except (OSError, RuntimeError) as exc:
        print(f"\n处理失败：{exc}", file=sys.stderr)
        return 1
    finally:
        temp_context.cleanup()
        try:
            RUNTIME_DIR.rmdir()
        except OSError:
            pass

    print(f"\n完成：{output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
