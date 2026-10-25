# Tampermonkey Scripts

个人使用的油猴（Tampermonkey）脚本合集。每个脚本放在独立目录中，包含脚本本体与使用说明。

## 脚本列表

| 脚本 | 说明 | 文档 |
|---|---|---|
| 图片验证码自动识别 | 自动识别页面图片验证码并填入输入框；内置 ddddocr ONNX 与 Tesseract.js 双引擎，可在油猴菜单切换 | [使用说明](autofill_authcode/README.md) |
| V2EX 每日自动签到 | 访问 V2EX 时自动领取每日登录奖励，支持同日去重、失败冷却与手动检查 | [使用说明](v2ex_daily_checkin/README.md) |

## 安装脚本

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展；
2. 打开下表中的脚本文件，点击 GitHub 页面右上角的 **Raw**（或直接访问 raw 链接），Tampermonkey 会自动弹出安装页；
3. 确认安装即可。

常用脚本的 raw 链接：

- 图片验证码自动识别：[captcha-ocr.user.js](https://raw.githubusercontent.com/nikoranger/tampermonkey_scripts/main/autofill_authcode/captcha-ocr.user.js)
- V2EX 每日自动签到：[v2ex-daily-checkin.user.js](https://raw.githubusercontent.com/nikoranger/tampermonkey_scripts/main/v2ex_daily_checkin/v2ex-daily-checkin.user.js)

也可以手动新建脚本，把 `.user.js` 的全部内容粘贴进去保存。

## 目录结构

```
.
├── LICENSE
├── autofill_authcode/          # 图片验证码自动识别
│   ├── captcha-ocr.user.js
│   ├── README.md
│   └── THIRD_PARTY_NOTICES.md
└── v2ex_daily_checkin/         # V2EX 每日自动签到
    ├── v2ex-daily-checkin.user.js
    └── README.md
```

## 说明

- 脚本仅供学习与个人使用，请仅在你有权操作的站点上使用，并遵守目标站点的使用条款。
- 第三方组件的许可证与来源见各脚本目录下的 `THIRD_PARTY_NOTICES.md`。

## License

本项目以 [MIT License](LICENSE) 发布，Copyright (c) 2026 niko。
