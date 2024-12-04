import os
import random
import re
from typing import List

import dash
from dash import dcc, html
from PIL import Image

app = dash.Dash(__name__)

pic_max_height = 475
PRELOAD_IMG_URL = "assets/Russian-Cute-Sexy-Girl.jpg"

img_path_list = []
browsed_img_list = []

show_folder_title = False
show_moving_promote = False


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
page_capacity = 5

app.layout = html.Div(
    [
        html.Div(style={"display": "flex", "flex-wrap": "wrap", "justify-content": "left"}, id="container"),
        html.Div(
            [
                html.Div(html.A(html.Button([html.Div(id="button_text"), html.Div(id="remain_count")], id="get_pics"), href="#container")),
                html.Div(
                    html.Div(
                        [
                            dcc.Slider(min=2, max=600, step=2, value=page_capacity, updatemode="drag", id="slider1"),
                            dcc.Slider(min=100, max=1500, step=1, value=pic_max_height, updatemode="drag", id="slider2"),
                        ],
                        style={"display": "flex", "flex-direction": "column"},
                    )
                ),
            ],
            id="button_container",
            style={"float": "right"},
        ),
    ]
)


@app.callback(
    dash.dependencies.Output("container", "children"),
    dash.dependencies.Output("remain_count", "children"),
    dash.dependencies.Input("get_pics", "n_clicks"),
)
def popup_100_pics(n_clicks):
    global img_path_list
    return_list = []
    previous_img_catalog = "〄 " + "default".capitalize()
    for idx in range(page_capacity):
        try:
            img_path = img_path_list.pop(0)
            current_img_catalog = "〄 " + img_path.split("/")[-2].capitalize()
        except IndexError:
            break
        if current_img_catalog != previous_img_catalog and show_folder_title:
            return_list.append(html.H1(current_img_catalog, id="img_catalog_" + current_img_catalog, style={"width": "100%"}))
            previous_img_catalog = current_img_catalog
        return_list.append(
            html.Video(
                src=img_path,
                muted=True,
                autoPlay=True,
                controls=True,
                loop=True,
                style={"max-height": "380px", "vertical-align": "middle"},
                id={"type": "pics", "index": idx},
            )
            if os.path.splitext(img_path)[-1].lower() in [".mp4", ".mov", ".avi", ".flv", ".mkv", ".ts", ".webm", ".m4v", ".tbnl"]
            else html.A(
                html.Img(
                    className=img_path,
                    src=PRELOAD_IMG_URL,
                    style={"max-height": "380px", "vertical-align": "middle"},
                    id={"type": "pics", "index": idx},
                ),
                href=img_path,
                target="_blank",
            )
        )
        browsed_img_list.append(img_path)
    if len(img_path_list) == 0:
        img_path_list = get_img_path_list(img_path_list)
    remain_count = "还剩{}张".format(len(img_path_list))
    if len([i for i in return_list if isinstance(i, html.H1)]) == 1 and show_moving_promote:
        return_list.insert(0, html.H1("Only one category in the page!", id="promotion"))
    return return_list, remain_count


@app.callback(dash.dependencies.Output("button_text", "children"), dash.dependencies.Input("slider1", "value"))
def set_page_capacity(s_value):
    global page_capacity
    page_capacity = s_value
    button_text = "再来{}张！".format(page_capacity)
    return button_text


@app.callback(
    dash.dependencies.Output({"type": "pics", "index": dash.dependencies.ALL}, "style"),
    dash.dependencies.Input("slider2", "value"),
    dash.dependencies.State({"type": "pics", "index": dash.dependencies.ALL}, "children"),
)
def det_pic_height(s_value, pics):
    global pic_max_height
    pic_max_height = s_value
    return [{"max-height": f"{pic_max_height}px", "vertical-align": "middle"} for i in range(len(pics))]


if __name__ == "__main__":
    app.run_server(debug=False, host="0.0.0.0")
