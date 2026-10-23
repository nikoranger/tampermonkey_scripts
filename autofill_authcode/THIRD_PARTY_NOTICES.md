# 第三方声明（Third-Party Notices）

本脚本（`captcha-ocr.user.js`）在运行时使用或包含以下第三方组件与数据。各组件的著作权归其原作者所有，本仓库仅按原许可证使用。

## 1. ddddocr

- **用途**：字符集（`CHARSET_OLD`）及可选下载的识别模型 `common.onnx` / `common_old.onnx`
- **来源**：<https://github.com/sml2h3/ddddocr>
- **版本**：模型取自 `ddddocr 1.0.6`（PyPI wheel）
- **许可证**：MIT License
- **说明**：脚本内嵌的 8210 项字符集派生自 ddddocr；模型文件不随本仓库分发，由脚本在用户浏览器中按需下载并缓存，或由用户手动导入。

## 2. ONNX Runtime Web（onnxruntime-web）

- **用途**：在浏览器内运行 ddddocr ONNX 模型
- **来源**：<https://github.com/microsoft/onnxruntime>
- **版本**：1.20.1
- **许可证**：MIT License
- **加载方式**：运行时通过 jsDelivr CDN 加载，不随本仓库分发

## 3. Tesseract.js

- **用途**：纯前端 OCR 引擎（引擎 B）
- **来源**：<https://github.com/naptha/tesseract.js>
- **版本**：5.1.1
- **许可证**：Apache License 2.0
- **加载方式**：运行时通过 jsDelivr CDN 加载，不随本仓库分发

## 4. tesseract.js-core

- **用途**：Tesseract.js 的 WASM 核心
- **来源**：<https://github.com/naptha/tesseract.js-core>
- **版本**：v5.1.1
- **许可证**：Apache License 2.0
- **加载方式**：运行时通过 jsDelivr CDN 加载，不随本仓库分发

## 5. Tesseract 英文语言数据（@tesseract.js-data/eng）

- **用途**：Tesseract.js 的英文识别语言包 `eng.traineddata`
- **来源**：<https://github.com/naptha/tessdata>、<https://github.com/tesseract-ocr/tessdata>
- **版本**：1.0.0（`4.0.0_best_int`）
- **许可证**：Apache License 2.0
- **加载方式**：运行时通过 jsDelivr CDN 加载，不随本仓库分发

## 许可证全文

- MIT License：<https://opensource.org/license/mit>
- Apache License 2.0：<https://www.apache.org/licenses/LICENSE-2.0>

本项目的许可证见仓库根目录的 [LICENSE](../LICENSE)。
