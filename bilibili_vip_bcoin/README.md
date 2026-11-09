# B 站大会员每月 B 币券自动领取并投喂（Tampermonkey）

一个按自然月运行的油猴脚本：访问 B 站时自动检查**当前登录账号是不是大会员**；如果是，就领取当月大会员权益里的 **5 张 B 币券**，再以「充电」方式把 B 币券**投喂给指定的用户（UID）**。

整个过程只用账号自己的 B 币券/余额，**不会花真钱**：充电接口固定 `is_bp_remains_prior=true`，B 币不足时只会报错，不会走微信/支付宝等真实支付渠道。

## 功能

- 通过 `x/web-interface/nav` 读取登录状态与大会员状态，非大会员直接跳过，不做任何领取或投喂；
- 通过 `x/vip/privilege/receive`（`type=1`）领取当月 5 张 B 币券；接口返回「已领取过」时视为成功，不重复领取；
- 通过 `x/ugcpay/web/v2/trade/elec/pay/quick` 把 B 币券以充电方式投喂给指定 UID；只认 `data.status === 4` 为成功；
- 按**自然月**（Asia/Shanghai）本地去重：每月只完整执行一次，避免重复扣券；
- 失败后 30 分钟冷却重试；未登录 / 非大会员 6 小时后重查；成功即本月不再重复执行；
- 目标 UID、单次充电数量、自动执行开关、调试日志都可在油猴菜单里调整，并保存在本地；
- 提供「标记本月已完成」，用于你已在别处领券或充电时，避免脚本重复投喂；
- 页面右下角 Shadow DOM 提示 + 控制台调试日志，便于排查。

## 不包含的能力

本脚本**不会**：

- 伪造登录、Cookie、会员身份，也不绕过会员、付费、DRM 或任何服务端鉴权；
- 使用真实支付渠道（`is_bp_remains_prior=true`，B 币不足只报错，不扣款）；
- 在账号未登录、不是大会员、或尚未配置目标 UID 时执行领取或投喂；
- 读取或上传你的账号资料、页面内容，所有请求都发往 B 站自己的接口。

> 这些接口是 B 站网页端使用的**非公开接口**，官方未承诺稳定，可能随改版失效（例如改为需要 WBI 签名、更换路径或参数）。脚本已按现有公开整理文档实现，并保留完整响应日志，方便失效时自行核对调整。请遵守目标网站的使用条款，仅用于你本人有权操作的账号。

## 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)（或支持 `GM_xmlhttpRequest` 的 Violentmonkey 等）；
2. 打开 [`vip-bcoin.user.js`](vip-bcoin.user.js)，或把文件拖进浏览器；
3. 在 Tampermonkey 安装页确认安装。脚本声明了 `@connect api.bilibili.com`，首次运行时按管理器提示允许跨域访问即可。

也可以手动新建脚本，把 `vip-bcoin.user.js` 的全部内容粘贴进去保存。

## 配置投喂目标

**必须先设置目标 UID**，否则脚本只会提示，不会领取也不会投喂。两种方式任选其一：

- **推荐**：安装完成后，点击 Tampermonkey 扩展图标 → 本脚本 → 「设置投喂目标 UID」，填入目标用户的 mid（纯数字）。设置会保存在本地，且会立即触发一次重新检查。
- 直接编辑脚本顶部的 `DEFAULT_TARGET_UID` 常量（菜单里设置的值优先于它）。

目标用户的 mid 可以在其个人空间页地址里看到，例如 `https://space.bilibili.com/123456` 中的 `123456`。

> 若你本月已经手动领过券、或用别的工具（如 BiliBiliToolPro）充过电，请先点「标记本月已完成」，避免脚本再投喂一次、多扣 B 币券。

## 油猴菜单

- **自动执行：开/关** —— 关闭后只保留手动执行；
- **设置投喂目标 UID（当前：…）** —— 填写 / 修改投喂对象；
- **设置单次充电数量（当前：5）** —— 即 `bp_num`。2020-12 之后 **1 B币 = 1 贝壳**，接口范围 `2-9999`，默认 `5` 正好对应每月 5 张 B 币券；
- **立即检查并执行** —— 不等自动延迟，手动跑一次完整流程；
- **查看本月状态** —— 显示本月执行结果；
- **标记本月已完成（避免重复投喂）** —— 本月不再自动领取或投喂；
- **调试日志：开/关** —— 在控制台输出 `[bili-vip-bcoin]` 前缀的详细日志。

菜单设置保存在 Tampermonkey 本地存储中，不会上传。

## 实现原理

| 步骤 | 接口 | 关键点 |
|---|---|---|
| 检查大会员 | `GET https://api.bilibili.com/x/web-interface/nav` | `vipStatus === 1` 或 `vip.status === 1`、`vipType > 0` 视为大会员；`wallet.coupon_balance` 为当月奖励 B 币数 |
| 领取 B 币券 | `POST https://api.bilibili.com/x/vip/privilege/receive` | 表单 `type=1&csrf=<bili_jct>`；`code=0` 成功，`69801` 已领取过，`-101` 未登录，`-111` CSRF 失败，`69800` 网络繁忙 |
| 充电投喂 | `POST https://api.bilibili.com/x/ugcpay/web/v2/trade/elec/pay/quick` | 表单 `bp_num=5&is_bp_remains_prior=true&up_mid=<UID>&otype=up&oid=<UID>&csrf=<bili_jct>`；`code=0` 且 `data.status=4` 才算成功，`-2` 低于下限、`-4` B 币不足 |

- 所有 POST 都带 `<bili_jct>`（从 `document.cookie` 读取）作为 CSRF Token，并设置 `Referer` / `Origin`；
- 跨域请求由 `GM_xmlhttpRequest` 发出，自动携带登录 Cookie（`SESSDATA`）；
- 状态按「自然月」存在 `GM_setValue` / `localStorage`，包含 `claimed`、`charged` 子状态，因此领券成功但充电失败时只会补做充电，不会重复领券或重复充电。

## 已知限制

- 依赖非公开接口，B 站改版后可能失效；若接口改为需要 WBI 签名，需要按新规则补充签名逻辑；
- 旧版充电接口 `x/ugcpay/trade/elec/pay/quick` 使用 `elec_num`（电池，1 B币 = 10 电池，范围 20-99990）。当前脚本用的是新版「贝壳」接口；如新版不可用，可把 `API_ELEC_PAY` 与 `bp_num` 改成旧版参数；
- 脚本按自然月去重，但**无法查询你在别处（手动 / 其他工具）的领券与充电记录**。已处理过请用「标记本月已完成」；
- 依赖 `GM_xmlhttpRequest`；不支持该 API 的脚本管理器会直接报「无法调用 B 站接口」；
- 需要账号已登录且 `bili_jct` 可读；登录态失效会提示重新登录；
- `is_bp_remains_prior=true` 保证只用 B 币券/余额，但**若账号本身有充值 B 币余额，也会被一并用于充电**。只想用完当月券的话，请确认 `bp_num` 与券数量一致（默认 5）；
- 请遵守目标网站的使用条款，仅在你有权操作的账号上使用。

## 调试

1. 打开油猴菜单里的「调试日志」，在浏览器控制台筛选 `[bili-vip-bcoin]`；
2. 「立即检查并执行」跑一次完整流程，观察 `nav` / `领取 B 币券结果` / `充电投喂结果` 三段日志；
3. 常见返回码对照：
   - `code=-101` / `nav.isLogin=false`：未登录或登录态失效 → 重新登录 B 站；
   - `code=-111`：CSRF 校验失败 → 刷新页面，确认 `bili_jct` 存在；
   - `code=69801`：本月券已领过（脚本视为成功，继续充电）；
   - `data.status=-2`：充电数量低于下限 → 调大「单次充电数量」；
   - `data.status=-4`：B 币券/余额不足 → 确认券是否到账、数量是否过大；
   - `code=69800`：网络繁忙 → 等待冷却后自动重试；
4. 若怀疑接口改版，在登录状态手动访问 `https://api.bilibili.com/x/web-interface/nav` 核对字段，并对照控制台里打印的完整响应更新脚本。

## License

本项目以 [MIT License](../LICENSE) 发布，Copyright (c) 2026 niko。
