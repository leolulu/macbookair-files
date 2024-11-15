import json

import matplotlib.pyplot as plt
import numpy as np
from kneed import KneeLocator
from sklearn.cluster import DBSCAN
from sklearn.neighbors import NearestNeighbors

from parse_azure_ocr_result import parse_line_and_words_boundary

# 加载和处理数据
with open(r"C:\Users\sisplayer\Downloads\result.json", "r", encoding="utf-8") as f:
    data = f.read().strip()
data = json.loads(data)
line_coordinates, words_coordinates = parse_line_and_words_boundary(data)
data = []
for line in words_coordinates:
    data.append(
        [
            min(min([i["x"] for i in line]), max([i["x"] for i in line])),
            -min(min([i["y"] for i in line]), max([i["y"] for i in line])),
        ]
    )

source_data = np.array(data)


# 自动确定 eps
def find_eps(data, k=4):
    """
    使用k-距离图和肘部法确定DBSCAN的eps值
    """
    nearest_neighbors = NearestNeighbors(n_neighbors=k)
    neighbors = nearest_neighbors.fit(data)
    distances, indices = neighbors.kneighbors(data)
    distances = np.sort(distances[:, k - 1])
    kn = KneeLocator(range(len(distances)), distances, curve="convex", direction="increasing")
    return distances[kn.knee]


eps = find_eps(source_data, k=4)
print(f"自动确定的eps值: {eps}")

# 设置min_samples，可以根据数据维度进行调整
min_samples = 2 * source_data.shape[1]
print(f"设置的min_samples值: {min_samples}")

# 应用DBSCAN
dbscan = DBSCAN(eps=eps, min_samples=min_samples)  # type: ignore
y_dbscan = dbscan.fit_predict(source_data)

# 绘制DBSCAN聚类结果
plt.figure(figsize=(8, 6))
unique_labels = set(y_dbscan)
colors = plt.cm.Spectral(np.linspace(0, 1, len(unique_labels)))  # type: ignore

for label, col in zip(unique_labels, colors):
    if label == -1:
        col = "k"  # 噪声点为黑色
    plt.scatter(
        source_data[y_dbscan == label, 0],
        source_data[y_dbscan == label, 1],
        s=100,
        c=[col],
        label=f"cluster {label}" if label != -1 else "noise",
    )

plt.title("DBSCAN result")
plt.xlabel("X coordinate")
plt.ylabel("Y coordinate")
plt.legend()
plt.show()
