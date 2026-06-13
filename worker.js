export default {
  async fetch(request) {
    // 1. 处理跨域预检
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      const { keyword, rawRule, captchaCode, cookieStr } = await request.json();
      if (!rawRule || !keyword) {
        return new Response(JSON.stringify({ status: "FAILED", msg: "缺少番名或规则密文" }), { status: 400, headers: corsHeaders() });
      }

      // === 2. Worker 内部纯净解码 Kazumi 规则 ===
      let rule;
      try {
        const base64Str = rawRule.replace("kazumi://", "").trim();
        const binaryString = atob(base64Str);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        rule = JSON.parse(new TextDecoder().decode(bytes));
      } catch (e) {
        return new Response(JSON.stringify({ status: "FAILED", msg: "规则解码失败" }), { headers: corsHeaders() });
      }

      const baseUrl = (rule.baseURL || rule.baseURI || "").replace(/\/$/, "");
      let searchUrl = rule.searchURL.replace("@keyword", encodeURIComponent(keyword));

      // 组装请求头
      const fetchHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": baseUrl + "/",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9"
      };
      if (cookieStr) fetchHeaders["Cookie"] = cookieStr;
      if (captchaCode) searchUrl += `&verify=${encodeURIComponent(captchaCode)}`;

      // 发起穿透请求
      const response = await fetch(searchUrl, { method: "GET", headers: fetchHeaders });
      const htmlText = await response.text();
      const setCookie = response.headers.get("set-cookie") || "";

      // === 3. 验证码拦截精准检测 ===
      const anti = rule.antiCrawlerConfig;
      let isCaptchaTriggered = false;

      if (anti && anti.enabled && anti.captchaImage) {
        // 精准提取 @class='xxx' 中的特征名
        const matchClass = anti.captchaImage.match(/@class=['"]([^'"]+)['"]/);
        const featureStr = matchClass ? matchClass[1] : "verify";

        if (htmlText.includes(featureStr) || htmlText.includes("请输入验证码")) {
          isCaptchaTriggered = true;
        }
      }

      if (isCaptchaTriggered) {
        return new Response(JSON.stringify({
          status: "NEED_CAPTCHA",
          ruleName: rule.name || "未知站点",
          captchaImg: `${baseUrl}/verify/index.html`,
          cookieStr: setCookie
        }), { headers: corsHeaders() });
      }

      // === 4. 修复误判：查无片源的硬性过滤 ===
      // 如果页面明确写了这些字，绝对是没搜到
      const noResultKeywords = ["没有找到", "暂无数据", "0条记录", "无结果", "暂无相关"];
      if (noResultKeywords.some(k => htmlText.includes(k))) {
        return new Response(JSON.stringify({ status: "FAILED", ruleName: rule.name, msg: "查无片源" }), { headers: corsHeaders() });
      }

      // === 5. 修复误判：智能嗅探解析成功特征 ===
      let hasResults = false;

      // 策略 A：如果规则的 searchList 里有明确的 class，尝试匹配
      const listClassMatch = (rule.searchList || "").match(/@class=['"]([^'"]+)['"]/);
      if (listClassMatch && htmlText.includes(listClassMatch[1])) {
        hasResults = true;
      } 
      // 策略 B：像 AGE 这种纯节点的 XPath，启用通用影视站 DOM 嗅探！
      else {
        // 涵盖了 MacCMS、AGE、以及绝大多数动漫站的结果卡片特征
        const genericMarkers = ["cata_video_item", "vod-link", "/detail/", "/vod/", "video_play_status", "stui-vodlist"];
        
        // 只要包含了特征，并且源码里真的有我们要搜的番剧名（忽略大小写），就判定为成功！
        const keywordLower = keyword.toLowerCase();
        if (genericMarkers.some(marker => htmlText.includes(marker)) && htmlText.toLowerCase().includes(keywordLower)) {
          hasResults = true;
        }
      }

      // === 6. 解析成功，提取画质并返回 ===
      if (hasResults) {
        let quality = "720P"; // 默认画质
        if (htmlText.includes("1080P") || htmlText.includes("蓝光") || htmlText.includes("BDRip") || htmlText.includes("BD")) {
          quality = "1080P";
        } else if (htmlText.includes("480P") || htmlText.includes("360P")) {
          quality = "480P";
        }
        return new Response(JSON.stringify({ status: "SUCCESS", ruleName: rule.name, quality }), { headers: corsHeaders() });
      } 
      
      // 没有任何成功特征，也没触发验证码
      return new Response(JSON.stringify({ status: "FAILED", ruleName: rule.name, msg: "解析失效" }), { headers: corsHeaders() });

    } catch (err) {
      return new Response(JSON.stringify({ status: "FAILED", msg: "请求原站超时" }), { headers: corsHeaders() });
    }
  }
};

function corsHeaders() {
  return {
    "Content-Type": "application/json;charset=UTF-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
