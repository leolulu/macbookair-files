import cv2
import matplotlib.pyplot as plt
from matplotlib.widgets import Slider, Button
import matplotlib.animation as animation
from matplotlib.widgets import RectangleSelector

class VideoPlayer:
    def __init__(self, video_path):
        # 打开视频文件
        self.cap = cv2.VideoCapture(video_path)
        if not self.cap.isOpened():
            raise IOError("无法打开视频文件")

        # 获取视频属性
        self.total_frames = int(self.cap.get(cv2.CAP_PROP_FRAME_COUNT))
        self.fps = self.cap.get(cv2.CAP_PROP_FPS)
        self.duration = self.total_frames / self.fps

        # 初始化播放器状态
        self.paused = False
        self.current_frame = 0
        self.selected_rect = None  # 存储选中的矩形

        # 设置 Matplotlib 图形和子图
        self.fig, (self.ax_video, self.ax_slider) = plt.subplots(2, 1, figsize=(8, 6),
                                                                  gridspec_kw={'height_ratios': [4, 1]})
        plt.subplots_adjust(left=0.1, bottom=0.25)

        # 初始化视频显示
        ret, frame = self.cap.read()
        if not ret:
            raise ValueError("无法读取视频的第一帧")
        self.frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        self.im = self.ax_video.imshow(self.frame)
        self.ax_video.axis('off')  # 隐藏坐标轴

        # 添加滑动条
        self.slider_ax = self.ax_slider
        self.slider = Slider(
            ax=self.slider_ax,
            label='进度',
            valmin=0,
            valmax=self.total_frames - 1,
            valinit=0,
            valfmt='%0.0f'
        )
        self.slider.on_changed(self.on_slider_change)

        # 添加按钮
        self.button_ax = self.fig.add_axes([0.8, 0.1, 0.1, 0.05])  # [left, bottom, width, height]
        self.button = Button(self.button_ax, '获取坐标')
        self.button.on_clicked(self.on_button_click)

        # 初始化 RectangleSelector 使用左键
        self.RS = RectangleSelector(
            self.ax_video,
            self.on_select,
            useblit=True,
            button=[1],  # 仅响应左键
            minspanx=5,
            minspany=5,
            spancoords='pixels',
            drag_from_anywhere=True,
            interactive=True
        )
        self.selector_active = True  # 选择器始终激活

        # 绑定鼠标事件
        self.cid_click = self.fig.canvas.mpl_connect('button_press_event', self.on_click)

        # 设置动画
        self.ani = animation.FuncAnimation(self.fig, self.update, interval=1000 / self.fps, blit=False)

    def on_slider_change(self, val):
        """当滑动条被拖动时，跳转到相应的帧"""
        self.current_frame = int(val)
        self.cap.set(cv2.CAP_PROP_POS_FRAMES, self.current_frame)
        ret, frame = self.cap.read()
        if ret:
            self.frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            self.im.set_data(self.frame)
            self.fig.canvas.draw_idle()

    def on_click(self, event):
        """右键点击切换暂停/播放状态"""
        if event.inaxes == self.ax_video:
            if event.button == 3:  # 右键
                self.paused = not self.paused
                print(f"{'暂停' if self.paused else '播放'}视频")
            # 左键用于矩形选择，不做其他操作

    def on_select(self, eclick, erelease):
        """回调函数，当矩形选择完成时调用"""
        x1, y1 = int(eclick.xdata), int(eclick.ydata)
        x2, y2 = int(erelease.xdata), int(erelease.ydata)
        self.selected_rect = (min(x1, x2), min(y1, y2), abs(x2 - x1), abs(y2 - y1))
        print(f"选中的矩形坐标: {self.selected_rect}")
        # 可选：在选择后暂停视频
        # self.paused = True

    def on_button_click(self, event):
        """当点击按钮时，返回坐标并关闭窗口"""
        if self.selected_rect:
            print(f"最终选中的矩形坐标: {self.selected_rect}")
            # 这里您可以将坐标保存到文件或其他处理
            plt.close(self.fig)
        else:
            print("尚未选择矩形。请先框选一个区域。")

    def update(self, frame):
        """更新视频帧"""
        if not self.paused:
            ret, frame = self.cap.read()
            if ret:
                self.frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                self.im.set_data(self.frame)
                self.current_frame += 1
                self.slider.set_val(self.current_frame)
            else:
                # 视频播放完毕，停止动画
                self.ani.event_source.stop()
        return self.im,

    def show(self):
        plt.show()
        self.cap.release()


if __name__ == "__main__":
    video_path = r"C:\Users\surface\Downloads\83e6db1d3b1c370371411a1e2700b950.mp4"
    player = VideoPlayer(video_path)
    player.show()
