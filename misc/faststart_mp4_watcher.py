import time
import ctypes
import subprocess
from pathlib import Path

WATCH_DIRS = [
    Path(r"D:\tmp\share folder in D"),
    Path(r"C:\Users\sisplayer\Downloads"),
    Path(r"C:\Users\sisplayer\Downloads\porn"),
    Path(r"D:\tmp\missav"),
]

INTERVAL = 10

SKIP_SUFFIXES = (
    ".faststart.mp4",
    ".failed.mp4",
    ".tmp.mp4",
)

GENERIC_READ = 0x80000000
OPEN_EXISTING = 3
FILE_ATTRIBUTE_NORMAL = 0x80
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value

CreateFileW = ctypes.windll.kernel32.CreateFileW
CreateFileW.argtypes = [
    ctypes.c_wchar_p,
    ctypes.c_uint32,
    ctypes.c_uint32,
    ctypes.c_void_p,
    ctypes.c_uint32,
    ctypes.c_uint32,
    ctypes.c_void_p,
]
CreateFileW.restype = ctypes.c_void_p

CloseHandle = ctypes.windll.kernel32.CloseHandle
CloseHandle.argtypes = [ctypes.c_void_p]
CloseHandle.restype = ctypes.c_int


def file_is_free(path: Path) -> bool:
    handle = CreateFileW(
        str(path),
        GENERIC_READ,
        0,  # share mode = 0，要求独占打开
        None,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        None,
    )

    if handle == INVALID_HANDLE_VALUE:
        return False

    CloseHandle(handle)
    return True


while True:
    for watch_dir in WATCH_DIRS:
        if not watch_dir.exists():
            print(f"skip missing dir: {watch_dir}")
            continue

        for src in watch_dir.glob("*.mp4"):
            if src.name.endswith(SKIP_SUFFIXES):
                continue

            if not file_is_free(src):
                print(f"skip locked: {src}")
                continue

            tmp = src.with_name(src.stem + ".tmp.mp4")
            ok = src.with_name(src.stem + ".faststart.mp4")
            failed = src.with_name(src.stem + ".failed.mp4")

            print(f"processing: {src}")

            try:
                subprocess.run([
                    "ffmpeg",
                    "-y",
                    "-i", str(src),
                    "-map", "0",
                    "-c", "copy",
                    "-movflags", "+faststart",
                    str(tmp),
                ], check=True)

                src.unlink()
                tmp.rename(ok)

                print(f"done: {ok}")

            except Exception as e:
                print(f"failed: {src} -> {e}")

                if tmp.exists():
                    tmp.unlink()

                if src.exists():
                    src.rename(failed)

    time.sleep(INTERVAL)