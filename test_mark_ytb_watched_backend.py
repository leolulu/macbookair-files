import io
import unittest
from unittest.mock import mock_open, patch
from typing import Any

import mark_ytb_watched_backend as backend


class FakeYoutubeDL:
    info: dict[str, Any] = {"comments": [], "comment_count": 0}
    warning: str | None = None
    options: dict[str, Any] | None = None
    extract_call: tuple[str, bool] | None = None

    def __init__(self, options):
        type(self).options = options

    def __enter__(self):
        return self

    def __exit__(self, *_unused_args):
        return None

    def extract_info(self, url, download):
        type(self).extract_call = (url, download)
        if type(self).warning:
            options = type(self).options
            assert options is not None
            options["logger"].warning(type(self).warning)
        return type(self).info


class CommentExtractionTests(unittest.TestCase):
    def setUp(self):
        FakeYoutubeDL.info = {"comments": [], "comment_count": 0}
        FakeYoutubeDL.warning = None
        FakeYoutubeDL.options = None
        FakeYoutubeDL.extract_call = None

    def test_extraction_uses_memory_only_complete_comment_options(self):
        comments = [{"id": "one"}]
        FakeYoutubeDL.info = {"comments": comments, "comment_count": 1}
        with (
            patch.object(backend.os.path, "exists", return_value=False),
            patch.object(backend, "YoutubeDL", FakeYoutubeDL),
        ):
            result = backend.extract_video_comments("https://example.test/video")

        self.assertIs(result, comments)
        self.assertEqual(FakeYoutubeDL.extract_call, ("https://example.test/video", False))
        assert FakeYoutubeDL.options is not None
        self.assertEqual(
            FakeYoutubeDL.options,
            {
                "getcomments": True,
                "skip_download": True,
                "ignore_no_formats_error": True,
                "noplaylist": True,
                "cachedir": False,
                "ignoreerrors": False,
                "quiet": True,
                "no_warnings": False,
                "proxy": backend.YOUTUBE_PROXY,
                "js_runtimes": {"node": {}},
                "extractor_args": {
                    "youtube": {
                        "comment_sort": ["new"],
                        "max_comments": [
                            "all",
                            str(backend.MAX_PARENT_COMMENTS + 1),
                            str(backend.MAX_REPLY_COMMENTS + 1),
                            str(backend.MAX_REPLIES_PER_THREAD),
                            str(backend.MAX_COMMENT_DEPTH),
                        ],
                    }
                },
                "logger": FakeYoutubeDL.options["logger"],
            },
        )

    def test_cookie_file_is_read_into_memory_stream(self):
        with (
            patch.object(backend.os.path, "exists", return_value=True),
            patch("builtins.open", mock_open(read_data="# Netscape HTTP Cookie File\n")) as opened,
            patch.object(backend, "YoutubeDL", FakeYoutubeDL),
        ):
            backend.extract_video_comments("video")

        opened.assert_called_once_with(backend.YOUTUBE_COOKIE_PATH, encoding="utf-8")
        assert FakeYoutubeDL.options is not None
        cookiefile = FakeYoutubeDL.options["cookiefile"]
        self.assertIsInstance(cookiefile, io.StringIO)
        self.assertEqual(cookiefile.getvalue(), "# Netscape HTTP Cookie File\n")

    def test_incomplete_comment_count_discards_partial_comments(self):
        FakeYoutubeDL.info = {"comments": [{"id": "partial"}], "comment_count": None}
        with (
            patch.object(backend.os.path, "exists", return_value=False),
            patch.object(backend, "YoutubeDL", FakeYoutubeDL),
        ):
            with self.assertRaisesRegex(backend.IncompleteCommentsError, "complete comment count"):
                backend.extract_video_comments("video")

    def test_empty_incomplete_comments_are_not_treated_as_valid_zero_comments(self):
        FakeYoutubeDL.info = {"comments": [], "comment_count": None}
        with (
            patch.object(backend.os.path, "exists", return_value=False),
            patch.object(backend, "YoutubeDL", FakeYoutubeDL),
        ):
            with self.assertRaisesRegex(backend.IncompleteCommentsError, "complete comment count"):
                backend.extract_video_comments("video")

    def test_disabled_or_unavailable_comments_are_distinct_from_zero_comments(self):
        FakeYoutubeDL.info = {"comments": None, "comment_count": None}
        with (
            patch.object(backend.os.path, "exists", return_value=False),
            patch.object(backend, "YoutubeDL", FakeYoutubeDL),
        ):
            with self.assertRaisesRegex(backend.CommentsUnavailableError, "disabled or unavailable"):
                backend.extract_video_comments("video")

    def test_each_incomplete_warning_discards_partial_comments(self):
        warnings = (
            "Detected YouTube comments looping. Stopping comment extraction",
            "Received incomplete data for a comment reply thread",
        )
        FakeYoutubeDL.info = {"comments": [{"id": "partial"}], "comment_count": 1}
        for warning in warnings:
            with self.subTest(warning=warning):
                FakeYoutubeDL.warning = warning
                with (
                    patch.object(backend.os.path, "exists", return_value=False),
                    patch.object(backend, "YoutubeDL", FakeYoutubeDL),
                ):
                    with self.assertRaisesRegex(backend.IncompleteCommentsError, "incomplete comment extraction"):
                        backend.extract_video_comments("video")


class CommentFormattingTests(unittest.TestCase):
    def test_exact_multiline_metadata_and_reply_depths(self):
        comments = [
            {
                "id": "root-id",
                "author": "Root Author",
                "author_id": "UC-root",
                "_time_text": "2 hours ago",
                "timestamp": 0,
                "like_count": 0,
                "text": "first line\nsecond line",
                "is_pinned": True,
                "author_is_uploader": True,
                "author_is_verified": True,
                "is_favorited": True,
            },
            {"id": "reply-id", "parent": "root-id", "timestamp": 1, "text": "reply"},
            {"id": "deep-id", "parent": "reply-id", "text": "deep reply"},
        ]
        expected = """Comment: 1
ID: root-id
Author: Root Author
Author ID: UC-root
Published: 2 hours ago (1970-01-01T00:00:00Z)
Likes: 0
Depth: 0
Parent: root
Flags: pinned, uploader, verified, hearted
Text:
first line
second line

---

Comment: 2
ID: reply-id
Author: -
Author ID: -
Published: 1970-01-01T00:00:01Z
Likes: -
Depth: 1
Parent: root-id
Flags: -
Text:
reply

---

Comment: 3
ID: deep-id
Author: -
Author ID: -
Published: -
Likes: -
Depth: 2
Parent: reply-id
Flags: -
Text:
deep reply"""
        self.assertEqual(backend.format_comments(comments), expected)

    def test_missing_and_cyclic_parents_degrade_to_depth_one(self):
        comments = [
            {"id": "orphan", "parent": "missing", "text": "orphan"},
            {"id": "a", "parent": "b", "text": "a"},
            {"id": "b", "parent": "a", "text": "b"},
        ]
        blocks = backend.format_comments(comments).split("\n\n---\n\n")
        self.assertTrue(all("Depth: 1" in block for block in blocks))

    def test_empty_comments_format_as_empty_text(self):
        self.assertEqual(backend.format_comments([]), "")


class CommentSelectionTests(unittest.TestCase):
    def test_parent_and_reply_budgets_are_independent(self):
        comments = [
            {"id": "parent-1", "author_id": "author-1", "text": "parent 1"},
            {"id": "reply-1", "parent": "parent-1", "text": "reply 1"},
            {"id": "reply-2", "parent": "parent-1", "text": "reply 2"},
            {"id": "parent-2", "author_id": "author-1", "text": "parent 2"},
            {"id": "reply-3", "parent": "parent-2", "text": "reply 3"},
            {"id": "parent-3", "author_id": "author-2", "text": "parent 3"},
            {"id": "parent-probe", "text": "parent probe"},
            {"id": "probe-reply", "parent": "parent-probe", "text": "probe reply"},
        ]
        with (
            patch.object(backend, "MAX_PARENT_COMMENTS", 3),
            patch.object(backend, "MAX_REPLY_COMMENTS", 2),
        ):
            selection = backend.select_comments(comments)

        self.assertEqual(
            [comment["id"] for comment in selection.comments],
            ["parent-1", "reply-1", "reply-2", "parent-2", "parent-3"],
        )
        self.assertEqual(selection.parent_count, 3)
        self.assertEqual(selection.unique_parent_authors, 2)
        self.assertEqual(selection.reply_count, 2)
        self.assertFalse(selection.parent_comments_complete)
        self.assertTrue(selection.reply_total_limit_reached)

    def test_complete_zero_comment_result_has_metadata(self):
        selection = backend.select_comments([])
        self.assertEqual(
            backend.format_comment_response(selection),
            """Result-Type: parent_complete
Parent-Comments: 0
Unique-Parent-Authors: 0
Parent-Comments-Complete: true
Reply-Comments: 0
Replies-Limited: true
Reply-Total-Limit-Reached: false
""",
        )

    def test_exact_budget_is_complete_until_probe_item_exists(self):
        comments = [
            {"id": "parent-1", "text": "parent 1"},
            {"id": "reply-1", "parent": "parent-1", "text": "reply 1"},
            {"id": "parent-2", "text": "parent 2"},
            {"id": "reply-2", "parent": "parent-2", "text": "reply 2"},
        ]
        with (
            patch.object(backend, "MAX_PARENT_COMMENTS", 2),
            patch.object(backend, "MAX_REPLY_COMMENTS", 2),
        ):
            selection = backend.select_comments(comments)

        self.assertTrue(selection.parent_comments_complete)
        self.assertFalse(selection.reply_total_limit_reached)


class VideoCommentsRouteTests(unittest.TestCase):
    def setUp(self):
        backend.app.config.update(TESTING=True)
        self.client = backend.app.test_client()

    def test_missing_video_url_returns_typed_bad_request(self):
        response = self.client.post("/video_comments", data={})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.content_type, "text/plain; charset=utf-8")
        self.assertEqual(
            response.get_data(as_text=True),
            "Error-Type: invalid_request\nError-Message: video_url is required\n",
        )

    def test_blank_video_url_returns_plain_text_bad_request(self):
        response = self.client.post("/video_comments", data={"video_url": " \t "})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.content_type, "text/plain; charset=utf-8")
        self.assertEqual(
            response.get_data(as_text=True),
            "Error-Type: invalid_request\nError-Message: video_url is required\n",
        )

    def test_get_missing_video_url_returns_typed_bad_request(self):
        response = self.client.get("/video_comments")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.content_type, "text/plain; charset=utf-8")
        self.assertEqual(
            response.get_data(as_text=True),
            "Error-Type: invalid_request\nError-Message: video_url is required\n",
        )

    def test_get_success_uses_query_parameter(self):
        comments = [{"id": "one", "text": "hello"}]
        with patch.object(backend, "extract_video_comments", return_value=comments) as extract:
            response = self.client.get("/video_comments", query_string={"video_url": "https://example.test/watch?v=one&x=two"})

        extract.assert_called_once_with("https://example.test/watch?v=one&x=two")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_data(as_text=True).startswith("Result-Type: parent_complete\n"))
        self.assertIn("Text:\nhello", response.get_data(as_text=True))

    def test_success_returns_formatted_plain_text(self):
        comments = [{"id": "one", "text": "hello"}]
        with patch.object(backend, "extract_video_comments", return_value=comments) as extract:
            response = self.client.post("/video_comments", data={"video_url": " video "})

        extract.assert_called_once_with(" video ")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content_type, "text/plain; charset=utf-8")
        self.assertTrue(response.get_data(as_text=True).startswith("Result-Type: parent_complete\n"))
        self.assertIn("Parent-Comments: 1\n", response.get_data(as_text=True))
        self.assertIn("Reply-Comments: 0\n", response.get_data(as_text=True))
        self.assertIn("Comment: 1\n", response.get_data(as_text=True))
        self.assertIn("Text:\nhello", response.get_data(as_text=True))

    def test_empty_comments_return_complete_zero_comment_metadata(self):
        with patch.object(backend, "extract_video_comments", return_value=[]):
            response = self.client.post("/video_comments", data={"video_url": "video"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content_type, "text/plain; charset=utf-8")
        self.assertEqual(
            response.get_data(as_text=True),
            """Result-Type: parent_complete
Parent-Comments: 0
Unique-Parent-Authors: 0
Parent-Comments-Complete: true
Reply-Comments: 0
Replies-Limited: true
Reply-Total-Limit-Reached: false
""",
        )

    def test_expected_errors_have_stable_types_and_single_line_messages(self):
        cases = (
            (
                backend.CommentsUnavailableError("disabled\r\n\r\ncomments"),
                422,
                "Error-Type: comments_unavailable\nError-Message: disabled comments\n",
            ),
            (
                backend.IncompleteCommentsError("partial\r\n\r\ndata"),
                502,
                "Error-Type: incomplete_comments\nError-Message: partial data\n",
            ),
            (
                backend.CookieLoadError("invalid\r\n\r\ncookie"),
                502,
                "Error-Type: cookie_error\nError-Message: invalid cookie\n",
            ),
            (
                backend.YoutubeDLError("extract\r\n\r\nfailed"),
                502,
                "Error-Type: extraction_failed\nError-Message: extract failed\n",
            ),
            (
                OSError("cookie\r\n\r\nfailed"),
                502,
                "Error-Type: cookie_error\nError-Message: cookie failed\n",
            ),
        )
        for error, status, expected in cases:
            with self.subTest(error=type(error).__name__):
                with patch.object(backend, "extract_video_comments", side_effect=error):
                    response = self.client.post("/video_comments", data={"video_url": "video"})
                self.assertEqual(response.status_code, status)
                self.assertEqual(response.content_type, "text/plain; charset=utf-8")
                self.assertEqual(response.get_data(as_text=True), expected)
                self.assertNotIn("partial comment text", response.get_data(as_text=True))

    def test_incomplete_extraction_signals_return_502_without_partial_text(self):
        cases = (
            ({"comments": [{"id": "partial", "text": "partial comment text"}], "comment_count": None}, None),
            (
                {"comments": [{"id": "partial", "text": "partial comment text"}], "comment_count": 1},
                "Detected YouTube comments looping. Stopping comment extraction",
            ),
        )
        for info, warning in cases:
            with self.subTest(warning=warning):
                FakeYoutubeDL.info = info
                FakeYoutubeDL.warning = warning
                with (
                    patch.object(backend.os.path, "exists", return_value=False),
                    patch.object(backend, "YoutubeDL", FakeYoutubeDL),
                ):
                    response = self.client.post("/video_comments", data={"video_url": "video"})
                self.assertEqual(response.status_code, 502)
                self.assertNotIn("partial comment text", response.get_data(as_text=True))

    def test_existing_routes_and_methods_remain_registered(self):
        rules = {rule.rule: sorted((rule.methods or set()) - {"HEAD", "OPTIONS"}) for rule in backend.app.url_map.iter_rules()}
        self.assertEqual(rules["/health"], ["GET"])
        self.assertEqual(rules["/mark_video_watched"], ["POST"])
        self.assertEqual(rules["/mark_and_download"], ["POST"])
        self.assertEqual(rules["/video_comments"], ["GET", "POST"])


if __name__ == "__main__":
    unittest.main()
