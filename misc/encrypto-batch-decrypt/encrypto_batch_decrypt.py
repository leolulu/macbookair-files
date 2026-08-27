from __future__ import annotations

import argparse
import getpass
import json
import logging
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import psutil
from pywinauto import Desktop
from pywinauto.keyboard import send_keys


ENCRYPTO_EXE = Path(r"C:\Program Files\Encrypto\Encrypto.exe")
LOG_NAME = "encrypto-batch.log"
YGOCDB_SEARCH_URL = "https://ygocdb.com/api/v0/?search={}"


def configure_logging(log_path: Path) -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[
            logging.FileHandler(log_path, encoding="utf-8"),
            logging.StreamHandler(sys.stdout),
        ],
        force=True,
    )


def crypto_files(source: Path) -> list[Path]:
    if source.is_file():
        if source.suffix.lower() != ".crypto":
            raise ValueError(f"Input is not a .crypto file: {source}")
        return [source]
    if not source.is_dir():
        raise FileNotFoundError(source)
    return sorted(p for p in source.rglob("*") if p.is_file() and p.suffix.lower() == ".crypto")


def output_path(source_root: Path, encrypted: Path, output_root: Path) -> Path:
    relative = encrypted.name if source_root.is_file() else encrypted.relative_to(source_root)
    relative = Path(relative)
    plain_name = relative.name[: -len(".crypto")]
    return output_root / relative.parent / plain_name


def launch_file(exe: Path, encrypted: Path) -> subprocess.Popen[bytes]:
    return subprocess.Popen([str(exe), str(encrypted)])


def find_encrypto_window(timeout: float = 30.0):
    deadline = time.monotonic() + timeout
    desktop = Desktop(backend="uia")
    last_titles: list[str] = []
    while time.monotonic() < deadline:
        windows = desktop.windows(visible_only=True, enabled_only=False)
        last_titles = []
        for window in windows:
            try:
                title = window.window_text()
                last_titles.append(title)
                pid = window.element_info.process_id
                process_path = Path(window.element_info.process_id and _process_path(pid) or "")
                if process_path.name.lower() == "encrypto.exe":
                    return window
            except Exception:
                continue
        time.sleep(0.25)
    raise TimeoutError(f"Encrypto window did not appear. Visible titles: {last_titles}")


def _process_path(pid: int) -> str:
    try:
        return psutil.Process(pid).exe()
    except Exception:
        return ""


def print_inspection(window) -> None:
    print(f"WINDOW title={window.window_text()!r} pid={window.element_info.process_id}")
    print("FLAT UIA ELEMENT LIST")
    for index, control in enumerate(window.descendants()):
        info = control.element_info
        try:
            text = control.window_text()
        except Exception:
            text = ""
        print(
            f"[{index:03d}] type={info.control_type!r} name={text!r} "
            f"automation_id={info.automation_id!r} class={info.class_name!r} "
            f"enabled={control.is_enabled()} visible={control.is_visible()} rect={control.rectangle()}"
        )


def descendants(window, control_type: str | None = None):
    controls = window.descendants(control_type=control_type) if control_type else window.descendants()
    return [control for control in controls if control.is_visible()]


def by_automation_id(window, automation_id: str, *, visible_only: bool = True):
    for control in window.descendants():
        if control.element_info.automation_id != automation_id:
            continue
        if visible_only and not control.is_visible():
            continue
        return control
    return None


def wait_automation_id(window, automation_id: str, timeout: float, *, enabled: bool = True):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        control = by_automation_id(window, automation_id)
        if control is not None and (not enabled or control.is_enabled()):
            return control
        time.sleep(0.25)
    return None


def wait_for_decrypt_screen(window, encrypted: Path, timeout: float = 30.0) -> None:
    expected_name = encrypted.name[: -len(".crypto")]
    deadline = time.monotonic() + timeout
    observed_name = ""
    while time.monotonic() < deadline:
        name_control = by_automation_id(window, "FilesAndFoldersTextBlock")
        hint = by_automation_id(window, "HintTextBlockDecypt")
        password = by_automation_id(window, "PassTextBoxDecrypt")
        decrypt = by_automation_id(window, "CryptButton")
        if name_control is not None:
            observed_name = name_control.window_text().strip()
        if (
            observed_name == expected_name
            and hint is not None
            and hint.window_text().strip()
            and password is not None
            and decrypt is not None
        ):
            return
        time.sleep(0.25)
    raise TimeoutError(
        f"Encrypto did not finish loading decrypt screen for {encrypted.name!r}; "
        f"last visible file was {observed_name!r}"
    )


def first_matching(window, *, control_type: str | None = None, title_re: str | None = None):
    pattern = re.compile(title_re, re.IGNORECASE) if title_re else None
    for control in descendants(window, control_type):
        text = control.window_text().strip()
        if pattern is None or pattern.search(text):
            return control
    return None


def wait_matching(window, timeout: float, *, control_type: str | None = None, title_re: str | None = None):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        control = first_matching(window, control_type=control_type, title_re=title_re)
        if control is not None and control.is_enabled():
            return control
        time.sleep(0.25)
    return None


def click(control) -> None:
    try:
        control.invoke()
    except Exception:
        control.click_input()


def click_nonblocking(control) -> None:
    try:
        control.set_focus()
        send_keys("{ENTER}")
    except Exception:
        control.click_input()


def wait_save_dialog(window, timeout: float):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for control in window.descendants(control_type="Window"):
            info = control.element_info
            if control.is_visible() and info.class_name == "#32770":
                return Desktop(backend="uia").window(handle=control.handle).wrapper_object()
        time.sleep(0.05)
    return None


def close_encrypto(window, timeout: float = 10.0) -> None:
    pid = window.element_info.process_id
    try:
        window.close()
    except Exception as error:
        logging.warning("Graceful Encrypto window close failed: %s", error)

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not psutil.pid_exists(pid):
            logging.info("Closed Encrypto")
            return
        time.sleep(0.25)

    try:
        process = psutil.Process(pid)
        if process.name().lower() == "encrypto.exe":
            logging.warning("Encrypto did not close gracefully; terminating process %d", pid)
            process.terminate()
            process.wait(timeout=5)
            logging.info("Closed Encrypto")
    except psutil.NoSuchProcess:
        logging.info("Closed Encrypto")


def close_running_encrypto_windows() -> None:
    windows_by_pid = {}
    for candidate in Desktop(backend="uia").windows(visible_only=True, enabled_only=False):
        try:
            pid = candidate.element_info.process_id
            if Path(_process_path(pid)).name.lower() == "encrypto.exe":
                windows_by_pid.setdefault(pid, candidate)
        except Exception:
            continue
    for candidate in windows_by_pid.values():
        logging.info("Closing a pre-existing Encrypto window before opening the next file")
        close_encrypto(candidate)


def output_candidates(destination: Path, encrypted: Path | None = None) -> list[Path]:
    candidates = []
    encrypted_resolved = encrypted.resolve() if encrypted is not None else None
    for path in destination.parent.glob(f"{destination.name}*"):
        if path.name != destination.name and not path.name.startswith(f"{destination.name}."):
            continue
        if encrypted_resolved is not None and path.resolve() == encrypted_resolved:
            continue
        if path.suffix.lower() == ".crypto":
            continue
        candidates.append(path)
    return sorted(candidates)


def overwrite_confirmation(window):
    for dialog in window.descendants(control_type="Window"):
        if not dialog.is_visible() or dialog.element_info.class_name != "#32770":
            continue
        if re.search(r"(?i)(confirm save as|确认另存为)", dialog.window_text().strip()):
            return dialog
    return None


def enter_password(window, password: str) -> None:
    edit = by_automation_id(window, "PassTextBoxDecrypt")
    if edit is None:
        raise RuntimeError("No password edit control found")
    edit.set_focus()
    try:
        edit.set_edit_text(password)
    except Exception:
        send_keys("^a{BACKSPACE}")
        send_keys(password, with_spaces=True)


def hint_card_name(window) -> str:
    hint = by_automation_id(window, "HintTextBlockDecypt")
    if hint is None:
        raise RuntimeError("No visible Encrypto hint was found for ygocdb lookup")
    text = hint.window_text().strip()
    match = re.match(r"(?i)^hint\s*:\s*(.+?)\s*$", text)
    if not match:
        raise RuntimeError(f"Unrecognized Encrypto hint format: {text!r}")
    return match.group(1)


def ygocdb_password(card_name: str, timeout: float = 20.0) -> str:
    url = YGOCDB_SEARCH_URL.format(urllib.parse.quote(card_name))
    request = urllib.request.Request(url, headers={"User-Agent": "encrypto-batch-decrypt/1.0"})
    last_error = None
    max_attempts = 6
    for attempt in range(1, max_attempts + 1):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = json.load(response)
            break
        except Exception as error:
            last_error = error
            if attempt == max_attempts:
                raise RuntimeError(f"ygocdb request failed after {attempt} attempts: {error}") from error
            logging.warning("ygocdb request attempt %d failed; retrying: %s", attempt, error)
            time.sleep(min(attempt, 5))
    else:
        raise RuntimeError(f"ygocdb request failed: {last_error}")
    results = payload.get("result") or []
    name_fields = ("cn_name", "sc_name", "md_name", "nwbbs_n", "cnocg_n", "jp_name", "en_name")
    exact = [item for item in results if any(str(item.get(field, "")).strip() == card_name for field in name_fields)]
    if len(exact) != 1:
        raise RuntimeError(
            f"ygocdb exact match for {card_name!r} is ambiguous or missing "
            f"(exact={len(exact)}, total={len(results)})"
        )
    card_id = str(exact[0].get("id", "")).strip()
    if not re.fullmatch(r"\d{8}", card_id):
        raise RuntimeError(f"ygocdb returned an invalid card password for {card_name!r}")
    logging.info("Resolved card password from ygocdb for hint %r", card_name)
    return card_id


def decrypt_one(
    window,
    password: str,
    encrypted: Path,
    destination: Path,
    timeout: float,
    overwrite: bool,
) -> Path:
    enter_password(window, password)
    decrypt = wait_automation_id(window, "CryptButton", 5)
    if decrypt is None:
        raise RuntimeError("Decrypt button not found")
    click(decrypt)

    save_as = wait_automation_id(window, "SaveButton", timeout)
    if save_as is None:
        raise RuntimeError("Save As button did not appear (wrong password or decryption failed)")
    save_as_clicked_at = time.monotonic()
    save_dialog_deadline = time.monotonic() + min(timeout, 60.0)
    dialog = None
    trigger_attempt = 0
    while dialog is None and time.monotonic() < save_dialog_deadline:
        trigger_attempt += 1
        current_save_as = wait_automation_id(window, "SaveButton", 2)
        if current_save_as is None:
            break
        click_nonblocking(current_save_as)
        remaining = save_dialog_deadline - time.monotonic()
        dialog = wait_save_dialog(window, min(10.0, max(remaining, 0.0)))
        if dialog is None and time.monotonic() < save_dialog_deadline:
            logging.warning("Save As dialog did not open; retrying trigger (attempt %d)", trigger_attempt)
    if dialog is None:
        raise RuntimeError("Windows Save As dialog did not appear")
    logging.info(
        "Save As dialog became ready in %.2f seconds after %d trigger attempt(s)",
        time.monotonic() - save_as_clicked_at,
        trigger_attempt,
    )
    destination.parent.mkdir(parents=True, exist_ok=True)
    edits = [
        c
        for c in dialog.descendants(control_type="Edit")
        if c.is_visible()
        and c.is_enabled()
        and c.element_info.class_name == "Edit"
        and c.element_info.automation_id == "1001"
    ]
    if not edits:
        raise RuntimeError("No filename field found in Save dialog")
    filename = edits[-1]
    try:
        default_name = str(filename.get_value()).strip()
    except Exception:
        default_name = ""
    default_name = Path(default_name).name
    if not default_name or default_name in {".", ".."}:
        raise RuntimeError(
            "Save As dialog did not expose a default filename; refusing to guess the output name"
        )
    destination = destination.parent / default_name
    logging.info("Preserving Encrypto default output filename: %s", default_name)
    existing_outputs = output_candidates(destination, encrypted)
    if existing_outputs and not overwrite:
        cancel = next(
            (
                c
                for c in dialog.descendants(control_type="Button")
                if c.is_visible() and c.is_enabled() and c.element_info.automation_id == "2"
            ),
            None,
        )
        if cancel is not None:
            click(cancel)
        raise FileExistsError(17, "Output exists", str(existing_outputs[0]))

    def active_address_field():
        addresses = [
            control
            for control in dialog.descendants(control_type="Edit")
            if control.is_visible()
            and control.is_enabled()
            and control.element_info.class_name == "Edit"
            and control.element_info.automation_id == "41477"
        ]
        return addresses[-1] if addresses else None

    filename.type_keys("%d", set_foreground=True)
    address_deadline = time.monotonic() + 5.0
    address = None
    while address is None and time.monotonic() < address_deadline:
        address = active_address_field()
        if address is None:
            time.sleep(0.05)
    if address is None:
        raise RuntimeError("Save dialog address field did not activate")

    address.set_edit_text(str(destination.parent))
    address.type_keys("{ENTER}", set_foreground=True)
    time.sleep(0.25)

    current_edits = [
        control
        for control in dialog.descendants(control_type="Edit")
        if control.is_visible()
        and control.is_enabled()
        and control.element_info.class_name == "Edit"
        and control.element_info.automation_id == "1001"
    ]
    if not current_edits:
        raise RuntimeError("Filename field did not return after changing the output directory")
    filename = current_edits[-1]
    filename.type_keys("%d", set_foreground=True)
    verify_deadline = time.monotonic() + 5.0
    address = None
    while address is None and time.monotonic() < verify_deadline:
        address = active_address_field()
        if address is None:
            time.sleep(0.05)
    if address is None:
        raise RuntimeError("Save dialog address field did not reactivate for verification")
    current_directory = str(address.get_value()).strip()
    expected = os.path.normcase(os.path.normpath(str(destination.parent)))
    actual = os.path.normcase(os.path.normpath(current_directory))
    if actual != expected:
        raise RuntimeError(
            f"Save dialog directory verification failed: expected {destination.parent}, got {current_directory}"
        )
    logging.info("Save dialog output directory: %s", destination.parent)

    address.type_keys("{ESC}", set_foreground=True)
    current_edits = [
        control
        for control in dialog.descendants(control_type="Edit")
        if control.is_visible()
        and control.is_enabled()
        and control.element_info.class_name == "Edit"
        and control.element_info.automation_id == "1001"
    ]
    if not current_edits:
        raise RuntimeError("Filename field disappeared after changing the output directory")
    filename = current_edits[-1]
    filename.set_edit_text(default_name)

    save = next(
        (
            c
            for c in dialog.descendants(control_type="Button")
            if c.is_visible() and c.is_enabled() and c.element_info.automation_id == "1"
        ),
        None,
    )
    if save is None:
        raise RuntimeError("Save/OK button not found in Save dialog")
    save_submitted_at = time.monotonic()
    filename.type_keys("{ENTER}", set_foreground=True)

    submission_deadline = time.monotonic() + 5.0
    while time.monotonic() < submission_deadline:
        save_dialog_visible = any(
            control.is_visible() and control.element_info.class_name == "#32770"
            for control in window.descendants(control_type="Window")
            if not re.search(r"(?i)(confirm save as|确认另存为)", control.window_text().strip())
        )
        if not save_dialog_visible or overwrite_confirmation(window) is not None:
            break
        time.sleep(0.05)
    else:
        raise RuntimeError("Save dialog did not accept the Save command")
    logging.info("Save dialog accepted the Save command")

    overwrite_decided = not (overwrite and existing_outputs)
    process_id = window.element_info.process_id
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        confirmation = overwrite_confirmation(window)
        if confirmation is not None:
            button_pattern = r"^(yes|是)" if overwrite else r"^(no|否)"
            decision = first_matching(confirmation, control_type="Button", title_re=button_pattern)
            if decision is None:
                raise RuntimeError("Overwrite confirmation appeared but its decision button was not found")
            click_nonblocking(decision)
            if not overwrite:
                time.sleep(0.5)
                cancel = next(
                    (
                        c
                        for c in dialog.descendants(control_type="Button")
                        if c.is_visible() and c.is_enabled() and c.element_info.automation_id == "2"
                    ),
                    None,
                )
                if cancel is not None:
                    click(cancel)
                raise RuntimeError(f"Refusing to overwrite encrypted source or existing output: {encrypted}")
            overwrite_decided = True
            time.sleep(0.5)
            continue

        candidates = output_candidates(destination, encrypted)
        valid_candidates = [
            candidate
            for candidate in candidates
            if candidate.exists() and (candidate.is_dir() or candidate.stat().st_size > 0)
        ]
        if not psutil.pid_exists(process_id):
            raise RuntimeError("Encrypto exited before showing the saved-completion screen")

        completed = by_automation_id(window, "OpenFolderButton")
        if overwrite_decided and completed is not None and valid_candidates:
            logging.info("Encrypto reported save completion in %.2f seconds", time.monotonic() - save_submitted_at)
            return valid_candidates[0]
        time.sleep(0.1)
    raise TimeoutError(f"Output was not created within {timeout}s: {destination}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Batch-decrypt Encrypto .crypto files through Windows UI Automation")
    parser.add_argument("source", type=Path, help="A .crypto file or a directory containing .crypto files")
    parser.add_argument(
        "output",
        type=Path,
        nargs="?",
        help="Output directory; defaults to the source file's directory (in-place, while preserving .crypto files)",
    )
    parser.add_argument("--inspect", action="store_true", help="Open the first file and print the real UIA control tree")
    parser.add_argument("--overwrite", action="store_true", help="Overwrite an existing output file")
    parser.add_argument("--keep-open", action="store_true", help="Leave Encrypto open after the batch finishes")
    parser.add_argument(
        "--password-source",
        choices=("prompt", "ygocdb"),
        default="ygocdb",
        help="Resolve each file's hint card name through ygocdb (default), or read one password from the terminal",
    )
    parser.add_argument("--encrypto", type=Path, default=ENCRYPTO_EXE, help="Path to Encrypto.exe")
    parser.add_argument(
        "--timeout",
        type=float,
        default=1800.0,
        help="Decrypt/save timeout per step in seconds (default: 1800)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source = args.source.resolve()
    files = crypto_files(source)
    if not files:
        print(f"No .crypto files found under {source}", file=sys.stderr)
        return 2
    if not args.encrypto.is_file():
        print(f"Encrypto executable not found: {args.encrypto}", file=sys.stderr)
        return 2

    log_root = source.parent if source.is_file() else source
    configure_logging(log_root / LOG_NAME)
    logging.info("Found %d encrypted file(s)", len(files))

    window = None
    try:
        if args.inspect:
            close_running_encrypto_windows()
            launch_file(args.encrypto, files[0])
            window = find_encrypto_window()
            wait_for_decrypt_screen(window, files[0])
            window.set_focus()
            print_inspection(window)
            return 0

        output_root = args.output.resolve() if args.output is not None else (source.parent if source.is_file() else source)
        output_root.mkdir(parents=True, exist_ok=True)
        shared_password = None
        if args.password_source == "prompt":
            shared_password = os.environ.get("ENCRYPTO_PASSWORD") or getpass.getpass("Password: ")
            if not shared_password:
                print("Password cannot be empty", file=sys.stderr)
                return 2

        failures = 0
        for index, encrypted in enumerate(files, 1):
            destination = output_path(source, encrypted, output_root)
            logging.info(
                "[%d/%d] Decrypting %s -> directory %s",
                index,
                len(files),
                encrypted,
                destination.parent,
            )
            try:
                close_running_encrypto_windows()
                launch_file(args.encrypto, encrypted)
                window = find_encrypto_window()
                wait_for_decrypt_screen(window, encrypted)
                window.set_focus()
                password = shared_password
                if args.password_source == "ygocdb":
                    password = ygocdb_password(hint_card_name(window))
                assert password is not None
                actual_destination = decrypt_one(
                    window,
                    password,
                    encrypted,
                    destination,
                    args.timeout,
                    args.overwrite,
                )
                logging.info("[%d/%d] OK %s", index, len(files), actual_destination)
            except FileExistsError as error:
                logging.info("[%d/%d] SKIP exists: %s", index, len(files), error.filename or error)
            except Exception:
                failures += 1
                logging.exception("[%d/%d] FAILED %s", index, len(files), encrypted)
            finally:
                if window is not None and (not args.keep_open or index < len(files)):
                    close_encrypto(window)
                    window = None
        return 1 if failures else 0
    finally:
        if window is not None and not args.keep_open:
            close_encrypto(window)


if __name__ == "__main__":
    raise SystemExit(main())
