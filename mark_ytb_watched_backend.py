# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "flask==3.1.3",
#     "yt-dlp==2026.7.4",
# ]
# ///

import io
import os
import re
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from threading import Thread
from typing import Any

from flask import Flask, Response, request
from yt_dlp import CookieLoadError, YoutubeDL
from yt_dlp.utils import YoutubeDLError


YOUTUBE_PROXY = "socks5://127.0.0.1:10808"
YOUTUBE_COOKIE_PATH = r"\\192.168.123.221\共享文件夹\BaiduNetdiskDownload\a\ytb.cookie"
MAX_PARENT_COMMENTS = 1000
MAX_REPLY_COMMENTS = 200
MAX_REPLIES_PER_THREAD = 2
MAX_COMMENT_DEPTH = 2


class IncompleteCommentsError(RuntimeError):
    pass


class CommentsUnavailableError(RuntimeError):
    pass


@dataclass(frozen=True)
class CommentSelection:
    comments: list[dict]
    parent_count: int
    unique_parent_authors: int
    reply_count: int
    parent_comments_complete: bool
    reply_total_limit_reached: bool


class _YtDlpMemoryLogger:
    def __init__(self):
        self.messages: list[str] = []

    def debug(self, _message):
        pass

    def warning(self, message):
        self.messages.append(str(message))

    def error(self, message):
        self.messages.append(str(message))


def extract_video_comments(video_url: str) -> list[dict]:
    logger = _YtDlpMemoryLogger()
    options: Any = {
        "getcomments": True,
        "skip_download": True,
        "ignore_no_formats_error": True,
        "noplaylist": True,
        "cachedir": False,
        "ignoreerrors": False,
        "quiet": True,
        "no_warnings": False,
        "proxy": YOUTUBE_PROXY,
        "js_runtimes": {"node": {}},
        "extractor_args": {
            "youtube": {
                "comment_sort": ["new"],
                "max_comments": [
                    "all",
                    str(MAX_PARENT_COMMENTS + 1),
                    str(MAX_REPLY_COMMENTS + 1),
                    str(MAX_REPLIES_PER_THREAD),
                    str(MAX_COMMENT_DEPTH),
                ],
            }
        },
        "logger": logger,
    }

    if os.path.exists(YOUTUBE_COOKIE_PATH):
        with open(YOUTUBE_COOKIE_PATH, encoding="utf-8") as cookie_file:
            options["cookiefile"] = io.StringIO(cookie_file.read())

    with YoutubeDL(options) as ydl:
        info = ydl.extract_info(video_url, download=False)

    comments = info.get("comments") if info else None
    incomplete_warnings = (
        "Detected YouTube comments looping. Stopping comment extraction",
        "Received incomplete data for a comment reply thread",
    )
    if any(warning in message for warning in incomplete_warnings for message in logger.messages):
        raise IncompleteCommentsError("yt-dlp reported an incomplete comment extraction")
    if comments is None:
        raise CommentsUnavailableError("yt-dlp reported comments are disabled or unavailable")
    if not isinstance(comments, list):
        raise IncompleteCommentsError("yt-dlp returned an invalid comments payload")
    if info.get("comment_count") is None:
        raise IncompleteCommentsError("yt-dlp returned comments without a complete comment count")
    return comments


def _display_scalar(value) -> str:
    return "-" if value is None or value == "" else str(value)


def _format_timestamp(timestamp) -> str | None:
    if timestamp is None or timestamp == "":
        return None
    try:
        return datetime.fromtimestamp(float(timestamp), timezone.utc).isoformat().replace("+00:00", "Z")
    except (TypeError, ValueError, OverflowError):
        return None


def format_comments(comments: list[dict]) -> str:
    parents = {str(comment["id"]): comment.get("parent") for comment in comments if comment.get("id") not in (None, "")}

    def depth_for(comment: dict) -> int:
        parent = comment.get("parent")
        if parent in (None, "", "root"):
            return 0

        depth = 0
        seen = {str(comment.get("id"))}
        while parent not in (None, "", "root"):
            parent_id = str(parent)
            if parent_id in seen or parent_id not in parents:
                return 1
            seen.add(parent_id)
            depth += 1
            parent = parents[parent_id]
        return depth

    blocks = []
    for index, comment in enumerate(comments, start=1):
        timestamp = _format_timestamp(comment.get("timestamp"))
        time_text = comment.get("_time_text")
        if time_text not in (None, "") and timestamp:
            published = f"{time_text} ({timestamp})"
        elif time_text not in (None, ""):
            published = str(time_text)
        else:
            published = timestamp or "-"

        flag_fields = (
            ("pinned", "is_pinned"),
            ("uploader", "author_is_uploader"),
            ("verified", "author_is_verified"),
            ("hearted", "is_favorited"),
        )
        flags = ", ".join(name for name, field in flag_fields if comment.get(field)) or "-"
        parent = comment.get("parent")
        parent_text = "root" if parent in (None, "", "root") else str(parent)
        blocks.append(
            "\n".join(
                (
                    f"Comment: {index}",
                    f"ID: {_display_scalar(comment.get('id'))}",
                    f"Author: {_display_scalar(comment.get('author'))}",
                    f"Author ID: {_display_scalar(comment.get('author_id'))}",
                    f"Published: {published}",
                    f"Likes: {_display_scalar(comment.get('like_count'))}",
                    f"Depth: {depth_for(comment)}",
                    f"Parent: {parent_text}",
                    f"Flags: {flags}",
                    "Text:",
                    _display_scalar(comment.get("text")),
                )
            )
        )
    return "\n\n---\n\n".join(blocks)


def select_comments(comments: list[dict]) -> CommentSelection:
    selected_comments = []
    selected_parent_ids = set()
    selected_parent_author_ids = set()
    parent_count = 0
    reply_count = 0
    extracted_parent_count = 0
    retained_reply_candidates = 0

    for comment in comments:
        parent = comment.get("parent")
        if parent in (None, "", "root"):
            extracted_parent_count += 1
            if parent_count >= MAX_PARENT_COMMENTS:
                continue
            selected_comments.append(comment)
            parent_count += 1
            comment_id = comment.get("id")
            if comment_id not in (None, ""):
                selected_parent_ids.add(str(comment_id))
            author_id = comment.get("author_id")
            if author_id not in (None, ""):
                selected_parent_author_ids.add(str(author_id))
            continue

        if str(parent) not in selected_parent_ids:
            continue
        retained_reply_candidates += 1
        if reply_count >= MAX_REPLY_COMMENTS:
            continue
        selected_comments.append(comment)
        reply_count += 1

    return CommentSelection(
        comments=selected_comments,
        parent_count=parent_count,
        unique_parent_authors=len(selected_parent_author_ids),
        reply_count=reply_count,
        parent_comments_complete=extracted_parent_count <= MAX_PARENT_COMMENTS,
        reply_total_limit_reached=retained_reply_candidates > MAX_REPLY_COMMENTS,
    )


def format_comment_response(selection: CommentSelection) -> str:
    result_type = "parent_complete" if selection.parent_comments_complete else "parent_limited"
    metadata = "\n".join(
        (
            f"Result-Type: {result_type}",
            f"Parent-Comments: {selection.parent_count}",
            f"Unique-Parent-Authors: {selection.unique_parent_authors}",
            f"Parent-Comments-Complete: {str(selection.parent_comments_complete).lower()}",
            f"Reply-Comments: {selection.reply_count}",
            "Replies-Limited: true",
            f"Reply-Total-Limit-Reached: {str(selection.reply_total_limit_reached).lower()}",
        )
    )
    formatted_comments = format_comments(selection.comments)
    return f"{metadata}\n\n{formatted_comments}" if formatted_comments else f"{metadata}\n"


python_exe = "python"
if os.path.exists(r"C:\Program Files\Python313\python.exe"):
    python_exe = '"C:/Program Files/Python313/python.exe"'


app = Flask(__name__)


def _single_line_error(error: Exception) -> str:
    return re.sub(r"[\r\n]+", " ", str(error))


def _error_response(error_type: str, message: str, status: int) -> Response:
    return Response(
        f"Error-Type: {error_type}\nError-Message: {message}\n",
        status=status,
        content_type="text/plain; charset=utf-8",
    )


@app.route("/video_comments", methods=["GET", "POST"])
def video_comments():
    if request.method == "GET":
        video_url = request.args.get("video_url", "")
    else:
        video_url = request.form.get("video_url", "")
    if not video_url.strip():
        return _error_response("invalid_request", "video_url is required", 400)

    try:
        comments = extract_video_comments(video_url)
        selection = select_comments(comments)
        text = format_comment_response(selection)
    except CommentsUnavailableError as error:
        return _error_response("comments_unavailable", _single_line_error(error), 422)
    except IncompleteCommentsError as error:
        return _error_response("incomplete_comments", _single_line_error(error), 502)
    except CookieLoadError as error:
        return _error_response("cookie_error", _single_line_error(error), 502)
    except YoutubeDLError as error:
        return _error_response("extraction_failed", _single_line_error(error), 502)
    except OSError as error:
        return _error_response("cookie_error", _single_line_error(error), 502)

    return Response(text, status=200, content_type="text/plain; charset=utf-8")


@app.route("/mark_video_watched", methods=["POST"])
def mark_video_watched():
    payload = request.form
    video_url = payload["video_url"]
    s = subprocess.run(python_exe + f' yt_dlp_tool.py -d "{video_url}"', shell=True)
    print(video_url, s.stdout, s.stderr)
    return "ok", 200


@app.route("/mark_and_download", methods=["POST"])
def download_video():
    payload = request.form
    video_url = payload["video_url"]
    download_dir = r"\\192.168.123.222\dufs\faster_whisper_result"
    download_command = python_exe + f' yt_dlp_tool.py --dl_dir "{download_dir}" --prefix "㊟" "{video_url}"'

    def run_command():
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        s = subprocess.run(download_command, shell=True, capture_output=True, text=True, env=env, encoding="utf-8", errors="ignore")
        print(f"Video URL: {video_url}")
        print(f"Return code: {s.returncode}")
        print(f"Standard output: {s.stdout}")
        print(f"Standard error: {s.stderr}")

    Thread(target=run_command).start()
    return "Download process started", 200


@app.route("/health", methods=["GET"])
def health():
    return "healthy"


if __name__ == "__main__":
    app.run(debug=False, port=59521, host="0.0.0.0")
