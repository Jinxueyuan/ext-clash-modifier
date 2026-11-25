import { Base64 } from 'js-base64';
import yaml from 'js-yaml';
import { KeyMergeStrategies, parse } from 'js-ini';
import './template.js';
import template from './template.js';

// 机场订阅只有识别到 Clash 客户端时才返回 YAML，否则返回 base64 节点列表
// （有些甚至只返回几个占位节点）。Cloudflare Workers 允许在子请求里设置 UA。
const CLASH_UA = 'clash-verge/v1.0.0';
const CLASH_RULE = 'https://raw.githubusercontent.com/Loyalsoldier/clash-rules/release/';

// 线路类型识别：判断节点入口 IP 是家宽还是机房。
// 主接口 ip-api.com 的 hosting 字段最准，但免费版只有 http、45 次/分钟；
// 它连续没响应时整轮退回 DoH 解析 + ipinfo.io，按 ASN / PTR 关键词猜。
// 结果按主机名缓存，命中缓存不占查询次数，节点多的订阅分几次刷新就能补齐。
const IP_API = 'http://ip-api.com/json/';
const IPINFO_API = 'https://ipinfo.io/';
const IP_CACHE_PATH = '/__ip-type__/';
const IP_CACHE_TTL = 7 * 24 * 60 * 60;
const IP_MISS_CACHE_TTL = 60 * 60; // 没查到的只记一会儿，下次刷新再试
const IP_REQUEST_LIMIT = 45; // Workers 免费版每个请求 50 个子请求
const IP_CONCURRENCY = 5;
const IP_BUDGET_MS = 8000; // 超过就不再查，剩下的节点留给下次刷新
const IP_API_FAIL_LIMIT = 3;
const DATACENTER_HINT =
  /cloud|amazon|aws|google|microsoft|azure|oracle|digitalocean|linode|akamai|vultr|hetzner|ovh|contabo|leaseweb|choopa|m247|alibaba|aliyun|tencent|hosting|datacenter|data ?center|idc|vps|server|colo|dedicated|cloudflare/i;
const RESIDENTIAL_HINT =
  /hinet|chunghwa|dynamic-?ip|adsl|dsl|broadband|ppp|dial-?up|residential|comcast|verizon|spectrum|xfinity|kddi|ntt/i;

function toArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function templateFormat(str, vars) {
  return str.replace(/\$\{([^}]*)\}/g, (_, key) => vars[key] ?? '');
}

function getProxyNames(proxyNames, rules, classified) {
  let result = [];
  rules.forEach((rule) => {
    if (rule.startsWith('[]')) {
      result.push(rule.substring(2));
    } else if (rule.startsWith('@')) {
      let names = classified && classified[rule.substring(1)];
      if (!names) {
        console.error(`unknown ip type: ${rule}`);
        return;
      }
      result.push(...proxyNames.filter((name) => names.has(name)));
    } else {
      let re;
      try {
        re = new RegExp(rule);
      } catch (_) {
        console.error(`invalid proxy regex: ${rule}`);
        return;
      }
      result.push(...proxyNames.filter((name) => re.test(name)));
    }
  });
  return [...new Set(result)];
}

async function fetchText(url, headers) {
  let resp = await fetch(url, headers ? { headers } : undefined);
  return await resp.text();
}

// INI 里出现 @residential / @datacenter 时才需要真的发请求做识别
function needsIpClassify(customObj) {
  return toArray(customObj['custom'] && customObj['custom']['custom_proxy_group'])
    .some((line) => /@(residential|datacenter)(`|$)/.test(String(line)));
}

// 缓存键走本域名的路径：Workers 的 Cache API 不能跨 zone 写
function ipCacheRequest(host, origin) {
  return new Request(`${origin}${IP_CACHE_PATH}${encodeURIComponent(host)}`);
}

async function readCachedType(host, origin) {
  if (typeof caches === 'undefined') return '';
  try {
    let hit = await caches.default.match(ipCacheRequest(host, origin));
    if (!hit) return '';
    let text = await hit.text();
    return text === 'residential' || text === 'datacenter' || text === 'unknown' ? text : '';
  } catch (_) {
    return '';
  }
}

async function writeCachedType(host, origin, type) {
  if (typeof caches === 'undefined') return;
  let ttl = type === 'unknown' ? IP_MISS_CACHE_TTL : IP_CACHE_TTL;
  try {
    await caches.default.put(ipCacheRequest(host, origin), new Response(type, {
      headers: { 'content-type': 'text/plain', 'cache-control': `max-age=${ttl}` },
    }));
  } catch (_) {}
}

async function fetchJson(url, headers) {
  let controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), 3000);
  try {
    let resp = await fetch(url, {
      signal: controller.signal,
      headers: headers ? { accept: headers } : undefined,
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function isIpLiteral(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

// DoH JSON 接口，用来把节点域名解析成 IP（ipinfo 只认 IP）
const DOH_APIS = [
  'https://dns.alidns.com/resolve',
  'https://cloudflare-dns.com/dns-query',
];

async function dohResolve(host, budget) {
  for (let api of DOH_APIS) {
    if (budget.left <= 0) return '';
    budget.left--;
    let data = await fetchJson(`${api}?name=${encodeURIComponent(host)}&type=A`, 'application/dns-json');
    let answer = data && Array.isArray(data.Answer) ? data.Answer : [];
    for (let record of answer) {
      if (record.type === 1 && record.data) return record.data;
    }
  }
  return '';
}

// ipinfo 没有 hosting 字段，只能看 ASN / PTR 里有没有机房或家宽关键词
async function ipinfoType(ip) {
  let data = await fetchJson(`${IPINFO_API}${encodeURIComponent(ip)}/json`);
  if (!data) return '';
  let desc = `${data.org || ''} ${data.hostname || ''}`;
  if (DATACENTER_HINT.test(desc)) return 'datacenter';
  if (RESIDENTIAL_HINT.test(desc)) return 'residential';
  return '';
}

// 单个主机名 -> 'residential' | 'datacenter' | ''
// ip-api 支持直接传域名，一次请求搞定；它不通时再用 DoH 解析 + ipinfo 兜底，
// 兜底要两次请求，所以 budget 是按请求数算的。
async function lookupHostType(host, budget, state) {
  let type = '';
  if (state.useIpApi && budget.left > 0) {
    budget.left--;
    let data = await fetchJson(
      `${IP_API}${encodeURIComponent(host)}?fields=status,hosting,isp,org,as`
    );
    if (data === null) {
      if (++state.fails >= IP_API_FAIL_LIMIT) state.useIpApi = false;
    } else {
      state.fails = 0;
      if (data.status === 'success') {
        if (data.hosting === true) type = 'datacenter';
        else if (data.hosting === false) type = 'residential';
        else {
          let desc = `${data.isp || ''} ${data.org || ''} ${data.as || ''}`;
          type = DATACENTER_HINT.test(desc) ? 'datacenter' : 'residential';
        }
      }
    }
  }
  if (!type && budget.left > 0) {
    let ip = isIpLiteral(host) ? host : '';
    if (!ip) ip = await dohResolve(host, budget);
    if (ip && budget.left > 0) {
      budget.left--;
      type = await ipinfoType(ip);
    }
  }
  return type;
}

// 返回 Map<节点名, 'residential'|'datacenter'>；没识别出来的节点不在里面
async function classifyProxies(proxies, origin, limit) {
  let hosts = [...new Set(
    proxies.map((p) => p && p.server).filter((s) => typeof s === 'string' && s)
  )];
  let types = new Map();
  let cached = await Promise.all(hosts.map((host) => readCachedType(host, origin)));
  let pending = [];
  hosts.forEach((host, i) => {
    if (cached[i] === 'residential' || cached[i] === 'datacenter') types.set(host, cached[i]);
    else if (!cached[i]) pending.push(host); // 上次没查到的先跳过，把请求留给别的节点
  });

  let budget = { left: limit };
  let state = { fails: 0, useIpApi: true };
  let deadline = Date.now() + IP_BUDGET_MS;
  let next = 0;

  let worker = async () => {
    while (next < pending.length && budget.left > 0 && Date.now() < deadline) {
      let host = pending[next++];
      let type = await lookupHostType(host, budget, state);
      await writeCachedType(host, origin, type || 'unknown');
      if (type) types.set(host, type);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(IP_CONCURRENCY, pending.length) }, worker)
  );

  let result = new Map();
  proxies.forEach((p) => {
    let type = p && types.get(p.server);
    if (type) result.set(p.name, type);
  });
  return result;
}

async function parseCustom(customUrl) {
  let customObj = null;
  if (customUrl) {
    try {
      let sep = customUrl.includes('?') ? '&' : '?';
      let ini = await fetchText(`${customUrl}${sep}ts=${Date.now()}`);
      customObj = parse(ini, { keyMergeStrategy: KeyMergeStrategies.JOIN_TO_ARRAY });
    } catch (e) {
      console.error(`failed to parse custom config: ${customUrl}`);
    }
  }
  if (customObj && customObj['custom']) return customObj;
  return parse(template.defaultIniConfig, { keyMergeStrategy: KeyMergeStrategies.JOIN_TO_ARRAY });
}

function parseVars(customObj, request) {
  let vars = {
    provider_proxy: new URL(request.url).origin + '/p/',
    clash_rule: '',
  };
  let customVars = customObj['var'] || {};
  Object.keys(customVars).forEach((key) => {
    let value = customVars[key];
    vars[key] = Array.isArray(value) ? value[value.length - 1] : value;
  });
  return vars;
}

function parseRules(customObj, proxyNames, vars, classified) {
  let ruleProviders = {}, rules = [];
  toArray(customObj['custom'] && customObj['custom']['ruleset']).forEach((line) => {
    let split = line.split(',');
    if (split.length < 2) return;
    let groupName = split[0];
    let clashMatch = split[1].match(/^clash-(classical|ipcidr|domain):/);
    if (clashMatch) {
      let behavior = clashMatch[1];
      let interval = Number(split[2]) || 86400;
      let url = templateFormat(split[1].substring(split[1].indexOf(':') + 1), vars);
      let nameMatch = url.match(/([^/]*)\.[^.]*$/);
      let name = nameMatch ? nameMatch[1] : url;
      if (!name) return;
      ruleProviders[name] = {
        type: 'http', behavior, url,
        path: `./ruleset/${name}`, interval,
      };
      rules.push(`RULE-SET,${name},${groupName}`);
    } else if (split[1] === '[]GEOIP' && split[2]) {
      rules.push(`GEOIP,${split[2]},${groupName}`);
    } else if (split[1] === '[]GEOSITE' && split[2]) {
      rules.push(`GEOSITE,${split[2]},${groupName}`);
    } else if (split[1] === '[]FINAL') {
      rules.push(`MATCH,${groupName}`);
    }
  });

  let proxyGroups = [];
  toArray(customObj['custom'] && customObj['custom']['custom_proxy_group']).forEach((line) => {
    let params = line.split('`');
    if (params.length < 2) return;
    let name = params[0];
    if (params[1] === 'url-test') {
      let [i, t, tol] = (params[4] || '').split(',');
      proxyGroups.push({
        name, type: 'url-test',
        url: params[3] || 'http://www.gstatic.com/generate_204',
        interval: Number(i) || 300,
        timeout: Number(t) || 5000,
        tolerance: Number(tol) || 50,
        proxies: getProxyNames(proxyNames, [params[2] || '.*'], classified),
      });
    } else if (params[1] === 'select') {
      proxyGroups.push({
        name, type: 'select',
        proxies: getProxyNames(proxyNames, params.slice(2), classified),
      });
    }
  });

  // 丢掉没有匹配到节点的组，并清理指向它们的引用，避免生成无效配置
  proxyGroups = proxyGroups.filter((g) => g.proxies.length > 0);
  let valid = new Set([...proxyNames, ...proxyGroups.map((g) => g.name), 'DIRECT', 'REJECT']);
  proxyGroups = proxyGroups
    .map((g) => ({ ...g, proxies: g.proxies.filter((p) => valid.has(p)) }))
    .filter((g) => g.proxies.length > 0);

  return { 'proxy-groups': proxyGroups, rules, 'rule-providers': ruleProviders };
}

async function fetchSub(url) {
  let resp = await fetch(url, { headers: { 'User-Agent': CLASH_UA } });
  return [await resp.text(), resp];
}

export default {
  async fetch(request) {
    let { pathname, searchParams } = new URL(request.url);

    if (pathname.startsWith('/p/')) {
      let filename = pathname.slice(3);
      return fetch(`${CLASH_RULE}${filename}`);
    }

    // 上一段用的缓存键路径，只给 Cache API 用，不对外提供内容
    if (pathname.startsWith(IP_CACHE_PATH)) {
      return new Response('not found', { status: 404 });
    }

    if (!pathname.startsWith('/m/')) {
      return new Response('error: invalid parameter', {
        headers: { 'content-type': 'text/plain' },
      });
    }

    let configUrl = Base64.decode(pathname.slice(3));
    let customUrl = null;
    try {
      if (searchParams.get('custom')) {
        customUrl = Base64.decode(searchParams.get('custom'));
      }
    } catch (_) {}

    let customObj = await parseCustom(customUrl);
    let vars = parseVars(customObj, request);

    let [rawConfig, resp] = await fetchSub(configUrl);
    let configObj;
    try {
      configObj = yaml.load(rawConfig);
    } catch (_) {}
    if (!configObj || typeof configObj !== 'object' || !Array.isArray(configObj['proxies'])) {
      return new Response(`error: subscription did not return a Clash YAML config (status ${resp.status})`, {
        status: 502,
        headers: { 'content-type': 'text/plain' },
      });
    }

    template.remove.forEach((key) => {
      if (key in configObj) delete configObj[key];
    });

    // 上游会在 dns.nameserver-policy 里引用 rule-set:cn / private / proxy，
    // 上游的 rule-providers 已被删掉，这些引用会让 Mihomo 因找不到 rule-set
    // 而拒绝加载整份配置；其中 cn / private 两条与默认 nameserver 完全相同。
    if (configObj.dns && typeof configObj.dns === 'object') {
      delete configObj.dns['nameserver-policy'];
    }

    let classified = null;
    if (needsIpClassify(customObj)) {
      let limit = Math.min(Math.max(Number(vars.ip_lookup_limit) || IP_REQUEST_LIMIT, 1), 1000);
      let types = await classifyProxies(configObj['proxies'], new URL(request.url).origin, limit);
      classified = { residential: new Set(), datacenter: new Set() };
      types.forEach((type, name) => classified[type].add(name));
    }

    let proxyNames = configObj['proxies'].map((p) => p['name']);
    Object.assign(configObj, parseRules(customObj, proxyNames, vars, classified));

    let configStr = yaml.dump(configObj);
    let headers = new Headers({ 'content-type': 'text/yaml; charset=utf-8' });
    ['subscription-userinfo', 'profile-update-interval'].forEach((key) => {
      let value = resp.headers.get(key);
      if (value) headers.set(key, value);
    });
    return new Response(configStr, { headers });
  },
};
