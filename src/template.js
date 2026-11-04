// 指定需要在原有配置文件上删除的字段
const remove = ["proxy-groups", "rules", "rule-providers"];

// 按节点名称中的关键字划分地区代理组，顺序即客户端中的显示顺序
// 命中任意 keyword 的节点归入该组；未匹配到任何关键字的节点不加入地区组
const regions = [
  { name: "美国节点", keywords: ["美国", "美國"] },
  { name: "日本节点", keywords: ["日本"] },
  { name: "新加坡节点", keywords: ["新加坡"] },
  { name: "台湾节点", keywords: ["台湾", "臺灣"] },
];

// 指定需要需要追加的 YAML 配置，注意缩进
// 在数组中，使用 `_PROXY_NAME` 指代所有的 Proxy Name
// 在数组中，使用 `_REGION_GROUPS` 指代上面所有地区代理组的名称
// 在 Rule Provider 中的 URL 中，使用 `_PROVIDER_PROXY|` 指代规则文件代理 URL
const append = `
proxy-groups:
  - name: 🔯 代理模式
    type: select
    proxies:
      - 绕过大陆丨黑名单(GFWlist)
      - 绕过大陆丨白名单(Whitelist)
      - 🌏 地区选择
  - name: 🔰 选择节点
    type: select
    proxies: [DIRECT, _PROXY_NAME]
  - name: 🌏 地区选择
    type: select
    proxies:
      - 🔰 选择节点
      - _REGION_GROUPS
  - name: 🛑 广告拦截
    type: select
    proxies:
      - DIRECT
      - REJECT
      - PROXY
  - name: 绕过大陆丨黑名单(GFWlist)
    type: url-test
    url: http://www.gstatic.com/generate_204
    interval: 86400
    proxies:
      - DIRECT
  - name: 绕过大陆丨白名单(Whitelist)
    type: url-test
    url: http://www.gstatic.com/generate_204
    interval: 86400
    proxies:
      - PROXY
  - name: PROXY
    type: url-test
    url: http://www.gstatic.com/generate_204
    interval: 86400
    proxies:
      - 🔰 选择节点

rules:
  - RULE-SET,applications,DIRECT
  - DOMAIN,clash.razord.top,DIRECT
  - DOMAIN,yacd.haishan.me,DIRECT
  - RULE-SET,private,DIRECT
  - RULE-SET,reject,🛑 广告拦截
  - RULE-SET,icloud,DIRECT
  - RULE-SET,apple,DIRECT
  - RULE-SET,google,DIRECT
  - RULE-SET,tld-not-cn,PROXY
  - RULE-SET,gfw,PROXY
  - RULE-SET,greatfire,PROXY
  - RULE-SET,telegramcidr,PROXY
  - RULE-SET,lancidr,DIRECT
  - RULE-SET,cncidr,DIRECT
  - GEOIP,,DIRECT
  - GEOIP,CN,DIRECT
  - RULE-SET,direct,DIRECT
  - RULE-SET,proxy,🔯 代理模式
  - MATCH,🔯 代理模式

rule-providers:
  reject:
    type: http
    behavior: domain
    url: _PROVIDER_PROXY|reject.txt
    path: ./ruleset/reject.yaml
    interval: 86400
  icloud:
    type: http
    behavior: domain
    url: _PROVIDER_PROXY|icloud.txt
    path: ./ruleset/icloud.yaml
    interval: 86400
  apple:
    type: http
    behavior: domain
    url: _PROVIDER_PROXY|apple.txt
    path: ./ruleset/apple.yaml
    interval: 86400
  google:
    type: http
    behavior: domain
    url: _PROVIDER_PROXY|google.txt
    path: ./ruleset/google.yaml
    interval: 86400
  proxy:
    type: http
    behavior: domain
    url: _PROVIDER_PROXY|proxy.txt
    path: ./ruleset/proxy.yaml
    interval: 86400
  direct:
    type: http
    behavior: domain
    url: _PROVIDER_PROXY|direct.txt
    path: ./ruleset/direct.yaml
    interval: 86400
  private:
    type: http
    behavior: domain
    url: _PROVIDER_PROXY|private.txt
    path: ./ruleset/private.yaml
    interval: 86400
  gfw:
    type: http
    behavior: domain
    url: _PROVIDER_PROXY|gfw.txt
    path: ./ruleset/gfw.yaml
    interval: 86400
  greatfire:
    type: http
    behavior: domain
    url: _PROVIDER_PROXY|greatfire.txt
    path: ./ruleset/greatfire.yaml
    interval: 86400
  tld-not-cn:
    type: http
    behavior: domain
    url: _PROVIDER_PROXY|tld-not-cn.txt
    path: ./ruleset/tld-not-cn.yaml
    interval: 86400
  telegramcidr:
    type: http
    behavior: ipcidr
    url: _PROVIDER_PROXY|telegramcidr.txt
    path: ./ruleset/telegramcidr.yaml
    interval: 86400
  cncidr:
    type: http
    behavior: ipcidr
    url: _PROVIDER_PROXY|cncidr.txt
    path: ./ruleset/cncidr.yaml
    interval: 86400
  lancidr:
    type: http
    behavior: ipcidr
    url: _PROVIDER_PROXY|lancidr.txt
    path: ./ruleset/lancidr.yaml
    interval: 86400
  applications:
    type: http
    behavior: classical
    url: _PROVIDER_PROXY|applications.txt
    path: ./ruleset/applications.yaml
    interval: 86400

`;

export default { remove, append, regions };
