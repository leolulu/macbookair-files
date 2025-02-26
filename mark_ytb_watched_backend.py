import os
import subprocess
from threading import Thread

from flask import Flask, request


python_exe = "python"
if os.path.exists(r"C:\Program Files\Python313\python.exe"):
    python_exe = '"C:/Program Files/Python313/python.exe"'


app = Flask(__name__)


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


@app.route("/mark_video_watched", methods=["GET"])
def hello():
    return "hello"


if __name__ == "__main__":
    app.run(debug=False, port=59521, host="0.0.0.0")
