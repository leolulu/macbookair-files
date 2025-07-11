import os
import random
import re
from typing import List

import dash
from dash import Patch, dcc, html, Input, Output, State, MATCH, ALL, callback
from PIL import Image

app = dash.Dash(__name__)

pic_max_height = 475
PRELOAD_IMG_URL = "assets/Russian-Cute-Sexy-Girl.jpg"
VIDEO_WARNING_IMG_URL = "assets/video_warning.png"

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
            temp_img_list.append(os.path.join(root, file_).replace("\\", "/").replace("#", "%23"))
    temp_img_list.sort()
    for temp_img in temp_img_list:
        if temp_img not in img_path_list and temp_img not in browsed_img_list:
            img_path_list.append(temp_img)
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
                                        className="option_item",
                                        id="option_hide_control",
                                    ),
                                    dcc.Checklist(
                                        [{"label": "隐mp4", "value": "not_display_mp4"}],
                                        inline=True,
                                        className="option_item",
                                        id="option_not_display_mp4",
                                    ),
                                    dcc.Checklist(
                                        [{"label": "隐图", "value": "not_display_pic"}],
                                        inline=True,
                                        className="option_item",
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
        img_path_list = get_img_path_list(img_path_list)
        tbnl_display_mode = False
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
    Output({"type": "tbnl", "index": dash.dependencies.ALL}, "controls", allow_duplicate=True),
    Output({"type": "mp4", "index": dash.dependencies.ALL}, "style", allow_duplicate=True),
    Output({"type": "pic", "index": dash.dependencies.ALL}, "style", allow_duplicate=True),
    Input("option_hide_control", "value"),
    Input("option_not_display_mp4", "value"),
    Input("option_not_display_pic", "value"),
    State({"type": "tbnl", "index": dash.dependencies.ALL}, "children"),
    State({"type": "mp4", "index": dash.dependencies.ALL}, "children"),
    State({"type": "pic", "index": dash.dependencies.ALL}, "children"),
    prevent_initial_call=True,
)
def apply_options(
    option_list_hide_control,
    option_list_not_display_mp4,
    option_list_not_display_pic,
    children_tbnl,
    children_mp4,
    children_pic,
):
    output_results = []

    if dash.ctx.triggered_id == "option_hide_control":
        if option_list_hide_control and "hide_control" in option_list_hide_control:
            dash.set_props("option_hide_control", {"style": {"color": "#4CAF50"}})
            controls_value = False
        else:
            dash.set_props("option_hide_control", {"style": {"color": ""}})
            controls_value = True
        output_results.append([controls_value for _ in range(len(children_tbnl))])
    else:
        output_results.append([dash.no_update for _ in range(len(children_tbnl))])

    if dash.ctx.triggered_id == "option_not_display_mp4":
        p = Patch()
        if option_list_not_display_mp4 and "not_display_mp4" in option_list_not_display_mp4:
            dash.set_props("option_not_display_mp4", {"style": {"color": "#4CAF50"}})
            p.update({"display": "none"})
        else:
            dash.set_props("option_not_display_mp4", {"style": {"color": ""}})
            p.update({"display": ""})
        output_results.append([p for _ in range(len(children_mp4))])
    else:
        output_results.append([dash.no_update for _ in range(len(children_mp4))])

    if dash.ctx.triggered_id == "option_not_display_pic":
        p = Patch()
        if option_list_not_display_pic and "not_display_pic" in option_list_not_display_pic:
            dash.set_props("option_not_display_pic", {"style": {"color": "#4CAF50"}})
            p.update({"display": "none"})
        else:
            dash.set_props("option_not_display_pic", {"style": {"color": ""}})
            p.update({"display": ""})
        output_results.append([p for _ in range(len(children_pic))])
    else:
        output_results.append([dash.no_update for _ in range(len(children_pic))])

    return output_results


@app.callback(
    dash.dependencies.Output({"type": dash.dependencies.ALL, "index": dash.dependencies.ALL}, "style", allow_duplicate=True),
    dash.dependencies.Input("path_filter", "value"),
    dash.dependencies.State({"type": dash.dependencies.ALL, "index": dash.dependencies.ALL}, "src"),
    dash.dependencies.State({"type": dash.dependencies.ALL, "index": dash.dependencies.ALL}, "style"),
    dash.dependencies.State({"type": dash.dependencies.ALL, "index": dash.dependencies.ALL}, "data-true-src"),
    prevent_initial_call="initial_duplicate",
)
def apply_filter_on_all_media(filter_value, src_paths, styles, src_paths_backup):
    output_style_result = []
    for src_path, org_style, true_src in zip(src_paths, styles, src_paths_backup):
        media_path = true_src if true_src else src_path
        if filter_value and re.search(filter_value, media_path):
            org_style.update({"display": "none"})
        else:
            org_style.pop("display", None)
        output_style_result.append(org_style)
    return output_style_result


if __name__ == "__main__":
    app.run(debug=False, host="0.0.0.0")
