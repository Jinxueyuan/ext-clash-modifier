// 指定需要在原有配置文件上删除的字段
const remove = ['proxy-groups', 'rules', 'rule-providers'];

// 用 INI 写策略：一行一条规则 / 一个代理组，改起来比手写 YAML 直观得多。
//
// [custom] ruleset=<代理组名>,<规则>
//   clash-{classical|domain|ipcidr}:<URL>  自动生成 rule-provider 与 RULE-SET 规则
//                                          第三段可写更新间隔（秒，默认 86400）
//   []GEOIP,<地区>                         生成 GEOIP 规则
//   []GEOSITE,<分类>                       生成 GEOSITE 规则（需 Clash.Meta 内核）
//   []FINAL                               生成 MATCH 规则
//   URL 里可用 ${provider_proxy} / ${clash_rule} 变量
// [custom] custom_proxy_group=<组名>`<select|url-test>`<参数...>
//   []文本      直接引用代理名 / 代理组名
//   正则表达式   按节点名称筛选，如 美国.* ；.* 表示全部节点
//   url-test 第 4 段为 <间隔>,<超时>,<容差>，如 300,5000,50
// [var] 可覆盖 provider_proxy / clash_rule 等变量
//
// 也可把 INI 放到公网，用 ?custom=<base64(INI_URL)> 覆盖这里的默认配置。
const defaultIniConfig = [
  '[custom]',
  'ruleset=🎯 全球直连,clash-classical:${provider_proxy}${clash_rule}applications.txt',
  'ruleset=🎯 全球直连,clash-domain:${provider_proxy}${clash_rule}private.txt',
  'ruleset=🛑 广告拦截,clash-domain:${provider_proxy}${clash_rule}reject.txt',
  'ruleset=🎯 全球直连,clash-domain:${provider_proxy}${clash_rule}icloud.txt',
  'ruleset=🎯 全球直连,clash-domain:${provider_proxy}${clash_rule}apple.txt',
  'ruleset=🎯 全球直连,clash-domain:${provider_proxy}${clash_rule}google.txt',
  'ruleset=🚀 节点选择,clash-domain:${provider_proxy}${clash_rule}tld-not-cn.txt',
  'ruleset=🚀 节点选择,clash-domain:${provider_proxy}${clash_rule}gfw.txt',
  'ruleset=🚀 节点选择,clash-domain:${provider_proxy}${clash_rule}greatfire.txt',
  'ruleset=🚀 节点选择,clash-ipcidr:${provider_proxy}${clash_rule}telegramcidr.txt',
  'ruleset=🎯 全球直连,clash-ipcidr:${provider_proxy}${clash_rule}lancidr.txt',
  'ruleset=🎯 全球直连,clash-ipcidr:${provider_proxy}${clash_rule}cncidr.txt',
  'ruleset=🚀 节点选择,clash-domain:${provider_proxy}${clash_rule}proxy.txt',
  'ruleset=🎯 全球直连,clash-domain:${provider_proxy}${clash_rule}direct.txt',
  'ruleset=🎯 全球直连,[]GEOIP,LAN',
  'ruleset=🎯 全球直连,[]GEOIP,CN',
  'ruleset=🐟 漏网之鱼,[]FINAL',
  'custom_proxy_group=🚀 节点选择`select`[]♻️ 自动选择`[]🔧 手动切换`[]🌏 地区选择`[]DIRECT',
  'custom_proxy_group=♻️ 自动选择`url-test`.*`http://www.gstatic.com/generate_204`300,5000,50',
  'custom_proxy_group=🔧 手动切换`select`.*',
  'custom_proxy_group=🎯 全球直连`select`[]DIRECT`[]🚀 节点选择`[]♻️ 自动选择`[]🔧 手动切换`[]REJECT',
  'custom_proxy_group=🛑 广告拦截`select`[]REJECT`[]🚀 节点选择`[]♻️ 自动选择`[]🔧 手动切换`[]DIRECT',
  'custom_proxy_group=🐟 漏网之鱼`select`[]DIRECT`[]🚀 节点选择`[]♻️ 自动选择`[]🔧 手动切换',
  'custom_proxy_group=🌏 地区选择`select`[]🔧 手动切换`[]美国节点`[]日本节点`[]新加坡节点`[]台湾节点',
  'custom_proxy_group=美国节点`url-test`美国.*`http://www.gstatic.com/generate_204`300,5000,50',
  'custom_proxy_group=日本节点`url-test`日本.*`http://www.gstatic.com/generate_204`300,5000,50',
  'custom_proxy_group=新加坡节点`url-test`新加坡.*`http://www.gstatic.com/generate_204`300,5000,50',
  'custom_proxy_group=台湾节点`url-test`(台湾|台灣|臺灣|臺湾).*`http://www.gstatic.com/generate_204`300,5000,50',
].join('\n');

export default { remove, defaultIniConfig };
