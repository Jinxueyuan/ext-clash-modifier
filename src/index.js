import { Base64 } from 'js-base64';
import yaml from 'js-yaml';
import { KeyMergeStrategies, parse } from 'js-ini';
import './template.js';
import template from './template.js';

// 机场订阅只有识别到 Clash 客户端时才返回 YAML，否则返回 base64 节点列表
// （有些甚至只返回几个占位节点）。Cloudflare Workers 允许在子请求里设置 UA。
const CLASH_UA = 'clash-verge/v1.0.0';
const CLASH_RULE = 'https://raw.githubusercontent.com/Loyalsoldier/clash-rules/release/';

function toArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function templateFormat(str, vars) {
  return str.replace(/\$\{([^}]*)\}/g, (_, key) => vars[key] ?? '');
}

function getProxyNames(proxyNames, rules) {
  let result = [];
  rules.forEach((rule) => {
    if (rule.startsWith('[]')) {
      result.push(rule.substring(2));
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

function parseRules(customObj, proxyNames, vars) {
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
        proxies: getProxyNames(proxyNames, [params[2] || '.*']),
      });
    } else if (params[1] === 'select') {
      proxyGroups.push({ name, type: 'select', proxies: getProxyNames(proxyNames, params.slice(2)) });
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

    let proxyNames = configObj['proxies'].map((p) => p['name']);
    Object.assign(configObj, parseRules(customObj, proxyNames, vars));

    let configStr = yaml.dump(configObj);
    let headers = new Headers({ 'content-type': 'text/yaml; charset=utf-8' });
    ['subscription-userinfo', 'profile-update-interval'].forEach((key) => {
      let value = resp.headers.get(key);
      if (value) headers.set(key, value);
    });
    return new Response(configStr, { headers });
  },
};
