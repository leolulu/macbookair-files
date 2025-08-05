import base64
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from threading import Thread
from typing import Iterable, List, Union, cast

import stable_whisper
import torch
import torchaudio
import zhconv
from faster_whisper import BatchedInferencePipeline, WhisperModel
from faster_whisper.audio import decode_audio
from faster_whisper.transcribe import Segment
from pyannote.audio import Pipeline
from pyannote.audio.pipelines.utils.hook import ProgressHook
from tqdm import tqdm


class LockManager:
    def __init__(self) -> None:
        self.lock = threading.Lock()

    @contextmanager
    def rich_live_lock(self, should_lock: bool):
        if should_lock:
            with self.lock:
                yield
        else:
            yield


class FasterWhisper:
    def __init__(
        self,
        model_size="large-v3",
        local_files_only=True,
        enable_lock_for_rich=False,
        compute_type="float16",
        batch_pipeline_mode=False,
    ) -> None:
        gpu_device_count = torch.cuda.device_count()
        self.model = WhisperModel(
            model_size,
            device="cuda",
            compute_type=compute_type,
            local_files_only=local_files_only,
            device_index=list(range(gpu_device_count))[::-1],
        )
        self.batch_pipeline_mode = batch_pipeline_mode
        if batch_pipeline_mode:
            self.model = BatchedInferencePipeline(model=self.model)
        self.pyannote_pipeline = None
        self.enable_lock_for_rich = enable_lock_for_rich
        self.lock_manager = LockManager()

    def transcribe(self, media_path, word_timestamps=True, language=None, vad_filter=True):
        segments, info = self.model.transcribe(
            media_path,
            beam_size=5,
            word_timestamps=word_timestamps,
            language=language,
            vad_filter=vad_filter,
        )
        print("Detected language '%s' with probability %f" % (info.language, info.language_probability))

        segments_result: List[Segment] = []
        total_duration = int(info.duration)

        td_len = str(len(str(total_duration)))
        last_burst = 0.0
        set_delay = 0.1
        global timestamp_prev, timestamp_last
        timestamp_prev = 0  # last timestamp in previous chunk
        timestamp_last = 0
        capture = io.StringIO()

        def pbar_delayed():  # to get last timestamp from chunk
            global timestamp_prev
            time.sleep(set_delay)  # wait for whole chunk to be iterated
            pbar.update(timestamp_last - timestamp_prev)
            timestamp_prev = timestamp_last
            print(capture.getvalue().splitlines()[-1])

        with tqdm(
            file=capture,
            total=total_duration,
            unit=" seconds",
            smoothing=0.00001,
            bar_format="{percentage:3.0f}% | {n_fmt:>" + td_len + "}/{total_fmt} | {elapsed}<<{remaining} | {rate_noinv_fmt}",
        ) as pbar:
            for segment in segments:
                if info.language == "zh":
                    segment.text = zhconv.convert(segment.text, "zh-cn")
                    if segment.words is not None:
                        for word in segment.words:
                            word.word = zhconv.convert(word.word, "zh-cn")
                timestamp_last = round(segment.end)
                time_now = time.time()
                if time_now - last_burst > set_delay:  # catch new chunk
                    last_burst = time_now
                    Thread(target=pbar_delayed, daemon=False).start()
                segments_result.append(segment)
            time.sleep(set_delay + 0.3)
            if timestamp_last < total_duration:
                pbar.update(total_duration - timestamp_last)
                print(capture.getvalue().splitlines()[-1])

        return segments_result, info

    def _default_move_result_file_callback(self, file_path, **kwargs):
        shutil.move(
            file_path,
            os.path.splitext(kwargs["media_path"])[0] + os.path.splitext(file_path)[-1],
        )

    def transcribe_to_file(
        self,
        media_path,
        word_timestamps=True,
        language=None,
        with_srt=True,
        with_txt=False,
        with_json=False,
        with_diarization=False,
        with_png=False,
        move_result_file_callback=None,
        force_align=True,
        regroup_eng=True,
        vad_filter=True,
    ):
        if not (with_srt or with_json or with_txt):
            raise UserWarning(f"srt、json、txt需要选择至少一种输出!")
        if str(language).lower() == "auto":
            print("自动检测语言中...")
            language = self.detect_language_by_longer_material(media_path)
        if move_result_file_callback is None:
            move_result_file_callback = self._default_move_result_file_callback
        video_duration = self.get_video_duration(media_path)
        print(f"视频时长为: {video_duration}")
        b_time = time.time()
        segments, info = self.transcribe(media_path, word_timestamps=word_timestamps, language=language, vad_filter=vad_filter)

        if force_align:
            try:
                with self.lock_manager.rich_live_lock(self.enable_lock_for_rich):
                    print("开始使用stable-ts提升字幕精度...")
                    segments = stable_whisper.transcribe_any(
                        lambda audio, **kwargs: [[{"word": j.word, "start": j.start, "end": j.end} for j in i.words] for i in segments],  # type: ignore
                        media_path,
                        regroup=True if regroup_eng and info.language == "en" else False,
                    ).segments
            except Exception as e:
                print(f"矫正字幕时出错，取消矫正，原因为：{e}")

        print(f"音转文环节运行时间为：{int(time.time() - b_time)}秒，速率为：{round(video_duration / (time.time() - b_time), 2)}\n")
        if with_srt:
            srt_content = self.generate_srt(self.segments_to_srt_subtitles(segments))
            srt_file_path = os.path.splitext(os.path.basename(media_path))[0] + ".srt"
            with open(srt_file_path, "w", encoding="utf-8") as f:
                f.write(srt_content)
            move_result_file_callback(srt_file_path, media_path=media_path)
        if with_txt:
            txt_file_path = os.path.splitext(os.path.basename(media_path))[0] + ".txt"
            with open(txt_file_path, "w", encoding="utf-8") as f:
                f.write("\n".join([i.text for i in segments]))
            move_result_file_callback(txt_file_path, media_path=media_path)
        if with_diarization:
            b_time = time.time()
            diarization_info = self.get_diarization(media_path, move_result_file_callback, with_png)
            print(f"说话人识别环节运行时间为：{int(time.time() - b_time)}秒，速率为：{round(video_duration / (time.time() - b_time), 2)}\n")
        if word_timestamps and with_json:
            json_data = {
                "asr_info": [
                    {
                        "start": s.start,
                        "end": s.end,
                        "text": s.text,
                        "words": [{"start": w.start, "end": w.end, "word": w.word} for w in s.words],  # type:ignore
                    }
                    for s in segments
                ],
            }
            if with_diarization:
                json_data["diarization_info"] = [{"start": d[0], "end": d[1], "label": d[2]} for d in diarization_info]  # type: ignore
            json_data["video_duration"] = video_duration  # type: ignore
            json_file_path = os.path.splitext(os.path.basename(media_path))[0] + ".json"
            with open(json_file_path, "w", encoding="utf-8") as f:
                f.write(json.dumps(json_data, indent=2, ensure_ascii=False))
            move_result_file_callback(json_file_path, media_path=media_path)

    def generate_srt(self, subtitles):
        def convert_to_srt_time_format(original_seconds):
            hours = int(original_seconds // 3600)
            minutes = int((original_seconds % 3600) // 60)
            seconds = int(original_seconds % 60)
            milliseconds = int((original_seconds % 1) * 1000)
            return f"{hours:02d}:{minutes:02d}:{seconds:02d},{milliseconds:03d}"

        srt_content = ""
        counter = 1
        for subtitle in subtitles:
            start_time, end_time, text = subtitle
            srt_content += f"{counter}\n"
            srt_content += f"{convert_to_srt_time_format(start_time)} --> {convert_to_srt_time_format(end_time)}\n"
            srt_content += f"{text}\n\n"
            counter += 1
        return srt_content

    def segments_to_srt_subtitles(self, segments: Iterable[Union[stable_whisper.result.Segment, Segment]]):
        return [(i.start, i.end, i.text) for i in segments]

    def get_diarization(self, media_path, move_result_file_callback, with_png):
        png_path = os.path.splitext(os.path.basename(media_path))[0] + ".png"
        audio_path, temp_dir_for_wav = self.media_to_wav(media_path)
        if not self.pyannote_pipeline:
            self.pyannote_pipeline = Pipeline.from_pretrained(
                "pyannote/speaker-diarization-3.1",
                use_auth_token=base64.b64decode("aGZfYVJ1c010aFJTdFNuVWxmRHFQbVdXQ1djSExyTXVLT0RqbQ==").decode('utf-8'),
            )
            try:
                if not re.search("RTX 3060", torch.cuda.get_device_name()):
                    self.pyannote_pipeline.to(torch.device("cuda"))
                    print(f"尝试绑定pyannote pipeline到GPU")
            except:
                print(f"pyannote pipeline绑定GPU失败...")
                traceback.print_exc()
        with self.lock_manager.rich_live_lock(self.enable_lock_for_rich):
            waveform, sample_rate = torchaudio.load(audio_path)
            print(f"预加载音频到内存")
            with ProgressHook() as hook:
                diarization = self.pyannote_pipeline({"waveform": waveform, "sample_rate": sample_rate}, hook=hook)
        if with_png:
            png_data = diarization._repr_png_()
            with open(png_path, "wb") as f:
                f.write(png_data)
            move_result_file_callback(png_path, media_path=media_path)
        temp_dir_for_wav.cleanup()
        return [(i[0].start, i[0].end, i[2]) for i in diarization.itertracks(yield_label=True)]

    def get_video_duration(self, video_path):
        cmd = ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", video_path]
        output = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT).stdout.decode("utf-8")
        match = re.search(r"(\d+(?:\.\d+)?)", output)
        if match:
            return float(match.group(1))
        else:
            raise UserWarning(f"无法正确获取视频时长:\n{output}")

    def media_to_wav(self, video_path):
        temp_dir_for_wav = tempfile.TemporaryDirectory()
        wav_path = os.path.join(temp_dir_for_wav.name, os.path.splitext(os.path.basename(video_path))[0] + ".wav")
        cmd = [
            "ffmpeg",
            "-i",
            video_path,
            "-ac",
            "1",
            "-ar",
            "16000",
            "-acodec",
            "pcm_s16le",
            "-map",
            "a",
            "-loglevel",
            "warning",
            wav_path,
        ]
        subprocess.run(cmd)
        return wav_path, temp_dir_for_wav

    def detect_language(self, media_path):
        audio = os.path.abspath(media_path)
        if self.batch_pipeline_mode:
            model = cast(BatchedInferencePipeline, self.model).model
        else:
            model = cast(WhisperModel, self.model)

        audio = decode_audio(audio, sampling_rate=model.feature_extractor.sampling_rate)
        features = model.feature_extractor(audio)  # type: ignore
        segment = features[:, : model.feature_extractor.nb_max_frames]
        encoder_output = model.encode(segment)
        # result = self.model.detect_language(audio)
        # 如上所示，新版WhisperModel自身新增了detect_language方法，直接使用decode的audio，不需要再encode
        # 输出格式略有变化
        # 目前基于WhisperModel的self.model的方法仍然可用，暂时不变更。未来如果被移除了，再做修改
        result = model.model.detect_language(encoder_output)
        return max(result[0], key=lambda x: x[-1])[0].replace("<|", "").replace("|>", "")

    def detect_language_by_longer_material(self, media_path):
        with tempfile.TemporaryDirectory() as temp_dir_for_ffmpeg:
            lang_results = defaultdict(int)
            duration = self.get_video_duration(media_path)
            start_time = 0
            detect_language_lock = threading.Lock()

            def detect_language_par(command_info):
                sub_media_file_path, start_time, end_time = command_info
                subprocess.call(
                    f'ffmpeg -i "{media_path}" -ss {start_time} -to {end_time} -c copy -loglevel warning "{sub_media_file_path}"',
                    shell=True,
                )
                lang_result = self.detect_language(sub_media_file_path)
                with detect_language_lock:
                    lang_results[lang_result] += 1
                print(f"语言检测结果：【{lang_result}】，时间：{start_time} - {end_time}")
                print(f"当前所有结果：{lang_results}")
                os.remove(sub_media_file_path)

            commands_info = []
            while start_time < duration:
                end_time = min(duration, start_time + 30)
                sub_media_file_path = f"_{start_time}_{end_time}".join(os.path.splitext(media_path))
                sub_media_file_path = os.path.join(temp_dir_for_ffmpeg, os.path.basename(sub_media_file_path))
                commands_info.append((sub_media_file_path, start_time, end_time))
                start_time += 30

            with ThreadPoolExecutor(max_workers=os.cpu_count() if os.cpu_count() else 4) as executor:
                executor.map(detect_language_par, commands_info)

        lang_results.pop("nn", None)
        try:
            final_result = max(lang_results.items(), key=lambda x: x[-1])[0]
            print(f"语言自动检测结果为：{final_result}")
        except ValueError:
            final_result = None
            print(f"语言自动检测结果中只有nn，提交默认语言进行处理")
        return final_result


if __name__ == "__main__":
    support_media_type_in_folder_processing_mode = [".mp4", ".flv", ".avi", ".mpg", ".wmv", ".mpeg", ".mov", ".webm", ".mp3"]
    with_diarization = False
    batch_pipeline_mode = False

    def process_media(media_path):
        if os.path.exists(os.path.splitext(media_path)[0] + ".srt") or os.path.exists(os.path.splitext(media_path)[0] + ".json"):
            # print(f"已经有字幕，跳过转换：{media_path}")
            return
        try:
            print(f"开始转换文件: {media_path}")
            w.transcribe_to_file(
                media_path=media_path.strip(),
                with_srt=True,
                with_json=True,
                with_txt=True,
                with_diarization=with_diarization,
                with_png=False,
                language="auto",
                vad_filter=True,
            )
        except:
            traceback.print_exc()

    if len(sys.argv) > 1:
        if sys.argv[1] == "dia":
            with_diarization = True
        elif sys.argv[1] == "batch":
            batch_pipeline_mode = True
        else:
            process_media(sys.argv[1].strip())

    w = FasterWhisper(local_files_only=True, model_size="large-v3-turbo", batch_pipeline_mode=batch_pipeline_mode)

    while True:
        input_path = input("请输入媒体文件或文件夹的绝对路径：").strip()
        if not input_path:
            continue
        if input_path[0] == '"' and input_path[-1] == '"':
            input_path = input_path[1:-1]

        if input_path == "loop":
            from pathlib import Path

            download_path = str(Path.home() / "Downloads")
            while True:
                for media_path in [
                    os.path.join(download_path, i)
                    for i in os.listdir(download_path)
                    if os.path.splitext(i)[-1].lower() in support_media_type_in_folder_processing_mode
                ]:
                    process_media(media_path)
                time.sleep(5)

        if os.path.isfile(input_path):
            media_paths = [input_path]
        elif os.path.isdir(input_path):
            media_paths = [
                os.path.join(input_path, i)
                for i in os.listdir(input_path)
                if os.path.splitext(i)[-1].lower() in support_media_type_in_folder_processing_mode
            ]
        else:
            media_paths = []
        for media_path in media_paths:
            process_media(media_path)
