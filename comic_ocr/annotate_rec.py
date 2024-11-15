from PIL import Image, ImageDraw
from PIL.ImageDraw import ImageDraw as ImageDrawType
import os
from typing import List,Tuple,Optional

def draw_polygon(draw: ImageDrawType, points: list[tuple[int, int]], color: str):
    draw.polygon(points, outline=color, width=1)


def draw_quadrilateral(image_path, coordinates,coordinates_words=None):
    """
    载入彩色图片，在指定坐标绘制四边形，并保存到本地。

    :param image_path: 原始图片路径
    :param coordinates: 格式：[[{"x": 26, "y": 117}, {"x": 177, "y": 117}, {"x": 177, "y": 143}, {"x": 26, "y": 143}]]
    :param output_path: 保存图片的路径
    """
    image = Image.open(image_path).convert("RGB")
    draw = ImageDraw.Draw(image)

    for coordinate in coordinates:
        points = [(point["x"], point["y"]) for point in coordinate]
        draw_polygon(draw, points, "red")

    if coordinates_words:
        for coordinate in coordinates_words:
            points = [(point["x"], point["y"]) for point in coordinate]
            draw_polygon(draw, points, "green")

    image.save("_annotate".join(os.path.splitext(image_path)))


if __name__ == "__main__":
    image_path = r"C:\Users\sisplayer\Downloads\sample_5ef169b4127970d6a7cf89ff7069f520.jpg"
    coordinates = [[{"x": 26, "y": 117}, {"x": 177, "y": 117}, {"x": 177, "y": 143}, {"x": 26, "y": 143}]]
    draw_quadrilateral(image_path, coordinates)
