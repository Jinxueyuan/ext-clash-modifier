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
// 节点的 server 多是随机子域名，要先用 DoH 解析成 IP，再拿 IP 查情报库。
//
// 注意：Workers 免费版每个请求只有 50 个子请求，而 Cache API 的 match / put
// 也算子请求。所以整张识别结果表只存一个缓存项（一次读 + 一次写），不能按节点
// 分别缓存，否则光读缓存就能把额度用光，节点越多的订阅反而进组越少。
// 识别结果按主机名存一条记录（IP + 类型）：已经识别过的节点之后每次刷新都能全部
// 进组，新节点每次刷新补一部分，多刷几次就补齐。
// Cache API 是按机房隔离的，绑定了 KV（IP_TYPE_KV）就优先用 KV，让所有机房共享
// 同一份结果；没绑就退回 Cache API，新机房仍需要重新补齐几次。
const IPINFO_API = 'https://ipinfo.io/';
const IPWHOIS_API = 'https://ipwho.is/';
const IP_CACHE_PATH = '/__ip-type__/';
const IP_CACHE_KEY = 'v3';
const KV_PREFIX = 'v1:';
const HOST_IP_TTL = 24 * 60 * 60; // 主机名 → IP 记一天，免得每小时重复 DoH
const IP_CACHE_TTL = 7 * 24 * 60 * 60; // 家宽 / 机房结果记 7 天
const IP_KEEP_TTL = 30 * 24 * 60 * 60; // KV 里已知类型多留一阵，过了 7 天校验期还能兜底
const IP_MISS_CACHE_TTL = 60 * 60; // 没识别出来的只记一会儿，下次刷新再试
const IP_REQUEST_LIMIT = 45; // 分类阶段所有子请求（fetch + Cache API）的总预算
const IP_CONCURRENCY = 5;
const IP_BUDGET_MS = 12000; // 超时就停，剩下的节点留给下次刷新
const IP_WHOIS_FAIL_LIMIT = 5; // ipwho 连续请求失败就退到 ipinfo
const IPINFO_FAIL_LIMIT = 5; // ipinfo 连续失败（被限流）就别再浪费请求
const DATACENTER_HINT =
  /cloud|amazon|aws|google|microsoft|azure|oracle|digitalocean|linode|akamai|vultr|hetzner|ovh|contabo|leaseweb|choopa|m247|alibaba|aliyun|tencent|hosting|datacenter|data ?center|idc|vps|server|colo|dedicated|cloudflare|linodeusercontent|digitaloceanspaces/i;
const RESIDENTIAL_HINT =
  /hinet|chunghwa|dynamic-?ip|adsl|dsl|broadband|ppp|dial-?up|residential|comcast|verizon|spectrum|xfinity|kddi|ntt|home|broadband|^as3462$/i;

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

// 每发一个 fetch / 调一次 Cache API 之前先 take 一次，保证不会撞上
// 「Too many subrequests」——撞上时后续请求全部失败，识别会直接停在半截。
function take(budget) {
  if (budget.left <= 0) return false;
  budget.left--;
  return true;
}

function ipCacheRequest(origin) {
  return new Request(`${origin}${IP_CACHE_PATH}${IP_CACHE_KEY}`);
}

// 一条记录：{ ip, type, at }，type 为空表示只解析到了 IP 还没查到类型。
function recordTtl(rec) {
  if (rec.type) return rec.type === 'unknown' ? IP_MISS_CACHE_TTL : IP_CACHE_TTL;
  return HOST_IP_TTL;
}

// 已识别过的类型算「可长期复用」：过了校验期也先沿用，避免整组消失
function isKnown(rec) {
  return !!rec && (rec.type === 'residential' || rec.type === 'datacenter');
}

function recordFresh(rec, now) {
  return !!rec && typeof rec.ip === 'string' && now - rec.at < recordTtl(rec);
}

async function loadRecords(hosts, env, origin, budget) {
  let records = new Map();
  let kv = env && env.IP_TYPE_KV;
  if (kv) {
    // KV 操作不占子请求额度，按主机名逐个读，写入时也就不会互相覆盖
    await Promise.all(hosts.map(async (host) => {
      try {
        let rec = await kv.get(`${KV_PREFIX}${host}`, 'json');
        if (rec && typeof rec === 'object') records.set(host, rec);
      } catch (_) {}
    }));
    return records;
  }
  // 没有 KV 时退回 Cache API：整表存一项，只花一次读 + 一次写
  if (typeof caches === 'undefined' || !take(budget)) return records;
  try {
    let hit = await caches.default.match(ipCacheRequest(origin));
    if (!hit) return records;
    let data = JSON.parse(await hit.text());
    Object.keys(data || {}).forEach((host) => {
      if (data[host] && typeof data[host] === 'object') records.set(host, data[host]);
    });
  } catch (_) {}
  return records;
}

async function saveRecords(records, dirty, env, origin, now) {
  if (!dirty.size) return;
  let kv = env && env.IP_TYPE_KV;
  if (kv) {
    await Promise.all([...dirty].map((host) => {
      let rec = records.get(host);
      if (!rec) return null;
      return kv.put(`${KV_PREFIX}${host}`, JSON.stringify(rec), {
        // 已知类型在 KV 里多留 30 天，过了 7 天校验期还能继续兜底
        expirationTtl: isKnown(rec) ? IP_KEEP_TTL : recordTtl(rec),
      }).catch(() => {});
    }));
    return;
  }
  if (typeof caches === 'undefined') return;
  let body = {};
  records.forEach((rec, host) => {
    if (isKnown(rec) || recordFresh(rec, now)) body[host] = rec;
  });
  try {
    await caches.default.put(ipCacheRequest(origin), new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json', 'cache-control': `max-age=${IP_KEEP_TTL}` },
    }));
  } catch (_) {}
}

async function fetchJson(url, accept, budget) {
  let controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), 3000);
  try {
    let resp = await fetch(url, {
      signal: controller.signal,
      headers: accept ? { accept } : undefined,
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (e) {
    // 真撞上子请求上限就把预算清零，剩下的节点留到下次刷新再查
    if (budget && /Too many subrequests/i.test(String((e && e.message) || e))) {
      budget.left = 0;
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function isIpLiteral(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

// DoH JSON 接口，用来把节点域名解析成 IP
const DOH_APIS = [
  'https://dns.alidns.com/resolve',
  'https://cloudflare-dns.com/dns-query',
];

async function resolveHost(host, budget) {
  if (isIpLiteral(host)) return host;
  for (let api of DOH_APIS) {
    if (!take(budget)) return '';
    let data = await fetchJson(`${api}?name=${encodeURIComponent(host)}&type=A`, 'application/dns-json', budget);
    let answer = data && Array.isArray(data.Answer) ? data.Answer : [];
    for (let record of answer) {
      if (record.type === 1 && record.data) return record.data;
    }
  }
  return '';
}

// 从情报字段里按关键词判断线路类型
function typeFromDesc(desc) {
  if (DATACENTER_HINT.test(desc)) return 'datacenter';
  if (RESIDENTIAL_HINT.test(desc)) return 'residential';
  return '';
}

// 主接口 ipwho.is：按 IP 查，返回 isp / org / asn / domain。
// 返回 null 表示请求失败（下次还要重试），'' 表示查到了但判断不出来。
async function ipwhoisType(ip, budget) {
  let data = await fetchJson(`${IPWHOIS_API}${encodeURIComponent(ip)}`, null, budget);
  if (!data) return null;
  if (data.success === false) return '';
  let conn = data.connection || {};
  let desc = `${conn.isp || ''} ${conn.org || ''} ${conn.domain || ''} ${conn.asn || ''}`;
  return typeFromDesc(desc);
}

// 兜底接口 ipinfo.io：免费版在 Workers 共享出口可能被限流，只有 org / hostname
async function ipinfoType(ip, budget) {
  let data = await fetchJson(`${IPINFO_API}${encodeURIComponent(ip)}/json`, null, budget);
  if (!data) return null;
  if (data.error) return '';
  return typeFromDesc(`${data.org || ''} ${data.hostname || ''}`);
}

// 单个主机名 -> 'residential' | 'datacenter' | ''；结果写进 records，不算在返回值里。
// 先看有没有新鲜记录，再 DoH 解析，最后查情报接口。budget 按子请求扣。
async function lookupHostType(host, budget, state, records, dirty, now) {
  let rec = records.get(host);
  // 记录过期后仍保留上次判定，重新校验失败时用它兜底，
  // 这样缓存到期那一刻组不会突然空掉。
  let known = isKnown(rec) ? rec.type : '';
  if (rec && recordFresh(rec, now)) {
    if (rec.type === 'unknown') return '';
    if (rec.type) return rec.type;
  } else {
    rec = null;
  }

  let ip = rec ? rec.ip : '';
  if (!ip) {
    ip = await resolveHost(host, budget);
    if (!ip) return ''; // DoH 失败 / 预算用完：不写记录，下次再试
    records.set(host, { ip, type: known, at: now });
    dirty.add(host);
  }

  let type = null;
  if (state.useIpWhois && take(budget)) {
    type = await ipwhoisType(ip, budget);
    if (type === null) {
      if (++state.fails >= IP_WHOIS_FAIL_LIMIT) state.useIpWhois = false;
    } else {
      state.fails = 0;
    }
  }
  if (type === null && state.useIpinfo && take(budget)) {
    let alt = await ipinfoType(ip, budget);
    if (alt) type = alt;
    if (alt === null && ++state.infoFails >= IPINFO_FAIL_LIMIT) state.useIpinfo = false;
    if (alt) state.infoFails = 0;
  }
  if (type === null) return ''; // 请求失败：不写 unknown，否则会把节点锁死一小时

  records.set(host, { ip, type: type || 'unknown', at: now });
  dirty.add(host);
  return type;
}

// 返回 Map<节点名, 'residential'|'datacenter'>；没识别出来的节点不在里面
async function classifyProxies(proxies, env, origin, limit) {
  let hosts = [...new Set(
    proxies.map((p) => p && p.server).filter((s) => typeof s === 'string' && s)
  )];
  let budget = { left: limit };
  let state = { fails: 0, infoFails: 0, useIpWhois: true, useIpinfo: true };
  let now = Math.floor(Date.now() / 1000);
  let dirty = new Set();
  let records = await loadRecords(hosts, env, origin, budget);
  // Cache API 后端要在最后写回整表，先留一次子请求；KV 不计额度，不用留
  if (!(env && env.IP_TYPE_KV) && budget.left > 0) budget.left--;

  let deadline = Date.now() + IP_BUDGET_MS;
  let next = 0;
  let worker = async () => {
    while (next < hosts.length && budget.left > 0 && Date.now() < deadline) {
      await lookupHostType(hosts[next++], budget, state, records, dirty, now);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(IP_CONCURRENCY, hosts.length) }, worker)
  );
  await saveRecords(records, dirty, env, origin, now);

  let result = new Map();
  proxies.forEach((p) => {
    if (!p || !p.name || !p.server) return;
    let rec = records.get(p.server);
    // 已识别过的类型即使过了校验期也先沿用，等到预算允许时再重新校验
    if (isKnown(rec)) result.set(p.name, rec.type);
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
  async fetch(request, env) {
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
      let types = await classifyProxies(configObj['proxies'], env, new URL(request.url).origin, limit);
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
