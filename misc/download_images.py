#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# /// script
# requires-python = ">=3.8"
# dependencies = ["requests"]
# ///
"""
逐行下载图片脚本

指定一个 txt（每行一个图片 URL），通过代理下载，单个 URL 出错则无限重试（404
除外），
处理完的行会从 txt 中删除，直到 txt 清空。非 URL 的行会被自动跳过并
原样保留，空行会被清理。默认串行，可用 -j N 开启并发（主线程统一读写 txt、
子线程把图片下载到内存，避免并发写冲突；进度按 --save-interval 攒批写回，
中断与结束时强制落盘）。进度记录在 txt 本身，可随时中断后续传。

日志统一走 logging：带时间戳与级别、线程安全逐条完整输出，可用 --log-file
同时落地到文件便于事后排查。
"""

import argparse
import logging
import os
import sys
import threading
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from itertools import count
from urllib.parse import unquote, urlparse

import requests

# 浏览器 User-Agent，避免部分服务器拒绝默认的 python-requests 请求
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/123.0.0.0 Safari/537.36"
    )
}

# Content-Type -> 扩展名（当 URL 本身没带扩展名时用来兜底）
CONTENT_TYPE_EXT = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/svg+xml": ".svg",
    "image/tiff": ".tiff",
    "image/x-icon": ".ico",
    "image/avif": ".avif",
}

FAILURE_TYPES = ("404", "timeout", "tcp", "other")
FAILURE_LABELS = {
    "404": "404",
    "timeout": "超时",
    "tcp": "TCP 连接",
    "other": "其他错误",
}
FAILURE_FILE_SUFFIXES = {
    "404": ".failed.404.txt",
    "timeout": ".failed.timeout.txt",
    "tcp": ".failed.tcp.txt",
    "other": ".failed.other.txt",
}

# 全局 logger；handler 在 main() 里通过 setup_logging 配置。
# logging 自带锁，多线程调用会逐条完整输出，不会互相撕裂。
logger = logging.getLogger("download_images")


def classify_failure(error):
    """把最终下载异常归入 404、超时、TCP 连接或其他错误。"""
    if isinstance(error, requests.exceptions.HTTPError):
        response = error.response
        if response is not None and response.status_code == 404:
            return "404"
    # ConnectTimeout 同时也是 ConnectionError，必须先判断 Timeout。
    if isinstance(error, requests.exceptions.Timeout):
        return "timeout"
    if isinstance(error, requests.exceptions.ConnectionError):
        return "tcp"
    return "other"


def make_failure_paths(txt_path):
    """生成四类失败清单的路径。"""
    return {
        failure_type: txt_path + suffix
        for failure_type, suffix in FAILURE_FILE_SUFFIXES.items()
    }


def append_failure(url, failure_type, failure_paths):
    """把失败 URL 追加到对应分类文件，返回该文件路径。"""
    failure_type = failure_type if failure_type in FAILURE_TYPES else "other"
    path = failure_paths[failure_type]
    with open(path, "a", encoding="utf-8") as f:
        f.write(url + "\n")
    return failure_type, path


def setup_logging(log_file=None):
    """配置日志：统一格式 + 时间戳 + 级别；始终输出到控制台，可选同时写文件。"""
    logger.setLevel(logging.INFO)
    logger.handlers.clear()
    fmt = logging.Formatter(
        "%(asctime)s [%(levelname)-7s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    logger.addHandler(sh)
    if log_file:
        # 追加模式，续跑时日志接着写
        fh = logging.FileHandler(log_file, mode="a", encoding="utf-8")
        fh.setFormatter(fmt)
        logger.addHandler(fh)


def parse_args():
    """解析命令行参数。"""
    parser = argparse.ArgumentParser(
        prog="download_images.py",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description=(
            "逐行下载图片。\n\n"
            "指定一个 txt 文件（每行一个图片 URL），通过代理下载，单个 URL 出错\n"
            "则【无限重试】，下载完成的 URL 会从 txt 中删除，直到全部下完。\n\n"
            "默认【串行】下载；加 -j N 可开启【并发】：子线程把图片下载到内存，\n"
            "主线程收到完整结果后立即写成正式文件；进度按 --save-interval 攒批\n"
            "写回 txt（中断与结束时强制落盘），避免大文件被高频全量重写。\n\n"
            "不是 http/https URL 的行会被跳过并【原样保留】在原文件里，\n"
            "空行会被清理掉，二者都不会卡住下载流程。\n\n"
            "进度直接记录在 txt 文件本身：可随时按 Ctrl+C 中断，重跑即从断点续传。"
        ),
        epilog=(
            "示例:\n"
            "  uv run download_images.py urls.txt\n"
            "      使用默认 7890 代理，串行下载到 ./images/ 目录\n\n"
            "  uv run download_images.py urls.txt -j 8\n"
            "      开 8 个线程并发下载\n\n"
            "  uv run download_images.py urls.txt -j 8 --log-file dl.log\n"
            "      并发下载，同时把日志追加写入 dl.log\n\n"
            "  uv run download_images.py urls.txt -o 我的图片\n"
            "      下载到 ./我的图片/ 目录\n\n"
            "  uv run download_images.py urls.txt --proxy \"\"\n"
            "      不走代理，直连下载\n\n"
            "  uv run download_images.py urls.txt --max-retries 5\n"
            "      单个 URL 最多重试 5 次，仍失败则按错误类型记入对应清单"
        ),
    )

    parser.add_argument(
        "txt",
        metavar="URL列表文件",
        help="文本文件路径，每行一个图片 URL（空行会被清理，非 URL 行会被跳过并保留）",
    )
    parser.add_argument(
        "-o", "--output-dir",
        metavar="目录",
        default="images",
        help="图片保存目录，不存在会自动创建（默认: %(default)s）",
    )
    parser.add_argument(
        "-j", "--concurrency",
        metavar="并发数",
        type=int,
        default=1,
        help=(
            "并发下载的线程数，默认 1（完全串行，行为与单线程一致）。"
            "设为大于 1 即开启并发：主线程统一读写 txt 与命名落盘、子线程只负责下载，"
            "因此不会产生 txt 并发写冲突；编号按 URL 在 txt 中的顺序预先固定，"
            "下载完成后立即从内存写入正式文件。"
            "调大能提速，但也会加大代理与目标站的压力，请酌情设置"
        ),
    )
    parser.add_argument(
        "--proxy",
        metavar="地址",
        default="http://127.0.0.1:7890",
        help=(
            "HTTP/HTTPS 代理地址，http 与 https 均走此代理；"
            "传入空字符串 \"\" 表示不使用代理（默认: %(default)s）"
        ),
    )
    parser.add_argument(
        "--timeout",
        metavar="秒",
        type=float,
        default=30,
        help="单次请求的超时时间，单位秒（默认: %(default)s）",
    )
    parser.add_argument(
        "--retry-wait",
        metavar="秒",
        type=float,
        default=10,
        help="每次重试前的等待时间，单位秒（默认: %(default)s）",
    )
    parser.add_argument(
        "--max-retries",
        metavar="次数",
        type=int,
        default=0,
        help=(
            "单个 URL 的最大重试次数。0 表示无限重试（默认）；"
            "设为正数时，超过该次数仍失败则跳过此 URL，"
            "并按 404、超时、TCP 连接、其他错误追加到不同失败清单；"
            "404 不重试，直接跳过"
        ),
    )
    parser.add_argument(
        "--save-interval",
        metavar="秒",
        type=float,
        default=300,
        help=(
            "并发模式下进度写回 txt 的最小间隔，单位秒（默认: %(default)s）。"
            "每次写回都会全量重写剩余清单，对大文件相当耗磁盘，故按间隔攒批；"
            "Ctrl+C 中断与全部完成时总会强制写回。串行模式不受此参数影响"
        ),
    )
    parser.add_argument(
        "--log-file",
        metavar="路径",
        default=None,
        help=(
            "把日志（下载/重试/结果）同时追加写入该文件，便于事后排查；"
            "不指定则只输出到控制台，不额外生成文件"
        ),
    )

    return parser.parse_args()


def is_url(s):
    """判断一行内容是否是 http/https URL。"""
    try:
        p = urlparse(s)
    except Exception:
        return False
    return p.scheme in ("http", "https") and bool(p.netloc)


def make_filename(url, save_dir, sequence, content_type=""):
    """根据 URL 推断文件名，在开头加七位序号，并避免文件名冲突。"""
    path = urlparse(url).path
    name = os.path.basename(unquote(path))
    base, ext = os.path.splitext(name)

    if not base:
        base = "image"
    if not ext:
        ct = content_type.split(";")[0].strip().lower()
        ext = CONTENT_TYPE_EXT.get(ct, ".jpg")

    numbered_base = f"{sequence:07d}_{base}"
    candidate = os.path.join(save_dir, numbered_base + ext)
    i = 1
    while os.path.exists(candidate):
        candidate = os.path.join(save_dir, f"{numbered_base}_{i}{ext}")
        i += 1
    return candidate


def _fetch_once(url, proxies, timeout):
    """发一次请求，把响应体分块读入内存，返回 Content-Type 和图片数据。"""
    with requests.get(
        url,
        headers=HEADERS,
        proxies=proxies,
        timeout=timeout,
        stream=True,
    ) as r:
        r.raise_for_status()
        data = bytearray()
        for chunk in r.iter_content(chunk_size=64 * 1024):
            if chunk:
                data.extend(chunk)
        return r.headers.get("Content-Type", ""), data


def download_with_retry(url, proxies, timeout, retry_wait, max_retries,
                        stop_event=None, tag=""):
    """带重试地把 url 下载到内存（只下载、不命名，供主/子线程复用）。

    返回 (Content-Type, bytearray, 失败类型)。成功时失败类型为 None；超过重试
    上限时前两项为 None，并返回最终异常的分类；收到 stop_event 时三项均为
    None。max_retries 为 0 表示无限重试，但 404 始终不重试。
    """
    attempt = 0
    while True:
        if stop_event is not None and stop_event.is_set():
            return None, None, None
        attempt += 1
        try:
            content_type, data = _fetch_once(url, proxies, timeout)
            return content_type, data, None
        except KeyboardInterrupt:
            raise
        except Exception as e:
            failure_type = classify_failure(e)
            if failure_type == "404":
                logger.error("%s收到 HTTP 404，不再重试并放弃: %s", tag, e)
                return None, None, failure_type
            if max_retries and attempt >= max_retries:
                logger.error(
                    "%s已重试 %d 次仍失败，归类为%s并放弃: %s",
                    tag, attempt, FAILURE_LABELS[failure_type], e,
                )
                return None, None, failure_type
            logger.warning("%s[重试 %d] 失败: %s", tag, attempt, e)
            # 可中断的等待：并发时若被叫停则立刻返回，串行时退化为普通 sleep
            if stop_event is not None:
                if stop_event.wait(retry_wait):
                    return None, None, None
            else:
                time.sleep(retry_wait)


def download(url, save_dir, proxies, timeout, retry_wait, max_retries, sequence):
    """串行下载单个 url：完整读入内存后直接写入正式文件。"""
    ct, data, failure_type = download_with_retry(
        url, proxies, timeout, retry_wait, max_retries
    )
    if data is None:
        return None, failure_type
    final = make_filename(url, save_dir, next(sequence), ct)
    with open(final, "wb") as f:
        f.write(data)
    return final, None


def load_entries(txt_path):
    """读取 txt，去掉每行首尾空白并丢弃空行，返回剩余条目列表（保持顺序）。"""
    with open(txt_path, "r", encoding="utf-8") as f:
        return [s for s in (line.strip() for line in f) if s]


def replace_with_retry(src, dst, attempts=8, base_delay=0.1):
    """带退避重试的 os.replace。

    Windows 上目标文件可能被杀毒软件、搜索索引等外部进程短暂占用，
    导致替换报 PermissionError（拒绝访问）；这类占用通常瞬间释放，
    重试即可恢复。重试耗尽仍失败则原样抛出，交由调用方处理。
    """
    delay = base_delay
    for attempt in range(1, attempts + 1):
        try:
            os.replace(src, dst)
            return
        except PermissionError as e:
            if attempt == attempts:
                raise
            logger.warning(
                "替换 %s 失败（第 %d 次，可能被杀毒/索引等进程短暂占用），"
                "%.1f 秒后重试: %s",
                dst, attempt, delay, e,
            )
            time.sleep(delay)
            delay = min(delay * 2, 2.0)


def save_entries(txt_path, entries):
    """把剩余条目原子写回，每行一个，不留空行；为空则清空文件。"""
    tmp = txt_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        if entries:
            f.write("\n".join(entries) + "\n")
    replace_with_retry(tmp, txt_path)


def run_serial(args, proxies, failure_paths, sequence):
    """串行路径：取第一个 URL 下载、删行、下一个。行为与并发功能引入前一致。"""
    ok = failed = 0
    failure_counts = {failure_type: 0 for failure_type in FAILURE_TYPES}
    while True:
        lines = load_entries(args.txt)
        # 找到第一个 URL 行；前面的非 URL 行跳过、原样留在文件里
        idx = next((i for i, s in enumerate(lines) if is_url(s)), None)
        if idx is None:
            break  # 再没有可下载的 URL 了

        url = lines[idx]
        logger.info("[%d] 下载: %s", ok + failed + 1, url)
        path, failure_type = download(
            url,
            args.output_dir,
            proxies,
            args.timeout,
            args.retry_wait,
            args.max_retries,
            sequence,
        )

        if path is not None:
            ok += 1
            logger.info("      已保存 -> %s", path)
        else:
            failed += 1
            failure_type, failure_path = append_failure(
                url, failure_type, failure_paths
            )
            failure_counts[failure_type] += 1
            logger.error(
                "      下载失败并放弃，归类为%s并记入 %s",
                FAILURE_LABELS[failure_type], failure_path,
            )

        # 删掉这一行 URL，其余（含跳过的非 URL 行）原样写回，空行不保留
        del lines[idx]
        save_entries(args.txt, lines)
    return ok, failure_counts


def run_concurrent(args, proxies, failure_paths):
    """并发路径：子线程下载到内存，主线程按任务序号立即正式落盘。"""
    all_lines = load_entries(args.txt)
    tasks = [
        (order, i, s)
        for order, (i, s) in enumerate(
            ((i, s) for i, s in enumerate(all_lines) if is_url(s)),
            start=1,
        )
    ]
    total = len(tasks)
    failure_counts = {failure_type: 0 for failure_type in FAILURE_TYPES}
    if total == 0:
        return 0, failure_counts

    done = set()               # 已处理完（成功/放弃）的行索引，用于从 txt 移除
    stop_event = threading.Event()
    meta = {}                  # future -> (任务顺序, 行索引, url)
    task_iter = iter(tasks)
    dirty = False              # 上次写回后是否有新完成的条目
    last_save = time.monotonic()

    def rewrite():
        # 未完成的 URL 行 + 全部非 URL 行按原顺序写回；只有主线程会调用
        save_entries(args.txt, [s for i, s in enumerate(all_lines) if i not in done])

    def flush(force=False):
        # 攒批写回进度：平时按 --save-interval 节流，中断/收尾时强制执行。
        # 写回失败不致命——进度仍在内存（done 集合）里，下一轮会再试。
        nonlocal dirty, last_save
        if not dirty:
            return
        if not force and time.monotonic() - last_save < args.save_interval:
            return
        try:
            rewrite()
        except PermissionError as e:
            if force:
                logger.error(
                    "进度写回 %s 失败: %s；完整剩余清单已写入 %s.tmp，"
                    "可手动改名替换后再续跑", args.txt, e, args.txt,
                )
            else:
                logger.warning(
                    "进度写回 %s 失败: %s；进度仍在内存中，稍后自动重试",
                    args.txt, e,
                )
            return
        dirty = False
        last_save = time.monotonic()

    def short(u):
        return u if len(u) <= 48 else u[:45] + "..."

    def submit_next(ex):
        try:
            order, i, url = next(task_iter)
        except StopIteration:
            return None
        fut = ex.submit(
            download_with_retry,
            url, proxies, args.timeout, args.retry_wait,
            args.max_retries, stop_event, f"<{short(url)}> ",
        )
        meta[fut] = (order, i, url)
        return fut

    ok = failed = 0
    with ThreadPoolExecutor(max_workers=args.concurrency) as ex:
        # 预填充滑动窗口：在途任务维持在并发数量级，避免一次性提交撑爆内存
        inflight = set()
        for _ in range(args.concurrency):
            fut = submit_next(ex)
            if fut is None:
                break
            inflight.add(fut)

        try:
            while inflight:
                done_set, inflight = wait(inflight, return_when=FIRST_COMPLETED)
                inflight = set(inflight)
                for fut in done_set:
                    order, i, url = meta.pop(fut)
                    ct, data, failure_type = fut.result()

                    nf = submit_next(ex)  # 补充一个新任务，维持窗口
                    if nf is not None:
                        inflight.add(nf)

                    if data is not None:
                        # order 在提交时已按 TXT 中的 URL 顺序固定，无需等待前序任务
                        final = make_filename(url, args.output_dir, order, ct)
                        with open(final, "wb") as f:
                            f.write(data)
                        ok += 1
                        done.add(i)
                        logger.info("[%d/%d] 已保存 %s -> %s",
                                    ok + failed, total, url, os.path.basename(final))
                    else:
                        failed += 1
                        done.add(i)
                        failure_type, failure_path = append_failure(
                            url, failure_type, failure_paths
                        )
                        failure_counts[failure_type] += 1
                        logger.error(
                            "[%d/%d] 放弃 %s（%s，已记入 %s）",
                            ok + failed, total, url,
                            FAILURE_LABELS[failure_type],
                            os.path.basename(failure_path),
                        )

                    dirty = True
                    flush()  # 攒批写回：距上次落盘超过 --save-interval 才真正重写 txt
        except KeyboardInterrupt:
            # 叫停所有子线程，把已完成的进度落盘后向上抛出，交给 main 统一收尾
            stop_event.set()
            logger.warning("正在停止（等待进行中的下载收尾）...")
            flush(force=True)
            raise

    flush(force=True)
    return ok, failure_counts


def main():
    args = parse_args()
    setup_logging(args.log_file)

    if not os.path.isfile(args.txt):
        logger.error("找不到文件: %s", args.txt)
        sys.exit(1)

    # 空字符串表示不走代理
    proxies = {"http": args.proxy, "https": args.proxy} if args.proxy else None

    os.makedirs(args.output_dir, exist_ok=True)
    logger.info("输出目录: %s", os.path.abspath(args.output_dir))
    if args.concurrency > 1:
        logger.info("并发数: %d", args.concurrency)
    failure_paths = make_failure_paths(args.txt)
    sequence = count(1)

    ok = 0
    failure_counts = {failure_type: 0 for failure_type in FAILURE_TYPES}
    interrupted = False
    try:
        if args.concurrency > 1:
            ok, failure_counts = run_concurrent(args, proxies, failure_paths)
        else:
            ok, failure_counts = run_serial(
                args, proxies, failure_paths, sequence
            )
    except KeyboardInterrupt:
        interrupted = True
        logger.warning("已中断，未下载的 URL 仍保留在 txt 中，重跑即可续传。")

    if interrupted:
        sys.exit(130)

    leftover = load_entries(args.txt)
    failed = sum(failure_counts.values())
    parts = [f"成功 {ok} 个，保存在: {os.path.abspath(args.output_dir)}"]
    if failed:
        details = [
            f"{FAILURE_LABELS[failure_type]} {count} 个: "
            f"{failure_paths[failure_type]}"
            for failure_type, count in failure_counts.items()
            if count
        ]
        parts.append(f"失败 {failed} 个（{'；'.join(details)}）")
    if leftover:
        parts.append(f"另有 {len(leftover)} 行非 URL 内容原样保留在 {args.txt}")
    logger.info("全部完成，%s", "；".join(parts))


if __name__ == "__main__":
    main()
