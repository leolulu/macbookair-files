import argparse
import math
import multiprocessing
import os
import re
import shutil
import subprocess
import threading
import time
import traceback
import uuid
import warnings
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from pathlib import Path
from types import SimpleNamespace
from typing import Dict, Optional, Tuple, Union, cast

import cv2
import matplotlib.pyplot as plt
import numpy as np
import requests
from matplotlib.widgets import Button, CheckButtons, RangeSlider, RectangleSelector, Slider
from retrying import retry
from tqdm import TqdmWarning, tqdm


class GlobalScopeObjects:
    download_folder_alias = "dl"
    global_tqdm_update_lock = threading.Lock()
    subprocess_popen_for_ffmpeg = partial(
        subprocess.Popen,
        shell=True,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        encoding="utf-8",
        errors="replace",
    )
    bar_format_prevent_precision_error = "{l_bar}{bar}| {n:.1f}/{total:.1f} [{elapsed}<{remaining},  {rate_fmt}{postfix}]"


class TqdmWarningManager:
    Lock = threading.Lock()
    Counter = 0

    @classmethod
    def impose_ignore(cls):
        with cls.Lock:
            if cls.Counter == 0:
                warnings.filterwarnings("ignore", category=TqdmWarning, module="tqdm")
            cls.Counter += 1

    @classmethod
    def lift_ignore(cls):
        with cls.Lock:
            cls.Counter -= 1
            if cls.Counter == 0:
                warnings.filterwarnings("default", category=TqdmWarning, module="tqdm")


class VideoCoordPicker:
    def __init__(self, video_path):
        plt.rcParams["font.sans-serif"] = ["SimHei"]  # 指定中文字体
        plt.rcParams["axes.unicode_minus"] = False  # 解决负号 '-' 显示为方块的问题

        # 打开视频文件
        self.cap = cv2.VideoCapture(video_path)
        if not self.cap.isOpened():
            raise IOError("无法打开视频文件")

        # 获取视频属性
        self.total_frames = int(self.cap.get(cv2.CAP_PROP_FRAME_COUNT))
        self.fps = self.cap.get(cv2.CAP_PROP_FPS)

        # 初始化播放器状态
        self.current_frame = 0
        self.selected_rect = None  # 存储选中的矩形

        # 设置 Matplotlib 图形和子图
        self.fig, axes = plt.subplot_mosaic(
            "AA;DB;CB",
            height_ratios=[10, 0.5, 1],
            width_ratios=[1, 9],
            figsize=(12, 9),
            layout="constrained",
        )
        self.ax_video = axes["A"]
        self.ax_slider = axes["B"]
        self.ax_button = axes["C"]
        self.ax_checkbox = axes["D"]

        # 初始化视频显示
        ret, frame = self.cap.read()
        if not ret:
            raise ValueError("无法读取视频的第一帧")
        self.video_height, self.video_width, _ = frame.shape
        self.frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        self.im = self.ax_video.imshow(self.frame)
        self.ax_video.axis("off")  # 隐藏坐标轴

        # 添加滑动条
        self._add_slider()

        # 添加按钮
        self.button = Button(self.ax_button, "确认")
        self.button.on_clicked(self._on_button_click)

        # 添加checkbox
        self.checkbox = CheckButtons(ax=self.ax_checkbox, labels=["截取时长"], label_props={"fontsize": [12]})
        self.checkbox.on_clicked(self._on_checkbox_click)

        # 初始化 RectangleSelector 使用左键
        self.RS = RectangleSelector(
            self.ax_video,
            self._on_select,
            useblit=True,
            button=[1],  # 仅响应左键 # type: ignore
            minspanx=5,
            minspany=5,
            spancoords="pixels",
            drag_from_anywhere=True,
            interactive=True,
        )

    def _on_checkbox_click(self, label):
        if self.checkbox.get_status()[0]:
            self._add_rangeslider()
        else:
            self._add_slider()
        self.fig.canvas.draw_idle()

    def _add_slider(self):
        self.slider = Slider(
            ax=self.ax_slider,
            label="进度条",
            valmin=0,
            valmax=self.total_frames - 1,
            valinit=self.slider_val if hasattr(self, "slider_val") else 0,
            valfmt="%d",
            initcolor="none",
            handle_style={"size": 0},
        )
        self.slider_val = self.slider.val
        self.slider.valtext.set_visible(False)
        self.slider.on_changed(self._on_slider_change)

    def _add_rangeslider(self):
        self.slider = RangeSlider(
            ax=self.ax_slider,
            label="进度条",
            valmin=0,
            valmax=self.total_frames - 1,
            valinit=(self.slider_val - (half_range := min(int(self.total_frames / 4), 60 * self.fps)), self.slider_val + half_range),
            valfmt="%d",
            handle_style={"size": 0},
        )
        self.slider_val_min, self.slider_val_max = self.slider.val
        self.slider.on_changed(self._get_rangeslider_changed_value)
        self.slider.valtext.set_visible(False)

    def _get_rangeslider_changed_value(self, val):
        (val_min, val_max) = val
        if val_min != self.slider_val_min:
            changed_value = val_min
        elif val_max != self.slider_val_max:
            changed_value = val_max
        self.slider_val_min, self.slider_val_max = cast(Tuple[float, float], self.slider.val)
        try:
            self._on_slider_change(changed_value)
        except:
            pass

    def _on_slider_change(self, val):
        """当滑动条被拖动时，跳转到相应的帧"""
        self.slider_val = val
        self.current_frame = int(val)
        self.cap.set(cv2.CAP_PROP_POS_FRAMES, self.current_frame)
        ret, frame = self.cap.read()
        if ret:
            self.frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            self.im.set_data(self.frame)
            self.fig.canvas.draw_idle()

    def snap_coords(self, selected_rect: Tuple[int, int, int, int]):
        ratio = 0.02
        threshold_x = self.video_width * ratio
        threshold_y = self.video_height * ratio
        (x, y, w, h) = selected_rect
        if x < threshold_x:
            w += x
            x = 0
        if y < threshold_y:
            h += y
            y = 0
        if x + w > self.video_width - threshold_x:
            w = self.video_width - x
        if y + h > self.video_height - threshold_y:
            h = self.video_height - y
        self.RS.extents = (x, x + w, y, y + h)
        return (x, y, w, h)

    def _on_select(self, eclick, erelease):
        """回调函数，当矩形选择完成时调用"""
        x1, y1 = int(eclick.xdata), int(eclick.ydata)
        x2, y2 = int(erelease.xdata), int(erelease.ydata)
        self.selected_rect = (min(x1, x2), min(y1, y2), abs(x2 - x1), abs(y2 - y1))
        self.selected_rect = self.snap_coords(self.selected_rect)
        print(f"选中的矩形坐标: {self.selected_rect}")

    def _on_button_click(self, event):
        """当点击按钮时，返回坐标并关闭窗口"""
        if self.selected_rect:
            print(f"最终选中的矩形坐标: {self.selected_rect}")  # (x, y, width, height)
            plt.close(self.fig)
        elif self.checkbox.get_status()[0]:
            print(f"没有框选矩形，但是启用了RangeSlider，走trim流程...")
            plt.close(self.fig)
        else:
            print("既未选择矩形，也未选择时长范围。请设置至少一个！")

    def pick_coord_and_optionally_trim(self):
        self.show()
        if self.selected_rect:
            coord = SimpleNamespace(
                x=self.selected_rect[0],
                y=self.selected_rect[1],
                w=self.selected_rect[2],
                h=self.selected_rect[3],
            )
        else:
            coord = None
        if self.checkbox.get_status()[0]:
            trim_range = SimpleNamespace(
                start=self.slider_val_min / self.fps,
                end=self.slider_val_max / self.fps,
            )
        else:
            trim_range = None
        return coord, trim_range

    def show(self):
        plt.show()
        self.cap.release()


class ConcatPrioritizer:
    def __init__(self) -> None:
        self.condition = threading.Condition()
        self.running_count = 0
        self.concat_lock = threading.Lock()

    def begin_concat(self):
        with self.condition:
            self.running_count += 1
        self.concat_lock.acquire()

    def end_concat(self):
        with self.condition:
            self.running_count -= 1
            if self.running_count == 0:
                self.condition.notify_all()
        self.concat_lock.release()

    def block_if_concatting(self):
        with self.condition:
            if self.running_count > 0:
                self.condition.wait()

    def __enter__(self):
        self.begin_concat()

    def __exit__(self, exc_type, exc_value, traceback):
        self.end_concat()


concat_prioritizer = ConcatPrioritizer()

global_encode_task_executor_pool = None


def check_video_corrupted(video_file_path):
    command = f'ffprobe "{video_file_path}"'
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
    is_corrupted, width, height = True, None, None
    for line_content in result.stderr.split("\n"):
        if "Stream" in line_content and "Video" in line_content:
            width, height = re.findall(r", (\d+)x(\d+)[ ,]", line_content)[0]
            is_corrupted = False
    return is_corrupted, width, height


def move_with_optional_security(source, target, backup_target=None, msg=""):
    if target.startswith(r"\\"):
        time.sleep(2)
    try:
        shutil.move(source, target)
    except:
        if backup_target:
            shutil.move(source, target)
    if msg:
        print(msg)


def get_font_location(frame, content: str, fontFace: int, font_scale: float, thickness: int) -> Tuple[int, int]:
    (text_width, text_height), _ = cv2.getTextSize(content, fontFace, font_scale, thickness)
    start_x = min(0, frame.shape[1] - text_width)
    start_y = max(0, text_height + 10)
    return (start_x, start_y)


def gen_pic_thumbnail(video_path, frame_interval, rows, cols, height, width, start_offset=0, alternative_output_folder_path=None):
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise UserWarning("无法打开视频文件!")
    thumbnails = []
    for i in tqdm(range(rows * cols), desc="缩略图", unit=" pic", dynamic_ncols=True):
        # 定位到指定帧
        cap.set(cv2.CAP_PROP_POS_FRAMES, i * frame_interval)
        ret, frame = cap.read()
        milliseconds = cap.get(cv2.CAP_PROP_POS_MSEC)
        if ret:
            # 计算时间戳
            seconds_total = milliseconds / 1000 + start_offset
            hours = int(seconds_total // 3600)
            seconds_total %= 3600
            minutes = int(seconds_total // 60)
            seconds = int(seconds_total % 60)
            timestamp = "{:02d}:{:02d}:{:02d}".format(hours, minutes, seconds)
            # 在图像的右上角添加时间戳（包括轮廓）
            font_face = cv2.FONT_HERSHEY_SIMPLEX
            font_scale = frame.shape[0] / 1080 * 4
            inner_white = (font_scale, 12)
            outer_black = (font_scale, 6)
            cv2.putText(
                frame,
                timestamp,
                get_font_location(frame, timestamp, font_face, *inner_white),
                font_face,
                inner_white[0],
                (0, 0, 0),
                inner_white[1],
            )
            cv2.putText(
                frame,
                timestamp,
                get_font_location(frame, timestamp, font_face, *outer_black),
                font_face,
                outer_black[0],
                (255, 255, 255),
                outer_black[1],
            )
            thumbnails.append(frame)
        else:
            thumbnails.append(np.zeros((height, width, 3), dtype=np.uint8))
    cap.release()

    # 计算缩略图的大小
    thumbnail_width = width * cols
    thumbnail_height = height * rows

    # 创建一个空白的背景图像
    thumbnail = np.zeros((thumbnail_height, thumbnail_width, 3), dtype=np.uint8)

    # 将每个缩略图放置到背景图像上
    for i in range(rows):
        for j in range(cols):
            thumbnail[i * height : (i + 1) * height, j * width : (j + 1) * width, :] = thumbnails[i * cols + j]

    # 保存缩略图
    output_path_img = os.path.splitext(video_path)[0] + ".jpg"
    temp_output_path_img = os.path.join(str(Path.home() / "Downloads"), f"WIP_{uuid.uuid4().hex}.jpg")
    # print(f"缩略图保存路径为：{output_path_img}")
    if os.path.exists(output_path_img):
        os.remove(output_path_img)
    cv2.imwrite(temp_output_path_img, thumbnail)

    threading.Thread(
        target=move_with_optional_security,
        args=(
            temp_output_path_img,
            (
                os.path.join(alternative_output_folder_path, os.path.basename(output_path_img))
                if alternative_output_folder_path
                else output_path_img
            ),
            os.path.join(os.path.dirname(temp_output_path_img), os.path.basename(output_path_img)),
            "",  # "图片缩略图移动到目标目录完毕...",
        ),
    ).start()


def log_ffmpeg_convert_error(
    proc: Union[subprocess.CompletedProcess, subprocess.Popen],
    video_path: str,
    additional_info: Optional[Dict[str, str]] = None,
):
    def _write_error_log(error_content: str):
        error_log_path = os.path.splitext(video_path)[0] + ".err.log"
        with open(error_log_path, "a", encoding="utf-8") as f:
            f.write(f"{error_content}\n\n")
            if additional_info:
                for key, value in additional_info.items():
                    f.write(f"{key}:\n{value}\n\n")

    if isinstance(proc, subprocess.CompletedProcess):
        try:
            proc.check_returncode()
        except subprocess.CalledProcessError as e:
            _write_error_log(e.stderr)
    elif isinstance(proc, subprocess.Popen):
        if (proc.returncode != 0) and proc.stderr:
            _write_error_log(proc.stderr.read())


def run_ffmpeg_command_with_shell_and_tqdm(
    command, tqdm_desc=None, total: Optional[Union[int, float]] = None, unit=" second", end_desc=None
):
    proc = GlobalScopeObjects.subprocess_popen_for_ffmpeg(command)
    if proc.stderr:
        pbar = tqdm(desc=tqdm_desc, unit=unit, total=total, dynamic_ncols=True)
        for line in proc.stderr:
            if (not total) and ("Duration" in line):
                if result := re.findall(r"Duration: (\d+):(\d+):(\d+)\.(\d+)", line):
                    if (d := duration_result_to_second(result[0], 1)) > (0 if pbar.total is None else pbar.total):
                        pbar.total = d
            if "speed" in line:
                if result := re.findall(r"time=(\d+):(\d+):(\d+)\.(\d+)", line):
                    n = duration_result_to_second(result[0], 1)
                    if n > pbar.total:
                        pbar.total = n
                    pbar.n = n
                    pbar.refresh()
        if end_desc:
            pbar.set_description_str(end_desc)
        pbar.close()
    proc.wait()
    log_ffmpeg_convert_error(proc, video_path, {"指令": command, "环节": str(tqdm_desc)})


def gen_video_thumbnail(
    video_path,
    preset,
    height,
    fps,
    duration_in_seconds,
    frame_interval,
    rows,
    cols,
    max_thumb_duration,
    start_offset=0,
    low_load_mode: Optional[int] = None,
    alternative_output_folder_path=None,
):
    video_name = os.path.splitext(os.path.basename(video_path))[0]
    output_path_video = os.path.splitext(video_path)[0] + ".tbnl"
    temp_output_path_video = os.path.join(str(Path.home() / "Downloads"), f"WIP_{uuid.uuid4().hex}.mp4")
    # 生成视频缩略图
    # 生成中间文件落盘
    key_timestamp = [i * frame_interval / fps for i in range(rows * cols)]
    thumbnail_duration = min(max_thumb_duration, math.ceil(duration_in_seconds / (rows * cols)))
    max_output_height = 2160
    input_template = ' -ss {start_time} -t {duration} -i "{input_file_path}" '
    footage_paths = []
    gen_footage_commands = []
    intermediate_file_paths = []
    for i in key_timestamp:
        gen_footage_command = "ffmpeg " + input_template.format(start_time=i, duration=thumbnail_duration, input_file_path=video_path)
        filter_commands = []
        if height > max_output_height / rows:
            target_height = int(max_output_height / rows)
            target_height = target_height if target_height % 2 == 0 else target_height - 1
            filter_commands.append(f"scale=w=-2:h={target_height}")
        else:
            target_height = height if height % 2 == 0 else height - 1
            filter_commands.append(f"scale=w=-2:h={target_height}")
        filter_drawtext_command = r"drawtext=text='%{pts\:gmtime\:drawtext_pts_offset\:%H\\\:%M\\\:%S}':x=10:y=10:fontsize=h/10:fontcolor=white:bordercolor=black:borderw=2"
        filter_drawtext_command = filter_drawtext_command.replace("drawtext_pts_offset", str(int(i) + start_offset))
        filter_commands.append(filter_drawtext_command)
        gen_footage_command += f" -vf {','.join(filter_commands)} "
        output_file_path = os.path.join(
            str(Path.home() / "Videos"),
            f"{video_name[:2]}-{video_name[-2:]}-{round(i,3)}-{str(time.time())[-3:]}.mp4",
        )
        footage_paths.append(output_file_path)
        gen_footage_command += f" -preset {preset} -y "
        gen_footage_command += f'"{output_file_path}"'
        intermediate_file_paths.append(output_file_path)
        gen_footage_commands.append(gen_footage_command)

    TqdmWarningManager.impose_ignore()
    pbar = tqdm(
        total=round(thumbnail_duration * len(gen_footage_commands)),
        desc="中间文件",
        unit=" second",
        dynamic_ncols=True,
        bar_format=GlobalScopeObjects.bar_format_prevent_precision_error,
    )

    def run_with_blocking(command):
        concat_prioritizer.block_if_concatting()
        proc = GlobalScopeObjects.subprocess_popen_for_ffmpeg(command)
        individual_current_processed_second = 0
        if proc.stderr:
            for line in proc.stderr:
                if "speed" in line:
                    if result := re.findall(r"time=(\d+):(\d+):(\d+)\.(\d+)", line):
                        new_processed_seconds = duration_result_to_second(result[0])
                        increment = new_processed_seconds - individual_current_processed_second
                        with GlobalScopeObjects.global_tqdm_update_lock:
                            if increment + pbar.n > pbar.total:
                                pbar.total = increment + pbar.n
                            pbar.update(increment)
                        individual_current_processed_second = new_processed_seconds
        proc.wait()
        log_ffmpeg_convert_error(proc, video_path, {"command": command, "环节": str("中间文件")})

    if global_encode_task_executor_pool:
        list(global_encode_task_executor_pool.map(run_with_blocking, gen_footage_commands))
    else:
        with ThreadPoolExecutor(low_load_mode if low_load_mode else os.cpu_count()) as exe:
            exe.map(run_with_blocking, gen_footage_commands)

    pbar.close()
    TqdmWarningManager.lift_ignore()

    # 检查中间文件是否损坏
    # print("开始检查中间文件是否损坏...")
    corrupted_file_paths = []
    intermediate_file_dimension: Tuple[int, int] = None  # type: ignore
    for intermediate_file_path in tqdm(intermediate_file_paths, desc="校验", dynamic_ncols=True):
        is_corrupted, intermediate_file_width, intermediate_file_height = check_video_corrupted(intermediate_file_path)
        if is_corrupted:
            corrupted_file_paths.append(intermediate_file_path)
        else:
            if intermediate_file_dimension is None:
                intermediate_file_dimension = (intermediate_file_width, intermediate_file_height)  # type: ignore
    # 修复受损的中间文件
    if corrupted_file_paths:
        print(f"开始修复以下受损文件:")
        print("\n".join(corrupted_file_paths))
        for corrupted_file_path in corrupted_file_paths:
            fix_command = 'ffmpeg -f lavfi -i color=c=gray:s={}x{}:d=1 -r {} -c:v libx264 -y "{}"'.format(
                intermediate_file_dimension[0], intermediate_file_dimension[1], fps, corrupted_file_path
            )
            print(f"修复指令：{fix_command}")
            run_ffmpeg_command_with_shell_and_tqdm(fix_command, "修复")

    # 合并中间文件
    command = "ffmpeg "
    for footage_path in footage_paths:
        command += f' -i "{footage_path}" '
    # 生成filter_complex指令
    filter_complex_template = ' -filter_complex "{filter_complex_section}" '
    h_commands = []
    row_ids = []
    for r_num in range(rows):
        h_command = "".join([f"[{r_num*cols+i}:v]" for i in range(cols)])
        h_command += f"hstack=inputs={cols}[row{r_num}]"
        row_ids.append(f"[row{r_num}]")
        h_commands.append(h_command)
    h_commands = ";".join(h_commands)
    v_commands = "".join([i for i in row_ids])
    if len(row_ids) > 1:
        v_commands += f"vstack=inputs={rows}[out_final]"
    else:
        v_commands += f"null[out_final]"
    filter_complex_command = filter_complex_template.format(filter_complex_section=";".join([h_commands, v_commands]))
    command += filter_complex_command
    # 其他指令部分
    command += f' -map "[out_final]" -preset {preset} -c:a copy -movflags +faststart -y '
    command += f' "{temp_output_path_video}"'
    # print(f"生成动态缩略图指令：{command}")
    with concat_prioritizer:
        run_ffmpeg_command_with_shell_and_tqdm(command, "合并", end_desc="视频缩略图生成完毕...")

    threading.Thread(
        target=move_with_optional_security,
        args=(
            temp_output_path_video,
            (
                os.path.join(alternative_output_folder_path, os.path.basename(output_path_video))
                if alternative_output_folder_path
                else output_path_video
            ),
            os.path.join(os.path.dirname(temp_output_path_video), os.path.basename(output_path_video)),
            "",  # 视频缩略图移动到目标目录完毕...",
        ),
    ).start()
    for f in footage_paths:
        os.remove(f)


def duration_result_to_second(findall_result, decimal_places: Optional[int] = None):
    hours, minutes, seconds, milliseconds = findall_result
    milliseconds = milliseconds.ljust(3, "0")
    result = int(hours) * 3600 + int(minutes) * 60 + int(seconds) + int(milliseconds) / 1000
    if decimal_places:
        result = round(result, decimal_places)
    return result


def get_max_screen_to_body_ratio_col(
    frame_height: int,
    frame_width: int,
    rows: int,
    cols_precise: Union[float, int],
    screen_ratio: float,
) -> int:
    base_cols = round(cols_precise)
    print(f"开始进行最大屏占比列数计算，基准列数: {base_cols}")
    candidate_cols = [base_cols - 2, base_cols - 1, base_cols, base_cols + 1, base_cols + 2]
    candidate_cols = [i for i in candidate_cols if i > 0]
    print(f"候选列数: {candidate_cols}")

    candidate_cols_ratio = [(frame_width * cols) / (frame_height * rows) for cols in candidate_cols]
    candidate_cols_screen_to_body_ratio = [
        (ratio / screen_ratio if ratio <= screen_ratio else screen_ratio / ratio) for ratio in candidate_cols_ratio
    ]

    result = list(zip(candidate_cols, candidate_cols_screen_to_body_ratio))
    print(f"计算结果: {[(i[0],str(round(i[1]*100,1))+'%') for i in result]}")
    max_result = max(result, key=lambda x: x[1])
    print("最大屏占比列数结果：" + f"列数【{max_result[0]}】，屏占比【{int(max_result[1] * 100)}%】")
    return max_result[0]


def gen_info(video_path, rows, cols, screen_ratio):
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise UserWarning(f"无法打开视频文件：{video_path}")

    height, width, _ = cap.read()[1].shape
    if cols is None:
        cols_precise = screen_ratio * height * rows / width
        print(f"原始列数计算结果：{cols_precise}")
        cols = get_max_screen_to_body_ratio_col(height, width, rows, cols_precise, screen_ratio)

    # 获取视频的总帧数和帧率
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    # 计算每个缩略图之间的帧间隔
    frame_interval = total_frames // (rows * cols)
    # 计算其他数据
    fps = cap.get(cv2.CAP_PROP_FPS)
    duration_in_seconds = total_frames / fps
    cap.release()
    return frame_interval, fps, height, width, duration_in_seconds, rows, cols


def generate_thumbnail(
    video_path,
    rows,
    cols=None,
    preset="ultrafast",
    process_full_video=False,
    low_load_mode: Optional[int] = None,
    max_thumb_duration=30,
    alternative_output_folder_path=None,
    screen_ratio_raw: str = "16/9",
    skip_completed_file=False,
    pic_thumbnail_only=False,
    video_thumbnail_only=False,
    delete_seg_file_in_full_mode=False,
):
    if skip_completed_file:
        self_result_file_exists = any(map(os.path.exists, [os.path.splitext(video_path)[0] + i for i in [".tbnl", ".jpg"]]))
        derivative_result_file_exists = any(
            [i.startswith(os.path.splitext(os.path.basename(video_path))[0] + "-seg") for i in os.listdir(os.path.dirname(video_path))]
        )
        if self_result_file_exists or derivative_result_file_exists:
            print(f"视频【{video_path}】已经存在结果文件，跳过...")
            return

    if "/" in screen_ratio_raw:
        screen_ratio = int(screen_ratio_raw.split("/")[0]) / int(screen_ratio_raw.split("/")[-1])
    else:
        screen_ratio = float(screen_ratio_raw)

    def process_video(video_path, rows_calced, cols_calced, start_offset=0):
        try:
            frame_interval, fps, height, width, duration_in_seconds, _, _ = gen_info(video_path, rows_calced, cols_calced, screen_ratio)
            if not video_thumbnail_only:
                gen_pic_thumbnail(
                    video_path, frame_interval, rows_calced, cols_calced, height, width, start_offset, alternative_output_folder_path
                )
            if not pic_thumbnail_only:
                gen_video_thumbnail(
                    video_path,
                    preset,
                    height,
                    fps,
                    duration_in_seconds,
                    frame_interval,
                    rows_calced,
                    cols_calced,
                    max_thumb_duration,
                    start_offset,
                    low_load_mode,
                    alternative_output_folder_path,
                )
        except:
            traceback.print_exc()

    _, _, _, _, duration_in_seconds, rows_calced, cols_calced = gen_info(video_path, rows, cols, screen_ratio)
    # print(f"开始生成缩略图，视频路径：{video_path}，行列数：{rows_calced}x{cols_calced}")
    if process_full_video and rows_calced * cols_calced * max_thumb_duration < duration_in_seconds:
        n = 1
        seg_start_time = 0
        while seg_start_time < duration_in_seconds:
            seg_end_time = min(seg_start_time + rows_calced * cols_calced * max_thumb_duration, duration_in_seconds)
            seg_file_path = f"-seg{str(n).zfill(2)}".join(os.path.splitext(video_path))
            command = f'ffmpeg -ss {seg_start_time} -to {seg_end_time} -accurate_seek -i "{video_path}" -c copy -map_chapters -1 -y -avoid_negative_ts 1 "{seg_file_path}"'
            run_ffmpeg_command_with_shell_and_tqdm(command, f"分段【{n}】", total=round(seg_end_time - seg_start_time))
            process_video(seg_file_path, rows_calced, cols_calced, start_offset=round(seg_start_time))
            if delete_seg_file_in_full_mode:
                os.remove(seg_file_path)
            seg_start_time = seg_end_time
            n += 1
    else:
        process_video(video_path, rows_calced, cols_calced)


def preprocessing_rotate_video(video_path: str, rotate_sign):
    if rotate_sign is None:
        return video_path
    print(f"开始预处理环节：旋转")

    if os.path.splitext(video_path.lower())[-1] != ".mp4":
        nise_mp4_path = os.path.splitext(video_path)[0] + "_nise.mp4"
        copy_to_mp4_command = f'ffmpeg -i "{video_path}" -y -c copy "{nise_mp4_path}"'
        print(f"视频格式不是mp4，尝试copy为mp4格式，指令：\n{copy_to_mp4_command}")
        result = subprocess.run(copy_to_mp4_command, shell=True, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if result.returncode != 0:
            print(f"尝试copy成mp4格式失败，错误日志：\n{result.stderr}\n将采用re-encoding的方式将视频转换为mp4格式...")
            re_encode_to_mp4_command = f'ffmpeg -i "{video_path}" -y "{nise_mp4_path}"'
            print(f"re-encoding指令：\n{re_encode_to_mp4_command}")
            subprocess.run(re_encode_to_mp4_command, shell=True, check=True)
        video_path = nise_mp4_path

    rotated_video_path = f"_rotated_{rotate_sign}".join([os.path.splitext(video_path)[0], ".mp4"])
    rotate_angle = {"l": "90", "r": "270"}[rotate_sign]
    command = f'ffmpeg -i "{video_path}" -metadata:s:v rotate="{rotate_angle}" -c copy -y "{rotated_video_path}"'
    # 存档：原本非mp4格式视频，直接使用transpose滤镜进行重编码。这次改成先转成mp4格式，然后统一应用metadata进行旋转
    #     transpose_angle = {"l": "2", "r": "1"}[rotate_sign]
    #     command = f'ffmpeg -i "{video_path}" -vf "transpose={transpose_angle}" -y "{rotated_video_path}"'
    # print(f"开始旋转视频，指令：\n{command}")
    run_ffmpeg_command_with_shell_and_tqdm(command, "旋转")
    return rotated_video_path


def pick_coord_and_optionally_trim_for_proc(video_path, queue):
    vcp = VideoCoordPicker(video_path)
    result = vcp.pick_coord_and_optionally_trim()
    queue.put(result)


def preprocessing_crop_trim_video(input_video_path: str, crop_sign):
    if crop_sign is None:
        return input_video_path
    output_video_path = input_video_path
    print(f"开始预处理环节：裁剪")
    with threading.Lock():
        queue = multiprocessing.Queue()
        proc = multiprocessing.Process(
            target=pick_coord_and_optionally_trim_for_proc,
            args=(input_video_path, queue),
        )
        proc.start()
        proc.join()
        if proc.exitcode != 0:
            raise UserWarning(f"pick_coord_and_optionally_trim通过子进程没有运行成功，裁剪失败！")
        coord, trim_range = queue.get()
    if (coord is None) and (trim_range is None):
        raise UserWarning("没有框选裁剪坐标或截取时间范围，取消处理...")
    crop_filter_segment = trim_command_segment = early_trim_command_segment = copy_command_segment = ""
    vf_command_segment = '-vf "{vf_content}"'
    if coord:
        x, y, w, h = coord.x, coord.y, coord.w, coord.h
        crop_filter_segment = f"crop={w}:{h}:{x}:{y}"
        output_video_path = os.path.splitext(output_video_path)[0] + "_cropped.mp4"
    if trim_range:
        trim_command_segment = f"-ss {trim_range.start} -to {trim_range.end}"
        output_video_path = os.path.splitext(output_video_path)[0] + "_trimmed.mp4"
    vf_content = [i for i in [crop_filter_segment] if i]
    if vf_content:
        vf_command_segment = vf_command_segment.format(vf_content=",".join(vf_content))
    else:
        vf_command_segment = ""
        copy_command_segment = "-c copy"
        if input_video_path.startswith(r"\\"):
            early_trim_command_segment = trim_command_segment
            trim_command_segment = ""
        output_video_path = os.path.splitext(output_video_path)[0] + "_copy" + os.path.splitext(input_video_path)[-1]

    command = f'ffmpeg {early_trim_command_segment} -i "{input_video_path}" {vf_command_segment} {trim_command_segment} {copy_command_segment} -y "{output_video_path}"'
    # print(f"开始裁剪和/或截取视频，指令：\n{command}")
    run_ffmpeg_command_with_shell_and_tqdm(command, "裁剪/截取", total=trim_range.end - trim_range.start if trim_range else None)
    return output_video_path


def preprocessing(video_path: str, kwargs):
    video_path = preprocessing_crop_trim_video(video_path, kwargs["crop_sign"])
    with threading.Lock():
        video_path = preprocessing_rotate_video(video_path, kwargs["rotate_sign"])
    return video_path


def process_video(args, **kwargs):
    video_file_extensions = [".mp4", ".flv", ".avi", ".mpg", ".wmv", ".mpeg", ".mov", ".mkv", ".ts", ".rmvb", ".rm", ".webm", ".gif"]
    video_path = args.video_path
    if video_path.lower() == GlobalScopeObjects.download_folder_alias:
        video_path = str(Path.home() / "Downloads")
    if (args.rows is None) and (args.cols is None):
        rows = 7
        cols = 7
    elif args.cols is None:
        rows = args.rows
        cols = None
    else:
        rows = args.rows
        cols = args.cols

    if os.path.isdir(video_path):  # 处理目录
        if args.recursion:
            video_paths = []
            for dir_, _, files_ in os.walk(video_path):
                for file_ in files_:
                    f = os.path.join(dir_, file_)
                    if os.path.splitext(f)[-1].lower() in video_file_extensions:
                        video_paths.append(f)
        else:
            video_paths = [
                os.path.join(video_path, f) for f in os.listdir(video_path) if os.path.splitext(f)[-1].lower() in video_file_extensions
            ]
        if args.parallel_processing_directory > 1:
            with ThreadPoolExecutor(args.parallel_processing_directory) as exe:
                for video_path in video_paths:
                    exe.submit(
                        generate_thumbnail,
                        preprocessing(video_path, kwargs),
                        rows,
                        cols,
                        args.preset,
                        args.full,
                        args.low,
                        args.max,
                        args.alternative_output_folder_path,
                        args.screen_ratio,
                        args.skip,
                        args.pic_only,
                        args.video_only,
                        args.full_delete_mode,
                    )
        else:
            for video_path in video_paths:
                try:
                    generate_thumbnail(
                        preprocessing(video_path, kwargs),
                        rows,
                        cols,
                        args.preset,
                        args.full,
                        args.low,
                        args.max,
                        args.alternative_output_folder_path,
                        args.screen_ratio,
                        args.skip,
                        args.pic_only,
                        args.video_only,
                        args.full_delete_mode,
                    )
                except:
                    traceback.print_exc()
    elif str(video_path).lower().startswith("http"):  # 处理网络视频
        file_name = os.path.basename(video_path)
        file_path = os.path.join(str(Path.home() / "Downloads"), file_name)
        if not os.path.exists(file_path):
            print(f"视频在本地不存在，开始下载: {file_name}")

            @retry(wait_fixed=6000, stop_max_attempt_number=10)
            def download_video(video_path):
                return requests.get(video_path, proxies={"http": "http://127.0.0.1:10809", "https": "http://127.0.0.1:10809"}).content

            video_data = download_video(video_path)
            with open(file_path, "wb") as f:
                f.write(video_data)
        generate_thumbnail(
            preprocessing(file_path, kwargs),
            rows,
            cols,
            args.preset,
            args.full,
            args.low,
            args.max,
            args.alternative_output_folder_path,
            args.screen_ratio,
            args.skip,
            args.pic_only,
            args.video_only,
            args.full_delete_mode,
        )
    else:  # 处理单个视频
        args.skip = False
        generate_thumbnail(
            preprocessing(video_path, kwargs),
            rows,
            cols,
            args.preset,
            args.full,
            args.low,
            args.max,
            args.alternative_output_folder_path,
            args.screen_ratio,
            args.skip,
            args.pic_only,
            args.video_only,
            args.full_delete_mode,
        )


def correct_drag_produced_path(input_path: str):
    if driver_letter_match := re.findall(r"^/?[a-z]/", input_path):
        driver_letter_part = driver_letter_match[0]
        driver_letter = driver_letter_part.replace("/", "").upper()
        corrected_path = input_path.replace(driver_letter_part, driver_letter + ":/")
        corrected_path = re.sub(r"\\(.)", r"\1", corrected_path)
        print(f"检测到拖拽产生的路径格式【{input_path}】，已修正为【{corrected_path}】")
        return corrected_path
    else:
        return input_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    parser.add_argument(
        "video_path",
        help=f'视频路径或视频目录路径(使用"{GlobalScopeObjects.download_folder_alias}"指代系统下载目录)；如果不提供的话，则进入交互式输入模式',
        type=str,
        nargs="?",
    )
    parser.add_argument("rows", help="缩略图行数", type=int, nargs="?")
    parser.add_argument("cols", help="缩略图列数", type=int, nargs="?")
    parser.add_argument(
        "--preset",
        help="ffmpeg的preset参数",
        type=str,
        default="ultrafast",
        choices=["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"],
    )
    parser.add_argument("--full", help="是否要生成多个缩略图以覆盖视频完整时长", action="store_true")
    parser.add_argument("-l", "--low", help="低负载模式，可指定转码线程数量，默认使用单线程进行转换", type=int, const=1, nargs="?")
    parser.add_argument(
        "-gl", "--global_low", help="全局低负载模式，所有并发任务共享指定数量转码线程，参数指定方式同low模式", type=int, const=1, nargs="?"
    )
    parser.add_argument("-m", "--max", help="指定生成单个视频缩略图的最大时长", type=int, default=30)
    parser.add_argument("-ao", "--alternative_output_folder_path", help="指定结果文件的生成路径，而不是和源文件相同目录", type=str)
    parser.add_argument(
        "-pp", "--parallel_processing_directory", help="当输入路径为文件夹时，使用指定数量的进程并发处理其中文件", type=int, default=1
    )
    parser.add_argument(
        "-sr", "--screen_ratio", help="指定屏幕长宽比，可输入'width/height'格式，也可直接输入小数", type=str, default="16/9"
    )
    parser.add_argument("-s", "--skip", help="跳过已经有输出结果的输入文件", action="store_true")
    parser.add_argument("-p", "--pic_only", help="只生成图像缩略图，不生成视频缩略图", action="store_true")
    parser.add_argument("-v", "--video_only", help="只生成视频缩略图，不生成图像缩略图", action="store_true")
    parser.add_argument("-r", "--recursion", help="如果输入路径为目录，则递归处理子目录", action="store_true")
    parser.add_argument("-d", "--full_delete_mode", help="删除full模式产生的seg视频文件", action="store_true")
    args = parser.parse_args()

    if args.pic_only and args.video_only:
        print(f"-p和-v模式只能二选一，不能同时设置!")
        exit()

    if args.global_low:
        global_encode_task_executor_pool = ThreadPoolExecutor(args.global_low)

    if args.video_path is None:
        while True:
            input_string = input(
                "请输入视频地址和行数，以空格隔开，若有列数则'row-col'的形式，若要旋转则在最后输入'l|r'，若要裁剪则在最后输入'c'："
            )
            if not input_string:
                continue

            try:
                video_path, rows_input = input_string.rsplit(" ", 1)
            except:
                print("输入格式错误，应该是'视频地址 行数[-列数][l|r][c]'的形式!")
                continue

            crop_sign = None
            rotate_sign = None
            if preprocessing_signs_match := re.findall(r"[lrc]+$", rows_input):
                preprocessing_signs = preprocessing_signs_match[0]
                if "l" in preprocessing_signs and "r" in preprocessing_signs:
                    print(f"'l'和r'不能同时指定!")
                    continue
                if "l" in preprocessing_signs:
                    rotate_sign = "l"
                if "r" in preprocessing_signs:
                    rotate_sign = "r"
                if "c" in preprocessing_signs:
                    crop_sign = "c"
                rows_input = rows_input.replace(preprocessing_signs, "")

            try:
                rows = int(rows_input)
                cols = None
            except ValueError:
                try:
                    rows, cols = [int(i) for i in rows_input.split("-")]
                except:
                    print(f"行列数解析失败，输入为：{rows_input}")
                    continue

            video_path_tasks = []
            if possible_files_from_all_drivers := re.findall(r"[a-zA-Z]:\\.*?\.[a-zA-Z0-9]{3,4}", video_path):
                # 应对多文件标准格式（所有磁盘位置）
                print("[DEBUG] 走多文件标准格式路径（所有磁盘位置）")
                for _path in possible_files_from_all_drivers:
                    video_path_tasks.append(_path)
            elif possible_files_from_user_folders_alternative_format := re.findall(r"[a-zA-Z]/.*?(?:Users|tmp).*?\.[a-zA-Z0-9]{3,4}", video_path):
                # 应对多文件非标准格式（所有磁盘位置）
                print("[DEBUG] 走多文件非标准格式路径（所有磁盘位置）")
                for _path in possible_files_from_user_folders_alternative_format:
                    _path = correct_drag_produced_path(_path)
                    video_path_tasks.append(_path)
            else:
                print("[DEBUG] 走默认路径")
                for _path in video_path.split('" "'):
                    _path = _path.strip('"')
                    _path = correct_drag_produced_path(_path)
                    video_path_tasks.append(_path)

            for video_path in video_path_tasks:
                threading.Thread(
                    target=process_video,
                    args=(
                        SimpleNamespace(
                            video_path=video_path.strip('"'),
                            rows=rows,
                            cols=cols,
                            preset=args.preset,
                            full=args.full,
                            low=args.low,
                            max=args.max,
                            alternative_output_folder_path=args.alternative_output_folder_path,
                            parallel_processing_directory=args.parallel_processing_directory,
                            screen_ratio=args.screen_ratio,
                            skip=args.skip,
                            pic_only=args.pic_only,
                            video_only=args.video_only,
                            recursion=args.recursion,
                            full_delete_mode=args.full_delete_mode,
                        ),
                    ),
                    kwargs={
                        "rotate_sign": rotate_sign,
                        "crop_sign": crop_sign,
                    },
                ).start()
    else:
        process_video(args)
