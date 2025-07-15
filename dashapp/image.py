import os
import random
import re
import shutil
from typing import List

import dash
from dash import ALL, MATCH, Input, Output, Patch, State, callback, dcc, html
from PIL import Image

app = dash.Dash(__name__)

pic_max_height = 475
PRELOAD_IMG_URL = "assets/Russian-Cute-Sexy-Girl.jpg"
VIDEO_WARNING_IMG_URL = "assets/video_warning.png"
TRASH_FOLDER_PATH = "./static/img/.trash"

img_path_list = []
browsed_img_list = []
consecutive_pic_count = 0

show_folder_title = False
show_moving_promote = False
tbnl_display_mode = False


def get_img_path_list(img_path_list: List):
    temp_img_list = []
    for root, dirs_, files_ in os.walk("./static/img"):
        for file_ in files_:
            if os.path.splitext(file_)[-1].lower() in [
                ".htm",
                ".html",
                ".txt",
                ".swf",
                ".db",
                ".css",
                ".js",
                ".bak",
                ".wmv",
                ".psd",
                ".url",
                ".mp3",
            ] or re.search(r"ds_store$", file_.lower()):
                continue
            if os.path.dirname(os.path.abspath(os.path.join(root, file_))) == os.path.abspath(TRASH_FOLDER_PATH):
                continue
            temp_img_list.append(os.path.join(root, file_).replace("\\", "/").replace("#", "%23"))
    temp_img_list.sort()
    for temp_img in temp_img_list:
        if (temp_img not in img_path_list) and (temp_img not in browsed_img_list):
            img_path_list.append(temp_img)
    img_path_list.sort()
    return img_path_list


img_path_list = get_img_path_list(img_path_list)

pic_resolutions_sum = []
sample_num = int(len(img_path_list) / 10)
for pic in random.sample(img_path_list, sample_num):
    try:
        pic_resolutions_sum.append(sum(Image.open(pic).size))
    except:
        pass
try:
    if len(pic_resolutions_sum) < sample_num * 0.5:
        raise UserWarning()
    avg_pic_resolution_sum = sum(pic_resolutions_sum) / len(pic_resolutions_sum)
    page_capacity = int(100_000 / avg_pic_resolution_sum)
    print("平均分辨率和为{}，计算得出每页{}张图...".format(avg_pic_resolution_sum, page_capacity))
except:
    page_capacity = 10
# Caution:
page_capacity = 6  # 这里写原始值6，是为了在第一次取图的时候，能取到正确数量。下面的12会除以2，再次得到这里的6

app.layout = html.Div(
    [
        html.Div(style={"display": "flex", "flex-wrap": "wrap", "justify-content": "left"}, id="container"),
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
                            dcc.Slider(
                                min=4,
                                max=100,
                                step=1,
                                value=12,  # 这里写12，是为了在按钮上能够显示正确数量
                                updatemode="drag",
                                id="slider1",
                                marks={
                                    4: "2",
                                    48: "24",
                                    90: "100",
                                    100: "1000",
                                },
                                className="slider",
                            ),
                            dcc.Slider(
                                min=100,
                                max=1500,
                                step=1,
                                value=pic_max_height,
                                updatemode="drag",
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
    ]
)


@app.callback(
    dash.dependencies.Output("container", "children"),
    dash.dependencies.Output("remain_count", "children"),
    dash.dependencies.Input("get_pics", "n_clicks"),
)
def popup_100_pics(n_clicks):
    global img_path_list, tbnl_display_mode, consecutive_pic_count
    return_list = []
    previous_img_catalog = "〄 " + "default".capitalize()
    pic_threshold = 20

    for idx in range(page_capacity):
        try:
            img_path = img_path_list.pop(0)
            file_ext = os.path.splitext(img_path)[-1].lower()
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
                style={"max-height": "380px", "vertical-align": "middle"},
                id={"type": "mp4" if (file_ext in [".mp4", ".m4v"]) else "tbnl" if file_ext == ".tbnl" else "video", "index": idx},
                **{"data-true-src": img_path},
            )
            if is_video
            else html.A(
                html.Img(
                    className=img_path,
                    src=PRELOAD_IMG_URL,
                    style={"max-height": "380px", "vertical-align": "middle"},
                    id={"type": "pic", "index": idx},
                    **{"data-true-src": img_path},
                ),
                href=img_path,
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
                        style={"max-height": pic_max_height, "vertical-align": "middle"},
                        id={"type": "pic", "index": idx + 1},
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
    return return_list, remain_count


@app.callback(dash.dependencies.Output("button_text", "children"), dash.dependencies.Input("slider1", "value"))
def set_page_capacity(s_value):
    def _value_mapping(in_value):
        if in_value <= 48:
            out_value = in_value / 2
        elif 48 < in_value <= 90:
            out_value = (38 / 21) * in_value - 1316 / 21
        elif 90 < in_value <= 100:
            out_value = 90 * in_value - 8000

        return 2 * round(out_value / 2)

    global page_capacity
    page_capacity = _value_mapping(s_value)
    button_text = "再来{}张！".format(page_capacity)
    return button_text


@callback(
    Output({"type": ALL, "index": ALL}, "style", allow_duplicate=True),
    Input("slider2", "value"),
    State({"type": ALL, "index": ALL}, "children"),
    prevent_initial_call="initial_duplicate",
)
def apply_height_change_to_media(s_value, children):
    global pic_max_height
    pic_max_height = s_value
    p = Patch()
    p.update({"max-height": f"{pic_max_height}px", "vertical-align": "middle"})
    return [p for _ in range(len(children))]


@callback(
    Output({"type": "tbnl", "index": ALL}, "controls", allow_duplicate=True),
    Input("option_hide_control", "value"),
    State({"type": "tbnl", "index": ALL}, "children"),
    prevent_initial_call="initial_duplicate",
)
def apply_option_to_tbnl_control(option_list_hide_control, children):
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
    State({"type": ALL, "index": ALL}, "data-true-src"),
    State({"type": ALL, "index": ALL}, "id"),
    prevent_initial_call="initial_duplicate",
)
def apply_options_to_media_display(
    option_list_not_display_mp4,
    option_list_not_display_pic,
    filter_value,
    src_paths,
    ids,
):
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
    if not os.path.exists(TRASH_FOLDER_PATH):
        os.makedirs(TRASH_FOLDER_PATH)
    count = 0
    for file_ in browsed_img_list:
        print(f"正在删除文件: {file_}")
        try:
            shutil.move(file_, TRASH_FOLDER_PATH)
            count += 1
        except Exception as e:
            try:
                if "already exists" in str(e):
                    os.remove(file_)
                    count += 1
            except Exception as e:
                print(f"删除失败: {e}")
    return "删除成功{}张".format(count)


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
    app.run(debug=False, host="0.0.0.0")
