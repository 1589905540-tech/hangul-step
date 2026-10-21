# 水彩背景与页面改版

页面根据用户提供的不背单词截图参考布局、配色、半透明卡片和三档回忆操作。截图是静态图，280ms 淡入、140ms 换词淡出与轻移为本次实现的动画设计，并非对原应用动画参数的测量。没有把截图、原应用图标或页面作为网站素材使用。

## 原创背景

- 方法：内置 `image_gen.imagegen`，一次生成一张原创水彩海岸背景，未生成变体或进行创意编辑。
- 原始 PNG：`D:\Projects\gtr_llm_robot_soccer\hangul-design-assets\coast-original.png`，1024 × 1536，2,773,308 字节。
- 原始 SHA-256：`905DCD8F774A489C1FBAA705B53EAF832BC80632B520FD83DFD153C6FC9110B6`。
- 网站实际使用文件：`D:\Projects\gtr_llm_robot_soccer\hangul-step\src\assets\coast-v1.webp`，1024 × 1536，231,036 字节。
- 格式压缩：本地 Sharp 编码为 WebP，quality 84；没有改变画面内容。
- 使用位置：首页背景。图片独立由 `/coast-v1.webp` 提供，Worker 构建产物包含图片，普通服务器也可使用。

完整生成提示：

```text
Use case: stylized-concept
Asset type: original portrait watercolor background artwork for a Korean vocabulary app
Primary request: a calm pale aqua sea, with a distant hazy slate-blue horizon near the upper fifth, small white waves, and muted warm sandstone rocks in the lower third.
Style/medium: a real watercolor painting with subtle watercolor paper grain.
Composition/framing: portrait 1024x1536, or the nearest supported portrait resolution; an open quiet middle area suitable for a UI overlay, with artwork only and no interface elements.
Lighting/mood: gentle natural daylight, calm and airy, subdued saturation.
Color palette: pale aqua, pale peach, seafoam, muted warm sandstone, hazy slate-blue.
Constraints: no text, no UI, no letters, no logos, no phone frame, no people, no watermark. Generate one original image only.
```

## 例句与边界

`src/examples.mjs` 含 20 个常用韩语词的原创简短例句及词组，已核对语法和对应中文。例句只在个人释义与内置审核词义有交集时显示，不为未知词义编造例句。

数据保存方式和服务端数据库没有改变。三档词卡自评仅决定本轮出题优先级，四选一答题才写入学习进度。页面目前需要联网；本次改版不包含离线同步或原生 iOS 安装包。

## 春芽标记

按照用户要求，标记改为无边框、两叶细茎的春芽，搭配轻宋体“春”字。`src/icon.svg` 是简单 favicon 几何图形，180、192、512 像素 PNG 位于 `src/assets/chun-icon-*.png`，用于 Apple 主屏幕和 PWA；PNG 使用米白背景，图形由 SVG 栅格化，未使用图像生成。图标链接带 `sprout-2` 版本参数以更新缓存，个人学习空间的内部标识保持原值。
