import base64
import json
import os
import subprocess
import time
from copy import deepcopy
from time import sleep
from typing import Any, Dict, List

import psutil
import requests


def kill_subprocess_recursively(p: subprocess.Popen):
    process = psutil.Process(p.pid)
    for proc in process.children(recursive=True):
        proc.kill()
    process.kill()


def establish_temp_proxy_server_with_v2fly(
    links: List[str],
    v2ray_config_template_file_name,
    v2ray_config_file_name,
    log_file_name,
    log_to_file=False,
    print_command=False,
):
    def parse_link(link) -> Dict[str, Any]:
        link_info = json.loads(base64.b64decode(link.replace("vmess://", "")).decode("utf-8"))
        if link_info["type"] != "none":
            print(link_info)
            raise UserWarning("遇到不支持解析的config...")
        return link_info

    links_info = [parse_link(l) for l in links]
    with open(v2ray_config_template_file_name, "r", encoding="utf-8") as f:
        v2ray_config = json.loads(f.read().strip())
    outbound_template = v2ray_config["outbounds"][0]
    new_outbounds = []
    for idx, link_info in enumerate(links_info):
        temp_outbound = deepcopy(outbound_template)
        temp_outbound["tag"] = f"out{idx}"
        temp_outbound["settings"]["vnext"] = [
            {
                "address": link_info["add"],
                "port": int(link_info["port"]),
                "users": [
                    {
                        "id": link_info["id"],
                        "alterId": int(link_info["aid"]),
                        "security": "auto",
                    }
                ],
            }
        ]
        temp_outbound["streamSettings"]["network"] = link_info["net"]
        if link_info["net"] == "ws":
            temp_outbound["streamSettings"]["wsSettings"] = {
                "path": link_info["path"],
                "headers": {"Host": link_info["host"]} if link_info["host"] else {},
            }
        if link_info["tls"] == "tls":
            temp_outbound["streamSettings"]["security"] = "tls"
            temp_outbound["streamSettings"]["tlsSettings"] = {"allowInsecure": True}
        new_outbounds.append(temp_outbound)
    v2ray_config["outbounds"] = new_outbounds

    with open(v2ray_config_file_name, "w", encoding="utf-8") as f:
        f.write(json.dumps(v2ray_config, indent=2))

    command = f"v2ray.exe run -c {v2ray_config_file_name} "
    if log_to_file:
        command += f' >> "{log_file_name}" 2>&1'
    if print_command:
        print(command)
    return subprocess.run(command, shell=True)


def establish_temp_proxy_server_with_multiple_links(
    links: List[str],
    v2ray_config_template_file_name,
    v2ray_config_file_name,
    log_file_name,
    log_to_file=False,
    print_command=False,
):
    def parse_link(link) -> Dict[str, Any]:
        link_info = json.loads(base64.b64decode(link.replace("vmess://", "")).decode("utf-8"))
        if link_info["type"] != "none" or link_info["tls"] != "":
            print(link_info)
            raise UserWarning("遇到不支持解析的config...")
        return link_info

    links_info = [parse_link(l) for l in links]
    with open(v2ray_config_template_file_name, "r", encoding="utf-8") as f:
        v2ray_config = json.loads(f.read().strip())
    outbound_info = v2ray_config["outbounds"][0]
    vnext = []
    for link_info in links_info:
        vnext.append(
            {
                "address": link_info["add"],
                "port": int(link_info["port"]),
                "users": [
                    {
                        "id": link_info["id"],
                        "alterId": int(link_info["aid"]),
                        "security": "auto",
                    }
                ],
            }
        )
    outbound_info["settings"]["vnext"] = vnext
    outbound_info["streamSettings"]["network"] = list(set([i["net"] for i in links_info]))[0]
    v2ray_config["outbounds"] = [outbound_info]
    with open(v2ray_config_file_name, "w", encoding="utf-8") as f:
        f.write(json.dumps(v2ray_config, indent=2))

    command = f"v2ray.exe -config {v2ray_config_file_name} "
    if log_to_file:
        command += f' >> "{log_file_name}" 2>&1'
    if print_command:
        print(command)
    return subprocess.run(command, shell=True)


def establish_temp_proxy_server(
    link: str,
    v2ray_config_template_file_name,
    v2ray_config_file_name,
    log_file_name,
    log_to_file=False,
    print_command=False,
):
    link_info = json.loads(base64.b64decode(link.replace("vmess://", "")).decode("utf-8"))
    if link_info["type"] != "none" or link_info["tls"] != "":
        print(link_info)
        raise UserWarning("遇到不支持解析的config...")
    with open(v2ray_config_template_file_name, "r", encoding="utf-8") as f:
        v2ray_config = json.loads(f.read().strip())
    outbound_info = v2ray_config["outbounds"][0]
    outbound_info["settings"]["vnext"] = [
        {
            "address": link_info["add"],
            "port": int(link_info["port"]),
            "users": [
                {
                    "id": link_info["id"],
                    "alterId": int(link_info["aid"]),
                    "security": "auto",
                }
            ],
        }
    ]
    outbound_info["streamSettings"]["network"] = link_info["net"]
    v2ray_config["outbounds"] = [outbound_info]
    with open(v2ray_config_file_name, "w", encoding="utf-8") as f:
        f.write(json.dumps(v2ray_config, indent=2))

    command = f"v2ray.exe -config {v2ray_config_file_name} "
    if log_to_file:
        command += f' >> "{log_file_name}" 2>&1'
    if print_command:
        print(command)
    return subprocess.Popen(command, shell=True)


def establish_temp_proxy_server_legacy(
    link: str,
    temp_proxy_server_port=10808,
    log_to_file=False,
    log_file_name="temp_proxy_server_for_local_proxy.log",
    print_command=False,
):
    command = f'lite-windows-amd64.exe -p {temp_proxy_server_port} "{link}"'
    if log_to_file:
        command += f' >> "{log_file_name}" 2>&1'
    if print_command:
        print(command)
    return subprocess.Popen(command, shell=True)


def test_by_website(
    test_website_url,
    proxy_str=f"http://127.0.0.1:10809",
    print_exception=False,
):
    try:
        proxies = {"http": proxy_str, "https": proxy_str}
        response = requests.get(test_website_url, proxies=proxies, timeout=10)
        response.raise_for_status()
        return True
    except Exception as e:
        if print_exception:
            print(e)
        return False


def test_by_youtube(proxy_str):
    return test_by_website("https://www.youtube.com/", proxy_str=proxy_str)


def test_by_website_with_retry(test_website_url, max_retry=5, retry_interval=1):
    fail_times = 0
    while fail_times <= max_retry:
        if test_by_website(test_website_url):
            return True
        else:
            fail_times += 1
            sleep(retry_interval)
    return False


class LocalKVDatabase:
    KV_DELIMITER = ": "
    ITEM_DELIMITER = "\n"

    def __init__(self, db_file_path) -> None:
        self.db_file_path = db_file_path

    def get_all_kv(self):
        if not os.path.exists(self.db_file_path):
            return dict()
        with open(self.db_file_path, "r", encoding="utf-8") as f:
            data = f.read().strip()
        data = {
            k: v for (k, v) in [item.split(LocalKVDatabase.KV_DELIMITER, maxsplit=1) for item in data.split(LocalKVDatabase.ITEM_DELIMITER)]
        }
        return data

    def read_value_by_key(self, key):
        data = self.get_all_kv()
        return data.get(key)

    def write_value_by_key(self, key, value):
        data = self.get_all_kv()
        data[key] = value
        with open(self.db_file_path, "w", encoding="utf-8") as f:
            f.write(LocalKVDatabase.ITEM_DELIMITER.join([LocalKVDatabase.KV_DELIMITER.join(item) for item in data.items()]))


def get_current_time_formatted_string():
    return "更新时间：{}".format(time.strftime("%Y-%m-%d %H:%M:%S", time.localtime()))
