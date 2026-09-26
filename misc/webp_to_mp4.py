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
from decimal import Decimal
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


def video_info(path, webp=False):
    command = ["ffprobe", "-v", "error"]
    if webp:
        command += ["-f", "webp_anim", "-min_delay", "0", "-ignore_loop", "1"]
    command += [
        "-select_streams", "v:0", "-show_packets", "-show_entries",
        "packet=pts_time,duration_time:stream=codec_name,width,height,pix_fmt:format=duration",
        "-of", "json", str(path),
    ]
    return json.loads(run(command))


def verify(source, video):
    original = video_info(source, webp=True)
    output = video_info(video)
    streams = output.get("streams", [])
    if len(streams) != 1 or streams[0].get("codec_name") != "h264":
        raise RuntimeError("MP4 verification failed: missing H.264 video")
    if (streams[0].get("width", 0) < 1 or streams[0].get("height", 0) < 1
            or streams[0].get("pix_fmt") != "yuv420p"):
        raise RuntimeError("MP4 verification failed: invalid video dimensions or pixel format")

    source_packets = original.get("packets", [])
    video_packets = output.get("packets", [])
    if len(source_packets) < 2 or len(source_packets) != len(video_packets):
        raise RuntimeError("MP4 verification failed: frame count differs from WebP")

    tolerance = Decimal("0.001")
    for index, (before, after) in enumerate(zip(source_packets, video_packets), 1):
        for field in ("pts_time", "duration_time"):
            if field not in before or field not in after:
                raise RuntimeError(f"MP4 verification failed: frame {index} lacks {field}")
            if abs(Decimal(before[field]) - Decimal(after[field])) > tolerance:
                raise RuntimeError(f"MP4 verification failed: frame {index} {field} differs")

    expected_end = (Decimal(source_packets[-1]["pts_time"])
                    + Decimal(source_packets[-1]["duration_time"]))
    actual_duration = Decimal(output.get("format", {}).get("duration", "0"))
    if abs(expected_end - actual_duration) > tolerance:
        raise RuntimeError("MP4 verification failed: total duration differs from WebP")

    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-xerror",
         "-i", str(video), "-map", "0:v:0", "-f", "null", "-"])


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
        verify(source, temporary)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path, help="Folder containing animated WebP files")
    parser.add_argument("-r", "--recursive", action="store_true", help="Include subfolders")
    parser.add_argument("-o", "--overwrite", action="store_true", help="Replace existing MP4 files")
    parser.add_argument("-d", "--delete-source", action="store_true",
                        help="Delete each WebP only after its new MP4 passes verification")
    args = parser.parse_args()

    if not args.folder.is_dir():
        parser.error(f"Folder does not exist: {args.folder}")
    for executable in ("ffmpeg", "ffprobe"):
        if shutil.which(executable) is None:
            parser.error(f"{executable} was not found on PATH")

    files = args.folder.rglob("*") if args.recursive else args.folder.iterdir()
    sources = sorted((p for p in files if p.is_file() and p.suffix.lower() == ".webp"),
                     key=lambda p: str(p).lower())
    converted = deleted = skipped = failed = 0
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
                source_stat = source.stat()
                convert(source, destination)
                print(f"Converted: {source} -> {destination}")
                converted += 1
                if args.delete_source:
                    current_stat = source.stat()
                    if (current_stat.st_size != source_stat.st_size
                            or current_stat.st_mtime_ns != source_stat.st_mtime_ns
                            or current_stat.st_ino != source_stat.st_ino):
                        raise RuntimeError("source changed during conversion; WebP was kept")
                    source.unlink()
                    print(f"Deleted source: {source}")
                    deleted += 1
        except (OSError, ValueError, RuntimeError) as error:
            print(f"Failed: {source}: {error}", file=sys.stderr)
            failed += 1

    print(f"Done: {converted} converted, {deleted} sources deleted, "
          f"{skipped} skipped, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
