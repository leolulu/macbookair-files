import cv2
import matplotlib.pyplot as plt
from matplotlib.widgets import Slider, Button
from matplotlib.widgets import RectangleSelector
from types import SimpleNamespace
import os
import subprocess


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
        self.fig, axes = plt.subplot_mosaic("AAAAA;CBBBB", height_ratios=[10, 1], figsize=(12, 9), layout="constrained")
        self.ax_video = axes["A"]
        self.ax_slider = axes["B"]
        self.ax_button = axes["C"]

        # 初始化视频显示
        ret, frame = self.cap.read()
        if not ret:
            raise ValueError("无法读取视频的第一帧")
        self.frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        self.im = self.ax_video.imshow(self.frame)
        self.ax_video.axis("off")  # 隐藏坐标轴

        # 添加滑动条
        self.slider = Slider(
            ax=self.ax_slider, label="进度条", valmin=0, valmax=self.total_frames - 1, valinit=0, valfmt="%d", initcolor="none"
        )
        self.slider.on_changed(self.on_slider_change)

        # 添加按钮
        self.button = Button(self.ax_button, "确认")
        self.button.on_clicked(self.on_button_click)

        # 初始化 RectangleSelector 使用左键
        self.RS = RectangleSelector(
            self.ax_video,
            self.on_select,
            useblit=True,
            button=[1],  # 仅响应左键
            minspanx=5,
            minspany=5,
            spancoords="pixels",
            drag_from_anywhere=True,
            interactive=True,
        )

    def on_slider_change(self, val):
        """当滑动条被拖动时，跳转到相应的帧"""
        self.current_frame = int(val)
        self.cap.set(cv2.CAP_PROP_POS_FRAMES, self.current_frame)
        ret, frame = self.cap.read()
        if ret:
            self.frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            self.im.set_data(self.frame)
            self.fig.canvas.draw_idle()

    def on_select(self, eclick, erelease):
        """回调函数，当矩形选择完成时调用"""
        x1, y1 = int(eclick.xdata), int(eclick.ydata)
        x2, y2 = int(erelease.xdata), int(erelease.ydata)
        self.selected_rect = (min(x1, x2), min(y1, y2), abs(x2 - x1), abs(y2 - y1))
        print(f"选中的矩形坐标: {self.selected_rect}")

    def on_button_click(self, event):
        """当点击按钮时，返回坐标并关闭窗口"""
        if self.selected_rect:
            print(f"最终选中的矩形坐标: {self.selected_rect}")  # (x, y, width, height)
            # 这里您可以将坐标保存到文件或其他处理
            plt.close(self.fig)
        else:
            print("尚未选择矩形。请先框选一个区域。")

    def pick_coord(self):
        self.show()
        if self.selected_rect:
            return SimpleNamespace(
                x=self.selected_rect[0],
                y=self.selected_rect[1],
                w=self.selected_rect[2],
                h=self.selected_rect[3],
            )
        else:
            return None

    def show(self):
        plt.show()
        self.cap.release()


def crop_with_ffmpeg(video_path, coord):
    x, y, w, h = coord.x, coord.y, coord.w, coord.h
    output_path = os.path.splitext(video_path)[0] + "_cropped.mp4"
    command = f'ffmpeg -i "{video_path}" -vf "crop={w}:{h}:{x}:{y}" -y "{output_path}"'
    print(f"crop指令：{command}")
    subprocess.run(command, shell=True)
    return output_path


if __name__ == "__main__":
    video_path = r"C:\Users\sisplayer\Downloads\543f9cd9f170a8c7d6952a9fab19e0a2.mp4"
    player = VideoCoordPicker(video_path)
    crop_with_ffmpeg(video_path, player.pick_coord())
