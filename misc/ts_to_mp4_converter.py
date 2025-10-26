#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TS文件转MP4文件脚本
将指定目录及其子目录中的所有TS文件转换为MP4文件
"""

import os
import subprocess
import sys
import argparse
import time
import shutil
from pathlib import Path


def check_dependencies():
    """
    检查必要的依赖是否已安装
    
    Returns:
        bool: 所有依赖是否都已安装
    """
    # 检查ffmpeg是否可用
    try:
        result = subprocess.run(['ffmpeg', '-version'],
                              capture_output=True, text=True, check=True)
        print(f"检测到ffmpeg: {result.stdout.split()[2]}")
    except (subprocess.CalledProcessError, FileNotFoundError):
        print("错误: 未检测到ffmpeg，请确保ffmpeg已安装并添加到PATH中")
        return False
    
    return True


def get_file_size(file_path):
    """
    获取文件大小（MB）
    
    Args:
        file_path (str): 文件路径
    
    Returns:
        float: 文件大小（MB）
    """
    try:
        size_bytes = os.path.getsize(file_path)
        return round(size_bytes / (1024 * 1024), 2)
    except OSError:
        return 0


def format_time(seconds):
    """
    格式化时间显示
    
    Args:
        seconds (float): 秒数
    
    Returns:
        str: 格式化后的时间字符串
    """
    if seconds < 60:
        return f"{int(seconds)}秒"
    elif seconds < 3600:
        minutes = int(seconds // 60)
        secs = int(seconds % 60)
        return f"{minutes}分{secs}秒"
    else:
        hours = int(seconds // 3600)
        minutes = int((seconds % 3600) // 60)
        secs = int(seconds % 60)
        return f"{hours}小时{minutes}分{secs}秒"


def convert_ts_to_mp4(input_file, output_file):
    """
    使用ffmpeg将TS文件转换为MP4文件
    
    Args:
        input_file (str): 输入的TS文件路径
        output_file (str): 输出的MP4文件路径
    
    Returns:
        bool: 转换是否成功
    """
    try:
        # 获取输入文件大小
        input_size = get_file_size(input_file)
        
        # 使用ffmpeg进行转换，使用-c copy参数进行无损remux
        cmd = [
            'ffmpeg',
            '-i', input_file,
            '-c', 'copy',  # 无损复制音视频流
            '-y',  # 覆盖已存在的输出文件
            '-loglevel', 'error',  # 只显示错误信息
            output_file
        ]
        
        print(f"正在转换: {input_file} ({input_size}MB)")
        start_time = time.time()
        
        # 运行ffmpeg命令
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        
        end_time = time.time()
        conversion_time = round(end_time - start_time, 2)
        
        if result.returncode == 0:
            # 检查输出文件是否存在且大小合理
            if os.path.exists(output_file):
                output_size = get_file_size(output_file)
                if output_size > 0:
                    print(f"转换成功: {output_file} ({output_size}MB, 耗时: {conversion_time}秒)")
                    return True
                else:
                    print(f"转换失败: 输出文件大小为0 - {input_file}")
                    return False
            else:
                print(f"转换失败: 输出文件未创建 - {input_file}")
                return False
        else:
            print(f"转换失败: {input_file}")
            if result.stderr:
                print(f"错误信息: {result.stderr}")
            return False
            
    except subprocess.CalledProcessError as e:
        print(f"转换过程中发生错误: {input_file}")
        if e.stderr:
            print(f"错误信息: {e.stderr}")
        return False
    except Exception as e:
        print(f"未知错误: {input_file}")
        print(f"错误信息: {str(e)}")
        return False


def find_and_convert_ts_files(directory, delete_original=False):
    """
    查找目录及其子目录中的所有TS文件并转换为MP4
    
    Args:
        directory (str): 要搜索的目录路径
        delete_original (bool): 是否删除原始TS文件
    
    Returns:
        tuple: (成功转换的文件数, 失败的文件数, 跳过的文件数)
    """
    success_count = 0
    failure_count = 0
    skipped_count = 0
    total_size_before = 0  # 转换前的总大小
    total_size_after = 0   # 转换后的总大小
    total_conversion_time = 0  # 总转换时间
    start_time = time.time()    # 开始处理时间
    
    # 确保目录存在
    if not os.path.isdir(directory):
        print(f"错误: 目录不存在 - {directory}")
        return (0, 0, 0)
    
    print(f"开始扫描目录: {directory}")
    
    # 首先扫描所有TS文件
    ts_files = []
    for root, dirs, files in os.walk(directory):
        for file in files:
            if file.lower().endswith('.ts'):
                ts_file_path = os.path.join(root, file)
                ts_files.append(ts_file_path)
    
    total_files = len(ts_files)
    if total_files == 0:
        print("未找到任何TS文件")
        return (0, 0, 0)
    
    print(f"找到 {total_files} 个TS文件")
    print("-" * 60)
    
    # 处理每个TS文件
    for i, ts_file_path in enumerate(ts_files, 1):
        mp4_file_path = os.path.splitext(ts_file_path)[0] + '.mp4'
        
        # 显示进度
        print(f"[{i}/{total_files}] 处理文件: {os.path.basename(ts_file_path)}")
        
        # 如果MP4文件已存在，跳过转换
        if os.path.exists(mp4_file_path):
            print(f"  -> MP4文件已存在，跳过转换")
            skipped_count += 1
            print("-" * 40)
            continue
        
        # 获取原始文件大小
        original_size = get_file_size(ts_file_path)
        total_size_before += original_size
        
        # 转换文件
        file_start_time = time.time()
        if convert_ts_to_mp4(ts_file_path, mp4_file_path):
            file_end_time = time.time()
            file_conversion_time = file_end_time - file_start_time
            total_conversion_time += file_conversion_time
            
            success_count += 1
            
            # 获取转换后文件大小
            converted_size = get_file_size(mp4_file_path)
            total_size_after += converted_size
            
            # 显示文件大小变化
            size_diff = converted_size - original_size
            size_percent = round((size_diff / original_size) * 100, 2) if original_size > 0 else 0
            size_change = f"+{size_diff}MB (+{size_percent}%)" if size_diff > 0 else f"{size_diff}MB ({size_percent}%)"
            print(f"  -> 文件大小变化: {original_size}MB -> {converted_size}MB ({size_change})")
            
            # 计算并显示处理时间和预估剩余时间
            elapsed_time = time.time() - start_time
            if success_count > 0:
                avg_time_per_file = total_conversion_time / success_count
                remaining_files = total_files - i
                estimated_remaining_time = avg_time_per_file * remaining_files
                
                # 格式化时间显示
                elapsed_str = format_time(elapsed_time)
                remaining_str = format_time(estimated_remaining_time)
                
                print(f"  -> 已用时间: {elapsed_str}, 预估剩余: {remaining_str}")
            
            # 如果需要删除原始文件
            if delete_original:
                try:
                    os.remove(ts_file_path)
                    print(f"  -> 已删除原始文件: {os.path.basename(ts_file_path)}")
                except Exception as e:
                    print(f"  -> 删除原始文件失败: {os.path.basename(ts_file_path)}")
                    print(f"     错误信息: {str(e)}")
        else:
            failure_count += 1
        
        print("-" * 40)
    
    # 显示总体统计信息
    total_elapsed_time = time.time() - start_time
    print("\n转换统计:")
    print(f"  总文件数: {total_files}")
    print(f"  成功转换: {success_count}")
    print(f"  转换失败: {failure_count}")
    print(f"  跳过文件: {skipped_count}")
    print(f"  总处理时间: {format_time(total_elapsed_time)}")
    
    if total_size_before > 0:
        total_size_diff = total_size_after - total_size_before
        total_size_percent = round((total_size_diff / total_size_before) * 100, 2)
        total_size_change = f"+{total_size_diff}MB (+{total_size_percent}%)" if total_size_diff > 0 else f"{total_size_diff}MB ({total_size_percent}%)"
        print(f"  总大小变化: {total_size_before}MB -> {total_size_after}MB ({total_size_change})")
    
    if success_count > 0:
        avg_time_per_file = total_conversion_time / success_count
        print(f"  平均转换时间: {format_time(avg_time_per_file)}/文件")
    
    return (success_count, failure_count, skipped_count)


def main():
    # 打印标题
    print("=" * 60)
    print("TS文件转MP4文件转换器")
    print("=" * 60)
    
    # 检查依赖
    if not check_dependencies():
        print("请安装必要的依赖后重试")
        sys.exit(1)
    
    # 设置命令行参数解析
    parser = argparse.ArgumentParser(
        description='将目录及其子目录中的TS文件转换为MP4文件',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
使用示例:
  python ts_to_mp4_converter.py "D:\\Videos"          # 转换并删除原始TS文件
  python ts_to_mp4_converter.py "D:\\Videos" --keep   # 转换并保留原始TS文件
        """
    )
    parser.add_argument('directory', help='要处理的目录路径')
    parser.add_argument('--keep', action='store_true',
                       help='保留原始TS文件（默认情况下会删除转换成功的TS文件）')
    
    args = parser.parse_args()
    
    # 获取绝对路径
    target_directory = os.path.abspath(args.directory)
    
    print(f"目标目录: {target_directory}")
    print(f"删除原始文件: {'否' if args.keep else '是'}")
    print("-" * 60)
    
    # 执行转换（默认删除原始文件，除非指定了--keep参数）
    success, failure, skipped = find_and_convert_ts_files(target_directory, not args.keep)
    
    print("=" * 60)
    print(f"转换完成!")
    print(f"成功转换: {success} 个文件")
    print(f"转换失败: {failure} 个文件")
    print(f"跳过文件: {skipped} 个文件")
    
    if failure > 0:
        print(f"警告: 有 {failure} 个文件转换失败")
        print("=" * 60)
        sys.exit(1)
    else:
        print("所有文件处理完成!")
        print("=" * 60)


if __name__ == "__main__":
    main()