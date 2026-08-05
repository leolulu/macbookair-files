# subtitle_video_player

本项目是支持多种字幕格式、字幕选词和 AI 问答的本地视频播放器。开发时使用 `pnpm test` 运行测试，使用 `pnpm run build:single-html` 生成单文件版本。

## 欧路笔记格式约定

播放器生成的欧路 Note 以 `**来源：**《` 作为稳定前缀；`eudic_auto_vocabulary_task_system` 据此保留播放器的来源与引用块排版，并为其他 Note 补充“生词语境”引用块。修改此前缀或后端识别规则时，需要同步检查两个项目。
