import json
import os
import subprocess
import sys


def get_subtitle_extension(codec_name):
    # 字幕格式与文件扩展名的映射
    extension_mapping = {
        "subrip": "srt",
        "ass": "ass",
        "hdmv_pgs_subtitle": "sup",
        "dvd_subtitle": "sub",
        "mov_text": "txt",
    }
    # 返回相应的扩展名，如果未知则默认返回 'srt'
    return extension_mapping.get(codec_name, "srt")


def extract_subtitles(input_file, language_filter=[]):
    print(f"Begin to handle input file: {input_file}")
    # 使用 ffprobe 获取文件信息
    cmd = [
        "ffprobe",
        "-loglevel",
        "error",
        "-show_entries",
        "stream=index,codec_name:stream_tags=language,title",
        "-select_streams",
        "s",
        "-of",
        "json",
        input_file,
    ]
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    streams = json.loads(result.stdout)

    # 遍历所有字幕流
    for stream in streams["streams"]:
        index = stream["index"]
        codec_name = stream["codec_name"]
        language = stream.get("tags", {}).get("language", "unk")
        sub_title = stream.get("tags", {}).get("title", "unk")
        if language_filter and all(not acceptable_language_fragment in language for acceptable_language_fragment in language_filter):
            continue

        # 获取正确的文件扩展名
        extension = get_subtitle_extension(codec_name)

        # 设置输出文件名
        output_file = f"{input_file.rsplit('.', 1)[0]}_{language}〔{sub_title}〕.{extension}"

        # 使用 ffmpeg 提取字幕
        print(f"Extracting subtitles to {output_file}")
        ffmpeg_cmd = ["ffmpeg", "-loglevel", "error", "-i", input_file, "-map", f"0:{index}", "-c", "copy", output_file]
        subprocess.run(ffmpeg_cmd)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python extract_sub.py input_file.mkv|mkv_files_dir [lang1[,lang2,...]]")
        sys.exit(1)

    input_path = os.path.abspath(sys.argv[1])
    language_filter = []
    if len(sys.argv) > 2:
        language_filter = sys.argv[2].split(",")

    if os.path.isdir(input_path):
        for file_ in os.listdir(input_path):
            if os.path.splitext(file_)[-1].lower() == ".mkv":
                extract_subtitles(os.path.join(input_path, file_), language_filter)
    else:
        extract_subtitles(input_path, language_filter)
