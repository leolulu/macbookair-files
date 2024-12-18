import base64
import json
import os
import pickle
import re
import subprocess
import time
import traceback
from collections import deque
from datetime import datetime
from typing import Optional

import chardet
import requests

from utils import LocalKVDatabase, establish_temp_proxy_server_legacy, kill_subprocess_recursively, test_by_youtube


class ProxyNode:
    TYPE_VMESS = "vmess"
    TYPE_TROJAN = "trojan"
    TYPE_UNDEFINE = "undefine"

    def __init__(self, link: str) -> None:
        self.link = link
        self.avg_speeds = deque(maxlen=10)
        self.fail_streak = 0
        self.name = None
        self.type = self.judge_node_type(link)
        self.birth_time = datetime.now()
        self.parse_link()

    def __eq__(self, other: object) -> bool:
        if isinstance(other, ProxyNode):
            if self.addr:
                return self.addr == other.addr
            else:
                return self.link == other.link
        return False

    def __hash__(self) -> int:
        if self.addr:
            return hash(self.addr)
        else:
            return hash(self.link)

    def parse_link(self):
        try:
            if self.link.lower().startswith("vmess"):
                self.link_info = json.loads(base64.b64decode(self.link.replace("vmess://", "")).decode("utf-8"))
                self.addr = self.link_info["add"]
            else:
                self.addr = None
        except:
            self.addr = None

    def judge_node_type(self, link):
        if link.lower().startswith(ProxyNode.TYPE_VMESS):
            return ProxyNode.TYPE_VMESS
        elif link.lower().startswith(ProxyNode.TYPE_TROJAN):
            return ProxyNode.TYPE_TROJAN
        else:
            return ProxyNode.TYPE_UNDEFINE

    def mark_fail_streak(self, isok: bool):
        if isok:
            self.fail_streak = 0
        else:
            self.fail_streak += 1

    @property
    def longterm_avg_speed(self):
        if not self.avg_speeds:
            return 0
        else:
            return int(sum(self.avg_speeds) / len(self.avg_speeds))

    @property
    def isok(self):
        return self.fail_streak == 0

    @property
    def survival_info(self):
        datetime_format = r"%Y-%m-%d %H:%M:%S"
        death_time = datetime.now()
        survival_duration = death_time - self.birth_time
        return (
            datetime.strftime(self.birth_time, datetime_format),
            datetime.strftime(death_time, datetime_format),
            round(survival_duration.total_seconds() / 3600, 1),
        )


class BLL_PROXY_GETTER:
    STREAM_ID = "stream_id"
    KVDB_PATH = "config.db"

    def __init__(self, top_node_count=5) -> None:
        self.kvdb = LocalKVDatabase(BLL_PROXY_GETTER.KVDB_PATH)
        self.default_proxy = "http://127.0.0.1:10809"
        self.active_proxy = self.default_proxy
        self.last_frame_file_name = "last.jpg"
        self.result_file_name_links = "filtered_node.txt"
        self.result_file_name_subscription = "filtered_node_subscription.txt"
        self.speed_test_output_file_name = "output.json"
        self.serialized_nodes_file_name = "proxy_nodes.pkl"
        self.temp_proxy_server_log_file_name = "temp_proxy_server.log"
        self.proxy_node_statistics_file_name = "proxy_node_statistics.txt"

        self.remove_useless_files(
            [
                self.result_file_name_links,
                self.speed_test_output_file_name,
                self.temp_proxy_server_log_file_name,
                self.result_file_name_subscription,
            ]
        )
        self.load_existing_nodes()
        self.top_node_count = top_node_count

    def load_existing_nodes(self):
        if os.path.exists(self.serialized_nodes_file_name):
            with open(self.serialized_nodes_file_name, "rb") as f:
                self.proxy_nodes = pickle.loads(f.read())
        else:
            self.proxy_nodes = set()

    def remove_useless_files(self, file_paths):
        for file_path in file_paths:
            if os.path.exists(file_path):
                os.remove(file_path)

    def set_proxy(self):
        os.environ["http_proxy"] = self.active_proxy
        os.environ["https_proxy"] = self.active_proxy

    def unset_proxy(self):
        os.environ.pop("http_proxy", None)
        os.environ.pop("https_proxy", None)

    def check_proxy_availability(self):
        alternative_proxy_port = 27653
        alternative_proxy = f"http://127.0.0.1:{alternative_proxy_port}"

        print(f"开始测试proxy可用性...")
        if test_by_youtube(self.active_proxy):
            print(f"默认proxy测试通过...")
            return None
        else:
            print(f"默认proxy不可用，尝试使用存量节点构建临时proxy...")
            for link in [i.link for i in self.proxy_nodes if i.isok]:
                print(f"尝试节点: {link[:50]}...")
                p = establish_temp_proxy_server_legacy(link, alternative_proxy_port, True, self.temp_proxy_server_log_file_name)
                if test_by_youtube(alternative_proxy):
                    print(f"替代节点测试成功，替换proxy...")
                    self.active_proxy = alternative_proxy
                    return p
                else:
                    kill_subprocess_recursively(p)

        raise UserWarning("没有可用的代理服务器(默认的与存量proxy节点)，跳过本轮环节...")

    def _obtain_stream_video_url_from_stream_id(self):
        self.set_proxy()
        stream_id = self.kvdb.read_value_by_key(BLL_PROXY_GETTER.STREAM_ID)
        if stream_id is None:
            self.kvdb.write_value_by_key(BLL_PROXY_GETTER.STREAM_ID, "在这里填入直播id")
            raise UserWarning(f'需要在"{BLL_PROXY_GETTER.KVDB_PATH}"中设置直播id')
        command = f"yt-dlp -g {self.kvdb.read_value_by_key(BLL_PROXY_GETTER.STREAM_ID)} | head -n 1"
        print(f"开始尝试获取直播视频地址...")
        process = subprocess.Popen(command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        output, error = process.communicate()
        self.unset_proxy()
        return process, output, error

    def _parse_stream_info_response(self, process, output, error):
        output_string = output.decode(str(chardet.detect(output)["encoding"])).strip()
        error_string = error.decode(str(chardet.detect(error)["encoding"])).strip()

        if process.returncode == 0:
            if "This live stream recording is not available" in error_string:
                print("直播id已过期，尝试获取新id...")
                return True
            self.steaming_url = output_string
            if not self.steaming_url:
                raise UserWarning(f"没有成功获取到视频地址：{error_string}")
            print(f"获取到直播视频真地址：{self.steaming_url[:50]}...")
        else:
            print("Error:", error_string)
            self.steaming_url = None

    def get_streaming_url(self):
        if self._parse_stream_info_response(*self._obtain_stream_video_url_from_stream_id()):
            self.set_proxy()
            res = requests.get("https://www.youtube.com/@bulianglin/streams")
            self.unset_proxy()
            new_stream_id = re.findall(r'"videoId":"(\S+?)".*?在线直播分享免费节点', res.text)[0]
            self.kvdb.write_value_by_key(BLL_PROXY_GETTER.STREAM_ID, new_stream_id)
            print(f"成功更新直播id...")
            self._parse_stream_info_response(*self._obtain_stream_video_url_from_stream_id())

    def get_last_frame(self):
        self.set_proxy()
        command = f'ffmpeg -hide_banner -loglevel error -i "{self.steaming_url}" -vframes 1 -y {self.last_frame_file_name}'
        print(f"开始尝试获取视频最后一帧，指令：\n{command[:100]}...")
        subprocess.run(command, shell=True)
        self.unset_proxy()

    def get_qr_data(self):
        url = "http://api.qrserver.com/v1/read-qr-code/"
        with open(self.last_frame_file_name, "rb") as f:
            files = {"file": f}
            response = requests.post(url, files=files)
        response.raise_for_status()
        link = json.loads(response.content)[0]["symbol"][0]["data"]
        self.deal_with_link(link)
        os.remove(self.last_frame_file_name)

    def deal_with_link(self, link: str):
        if link == "":
            raise UserWarning("二维码解析结果为空...")
        if link.lower().startswith("ss"):
            print(f"节点为ss系，跳过...")
            return
        if link.lower().startswith("trojan") and len(self.proxy_nodes) >= self.top_node_count:
            print(f"节点为trojan类型，跳过...")
            return
        print(f"获取到当前图像的二维码内容：\n{link}")
        self.proxy_nodes.add(ProxyNode(link))

    def find_node_by_link(self, link):
        for proxy_node in self.proxy_nodes:
            if proxy_node.link == link:
                return proxy_node
        return None

    def test_node_speed(self):
        if not self.proxy_nodes:
            print(f"节点池中没有节点，跳过测速环节...")
            return
        print(f"准备开始测速，当前节点池里面共有{len(self.proxy_nodes)}个节点...")

        for proxy_node in self.proxy_nodes:
            link_str = proxy_node.link
            command = f'lite-windows-amd64.exe -config config.json -test "{link_str}" >nul 2>&1'
            print(f"开始测速，指令：\n{command[:100]}...")
            try:
                subprocess.run(command, shell=True, timeout=60)
                with open("output.json", "r", encoding="utf-8") as f:
                    all_result = json.loads(f.read())
                for node_result in all_result["nodes"]:
                    proxy_node = self.find_node_by_link(node_result["link"])
                    if proxy_node:
                        isok = node_result["isok"]
                        proxy_node.mark_fail_streak(isok)
                        if isok:
                            proxy_node.avg_speeds.append(node_result["avg_speed"])
                        if not proxy_node.name:
                            proxy_node.name = node_result["remarks"]
                        break
                    else:
                        print(f"[DEBUG]竟然有link在node库里面找不到，奇了个怪了...")
            except (subprocess.TimeoutExpired, FileNotFoundError) as e:
                print(f"测速超时，跳过当前节点本轮测速，标记测速失败...{e}")
                node = self.find_node_by_link(link_str)
                if node:
                    node.mark_fail_streak(False)
                else:
                    print(f"[DEBUG]无法通过link匹配节点...")

        nodes_to_remove = []
        for proxy_node in self.proxy_nodes:
            if proxy_node.fail_streak >= 10:
                nodes_to_remove.append(proxy_node)
        for node_to_remove in nodes_to_remove:
            self.proxy_nodes.remove(node_to_remove)
            print(f"节点{node_to_remove.name}测速失败过多，已剔除...")
            self.save_node_statistics(node_to_remove)

        top_nodes = sorted(
            [i for i in self.proxy_nodes if i.isok and i.type == ProxyNode.TYPE_VMESS], key=lambda x: x.longterm_avg_speed, reverse=True
        )[: self.top_node_count]
        if len(top_nodes) < self.top_node_count:
            top_nodes.extend(
                sorted(
                    [i for i in self.proxy_nodes if i.isok and i.type == ProxyNode.TYPE_TROJAN],
                    key=lambda x: x.longterm_avg_speed,
                    reverse=True,
                )[: self.top_node_count - len(top_nodes)]
            )

        if top_nodes:
            result_output_content = "{}\n\n{}\n\n更新时间: {}".format(
                "\n".join([i.link for i in top_nodes]),
                "\n".join([f"{round(i.longterm_avg_speed/1024/1024,2)}MB/S - {i.name}" for i in top_nodes]),
                time.strftime("%Y-%m-%d %H:%M:%S", time.localtime()),
            )
            with open(self.result_file_name_links, "w", encoding="utf-8") as f:
                f.write(result_output_content)

        os.remove(self.speed_test_output_file_name)

    def save_node_statistics(self, node: ProxyNode):
        info = node.survival_info
        with open(self.proxy_node_statistics_file_name, "a", encoding="utf-8") as f:
            if len(node.avg_speeds) == 0:
                avg_speed = "premature death"
            else:
                avg_speed = f"{round(sum(node.avg_speeds)/len(node.avg_speeds)/1024/1024,1)}MB/s"
            f.write(
                f"节点名称: {node.name}\n节点类型: {node.type}\n平均测速: {avg_speed}\n加入时间: {info[0]}\n剔除时间: {info[1]}\n生存时长: {info[2]}小时\n\n"
            )

    def save_nodes(self):
        if self.proxy_nodes:
            serialized_obj = pickle.dumps(self.proxy_nodes)
            with open(self.serialized_nodes_file_name, "wb") as file:
                file.write(serialized_obj)

    def send_result_file_to_dufs(self):
        if not os.path.exists(self.result_file_name_links):
            return
        # 结果列表文件
        url = f"http://t.bad-sql.top:1127/Saladict/{self.result_file_name_links}"
        with open(self.result_file_name_links, "rb") as f:
            response = requests.put(url, data=f)
            response.raise_for_status()
        # 订阅文件
        url = f"http://t.bad-sql.top:1127/Saladict/{self.result_file_name_subscription}"
        with open(self.result_file_name_links, "r", encoding="utf-8") as f:
            result = f.read()
        with open(self.result_file_name_subscription, "w", encoding="utf-8") as f:
            f.write(base64.b64encode(result.encode("utf-8")).decode("utf-8"))
        with open(self.result_file_name_subscription, "rb") as f:
            response = requests.put(url, data=f)
            response.raise_for_status()
        print(f"测速完毕，结果已保存...\n")

    def reset_proxy_if_necessary(self, p: Optional[subprocess.Popen]):
        if p:
            kill_subprocess_recursively(p)
            self.active_proxy = self.default_proxy
            print(f"替代proxy下线，恢复默认proxy，关闭temp proxy server...")

    def run(self):
        temp_proxy_server_subprocess = self.check_proxy_availability()
        self.get_streaming_url()
        self.get_last_frame()
        self.reset_proxy_if_necessary(temp_proxy_server_subprocess)
        self.get_qr_data()
        self.test_node_speed()
        self.save_nodes()
        self.send_result_file_to_dufs()


if __name__ == "__main__":
    raw_round_interval = 600
    top_node_count = 10
    bll = BLL_PROXY_GETTER(top_node_count=top_node_count)
    for _ in range(5):
        last_btime = time.time()
        try:
            bll.run()
        except:
            traceback.print_exc()
        organic_round_interval = 30 if len(bll.proxy_nodes) < top_node_count else raw_round_interval
        while time.time() - last_btime < organic_round_interval:
            print(f"等待下一轮测速，剩余时间：{int(organic_round_interval - (time.time() - last_btime))}秒...")
            time.sleep(10)
