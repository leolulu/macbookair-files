# Read Frog 布局来源

句子解析面板的核心布局、手绘 SVG、样式和提示／箭头定位处理，适配自 Read Frog（陪读蛙）1.52.1 已安装版本的长难句分析模板与交互源码。

- 上游项目：https://github.com/mengxi-ream/read-frog
- 上游许可证：GNU GPL version 3；全文见 `assets/READFROG-LICENSE`。
- 修改日期：2026-10-25。
- 适配文件：`assets/sentence_analysis.css`、`js/sentence_analysis.js` 中的布局和交互部分。
- 适配内容：将 Liquid 标注事件映射为播放器自身的 DOM 渲染；将 Shadow DOM 选择器限定到 `.svp-sa`；接入现有 AI SSE、字幕范围、会话与浏览器朗读。没有引入 Liquid、插件运行时或新的浏览器插件。
- `test/fixtures/readfrog-1.52.1.json` 保存该版本的示例 DOM、样式和标注，用于相同数据下的布局对照。

保留了上游的圈线图形、尺寸、配色、嵌套层次、行内小标签、断句规则、浮层位置选择和箭头曲线／箭头尖计算。播放器外围的标题、字幕跳转、范围调整和异常提示属于宿主适配。单文件构建包含上述源代码和许可证全文。
