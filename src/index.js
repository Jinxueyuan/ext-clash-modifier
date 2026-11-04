import { Base64 } from "js-base64";
import yaml from "js-yaml";
import "./template.js";
import template from "./template.js";

// Many subscription endpoints only return a Clash YAML when the request comes
// from a Clash client. Otherwise they return a base64 proxy list (or, like
// /api/v1/client/subscribe, only a few placeholder nodes). Cloudflare Workers
// lets us set User-Agent on a subrequest, so always ask for a Meta-compatible
// config: the template below relies on rule-providers / RULE-SET anyway.
const CLASH_UA = "clash-verge/v1.0.0";

export default {
  async fetch(request) {
    let { pathname } = new URL(request.url);

    if (pathname.startsWith("/p/")) {
      let filename = pathname.slice(3)
      return fetch(`https://raw.githubusercontent.com/Loyalsoldier/clash-rules/release/${filename}`)
    }

    if (!pathname.startsWith("/m/")) {
      return new Response(`error: invalid parameter`, {
        headers: {
          "content-type": "text/plain",
        },
      });
    }

    let configUrl = Base64.decode(pathname.slice(3));

    let resp = await fetch(configUrl, {
      headers: { "User-Agent": CLASH_UA },
    });
    let rawConfig = await resp.text();

    let configObj;
    try {
      configObj = yaml.load(rawConfig);
    } catch (_) {
      // handled by the check below
    }
    if (!configObj || typeof configObj !== "object" || !Array.isArray(configObj["proxies"])) {
      return new Response(`error: subscription did not return a Clash YAML config (status ${resp.status})`, {
        status: 502,
        headers: { "content-type": "text/plain" },
      });
    }

    // remove
    template.remove.forEach((key) => {
      if (key in configObj) {
        delete configObj[key];
      }
    });

    // append
    let appendObj = yaml.load(template.append);
    configObj = Object.assign(configObj, appendObj);

    // replace proxy names
    let proxyName = [];
    configObj["proxies"].forEach((proxyElem) => {
      proxyName.push(proxyElem["name"]);
    });

    // 按地区划分代理组，没有匹配节点的地区会被跳过
    let regionGroupNames = [];
    let regionGroups = [];
    (template.regions || []).forEach((region) => {
      let matched = proxyName.filter((name) =>
        region.keywords.some((keyword) => name.includes(keyword))
      );
      if (matched.length === 0) {
        return;
      }
      regionGroupNames.push(region.name);
      regionGroups.push({
        name: region.name,
        type: "url-test",
        url: "http://www.gstatic.com/generate_204",
        interval: 86400,
        proxies: matched,
      });
    });

    configObj["proxy-groups"].forEach((_, index) => {
      let groupElem = configObj["proxy-groups"][index];

      let i = groupElem["proxies"].indexOf("_PROXY_NAME");
      if (i !== -1) {
        groupElem["proxies"].splice(i, 1, ...proxyName);
      }

      let j = groupElem["proxies"].indexOf("_REGION_GROUPS");
      if (j !== -1) {
        groupElem["proxies"].splice(j, 1, ...regionGroupNames);
      }
    });

    configObj["proxy-groups"].push(...regionGroups);

    // replace rule provider proxy
    Object.keys(configObj["rule-providers"]).forEach(index => {
      let providerElem = configObj["rule-providers"][index];
      let providerProxy = new URL(request.url).origin + '/p/'
      providerElem['url'] = providerElem['url'].replace('_PROVIDER_PROXY|', providerProxy)
    });


    let configStr = yaml.dump(configObj);
    // The body was rewritten, so origin framing headers (content-length,
    // content-encoding, ...) must not be copied over. Keep the subscription
    // metadata that clients use to show used/total traffic and expiry.
    let headers = new Headers({ "content-type": "text/yaml; charset=utf-8" });
    ["subscription-userinfo", "profile-update-interval"].forEach((key) => {
      let value = resp.headers.get(key);
      if (value) {
        headers.set(key, value);
      }
    });
    return new Response(configStr, {
      headers,
    });
  },
};
