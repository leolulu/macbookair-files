import subprocess
from threading import Thread

from flask import Flask, request

app = Flask(__name__)


@app.route("/mark_video_watched", methods=["POST"])
def mark_video_watched():
    payload = request.form
    video_url = payload["video_url"]
    s = subprocess.run(f'python yt_dlp_tool.py -d "{video_url}"', shell=True)
    print(video_url, s.stdout, s.stderr)
    return "ok", 200


@app.route("/mark_and_download", methods=["POST"])
def download_video():
    payload = request.form
    video_url = payload["video_url"]
    download_dir = r"\\192.168.123.222\dufs\faster_whisper_result"
    download_command = f'python yt_dlp_tool.py --dl_dir "{download_dir}" "{video_url}"'

    def run_command():
        s = subprocess.run(download_command, shell=True, capture_output=True, text=True)
        print(video_url, s.stdout, s.stderr)

    Thread(target=run_command).start()
    return "Download process started", 200


@app.route("/mark_video_watched", methods=["GET"])
def hello():
    return "hello"


if __name__ == "__main__":
    app.run(debug=False, port=59521, host="0.0.0.0")
