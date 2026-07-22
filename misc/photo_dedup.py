#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
照片查重器：按文件内容 MD5 精确查重，递归扫描，重复项软删除（移动到指定目录）。

规则：
1. 只有字节内容完全相同的图片才算重复（MD5）
2. 递归扫描指定目录下所有图片（跨子目录）
3. 每组重复只保留第一张，其余移动到软删除目录

效率策略（仍保证最终结果 = 全文件 MD5 一致）：
- os.scandir 递归扫描，扫描时顺带取 size（少一次 stat）
- 体积唯一的文件直接跳过
- 同体积先算「头+尾采样哈希」预筛，筛掉绝大部分非重复
- 小文件采样即等于全量 MD5，无需二遍读取
- 剩余候选多线程并行计算全量 MD5
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# 常见图片扩展名（小写，比较时统一 lower）
IMAGE_EXTENSIONS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".bmp",
    ".webp",
    ".tif",
    ".tiff",
    ".heic",
    ".heif",
    ".ico",
    ".jfif",
    ".raw",
    ".cr2",
    ".nef",
    ".arw",
    ".dng",
}

DEFAULT_TRASH_DIR_NAME = "_photo_duplicates_trash"
CHUNK_SIZE = 1024 * 1024  # 全量 MD5 读块：1 MiB
SAMPLE_SIZE = 64 * 1024  # 预筛采样：头/尾各 64 KiB
PROGRESS_BAR_WIDTH = 30


def _md5() -> hashlib._Hash:
    # usedforsecurity=False：明确非加密用途，部分 Python 版本略快
    try:
        return hashlib.md5(usedforsecurity=False)  # type: ignore[call-arg]
    except TypeError:
        return hashlib.md5()


def is_image_filename(name: str) -> bool:
    dot = name.rfind(".")
    if dot < 0:
        return False
    return name[dot:].lower() in IMAGE_EXTENSIONS


def default_workers() -> int:
    # 读盘为主：线程数略高于 CPU 通常更划算
    cpu = os.cpu_count() or 4
    return max(4, min(32, cpu * 4))


class ProgressBar:
    """纯标准库单行进度条（无第三方依赖）。"""

    def __init__(self, total: int, desc: str = "", width: int = PROGRESS_BAR_WIDTH) -> None:
        self.total = max(int(total), 0)
        self.desc = desc
        self.width = width
        self.current = 0
        self._start = time.monotonic()
        self._last_render = 0.0
        self._finished = False
        self._is_tty = sys.stdout.isatty()
        self.render(force=True)

    def update(self, n: int = 1) -> None:
        if self._finished:
            return
        if self.total > 0:
            self.current = min(self.current + n, self.total)
        else:
            self.current += n
        min_interval = 0.05 if self._is_tty else 0.5
        now = time.monotonic()
        done = self.total > 0 and self.current >= self.total
        if done or (now - self._last_render) >= min_interval:
            self.render(force=True)

    def render(self, force: bool = False) -> None:
        if self._finished and not force:
            return
        now = time.monotonic()
        self._last_render = now
        elapsed = max(now - self._start, 1e-6)

        if self.total > 0:
            ratio = min(self.current / self.total, 1.0)
            filled = int(self.width * ratio)
            bar = "█" * filled + "░" * (self.width - filled)
            percent = ratio * 100
            speed = self.current / elapsed
            remaining = (self.total - self.current) / speed if speed > 0 else 0.0
            line = (
                f"\r{self.desc} |{bar}| "
                f"{self.current}/{self.total} "
                f"({percent:5.1f}%) "
                f"{speed:.1f} it/s "
                f"ETA {self._fmt_time(remaining)}"
            )
        else:
            spinner = "-\\|/"[int(now * 8) % 4]
            line = (
                f"\r{self.desc} {spinner} "
                f"已处理 {self.current} "
                f"耗时 {self._fmt_time(elapsed)}"
            )

        sys.stdout.write(line + " " * 8)
        sys.stdout.flush()

    def close(self) -> None:
        if self._finished:
            return
        if self.total > 0:
            self.current = self.total
        self.render(force=True)
        sys.stdout.write("\n")
        sys.stdout.flush()
        self._finished = True

    @staticmethod
    def _fmt_time(seconds: float) -> str:
        if seconds < 0 or seconds == float("inf"):
            return "--:--"
        seconds = int(seconds)
        m, s = divmod(seconds, 60)
        h, m = divmod(m, 60)
        if h > 0:
            return f"{h:d}:{m:02d}:{s:02d}"
        return f"{m:02d}:{s:02d}"


def compute_full_md5(path: str) -> str:
    """全文件 MD5（最终判定依据）。"""
    md5 = _md5()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(CHUNK_SIZE)
            if not chunk:
                break
            md5.update(chunk)
    return md5.hexdigest()


def compute_sample_hash(path: str, size: int) -> tuple[str, bool]:
    """
    采样哈希用于预筛。
    返回 (hex_digest, is_full_content)：
    - 小文件（整文件已被采样读完）→ is_full_content=True，可直接当最终 MD5
    - 大文件只读头/尾 → is_full_content=False，碰撞后再全量 MD5
    """
    md5 = _md5()
    with open(path, "rb") as f:
        if size <= SAMPLE_SIZE:
            md5.update(f.read(size))
            return md5.hexdigest(), True

        if size <= SAMPLE_SIZE * 2:
            # 整文件两次读完，结果仍是完整 MD5
            md5.update(f.read())
            return md5.hexdigest(), True

        # 大文件：头 + 尾 各 SAMPLE_SIZE（仅用于预筛，不是完整 MD5）
        md5.update(f.read(SAMPLE_SIZE))
        f.seek(size - SAMPLE_SIZE)
        md5.update(f.read(SAMPLE_SIZE))
        return md5.hexdigest(), False


def _is_under(path: str, parent: str) -> bool:
    """path 是否等于 parent 或在其目录树下（字符串前缀，避免反复 Path.resolve）。"""
    if path == parent:
        return True
    prefix = parent if parent.endswith(os.sep) else parent + os.sep
    return path.startswith(prefix)


def collect_images(root: Path, trash_dir: Path) -> list[tuple[str, int]]:
    """
    用 os.scandir 递归收集图片，并顺带记录 size。
    返回 [(abspath, size), ...]，按路径排序。
    """
    root_s = os.path.abspath(str(root))
    trash_s = os.path.abspath(str(trash_dir))
    images: list[tuple[str, int]] = []

    bar = ProgressBar(total=0, desc="扫描文件")
    scanned = 0
    stack = [root_s]

    while stack:
        current = stack.pop()
        # 整棵软删除目录跳过
        if _is_under(current, trash_s):
            continue
        try:
            with os.scandir(current) as it:
                for entry in it:
                    scanned += 1
                    if scanned % 50 == 0:
                        bar.update(50)
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            p = entry.path
                            if not _is_under(p, trash_s):
                                stack.append(p)
                            continue
                        if not entry.is_file(follow_symlinks=False):
                            continue
                        name = entry.name
                        if not is_image_filename(name):
                            continue
                        # DirEntry.stat 通常带缓存，比 Path.stat 更省
                        size = entry.stat(follow_symlinks=False).st_size
                        images.append((os.path.abspath(entry.path), size))
                    except OSError:
                        continue
        except OSError as e:
            sys.stdout.write("\n")
            print(f"[警告] 无法打开目录，跳过: {current} ({e})", file=sys.stderr)

    remainder = scanned % 50
    if remainder:
        bar.update(remainder)
    bar.close()
    print(f"  扫描完成，命中图片 {len(images)} 张（共遍历 {scanned} 项）")

    # 稳定排序，保证“第一张”可复现
    images.sort(key=lambda x: x[0].lower())
    return images


def _parallel_map(
    items: list,
    worker,
    desc: str,
    workers: int,
) -> list:
    """
    多线程并行处理，保持与 items 相同顺序的结果列表。
    worker(item) -> result；失败时 worker 应抛异常，此处捕获为 None。
    """
    if not items:
        return []

    results: list = [None] * len(items)
    bar = ProgressBar(total=len(items), desc=desc)

    # 少量任务串行更省调度开销
    if len(items) < 4 or workers <= 1:
        for i, item in enumerate(items):
            try:
                results[i] = worker(item)
            except OSError as e:
                sys.stdout.write("\n")
                print(f"[警告] 处理失败，跳过: {item} ({e})", file=sys.stderr)
                results[i] = None
            bar.update(1)
        bar.close()
        return results

    with ThreadPoolExecutor(max_workers=workers) as pool:
        future_map = {pool.submit(worker, item): i for i, item in enumerate(items)}
        for fut in as_completed(future_map):
            i = future_map[fut]
            try:
                results[i] = fut.result()
            except OSError as e:
                sys.stdout.write("\n")
                print(f"[警告] 处理失败，跳过: {items[i]} ({e})", file=sys.stderr)
                results[i] = None
            bar.update(1)
    bar.close()
    return results


def find_duplicates(
    images: list[tuple[str, int]],
    workers: int,
) -> dict[str, list[str]]:
    """
    三级过滤：size → 采样哈希 → 全量 MD5。
    返回：full_md5 -> 按保留顺序排列的路径列表（仅 >=2 的组）。
    """
    by_size: dict[int, list[str]] = defaultdict(list)
    for path, size in images:
        by_size[size].append(path)

    size_candidates: list[tuple[str, int]] = []
    unique_size_skipped = 0
    for size, paths in by_size.items():
        if len(paths) < 2:
            unique_size_skipped += len(paths)
            continue
        for p in paths:
            size_candidates.append((p, size))

    print(
        f"  体积预筛: 候选 {len(size_candidates)} 张，"
        f"跳过体积唯一 {unique_size_skipped} 张"
    )

    if not size_candidates:
        return {}

    # --- 阶段 A：采样哈希 ---
    def _sample_job(item: tuple[str, int]) -> tuple[str, int, str, bool] | None:
        path, size = item
        digest, is_full = compute_sample_hash(path, size)
        return path, size, digest, is_full

    sample_results = _parallel_map(
        size_candidates,
        _sample_job,
        desc="采样预筛",
        workers=workers,
    )

    # key: (size, sample_digest) -> list of (path, is_full)
    by_sample: dict[tuple[int, str], list[tuple[str, bool]]] = defaultdict(list)
    for row in sample_results:
        if row is None:
            continue
        path, size, digest, is_full = row
        by_sample[(size, digest)].append((path, is_full))

    # 采样后仍可能重复的组
    need_full: list[str] = []
    # 已可直接确认的全量 MD5 组（小文件）
    confirmed: dict[str, list[str]] = defaultdict(list)

    sample_filtered_out = 0
    for (_size, sample_digest), members in by_sample.items():
        if len(members) < 2:
            sample_filtered_out += len(members)
            continue

        all_full = all(is_full for _p, is_full in members)
        if all_full:
            # 采样已读完整文件，sample_digest 就是 MD5
            paths = [p for p, _ in members]
            paths.sort(key=str.lower)
            confirmed[sample_digest].extend(paths)
        else:
            # 大文件：头尾采样相同仍可能中间不同，必须全量 MD5 最终判定
            need_full.extend(p for p, _ in members)

    print(
        f"  采样预筛: 待全量 MD5 {len(need_full)} 张，"
        f"采样即确认(小文件)组内文件 "
        f"{sum(len(v) for v in confirmed.values())} 张，"
        f"采样已排除 {sample_filtered_out} 张"
    )

    # --- 阶段 B：全量 MD5（仅剩候选）---
    if need_full:
        # 去重保序
        seen: set[str] = set()
        unique_need: list[str] = []
        for p in need_full:
            if p not in seen:
                seen.add(p)
                unique_need.append(p)

        full_results = _parallel_map(
            unique_need,
            compute_full_md5,
            desc="全量 MD5",
            workers=workers,
        )
        for path, digest in zip(unique_need, full_results):
            if digest is None:
                continue
            confirmed[digest].append(path)

    # 每组内按路径排序，只保留真正重复
    result: dict[str, list[str]] = {}
    for digest, paths in confirmed.items():
        # 可能从 confirmed 与 full 两路合并，需去重+排序
        uniq = sorted(set(paths), key=str.lower)
        if len(uniq) >= 2:
            result[digest] = uniq
    return result


def unique_dest_path(dest_dir: Path, src: Path) -> Path:
    """在目标目录生成不冲突的文件名；冲突时追加 _1, _2 ..."""
    candidate = dest_dir / src.name
    if not candidate.exists():
        return candidate

    stem = src.stem
    suffix = src.suffix
    n = 1
    while True:
        candidate = dest_dir / f"{stem}_{n}{suffix}"
        if not candidate.exists():
            return candidate
        n += 1


def soft_delete(
    path: Path,
    trash_dir: Path,
    dry_run: bool,
    quiet: bool = False,
) -> Path | None:
    """将文件移动到软删除目录，返回目标路径。"""
    trash_dir.mkdir(parents=True, exist_ok=True)
    dest = unique_dest_path(trash_dir, path)

    if dry_run:
        if not quiet:
            print(f"  [预览] 移动: {path}  ->  {dest}")
        return dest

    try:
        shutil.move(str(path), str(dest))
        if not quiet:
            print(f"  [已移动] {path}  ->  {dest}")
        return dest
    except OSError as e:
        if quiet:
            sys.stdout.write("\n")
        print(f"  [失败] 移动失败: {path} ({e})", file=sys.stderr)
        return None


def process(
    root: Path,
    trash_dir: Path,
    dry_run: bool,
    list_only: bool,
    workers: int,
) -> int:
    root = root.resolve()
    if not root.is_dir():
        print(f"[错误] 目录不存在或不是文件夹: {root}", file=sys.stderr)
        return 1

    if not trash_dir.is_absolute():
        trash_dir = (root / trash_dir).resolve()
    else:
        trash_dir = trash_dir.resolve()

    print(f"扫描目录: {root}")
    print(f"软删除目录: {trash_dir}")
    print(f"并行线程: {workers}")
    if dry_run:
        print("模式: 预览（不会真正移动文件）")
    elif list_only:
        print("模式: 仅列出重复，不移动")
    else:
        print("模式: 执行软删除（移动重复项）")
    print("-" * 60)

    t0 = time.monotonic()
    print("阶段 1/3: 递归扫描图片...")
    images = collect_images(root, trash_dir)
    print(f"共发现图片: {len(images)} 张")

    if not images:
        print("没有可处理的图片。")
        return 0

    print("阶段 2/3: 查重（体积 → 采样 → 全量 MD5）...")
    duplicates = find_duplicates(images, workers=workers)

    if not duplicates:
        print(f"未发现完全相同的重复图片。（耗时 {time.monotonic() - t0:.2f}s）")
        return 0

    group_count = len(duplicates)
    dup_file_count = sum(len(paths) - 1 for paths in duplicates.values())
    print(f"发现重复组: {group_count} 组，可软删除: {dup_file_count} 张")
    print(f"查重耗时: {time.monotonic() - t0:.2f}s")
    print("-" * 60)

    jobs: list[tuple[int, str, Path, Path]] = []
    for i, (digest, paths) in enumerate(sorted(duplicates.items()), start=1):
        keep = Path(paths[0])
        for p in paths[1:]:
            jobs.append((i, digest, keep, Path(p)))

    moved = 0
    failed = 0

    group_sizes: dict[int, int] = defaultdict(int)
    group_keep: dict[int, tuple[str, Path]] = {}
    for i, digest, keep, _p in jobs:
        group_sizes[i] += 1
        group_keep[i] = (digest, keep)

    for i in sorted(group_sizes):
        digest, keep = group_keep[i]
        print(f"[组 {i}] MD5={digest}  共 {group_sizes[i] + 1} 张")
        print(f"  保留: {keep}")
        for _i, _digest, _keep, p in jobs:
            if _i == i:
                print(f"  重复: {p}")

    if not list_only:
        print(f"阶段 3/3: {'预览移动' if dry_run else '软删除移动'}...")
        move_bar = ProgressBar(
            total=len(jobs),
            desc="预览移动" if dry_run else "软删除",
        )
        for _i, _digest, _keep, p in jobs:
            result = soft_delete(p, trash_dir, dry_run=dry_run, quiet=True)
            if result is not None:
                moved += 1
            else:
                failed += 1
            move_bar.update(1)
        move_bar.close()

    print("-" * 60)
    if list_only:
        print(f"完成。重复组 {group_count}，重复文件 {dup_file_count}（未移动）。")
    elif dry_run:
        print(f"预览完成。将软删除 {moved} 张，失败 {failed} 张。")
        print("去掉 --dry-run 后会真正移动文件。")
    else:
        print(f"完成。已软删除 {moved} 张，失败 {failed} 张。")
        print(f"重复文件已移动到: {trash_dir}")

    return 0 if failed == 0 else 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="照片查重器：MD5 精确查重，递归扫描，重复项软删除（移动到指定目录）。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=f"""示例:
  # 仅列出重复（不移动）
  uv run photo_dedup.py "D:\\Photos" --list-only

  # 预览将要移动的文件
  uv run photo_dedup.py "D:\\Photos" --dry-run

  # 真正执行：保留每组第一张，其余移到默认软删除目录
  uv run photo_dedup.py "D:\\Photos"

  # 指定并行线程数（读盘慢可试 8~32）
  uv run photo_dedup.py "D:\\Photos" --workers 16

  # 指定软删除目录
  uv run photo_dedup.py "D:\\Photos" --trash-dir "D:\\Photos\\_trash"

默认软删除目录名: {DEFAULT_TRASH_DIR_NAME}（位于扫描根目录下）
""",
    )
    parser.add_argument(
        "directory",
        type=Path,
        help="要扫描的根目录（会递归包含所有子目录）",
    )
    parser.add_argument(
        "--trash-dir",
        type=Path,
        default=Path(DEFAULT_TRASH_DIR_NAME),
        help=f"软删除目标目录（相对路径则相对于扫描根目录）。默认: {DEFAULT_TRASH_DIR_NAME}",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="预览模式：只显示将要移动的文件，不实际移动",
    )
    parser.add_argument(
        "--list-only",
        action="store_true",
        help="仅列出重复组，不做移动（比 dry-run 更安静，不打印目标路径）",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=default_workers(),
        help=f"并行哈希线程数（默认 {default_workers()}）。设为 1 可关闭并行",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.dry_run and args.list_only:
        print("[错误] --dry-run 与 --list-only 不能同时使用。", file=sys.stderr)
        return 1
    if args.workers < 1:
        print("[错误] --workers 必须 >= 1。", file=sys.stderr)
        return 1

    return process(
        root=args.directory,
        trash_dir=args.trash_dir,
        dry_run=args.dry_run,
        list_only=args.list_only,
        workers=args.workers,
    )


if __name__ == "__main__":
    sys.exit(main())
