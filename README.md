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
npm ci
wrangler login
wrangler deploy
```

> 依赖 `js-base64` / `js-yaml` / `js-ini` 必须先安装到仓库目录，否则 Wrangler 打包时会报 `Could not resolve "js-base64"` 等 3 个错误。`wrangler.toml` 里的 `[build] command` 会在 `wrangler dev` / `wrangler deploy` 打包前自动补做 `npm install`，因此全新 clone 直接部署也可以。
>
> 使用 wrangler 2.x（本仓库 `devDependencies` 里的版本）时命令是 `wrangler publish`；`wrangler deploy` 需要 wrangler 3+。

3. 绑定你的域名 (。・∀・)ノ

## 自定义 `template.js`

策略写在 `template.js` 的 `defaultIniConfig` 里，采用类似 Clash for Windows Parser 的 INI 格式：一行一条规则、一行一个代理组，改起来比手写 YAML 直观得多。设计参考 [CHENXCHEN/ext-clash-modifier](https://github.com/CHENXCHEN/ext-clash-modifier)。

### 规则 `ruleset=`

```
ruleset=<代理组名>,clash-{classical|domain|ipcidr}:<规则文件 URL>[,<间隔秒>]
ruleset=<代理组名>,[]GEOIP,<地区>
ruleset=<代理组名>,[]FINAL
```

- `clash-*` 会同时生成 `rule-providers` 项和 `RULE-SET` 规则；URL 中可用 `${provider_proxy}`、`${clash_rule}` 变量。默认 `provider_proxy` 指向本 Worker 的 `/p/` 反代，`clash_rule` 为空。
- `[]GEOIP` 生成 `GEOIP` 规则，`[]FINAL` 生成 `MATCH` 规则。

### 代理组 `custom_proxy_group=`

```
custom_proxy_group=<组名>`select`<参数>`<参数>...
custom_proxy_group=<组名>`url-test`<节点正则>`<测试 URL>`<间隔>,<超时>,<容差>
```

用反引号分隔。`[]文本` 直接引用代理名或代理组名；不带 `[]` 的参数按**正则表达式**从节点名称中筛选，`.*` 表示全部节点。按地区分组就是一条正则的事：

```
custom_proxy_group=🌏 地区选择`select`[]🔧 手动切换`[]美国节点`[]日本节点
custom_proxy_group=美国节点`url-test`美国.*`http://www.gstatic.com/generate_204`300,5000,50
custom_proxy_group=日本节点`url-test`日本.*`http://www.gstatic.com/generate_204`300,5000,50
```

没有匹配到节点的组会自动跳过，指向它的引用也会被清理。默认配置已包含美国 / 日本 / 新加坡 / 台湾分组和 `🌏 地区选择` 选择器。

### 变量与外部配置

INI 里可加 `[var]` 覆盖 `provider_proxy` / `clash_rule`。也可以把整份 INI 放到公网，用 `?custom=<base64(INI_URL)>` 覆盖默认配置（拉取时会附加时间戳避免缓存）：

```
https://<your-domain>/m/<base64-config-url>?custom=<base64-ini-url>
```

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
