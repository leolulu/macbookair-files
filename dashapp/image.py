import argparse
from copy import deepcopy
import os
import random
import re
import shutil
import subprocess
import threading
import zipfile
from concurrent.futures import ThreadPoolExecutor
from typing import List
from urllib.parse import urlparse

import dash
from dash import ALL, Input, Output, Patch, State, callback, dcc, html
from PIL import Image

app = dash.Dash(__name__)

pic_max_height = 475
PRELOAD_IMG_URL = "assets/Russian-Cute-Sexy-Girl.jpg"
VIDEO_WARNING_IMG_URL = "assets/video_warning.png"
TRASH_FOLDER_PATH = "./static/img/.trash"
JPG_FROM_WEBP_FOLDER = "jpg_from_webp"
IMG_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".tif", ".avif", ".jfif"}
VIDEO_EXTS = {".mp4", ".mov", ".avi", ".flv", ".mkv", ".ts", ".webm", ".m4v"}
MEDIA_EXTS = IMG_EXTS | VIDEO_EXTS
IGNORED_FILE_EXTS = {
    ".htm",
    ".html",
    ".swf",
    ".db",
    ".css",
    ".js",
    ".bak",
    ".wmv",
    ".psd",
    ".url",
    ".mp3",
}

img_path_list = []
browsed_img_list = []
consecutive_pic_count = 0
parsed_txt_files = set()
remote_url_order = {}

show_folder_title = False
show_moving_promote = False
tbnl_display_mode = False
native_image_loading = False

exe_for_webp = ThreadPoolExecutor(max_workers=8)
exe_for_zip = ThreadPoolExecutor(max_workers=1)
lock = threading.Lock()
settings_lock = threading.Lock()
converting_webp = []

os.makedirs("./static/img", exist_ok=True)


def is_remote(path):
    return path.startswith(("http://", "https://"))


def url_ext(path):
    """获取扩展名；远程 URL 先剥离 query/fragment 再取，避免 v.mp4?t=1 被误判成图片"""
    if is_remote(path):
        path = urlparse(path).path
    return os.path.splitext(path)[-1].lower()


def media_sort_key(path):
    """本地文件按路径排在前；远程 URL 聚末尾，按 (来源txt路径, txt内出现顺序) 两级排序"""
    if is_remote(path):
        txt_key, idx = remote_url_order.get(path, (path, 0))
        return (1, txt_key, idx)
    return (0, path, 0)


def extract_media_urls_from_text(content):
    """从文本内容中提取所有指向图片/视频的 http(s) 直链"""
    urls = []
    for candidate in re.findall(r"""https?://[^\s"'<>()\[\],;]+""", content):
        if url_ext(candidate) in MEDIA_EXTS:
            urls.append(candidate)
    return urls


def extract_media_urls(txt_path):
    """从 txt 文件中提取所有指向图片/视频的 http(s) 直链"""
    try:
        with open(txt_path, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read()
    except Exception as e:
        print(f"解析txt链接失败: {txt_path}, {e}")
        return []
    return extract_media_urls_from_text(content)


def trash_remote_urls(urls_to_delete):
    """
    从 ./static/img 树下现存的所有 txt 中，把包含已看 URL 的整行移入回收站同名 txt（平铺，append 合并）
    若某 txt 删除后不再含任何媒体链接，则删除该 txt 文件
    """
    url_set = set(urls_to_delete)
    removed_line_count = 0
    if not url_set:
        return removed_line_count
    os.makedirs(TRASH_FOLDER_PATH, exist_ok=True)
    for root, dirs_, files_ in os.walk("./static/img"):
        if os.path.abspath(root) == os.path.abspath(TRASH_FOLDER_PATH):
            continue
        for file_ in files_:
            if os.path.splitext(file_)[-1].lower() != ".txt":
                continue
            txt_path = os.path.join(root, file_)
            try:
                with open(txt_path, "r", encoding="utf-8", errors="surrogateescape", newline="") as f:
                    lines = f.readlines()
            except Exception as e:
                print(f"回收txt链接失败(读取): {txt_path}, {e}")
                continue
            kept_lines = []
            trashed_lines = []
            for line in lines:
                if url_set.intersection(extract_media_urls_from_text(line)):
                    trashed_lines.append(line)
                else:
                    kept_lines.append(line)
            if not trashed_lines:
                continue
            try:
                with open(os.path.join(TRASH_FOLDER_PATH, file_), "a", encoding="utf-8", errors="surrogateescape", newline="") as f:
                    for line in trashed_lines:
                        f.write(line if line.endswith("\n") else line + "\n")
                if extract_media_urls_from_text("".join(kept_lines)):
                    with open(txt_path, "w", encoding="utf-8", errors="surrogateescape", newline="") as f:
                        f.writelines(kept_lines)
                else:
                    os.remove(txt_path)
                removed_line_count += len(trashed_lines)
            except Exception as e:
                print(f"回收txt链接失败(写入): {txt_path}, {e}")
    return removed_line_count


def get_txt_title_for_image(img_path):
    """
    检查图片路径是否存在对应的txt文件，如果存在则读取内容作为title
    """
    try:
        txt_path = os.path.splitext(img_path)[0] + ".txt"
        if os.path.exists(txt_path):
            with open(txt_path, "r", encoding="utf-8") as f:
                content = f.read().strip()
                return content if content else None
        return None
    except Exception as e:
        print(f"读取txt文件时出错: {e}")
        return None

def clean_empty_folders(folder_paths=None):
    """
    清理空文件夹，从最深层向上递归删除
    跳过特殊文件夹和顶层 static/img/
    """
    static_img_root = os.path.abspath("./static/img")
    special_folders = {"jpg_from_webp", ".trash"}
    removed_dir_count = 0

    for root, dirs, files in os.walk(static_img_root, topdown=False):
        # 跳过顶层
        if os.path.abspath(root) == static_img_root:
            continue
            
        # 跳过特殊文件夹
        if os.path.basename(root) in special_folders:
            continue
            
        # 尝试删除空文件夹
        try:
            if not os.listdir(root):
                os.rmdir(root)
                removed_dir_count += 1
        except OSError:
            pass

    return removed_dir_count



def get_img_path_list(img_path_list: List[str]):
    global browsed_img_list
    browsed_img_list = [path for path in browsed_img_list if is_remote(path) or os.path.exists(path.replace("%23", "#"))]

    temp_img_list = []
    trash_folder_abs = os.path.abspath(TRASH_FOLDER_PATH)
    for root, dirs_, files_ in os.walk("./static/img"):
        root_abs = os.path.abspath(root)
        root_basename = os.path.basename(root)
        for file_ in files_:
            file_ext = os.path.splitext(file_)[-1].lower()
            if file_ext in IGNORED_FILE_EXTS or re.search(r"ds_store$", file_.lower()):
                continue
            if root_abs == trash_folder_abs:
                continue
            if root_basename == JPG_FROM_WEBP_FOLDER:
                continue
            if file_ext == ".txt":
                txt_abs = os.path.abspath(os.path.join(root, file_))
                if txt_abs not in parsed_txt_files:
                    parsed_txt_files.add(txt_abs)
                    urls = extract_media_urls(os.path.join(root, file_))
                    txt_key = os.path.join(root, file_).replace("\\", "/")
                    for url_idx, url_ in enumerate(urls):
                        remote_url_order.setdefault(url_, (txt_key, url_idx))
                    temp_img_list.extend(urls)
                continue
            if (
                (file_ext == ".webp")
                and (not os.path.exists(os.path.join(root, JPG_FROM_WEBP_FOLDER, file_.replace(".webp", ".jpg"))))
                and (file_ not in converting_webp)
            ):
                new_folder = os.path.join(root, JPG_FROM_WEBP_FOLDER)
                with lock:
                    if not os.path.exists(new_folder):
                        os.makedirs(new_folder)
                new_path = os.path.join(new_folder, os.path.splitext(file_)[0] + ".jpg")

                def _task_for_webp(file_, new_path, root):
                    command = f'ffmpeg -hide_banner -i "{os.path.join(root, file_)}" -q:v 1 -y "{new_path}"'
                    # print(f"检测到webp，将转换成jpg，指令为: {command}")
                    try:
                        subprocess.run(command, shell=True, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    except Exception as e:
                        print(f"webp->jpg转换失败: {e}\n转换命令: {command}")
                        if isinstance(e, subprocess.CalledProcessError):
                            print(f"详细错误信息(stdout): {e.stdout.decode()}")
                            print(f"详细错误信息(stderr): {e.stderr.decode()}")
                    finally:
                        converting_webp.remove(file_)

                exe_for_webp.submit(_task_for_webp, file_, new_path, root)
                converting_webp.append(file_)

            if file_ext == ".zip":

                def _task_for_zip(file_, root):
                    with zipfile.ZipFile(os.path.join(root, file_), "r") as zip_ref:
                        zip_ref.extractall(os.path.join(root, os.path.splitext(file_)[0]))
                    os.remove(os.path.join(root, file_))

                exe_for_zip.submit(_task_for_zip, file_, root)

            temp_img_list.append(os.path.join(root, file_).replace("\\", "/").replace("#", "%23"))
    temp_img_list.sort(key=media_sort_key)
    pending_img_set = set(img_path_list)
    browsed_img_set = set(browsed_img_list)
    for temp_img in temp_img_list:
        if (temp_img not in pending_img_set) and (temp_img not in browsed_img_set):
            img_path_list.append(temp_img)
            pending_img_set.add(temp_img)
    img_path_list.sort(key=media_sort_key)
    return img_path_list


img_path_list = get_img_path_list(img_path_list)

pic_resolutions_sum = []
sample_num = int(len(img_path_list) / 10)
for pic in random.sample(img_path_list, sample_num):
    try:
        pic_resolutions_sum.append(sum(Image.open(pic.replace("%23", "#")).size))
    except:  # noqa: E722
        pass
try:
    if len(pic_resolutions_sum) < sample_num * 0.5:
        raise UserWarning()
    avg_pic_resolution_sum = sum(pic_resolutions_sum) / len(pic_resolutions_sum)
    page_capacity = int(100_000 / avg_pic_resolution_sum)
    print("平均分辨率和为{}，计算得出每页{}张图...".format(avg_pic_resolution_sum, page_capacity))
except:  # noqa: E722
    page_capacity = 10
# Caution:
page_capacity = 6  # 这里写原始值6，是为了在第一次取图的时候，能取到正确数量。下面的12会除以2，再次得到这里的6

# 跨标签页共享设置的唯一注册表。
#
# 新增需要跨标签页同步的控件时：
# 1. 在这里登记默认值、组件 id 和对应属性；
# 2. 在控件原有的业务回调里调用 commit_display_settings，或把直接输入交给
#    commit_triggered_control_settings。
# 布局初始化和“再来”按钮触发的当前标签页回填都会自动读取本表，无需再分别补 set_props。
#
# page_capacity 是由数量滑块/手动输入推导出的业务值，没有可直接回填的组件属性，所以只登记默认值。
# option_show_delete_button 有意不登记：删除功能具有破坏性，它的显示开关只在当前标签页生效。
SHARED_SETTING_SPECS = {
    "page_capacity": {"default": page_capacity},
    "capacity_slider_value": {"default": 12, "component_id": "slider1", "component_property": "value"},
    "pic_max_height": {"default": pic_max_height, "component_id": "slider2", "component_property": "value"},
    "hide_control_options": {"default": [], "component_id": "option_hide_control", "component_property": "value"},
    "hidden_mp4_options": {"default": [], "component_id": "option_not_display_mp4", "component_property": "value"},
    "hidden_pic_options": {"default": [], "component_id": "option_not_display_pic", "component_property": "value"},
    "path_filter": {"default": None, "component_id": "path_filter", "component_property": "value"},
}
_display_settings = {name: deepcopy(spec["default"]) for name, spec in SHARED_SETTING_SPECS.items()}
_component_setting_names = {
    (spec["component_id"], spec["component_property"]): name
    for name, spec in SHARED_SETTING_SPECS.items()
    if "component_id" in spec
}

def get_display_settings():
    with settings_lock:
        return deepcopy(_display_settings)


def update_display_settings(**updates):
    unknown_settings = updates.keys() - SHARED_SETTING_SPECS.keys()
    if unknown_settings:
        raise KeyError("未登记的跨标签页设置: {}".format(", ".join(sorted(unknown_settings))))
    with settings_lock:
        _display_settings.update(deepcopy(updates))
        return deepcopy(_display_settings)


def get_container_style(height):
    return {
        "display": "flex",
        "flex-wrap": "wrap",
        "justify-content": "left",
        "--media-max-height": f"{height}px",
    }


def get_settings_component_props(settings):
    """把共享设置转换成当前标签页需要回填的组件属性。"""
    component_props = {}
    for setting_name, spec in SHARED_SETTING_SPECS.items():
        if "component_id" not in spec:
            continue
        component_props.setdefault(spec["component_id"], {})[spec["component_property"]] = deepcopy(settings[setting_name])

    # 下列属性是共享设置的派生显示结果，不对应可独立编辑的设置项。
    component_props.update(
        {
            "container": {"style": get_container_style(settings["pic_max_height"])},
            "button_text": {"children": "再来{}张！".format(settings["page_capacity"])},
            "capacity_input": {
                "value": settings["page_capacity"] if settings["capacity_slider_value"] > 100 else None
            },
            "capacity_popup": {"className": "show" if settings["capacity_slider_value"] > 100 else ""},
            "applied_display_settings": {"data": deepcopy(settings)},
        }
    )
    return component_props


def apply_display_settings_to_tab(settings):
    """将服务端共享设置回填到发起当前回调的标签页。"""
    for component_id, props in get_settings_component_props(settings).items():
        dash.set_props(component_id, props)


def commit_display_settings(**updates):
    """原子更新服务端共享设置，并记录当前标签页已经应用的版本。"""
    settings = update_display_settings(**updates)
    dash.set_props("applied_display_settings", {"data": settings})
    return settings


def commit_triggered_control_settings(component_values, applied_settings):
    """提交本次回调中由用户直接改动的、已登记的控件值。"""
    updates = {}
    for prop_id in dash.ctx.triggered_prop_ids:
        if prop_id == "." or "." not in prop_id:
            continue
        component_id, component_property = prop_id.rsplit(".", 1)
        setting_name = _component_setting_names.get((component_id, component_property))
        if setting_name is None or component_id not in component_values:
            continue
        value = component_values[component_id]
        if applied_settings is not None and value == applied_settings.get(setting_name):
            continue
        updates[setting_name] = value
    if updates:
        commit_display_settings(**updates)


_base_layout = html.Div(
    [
        html.Div(
            style={
                "display": "flex",
                "flex-wrap": "wrap",
                "justify-content": "left",
                "--media-max-height": f"{pic_max_height}px",
            },
            id="container",
        ),
        html.Div(
            [
                html.Div(
                    html.Div(
                        [
                            html.Div(
                                [
                                    dcc.Checklist(
                                        [{"label": "无控", "value": "hide_control"}],
                                        inline=True,
                                        id="option_hide_control",
                                    ),
                                    dcc.Checklist(
                                        [{"label": "隐mp4", "value": "not_display_mp4"}],
                                        inline=True,
                                        id="option_not_display_mp4",
                                    ),
                                    dcc.Checklist(
                                        [{"label": "隐图", "value": "not_display_pic"}],
                                        inline=True,
                                        id="option_not_display_pic",
                                    ),
                                ],
                                id="option_container",
                            ),
                            html.Div(
                                dcc.Input(id="path_filter", type="text", placeholder='过滤"路径"，可以使用正则', debounce=True),
                                style={"margin-bottom": "12px", "padding": "0px 25px"},
                            ),
                            html.Div(
                                style={"padding": "0px 25px"},
                            ),
                            html.Div(
                                [
                                    dcc.Slider(
                                        min=4,
                                        max=104,
                                        step=1,
                                        value=12,
                                        updatemode="mouseup",
                                        id="slider1",
                                        marks={
                                            4: "2",
                                            48: "24",
                                            90: {"label": "100", "style": {"transform": "translateX(-90%)"}},
                                            100: {"label": "1000", "style": {"transform": "translateX(-85%)"}},
                                            104: {"label": "∞", "style": {"transform": "translateX(-45%)", "fontWeight": "bold"}},
                                        },
                                        className="slider",
                                    ),
                                    html.Div(
                                        [
                                            dcc.Input(id="capacity_input", type="number", min=2),
                                            html.Button("确认", id="capacity_confirm"),
                                        ],
                                        id="capacity_popup",
                                    ),
                                ],
                                style={"position": "relative"},
                            ),
                            dcc.Slider(
                                min=100,
                                max=1500,
                                step=1,
                                value=pic_max_height,
                                updatemode="mouseup",
                                id="slider2",
                                marks=None,
                                className="slider",
                            ),
                        ],
                        style={"display": "flex", "flex-direction": "column"},
                    )
                ),
                html.Div(
                    html.A(
                        html.Button([html.Div(id="button_text"), html.Div(id="remain_count")], id="get_pics"),
                        href="#container",
                    ),
                    style={"margin-right": "20px"},
                ),
            ],
            id="button_container",
        ),
        html.Div(
            [
                dcc.Checklist(
                    [{"label": "删除", "value": "show_delete_button"}],
                    inline=True,
                    id="option_show_delete_button",
                ),
                html.Div(id="delete_button"),
            ],
            id="delete_component_container",
        ),
        dcc.Store(id="data_update_img_path_list"),
        dcc.Store(id="applied_display_settings"),
    ]
)


def _apply_layout_settings(component, component_props):
    if isinstance(component, (list, tuple)):
        for child in component:
            _apply_layout_settings(child, component_props)
        return
    if not hasattr(component, "to_plotly_json"):
        return

    component_id = getattr(component, "id", None)
    for component_property, value in component_props.get(component_id, {}).items():
        setattr(component, component_property, deepcopy(value))

    _apply_layout_settings(getattr(component, "children", None), component_props)


def serve_layout():
    layout = deepcopy(_base_layout)
    _apply_layout_settings(layout, get_settings_component_props(get_display_settings()))
    return layout


app.layout = serve_layout


@app.callback(
    dash.dependencies.Output("container", "children"),
    dash.dependencies.Output("remain_count", "children"),
    dash.dependencies.Input("get_pics", "n_clicks"),
)
def popup_100_pics(n_clicks):
    global img_path_list, tbnl_display_mode, consecutive_pic_count
    settings = get_display_settings()
    return_list = []
    previous_img_catalog = "〄 " + "default".capitalize()
    pic_threshold = 20

    for idx in range(settings["page_capacity"]):
        try:
            img_path = img_path_list.pop(0)
            file_ext = url_ext(img_path)
            current_img_catalog = "〄 " + img_path.split("/")[-2].capitalize()
        except IndexError:
            break
        if current_img_catalog != previous_img_catalog and show_folder_title:
            return_list.append(html.H1(current_img_catalog, id="img_catalog_" + current_img_catalog, style={"width": "100%"}))
            previous_img_catalog = current_img_catalog
        if file_ext == ".tbnl":
            tbnl_display_mode = True

        is_video = file_ext in [".mp4", ".mov", ".avi", ".flv", ".mkv", ".ts", ".webm", ".m4v", ".tbnl"]

        return_list.append(
            html.Video(
                src=img_path,
                muted=True,
                autoPlay=False if (tbnl_display_mode and file_ext != ".tbnl") else True,
                controls=True,
                loop=True,
                style={"max-height": "var(--media-max-height)", "vertical-align": "middle"},
                id={"type": "mp4" if (file_ext in [".mp4", ".m4v"]) else "tbnl" if file_ext == ".tbnl" else "video", "index": idx},
                className=img_path,
            )
            if is_video
            else html.A(
                html.Img(
                    className=img_path,
                    src=img_path if is_remote(img_path) or native_image_loading else PRELOAD_IMG_URL,
                    style={"max-height": "var(--media-max-height)", "vertical-align": "middle"},
                    id={"type": "pic", "index": idx},
                    title=None if is_remote(img_path) else get_txt_title_for_image(img_path),
                    **({"data-native-loading": "true"} if native_image_loading and not is_remote(img_path) else {}),
                ),
                href=os.path.join(
                    os.path.dirname(img_path),
                    JPG_FROM_WEBP_FOLDER,
                    os.path.basename(img_path).replace(".webp", ".jpg"),
                )
                if img_path.endswith(".webp") and not is_remote(img_path)
                else img_path,
                target="_blank",
            )
        )
        browsed_img_list.append(img_path)

        if not is_video:
            consecutive_pic_count += 1
        else:
            if consecutive_pic_count >= pic_threshold:
                return_list.insert(
                    -1,
                    html.Img(
                        src=VIDEO_WARNING_IMG_URL,
                        style={"max-height": "var(--media-max-height)", "vertical-align": "middle"},
                        id={"type": "pic", "index": idx + 1},
                        className="",
                    ),
                )
                consecutive_pic_count = 0
                break
            else:
                consecutive_pic_count = 0

    if len(img_path_list) == 0:
        tbnl_display_mode = False
        img_path_list = get_img_path_list(img_path_list)
    remain_count = "还剩{}张".format(len(img_path_list))
    if len([i for i in return_list if isinstance(i, html.H1)]) == 1 and show_moving_promote:
        return_list.insert(0, html.H1("Only one category in the page!", id="promotion"))
    apply_display_settings_to_tab(settings)
    return return_list, remain_count


@app.callback(
    dash.dependencies.Output("button_text", "children"),
    dash.dependencies.Input("slider1", "value"),
    dash.dependencies.State("applied_display_settings", "data"),
    prevent_initial_call=True,
)
def set_page_capacity(s_value, applied_settings):
    # slider1 uses updatemode=mouseup, so this callback only commits a settled value.
    if s_value is None:
        return dash.no_update
    settings = get_display_settings()
    if applied_settings and s_value == applied_settings.get("capacity_slider_value"):
        if s_value > 100:
            dash.set_props("capacity_popup", {"className": "show"})
            dash.set_props("capacity_input", {"value": applied_settings.get("page_capacity", settings["page_capacity"])})
        else:
            dash.set_props("capacity_popup", {"className": ""})
        return "再来{}张！".format(applied_settings.get("page_capacity", settings["page_capacity"]))

    def _value_mapping(in_value):
        out_value = float(in_value)
        if in_value <= 48:
            out_value = in_value / 2
        elif 48 < in_value <= 90:
            out_value = (38 / 21) * in_value - 1316 / 21
        elif 90 < in_value <= 100:
            out_value = 90 * in_value - 8000

        return 2 * round(out_value / 2)

    if s_value > 100:
        # 超档位：滑块不再控制数量，浮层手动输入接管，数量保持不变直到输入确认
        dash.set_props("capacity_popup", {"className": "show"})
        dash.set_props("capacity_input", {"value": settings["page_capacity"]})
        return "再来{}张！".format(settings["page_capacity"])
    dash.set_props("capacity_popup", {"className": ""})
    capacity = _value_mapping(s_value)
    commit_display_settings(page_capacity=capacity, capacity_slider_value=s_value)
    button_text = "再来{}张！".format(capacity)
    return button_text


@callback(
    Output("button_text", "children", allow_duplicate=True),
    Input("capacity_confirm", "n_clicks"),
    Input("capacity_input", "n_submit"),
    State("capacity_input", "value"),
    prevent_initial_call=True,
)
def confirm_manual_capacity(n_clicks, n_submit, input_value):
    try:
        capacity = max(2, 2 * round(float(input_value) / 2))
    except (TypeError, ValueError):
        return dash.no_update
    commit_display_settings(page_capacity=capacity, capacity_slider_value=104)
    dash.set_props("capacity_input", {"value": capacity})
    return "再来{}张！".format(capacity)


# 超档"啪"吸附：updatemode=mouseup 下 value 仅在松手时更新，拖动全程跟手零回写——
# 松手落在 101~103 不稳定区时，过中点(102)弹入 104，未过弹回 100，模拟机械跳档
app.clientside_callback(
    """
    function(value) {
        if (value > 100 && value < 104) {
            return value >= 102 ? 104 : 100;
        }
        return window.dash_clientside.no_update;
    }
    """,
    Output("slider1", "value"),
    Input("slider1", "value"),
    prevent_initial_call=True,
)


@callback(
    Output("container", "style"),
    Input("slider2", "value"),
    State("applied_display_settings", "data"),
    prevent_initial_call=True,
)
def apply_height_change_to_media(s_value, applied_settings):
    if s_value is None:
        return dash.no_update
    if applied_settings and s_value == applied_settings.get("pic_max_height"):
        return dash.no_update
    commit_display_settings(pic_max_height=s_value)
    p = Patch()
    p["--media-max-height"] = f"{s_value}px"
    return p


@callback(
    Output({"type": "tbnl", "index": ALL}, "controls", allow_duplicate=True),
    Input("option_hide_control", "value"),
    State({"type": "tbnl", "index": ALL}, "children"),
    State("applied_display_settings", "data"),
    prevent_initial_call="initial_duplicate",
)
def apply_option_to_tbnl_control(option_list_hide_control, children, applied_settings):
    commit_triggered_control_settings({"option_hide_control": option_list_hide_control}, applied_settings)
    if option_list_hide_control and "hide_control" in option_list_hide_control:
        dash.set_props("option_hide_control", {"style": {"color": "#4CAF50"}})
        controls_value = False
    else:
        dash.set_props("option_hide_control", {"style": {"color": ""}})
        controls_value = True
    return [controls_value for _ in range(len(children))]


@callback(
    Output({"type": ALL, "index": ALL}, "style", allow_duplicate=True),
    Input("option_not_display_mp4", "value"),
    Input("option_not_display_pic", "value"),
    Input("path_filter", "value"),
    State({"type": ALL, "index": ALL}, "className"),
    State({"type": ALL, "index": ALL}, "id"),
    State("applied_display_settings", "data"),
    prevent_initial_call="initial_duplicate",
)
def apply_options_to_media_display(
    option_list_not_display_mp4,
    option_list_not_display_pic,
    filter_value,
    src_paths,
    ids,
    applied_settings,
):
    commit_triggered_control_settings(
        {
            "option_not_display_mp4": option_list_not_display_mp4,
            "option_not_display_pic": option_list_not_display_pic,
            "path_filter": filter_value,
        },
        applied_settings,
    )
    layout_triggered = dash.ctx.triggered and all(item["prop_id"] == "." for item in dash.ctx.triggered)
    if not option_list_not_display_mp4 and not option_list_not_display_pic and not filter_value and layout_triggered:
        raise dash.exceptions.PreventUpdate

    output_results = []

    if option_list_not_display_mp4 and "not_display_mp4" in option_list_not_display_mp4:
        dash.set_props("option_not_display_mp4", {"style": {"color": "#4CAF50"}})
        mp4_need_hide = True
    else:
        dash.set_props("option_not_display_mp4", {"style": {"color": ""}})
        mp4_need_hide = False

    if option_list_not_display_pic and "not_display_pic" in option_list_not_display_pic:
        dash.set_props("option_not_display_pic", {"style": {"color": "#4CAF50"}})
        pic_need_hide = True
    else:
        dash.set_props("option_not_display_pic", {"style": {"color": ""}})
        pic_need_hide = False

    for src_path, id_ in zip(src_paths, ids):
        type_ = id_["type"]
        p = Patch()

        if filter_value and re.search(filter_value, src_path):
            hide_by_filter = True
        else:
            hide_by_filter = False

        if type_ in ["video", "tbnl"]:
            if hide_by_filter:
                p.update({"display": "none"})
            else:
                p.update({"display": ""})
        elif type_ == "mp4":
            if mp4_need_hide or hide_by_filter:
                p.update({"display": "none"})
            else:
                p.update({"display": ""})
        elif type_ == "pic":
            if pic_need_hide or hide_by_filter:
                p.update({"display": "none"})
            else:
                p.update({"display": ""})
        else:
            raise UserWarning(f"未知的媒体元素id type: {type_}")

        output_results.append(p)

    return output_results


@callback(
    Output("delete_button", "style"),
    Output("delete_button", "children"),
    Input("option_show_delete_button", "value"),
)
def toggle_delete_button_display(value):
    if value:
        return {"display": "block"}, dash.no_update
    else:
        return {"display": "none"}, "删除已经浏览过的媒体文件"


@callback(
    Output("delete_button", "children", allow_duplicate=True),
    Input("delete_button", "n_clicks"),
    prevent_initial_call=True,
)
def delete_button_click(n_clicks):
    global browsed_img_list
    if not os.path.exists(TRASH_FOLDER_PATH):
        os.makedirs(TRASH_FOLDER_PATH)
    count = 0
    parent_folders = []  # 收集被删文件的父文件夹路径
    for file_ in browsed_img_list:
        if is_remote(file_):
            continue
        try:
            file_path = file_.replace("%23", "#")
            shutil.move(file_path, TRASH_FOLDER_PATH)
            parent_folders.append(os.path.dirname(file_path))
            count += 1
        except Exception as e:
            try:
                if "already exists" in str(e):
                    file_path = file_.replace("%23", "#")
                    os.remove(file_path)
                    parent_folders.append(os.path.dirname(file_path))
                    count += 1
            except Exception as e:
                print(f"删除失败: {e}")
    
    # 已看过的远程链接：从所有 txt 中整行移入回收站同名 txt，并从 browsed 中清除
    removed_link_count = trash_remote_urls([p for p in browsed_img_list if is_remote(p)])
    browsed_img_list = [p for p in browsed_img_list if not is_remote(p)]

    # 清理空文件夹
    removed_dir_count = clean_empty_folders(parent_folders)

    return "删除成功{}张，移除链接{}条，清理空目录{}个".format(count, removed_link_count, removed_dir_count)


@callback(
    Output("remain_count", "children", allow_duplicate=True),
    Input("data_update_img_path_list", "data"),
    prevent_initial_call=True,
    running=[
        (Output("get_pics", "style"), {"background-color": "#e9a8a8"}, {}),
        (Output("get_pics", "disabled"), True, False),
    ],
)
def update_img_path_list(data):
    global img_path_list
    img_path_list = get_img_path_list(img_path_list)
    return "还剩{}张".format(len(img_path_list))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--instant",
        action="store_true",
        help="启动时直接设置所有本地图片的 src，由浏览器自行调度加载",
    )
    args = parser.parse_args()
    native_image_loading = args.instant
    app.run(debug=False, host="0.0.0.0")
