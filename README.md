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
ruleset=<代理组名>,[]GEOSITE,<分类>
ruleset=<代理组名>,[]FINAL
```

- `clash-*` 会同时生成 `rule-providers` 项和 `RULE-SET` 规则；URL 中可用 `${provider_proxy}`、`${clash_rule}` 变量。默认 `provider_proxy` 指向本 Worker 的 `/p/` 反代，`clash_rule` 为空。
- `[]GEOIP` 生成 `GEOIP` 规则，`[]GEOSITE` 生成 `GEOSITE` 规则，`[]FINAL` 生成 `MATCH` 规则。

例如把常见大站交给节点、把国内站点直连：

```
ruleset=🚀 节点选择,[]GEOSITE,geolocation-!cn
ruleset=🎯 全球直连,[]GEOSITE,cn
```

> `GEOSITE` 是 Clash.Meta（Clash Verge Rev / Mihomo / Clash for Android Meta）内核才支持的规则类型，原版 Clash Premium 不认识，会报错或忽略。默认配置里没有放 `GEOSITE` 规则，需要时自己加即可。

### 代理组 `custom_proxy_group=`

```
custom_proxy_group=<组名>`select`<参数>`<参数>...
custom_proxy_group=<组名>`url-test`<节点正则>`<测试 URL>`<间隔>,<超时>,<容差>
```

用反引号分隔。`[]文本` 直接引用代理名或代理组名；不带 `[]` 的参数按**正则表达式**从节点名称中筛选，`.*` 表示全部节点。按地区分组就是一条正则的事：

```
custom_proxy_group=🌏 地区选择`select`[]🔧 手动切换`[]🇺🇸 美国节点`[]🇯🇵 日本节点
custom_proxy_group=🇺🇸 美国节点`url-test`美国.*`http://www.gstatic.com/generate_204`300,5000,50
custom_proxy_group=🇯🇵 日本节点`url-test`日本.*`http://www.gstatic.com/generate_204`300,5000,50
```

没有匹配到节点的组会自动跳过，指向它的引用也会被清理。默认配置已包含美国 / 日本 / 新加坡 / 台湾分组和 `🌏 地区选择` 选择器。

### 按线路类型分组（家宽 / 机房）

除了正则，还可以用 `@residential` / `@datacenter` 按**节点服务器的 IP 类型**筛选，而不是看节点名字：

```
custom_proxy_group=🏠 家宽节点`url-test`@residential`http://www.gstatic.com/generate_204`300,5000,50
custom_proxy_group=🏢 机房节点`url-test`@datacenter`http://www.gstatic.com/generate_204`300,5000,50
```

默认配置已经带上这两个组，并挂在 `🚀 节点选择` 下面。生成配置时，Worker 先用 DoH 把每个节点的 `server`（常是随机子域名）解析成 IP，再拿 IP 查 [ipwho.is](https://ipwho.is) 的 `isp` / `org` / `domain` / `asn`，按关键词判断家宽（如 HiNet / 中华电信 / `dynamic-ip`）还是机房（如 Akamai / DigitalOcean / Cloud）。ipwho.is 请求失败时才退到 [ipinfo.io](https://ipinfo.io)（免费版在 Workers 共享出口可能被限流）。INI 里没有 `@` 参数时不会发任何查询。

> 早期版本用 ip-api.com 的 `hosting` 字段作主接口，但它的免费 HTTP 端点现在直接返回 `status:fail`，已改用 ipwho.is。

识别结果按主机名存一条记录：主机名→IP 记 1 天，线路类型记 7 天（没识别出来的记 1 小时）。**过了校验期不会立刻丢掉**：仍沿用上次的判定结果，等预算允许时再重新校验，所以缓存到期那一刻组不会突然空掉。没绑 KV 时这些记录整体存在 Cache API 的**一个**缓存项里；之所以不按节点分开存，是因为 Workers 的 **Cache API 调用（`match` / `put`）也占子请求额度**，按节点分开缓存时节点一多，光读缓存就会把 50 次额度用光，导致每次刷新只能认出很少几个节点，看着就像「家宽越刷越少、机房直接消失」。

`ip_lookup_limit` 是识别阶段**所有子请求**（`fetch` + Cache API）的总预算，默认 45：

```
[var]
ip_lookup_limit=45
```

每条新节点大约要一次 DoH + 一次情报查询，所以一次刷新能补 20 个左右的新节点；80 个节点的订阅刷新三四次就补齐。补齐之后每次生成只花一次缓存读（有变化时再写一次），所有节点都会稳定进组，不会再越刷越少。写回缓存的那一次子请求会提前预留，额度用尽也不会丢掉这次的识别结果。

Workers 免费版单请求上限 50 个子请求，默认值留了余量；付费版可以把这个值调大，一次就能补更多节点。

### 跨机房共享识别结果（可选 KV）

没绑 KV 时结果存在 Cache API 里，而 Cache API 是**按 Cloudflare 机房**隔离的：请求落到没预热过的机房，要重新刷三四次补齐。

绑一个 KV 命名空间就能让所有机房共享同一份结果：

```
wrangler kv:namespace create IP_TYPE_KV
wrangler kv:namespace create IP_TYPE_KV --preview
```

把两条命令输出的 id 分别填进 `wrangler.toml` 里的 `id` / `preview_id`（配置文件里已有注释好的模板），重新 deploy 即可。绑定后识别结果按主机名逐条写进 KV（KV 操作不占子请求额度），一个机房新识别出的节点，其他机房大约 60 秒后也能用上，不用再各自预热。KV 里已识别的记录保留 30 天，比 7 天的校验期长，过期后仍能拿来兜底。

KV 免费额度是每天 10 万次读、1000 次写：每次生成最多读「节点数」个键，只有新识别出的节点才写，正常使用够用。

几点限制：

- 判定的是节点**入口服务器**的 IP。走中转或 CDN 的节点看到的是中转地址，可能和真实出口不一致。
- ipwho.is / ipinfo.io 都靠关键词猜，识别不出来的节点这次不进组，仍留在 `♻️ 自动选择` / `🔧 手动切换` 里，下次刷新会用缓存继续补齐。
- 查询会把节点服务器 IP 发给第三方。介意的话删掉这两行，或换回按节点名正则分组。

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
