"""Convert animated WebP files in a folder to adjacent MP4 files.

Usage: uv run python webp_to_mp4.py "C:\\path\\to\\folder"
Requires a recent FFmpeg build with the webp_anim demuxer/decoder and libx264.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path


def run(command):
    result = subprocess.run(command, capture_output=True, text=True, errors="replace")
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    return result.stdout


def is_animated(path):
    data = json.loads(run([
        "ffprobe", "-v", "error", "-count_packets", "-select_streams", "v:0",
        "-show_entries", "stream=codec_name,nb_read_packets", "-of", "json", str(path),
    ]))
    streams = data.get("streams", [])
    return bool(streams and streams[0].get("codec_name") == "webp_anim"
                and int(streams[0].get("nb_read_packets", 0)) > 1)


def convert(source, destination):
    temporary = destination.with_name(f".{destination.stem}.{uuid.uuid4().hex}.mp4")
    try:
        run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "webp_anim", "-min_delay", "0", "-ignore_loop", "1",
            "-i", str(source), "-map", "0:v:0", "-an",
            "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2:color=black,format=yuv420p",
            "-fps_mode", "vfr", "-enc_time_base", "1:1000",
            "-c:v", "libx264", "-bf", "0", "-crf", "18", "-preset", "medium",
            "-movflags", "+faststart", str(temporary),
        ])
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path, help="Folder containing animated WebP files")
    parser.add_argument("--recursive", action="store_true", help="Include subfolders")
    parser.add_argument("--overwrite", action="store_true", help="Replace existing MP4 files")
    args = parser.parse_args()

    if not args.folder.is_dir():
        parser.error(f"Folder does not exist: {args.folder}")
    for executable in ("ffmpeg", "ffprobe"):
        if shutil.which(executable) is None:
            parser.error(f"{executable} was not found on PATH")

    files = args.folder.rglob("*") if args.recursive else args.folder.iterdir()
    sources = sorted((p for p in files if p.is_file() and p.suffix.lower() == ".webp"),
                     key=lambda p: str(p).lower())
    converted = skipped = failed = 0
    for source in sources:
        destination = source.with_suffix(".mp4")
        try:
            if destination.exists() and not args.overwrite:
                print(f"Skip (MP4 exists): {source}")
                skipped += 1
            elif not is_animated(source):
                print(f"Skip (static WebP): {source}")
                skipped += 1
            else:
                convert(source, destination)
                print(f"Converted: {source} -> {destination}")
                converted += 1
        except (OSError, ValueError, RuntimeError) as error:
            print(f"Failed: {source}: {error}", file=sys.stderr)
            failed += 1

    print(f"Done: {converted} converted, {skipped} skipped, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
