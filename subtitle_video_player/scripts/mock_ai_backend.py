"""AI 对话功能的本地 mock 后端。

模拟 doubao_backend 的 /stream SSE 接口与 / 非流式接口，
用于在没有真实 API key 的情况下联调字幕播放器的 AI 对话功能。

用法: uv run python scripts/mock_ai_backend.py [端口]   (默认 11301)

测试指令(包含在提问中即可触发对应分支):
- "触发错误"   -> 流中途下发 error 事件
- "触发500"    -> 返回 HTTP 500
"""

import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

REPLY_TEMPLATE = (
    "这是 mock 后端的回答。收到你的问题(共 {n} 字)，"
    "本轮请求附带的 system_message 长度为 {m} 字符。"
    "在 [0:00:05] 这句字幕里提到了相关内容，可以点击时间点跳转试试；"
    "更早的背景见 [0:00:01]。"
    "下面是一段用来测试流式渲染的长文本："
    "第一点，流式输出按小块推送，前端应有打字机效果；"
    "第二点，生成过程中可以点击停止，残缺回答不会计入历史；"
    "第三点，完成后回答中的时间点会变成可点击链接。"
    "以上内容仅用于联调，与真实模型无关。"
)


class MockHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _read_payload(self):
        if self.command == "POST":
            length = int(self.headers.get("Content-Length") or 0)
            try:
                return json.loads(self.rfile.read(length).decode("utf-8"))
            except Exception:
                return {}
        return {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}

    def do_POST(self):
        self._route()

    def do_GET(self):
        self._route()

    def _route(self):
        path = urlparse(self.path).path
        payload = self._read_payload()
        if path == "/stream":
            self._handle_stream(payload)
        elif path == "/":
            self._handle_plain(payload)
        else:
            self._send_text(404, "not found")

    def _send_text(self, status, text):
        body = text.encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _build_reply(self, payload):
        user_message = payload.get("user_message") or ""
        system_message = payload.get("system_message") or ""
        return REPLY_TEMPLATE.format(n=len(user_message), m=len(system_message))

    def _handle_plain(self, payload):
        if not payload.get("user_message"):
            self._send_text(400, "缺少必填参数: user_message")
            return
        if "触发500" in payload["user_message"]:
            self._send_text(500, "mock 内部错误")
            return
        self._send_text(200, self._build_reply(payload))

    def _handle_stream(self, payload):
        user_message = payload.get("user_message") or ""
        if not user_message:
            self._send_text(400, "缺少必填参数: user_message")
            return
        if "触发500" in user_message:
            self._send_text(500, "mock 内部错误")
            return

        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        # SSE 长度未知，直接短连接输出
        self.send_header("Connection", "close")
        self.end_headers()

        def emit(obj):
            data = "data: " + json.dumps(obj, ensure_ascii=False) + "\n\n"
            self.wfile.write(data.encode("utf-8"))
            self.wfile.flush()

        try:
            emit({"type": "session", "id": payload.get("id") or "mock-session"})
            if "触发错误" in user_message:
                emit({"type": "delta", "content": "开始回答，然后……"})
                time.sleep(0.3)
                emit({"type": "error", "code": "upstream_interrupted", "message": "模型流式响应中断(mock)"})
                return
            reply = self._build_reply(payload)
            for i in range(0, len(reply), 6):
                emit({"type": "delta", "content": reply[i:i + 6]})
                time.sleep(0.08)
            emit({"type": "done", "preserved": True})
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            sys.stderr.write("[mock] 客户端断开(停止生成)\n")

    def log_message(self, fmt, *args):
        sys.stderr.write("[mock] " + fmt % args + "\n")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 11301
    server = ThreadingHTTPServer(("127.0.0.1", port), MockHandler)
    print(f"mock AI 后端已启动: http://127.0.0.1:{port}  (Ctrl+C 退出)")
    server.serve_forever()


if __name__ == "__main__":
    main()
