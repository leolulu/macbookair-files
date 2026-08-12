# subtitle_video_player

本项目是支持多种字幕格式、字幕选词和 AI 问答的本地视频播放器。开发时使用 `pnpm test` 运行测试，使用 `pnpm run build:single-html` 生成单文件版本。

## 欧路笔记格式约定

播放器生成的欧路 Note 以 `**来源：**《` 作为稳定前缀，欧路中保留完整来源；`eudic_auto_vocabulary_task_system` 据此识别播放器 Note，并在生成滴答正文时隐藏来源行、保留引用块，统一显示“生词语境”标题。修改此前缀或后端识别规则时，需要同步检查两个项目。
