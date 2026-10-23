# 图片验证码自动识别（Tampermonkey）

一个油猴脚本：自动识别页面上的图片验证码，填入对应输入框。集成两种识别引擎，可在油猴菜单里随时切换：

| 引擎 | 实现 | 特点 |
|---|---|---|
| **A. ddddocr ONNX** | 在浏览器内用 `onnxruntime-web` 跑 ddddocr 的量化模型（`common.onnx` / `common_old.onnx`） | 准确率高（常见数字/字母验证码 90%+），图片不出浏览器；首次使用需下载约 7–14MB 模型 |
| **B. Tesseract.js** | `tesseract.js` 纯前端 OCR，自带灰度/二值化/去噪预处理 | 无需 ddddocr ONNX 模型；首次仍需下载 worker、WASM 和语言包；对干扰线、扭曲字符的准确率一般 |

默认 `自动（A→B）`：先用 A，识别为空或失败时自动退回 B。

## 安装

1. 在 Tampermonkey 中新建脚本，粘贴 [`captcha-ocr.user.js`](captcha-ocr.user.js) 的全部内容并保存（或直接把该文件拖进浏览器）。
2. 打开带验证码的页面，Tampermonkey 会自动扫描：优先匹配同一行、标签或占位符含 captcha、图形码、验证码、vcode 等关键词的输入框和附近的图片/画布，识别后填入。

## 在油猴菜单中切换

点击 Tampermonkey 扩展图标 → 本脚本名称，即可看到菜单项：

- **识别引擎：自动 / ddddocr ONNX / Tesseract.js** —— 点击循环切换，设置会持久化；
- **自动填入：开/关** —— 关闭后只响应“立即识别”；
- **跨域图片读取：开/关** —— 默认关闭，避免一次性验证码被第二次请求；开启前还需把图片域名加入脚本头部 `@connect`；
- **自动提交：开/关** —— 填入后自动提交表单（默认关，避免误提交）；
- **调试日志：开/关** —— 控制台输出 `[captcha-ocr]` 详细过程；
- **立即识别并填入当前页面验证码** —— 手动触发一次；
- **导入本地 ddddocr 模型文件…** —— 网络下载模型失败时的离线方案；
- **清除模型缓存并重置引擎**。

## 引擎 A 的模型从哪里来

按以下顺序自动尝试：

1. **国内 PyPI 镜像（首选）**：依次尝试华为云、阿里云镜像，下载 `ddddocr 1.0.6` 的 wheel（约 6.9MB），在浏览器内解析 ZIP、解压出 `ddddocr/common.onnx`（13.6MB），并校验同一个固定 SHA-256。
2. **PyPI 官方源**：镜像不可用时回退到官方源，内容仍会进行 SHA-256 校验。
3. **GitHub / jsDelivr 的 `common_old.onnx` 直链**（约 13.6MB，国内可能被墙）。
4. **手动导入**：菜单“导入本地 ddddocr 模型文件…”，选择任意 `common.onnx` / `common_old.onnx`。

下载过程中会显示百分比、已下载大小和平均速度。模型会缓存到当前站点的 Cache Storage（首次识别每个站点下载一次）。脚本会自动识别模型版本（1.6.x 输出 logits、1.0.x 输出索引），采用对应的归一化与 CTC 解码，无需手动配置。

## 引擎 B 的网络路径

Tesseract.js 并非完全离线：首次使用仍会从 jsDelivr 加载 worker、WASM core 和英文语言包。若访问不了 jsDelivr，修改脚本顶部的 `DEFAULT_SETTINGS`：

```js
tesseractWorkerPath: 'https://unpkg.com/tesseract.js@5.1.1/dist/worker.min.js',
tesseractCorePath:   'https://unpkg.com/tesseract.js-core@v5.1.1',
tesseractLangPath:   'https://unpkg.com/@tesseract.js-data/eng@1.0.0/4.0.0_best_int',
```

同理，`ortWasmPaths` 可换成 `https://unpkg.com/onnxruntime-web@1.20.1/dist/`。

> 注意：脚本头部的 `@require` 地址也来自 jsDelivr。若安装时网络不通，`onnxruntime-web` / `Tesseract.js` 会加载失败，可在元数据里换成 unpkg 或自托管地址后重新安装。

## 匹配机制

脚本不内置任何站点专用规则，只使用通用启发式：图片侧需带有 `captcha`、`验证码`、`vcode`、`checkImg` 等明确提示，并优先匹配同样有提示且位于同一行的输入框；单独的 `verify` / `validate` 不会触发自动配对。

## 行为细节

- 输入框写入使用原生 `value` setter 并派发 `input`/`change` 事件，兼容 React/Vue 受控组件。
- 自动填入后会恢复用户原来的焦点和光标/选区位置；若原本就在验证码框内，光标会移到填入内容末尾。
- 首次进入页面会监听验证码图片加载并延迟重试，图片加载完成后自动开始识别。
- 图片与输入框会全页统一评分配对：优先同一行的“图形码”字段；若两者之间隔着其他输入框，会显著降权，避免把验证码填到上方的短信验证码等字段。
- 验证码图片 `src` 变化（站点刷新验证码）时会自动重新识别；识别期间图片发生变化时，旧结果会被丢弃而不是填入新验证码。
- 同源图片直接读画布。跨域图片默认跳过；手动开启“跨域图片读取”并添加对应的 `@connect` 域名后，才会通过 `GM_xmlhttpRequest` 重新获取。
- 若验证码 URL 每次请求都会刷新，跨域二次获取可能导致页面图片与 OCR 文本不一致，这类站点应保持跨域读取关闭。
- 若你已手动修改过输入框，脚本不会覆盖；自动提交前也会再次检查输入框和验证码是否发生变化。
- 滑块/拼图/点选类验证码不适用（本脚本只处理字符型图片验证码）。

## 已知限制

- 脚本带 `@noframes`，不进入 iframe。若验证码位于 iframe 内，删除元数据中的这一行。
- 不处理 Shadow DOM 内的元素（选择器无法穿透）；需要时请改用其他方案。
- 页面用 `<canvas>` 绘制验证码且不改变 DOM 属性时，无法感知“换图”，请用菜单“立即识别并填入”手动触发。
- 跨域验证码默认不支持；开启前需自行确认图片请求不会刷新或作废当前验证码，并在元数据中添加对应图片域名的 `@connect`。
- 严格 CSP 的站点可能阻止 wasm/worker 加载；此时自动模式会尝试另一个引擎，仍失败可查看调试日志。
- 请仅在你本人有权操作的站点使用，并遵守目标站点的使用条款。

## License

本项目以 [MIT License](../LICENSE) 发布，Copyright (c) 2026 niko。

- 脚本内嵌的 ddddocr 字符集来自 [ddddocr](https://github.com/sml2h3/ddddocr)（MIT）；
- `onnxruntime-web`（MIT）、`Tesseract.js` / `tesseract.js-core`（Apache-2.0）等依赖在运行时从 CDN 加载，不随本仓库分发。

完整第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
