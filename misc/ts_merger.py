#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TS文件合并脚本
将指定目录及其子目录中的每个目录内的所有TS文件合并成一个MP4文件
生成的MP4文件保存在脚本所在目录
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
                              capture_output=True, text=True, check=True, encoding='utf-8', errors='replace')
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


def create_file_list(ts_files, list_file_path):
    """
    创建文件列表，用于ffmpeg的concat demuxer
    
    Args:
        ts_files (list): TS文件路径列表
        list_file_path (str): 文件列表输出路径
    
    Returns:
        bool: 是否成功创建文件列表
    """
    try:
        with open(list_file_path, 'w', encoding='utf-8') as f:
            for ts_file in ts_files:
                # 使用绝对路径，避免跨驱动器路径问题
                abs_path = os.path.abspath(ts_file)
                # Windows路径只需要替换反斜杠为正斜杠
                abs_path = abs_path.replace('\\', '/')
                f.write(f"file '{abs_path}'\n")
        return True
    except Exception as e:
        print(f"创建文件列表失败: {str(e)}")
        return False


def merge_ts_files(ts_files, output_file, delete_original=False):
    """
    将多个TS文件合并成一个MP4文件
    
    Args:
        ts_files (list): TS文件路径列表
        output_file (str): 输出的MP4文件路径
        delete_original (bool): 是否删除原始TS文件
    
    Returns:
        bool: 合并是否成功
    """
    if len(ts_files) == 0:
        print("错误: 没有TS文件需要合并")
        return False
    
    # 计算原始文件总大小
    total_original_size = sum(get_file_size(ts_file) for ts_file in ts_files)
    
    # 创建临时文件列表
    temp_list_file = os.path.join(os.path.dirname(output_file), "filelist.txt")
    if not create_file_list(ts_files, temp_list_file):
        return False
    
    try:
        print(f"正在合并 {len(ts_files)} 个TS文件...")
        print(f"原始总大小: {total_original_size}MB")
        
        start_time = time.time()
        
        # 使用ffmpeg的concat demuxer进行合并
        cmd = [
            'ffmpeg',
            '-f', 'concat',  # 使用concat demuxer
            '-safe', '0',    # 允许不安全的文件路径
            '-i', temp_list_file,
            '-c', 'copy',   # 无损复制音视频流
            '-y',           # 覆盖已存在的输出文件
            '-loglevel', 'error',  # 只显示错误信息
            output_file
        ]
        
        # 使用UTF-8编码处理输出
        result = subprocess.run(cmd, capture_output=True, text=True, check=True, encoding='utf-8', errors='replace')
        
        end_time = time.time()
        conversion_time = round(end_time - start_time, 2)
        
        if result.returncode == 0:
            # 检查输出文件是否存在且大小合理
            if os.path.exists(output_file):
                output_size = get_file_size(output_file)
                if output_size > 0:
                    print(f"合并成功: {output_file} ({output_size}MB, 耗时: {conversion_time}秒)")
                    
                    # 显示文件大小变化
                    size_diff = output_size - total_original_size
                    size_percent = round((size_diff / total_original_size) * 100, 2) if total_original_size > 0 else 0
                    size_change = f"+{size_diff}MB (+{size_percent}%)" if size_diff > 0 else f"{size_diff}MB ({size_percent}%)"
                    print(f"文件大小变化: {total_original_size}MB -> {output_size}MB ({size_change})")
                    
                    # 如果需要删除原始文件
                    if delete_original:
                        deleted_count = 0
                        for ts_file in ts_files:
                            try:
                                os.remove(ts_file)
                                deleted_count += 1
                            except Exception as e:
                                print(f"删除原始文件失败: {ts_file}")
                                print(f"错误信息: {str(e)}")
                        print(f"已删除 {deleted_count}/{len(ts_files)} 个原始TS文件")
                    
                    return True
                else:
                    print(f"合并失败: 输出文件大小为0")
                    return False
            else:
                print(f"合并失败: 输出文件未创建")
                return False
        else:
            print(f"合并失败")
            if result.stderr:
                print(f"错误信息: {result.stderr}")
            return False
            
    except subprocess.CalledProcessError as e:
        print(f"合并过程中发生错误")
        if e.stderr:
            print(f"错误信息: {e.stderr}")
        return False
    except Exception as e:
        print(f"未知错误")
        print(f"错误信息: {str(e)}")
        return False
    finally:
        # 删除临时文件列表
        if os.path.exists(temp_list_file):
            try:
                os.remove(temp_list_file)
            except:
                pass


def find_and_merge_ts_files(directory, delete_original=False):
    """
    查找目录及其子目录中的TS文件，并将每个目录内的TS文件合并成一个MP4文件
    
    Args:
        directory (str): 要搜索的目录路径
        delete_original (bool): 是否删除原始TS文件
    
    Returns:
        tuple: (成功合并的目录数, 失败的目录数, 跳过的目录数)
    """
    success_count = 0
    failure_count = 0
    skipped_count = 0
    total_size_before = 0  # 合并前的总大小
    total_size_after = 0   # 合并后的总大小
    total_merge_time = 0   # 总合并时间
    start_time = time.time()  # 开始处理时间
    
    # 确保目录存在
    if not os.path.isdir(directory):
        print(f"错误: 目录不存在 - {directory}")
        return (0, 0, 0)
    
    print(f"开始扫描目录: {directory}")
    
    # 获取脚本所在目录
    script_dir = os.path.dirname(os.path.abspath(__file__))
    
    # 首先扫描所有包含TS文件的目录
    dirs_with_ts = {}
    for root, dirs, files in os.walk(directory):
        ts_files = []
        for file in files:
            if file.lower().endswith('.ts'):
                ts_files.append(os.path.join(root, file))
        
        if ts_files:
            # 按文件名排序，确保合并顺序正确
            ts_files.sort()
            dirs_with_ts[root] = ts_files
    
    total_dirs = len(dirs_with_ts)
    if total_dirs == 0:
        print("未找到任何包含TS文件的目录")
        return (0, 0, 0)
    
    print(f"找到 {total_dirs} 个包含TS文件的目录")
    print("-" * 60)
    
    # 处理每个目录
    for i, (dir_path, ts_files) in enumerate(dirs_with_ts.items(), 1):
        # 显示进度
        dir_name = os.path.basename(dir_path)
        relative_path = os.path.relpath(dir_path, directory)
        print(f"[{i}/{total_dirs}] 处理目录: {relative_path} ({len(ts_files)}个TS文件)")
        
        # 生成输出文件名
        safe_dir_name = "".join(c if c.isalnum() or c in (' ', '-', '_') else '_' for c in dir_name)
        output_file = os.path.join(script_dir, f"{safe_dir_name}.mp4")
        
        # 如果输出文件已存在，添加唯一标识符
        counter = 1
        original_output_file = output_file
        while os.path.exists(output_file):
            base, ext = os.path.splitext(original_output_file)
            output_file = f"{base}_{counter}{ext}"
            counter += 1
        
        # 如果输出文件与原始文件不同，说明有重名文件
        if output_file != original_output_file:
            print(f"  -> 检测到同名文件，使用新文件名: {os.path.basename(output_file)}")
        
        # 计算原始文件总大小
        dir_original_size = sum(get_file_size(ts_file) for ts_file in ts_files)
        total_size_before += dir_original_size
        
        # 合并文件
        dir_start_time = time.time()
        if merge_ts_files(ts_files, output_file, delete_original):
            dir_end_time = time.time()
            dir_merge_time = dir_end_time - dir_start_time
            total_merge_time += dir_merge_time
            
            success_count += 1
            
            # 获取合并后文件大小
            merged_size = get_file_size(output_file)
            total_size_after += merged_size
            
            # 计算并显示处理时间和预估剩余时间
            elapsed_time = time.time() - start_time
            if success_count > 0:
                avg_time_per_dir = total_merge_time / success_count
                remaining_dirs = total_dirs - i
                estimated_remaining_time = avg_time_per_dir * remaining_dirs
                
                # 格式化时间显示
                elapsed_str = format_time(elapsed_time)
                remaining_str = format_time(estimated_remaining_time)
                
                print(f"  -> 已用时间: {elapsed_str}, 预估剩余: {remaining_str}")
        else:
            failure_count += 1
        
        print("-" * 40)
    
    # 显示总体统计信息
    total_elapsed_time = time.time() - start_time
    print("\n合并统计:")
    print(f"  总目录数: {total_dirs}")
    print(f"  成功合并: {success_count}")
    print(f"  合并失败: {failure_count}")
    print(f"  跳过目录: {skipped_count}")
    print(f"  总处理时间: {format_time(total_elapsed_time)}")
    
    if total_size_before > 0:
        total_size_diff = total_size_after - total_size_before
        total_size_percent = round((total_size_diff / total_size_before) * 100, 2)
        total_size_change = f"+{total_size_diff}MB (+{total_size_percent}%)" if total_size_diff > 0 else f"{total_size_diff}MB ({total_size_percent}%)"
        print(f"  总大小变化: {total_size_before}MB -> {total_size_after}MB ({total_size_change})")
    
    if success_count > 0:
        avg_time_per_dir = total_merge_time / success_count
        print(f"  平均合并时间: {format_time(avg_time_per_dir)}/目录")
    
    return (success_count, failure_count, skipped_count)


def main():
    # 打印标题
    print("=" * 60)
    print("TS文件合并器")
    print("=" * 60)
    
    # 检查依赖
    if not check_dependencies():
        print("请安装必要的依赖后重试")
        sys.exit(1)
    
    # 设置命令行参数解析
    parser = argparse.ArgumentParser(
        description='将目录及其子目录中的每个目录内的所有TS文件合并成一个MP4文件',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
使用示例:
  python ts_merger.py "D:\\Videos"          # 合并并删除原始TS文件
  python ts_merger.py "D:\\Videos" --keep   # 合并并保留原始TS文件

注意:
  - 每个目录内的TS文件将按文件名排序后合并
  - 合并后的MP4文件将保存在脚本所在目录
  - 输出文件名与目录名相同（特殊字符会被替换为下划线）
        """
    )
    parser.add_argument('directory', help='要处理的目录路径')
    parser.add_argument('--keep', action='store_true', 
                       help='保留原始TS文件（默认情况下会删除合并成功的TS文件）')
    
    args = parser.parse_args()
    
    # 获取绝对路径
    target_directory = os.path.abspath(args.directory)
    
    print(f"目标目录: {target_directory}")
    print(f"删除原始文件: {'否' if args.keep else '是'}")
    print(f"输出目录: {os.path.dirname(os.path.abspath(__file__))}")
    print("-" * 60)
    
    # 执行合并（默认删除原始文件，除非指定了--keep参数）
    success, failure, skipped = find_and_merge_ts_files(target_directory, not args.keep)
    
    print("=" * 60)
    print(f"合并完成!")
    print(f"成功合并: {success} 个目录")
    print(f"合并失败: {failure} 个目录")
    print(f"跳过目录: {skipped} 个目录")
    
    if failure > 0:
        print(f"警告: 有 {failure} 个目录合并失败")
        print("=" * 60)
        sys.exit(1)
    else:
        print("所有目录处理完成!")
        print("=" * 60)


if __name__ == "__main__":
    main()