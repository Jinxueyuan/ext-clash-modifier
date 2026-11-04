# External Clash Modifier

[Related Post](https://pooi.me/external-clash-modifier/)

一个简陋的外置 Clash 配置文件修改器，用于在不支持 Parser 的 GUI （如 Clash For Android）上实现机场自带策略的覆写，同时附带 Rule Provider 反向代理服务。

支持显示已使用流量、总流量、到期时间。

运行于 Cloudflare Workers。

策略来源于 [这个 Issue](https://web.archive.org/web/20231015024249/https://github.com/Fndroid/clash_for_windows_pkg/issues/2193)

## 部署

1. 安装 [wrangler](https://github.com/cloudflare/workers-sdk/tree/main/packages/wrangler)

```
npm i -g wrangler
```

2. Clone 这个项目，然后在 Repo 中执行

```
npm i
wrangler login
wrangler deploy
```

3. 绑定你的域名 (。・∀・)ノ

## 自定义 `template.js`

默认的应该足够用了，如果需要进一步自定义，可以修改 `template.js` 和 `index.js`（逃

## 使用

```
https://<your-domain>/m/<base64-config-url>
```

把订阅链接整体做 Base64 编码（不要带换行）后拼在 `/m/` 后面，带 `?token=...` 等参数的链接也可以直接用：

```
printf '%s' 'https://example.com/api/v1/client/subscribe?token=xxx' | base64 -w0
```

如果结果里带有 `/` 或 `+`，可改用 URL-safe Base64（把 `+` 换成 `-`、`/` 换成 `_`，并去掉末尾 `=`），`js-base64` 两种格式都能解码。

Worker 会以 Clash 客户端的 User-Agent 去拉取订阅，因此那些只在识别到 Clash 客户端时才返回 YAML 的订阅接口（例如 `/api/v1/client/subscribe`）同样可用；响应中的 `subscription-userinfo` 会透传给客户端，用于显示已用流量、总流量和到期时间。若订阅返回的不是 Clash YAML，会返回 502 并提示原因。

## 注意事项

`workers.dev` 已被墙，请使用自有域名。
