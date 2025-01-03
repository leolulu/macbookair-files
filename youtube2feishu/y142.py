import os
import subprocess
import sys
import time

temp_folder = str(int(time.time()))
if not os.path.exists(temp_folder):
    os.mkdir(temp_folder)
log_folder = 'logs'
if not os.path.exists(log_folder):
    os.mkdir(log_folder)
log_path = os.path.join(log_folder, f'{temp_folder}.log')

command = 'python yt_dlp_tool.py  --temp_folder_name "{temp_folder_name}" --dl_dir "{dl_dir}" --postprefix "__l0" {url} > {log_path} 2>&1'.format(
    dl_dir=r"\\192.168.123.222\folder_for_142",
    url=sys.argv[1],
    log_path=log_path,
    temp_folder_name=temp_folder
)
print(command)
subprocess.Popen(command, shell=True)
