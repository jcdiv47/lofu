/**
 * Recognizes interstitials served instead of the real page: captchas,
 * bot challenges, "verify you're human" walls. They come back as HTTP 200,
 * so without this they would be stored as successfully extracted articles.
 *
 * Only short pages are checked: block pages are a few sentences, and a long
 * article that merely mentions "captcha" must not match.
 */
const MAX_BLOCK_PAGE_CHARS = 600;

const SIGNATURES: [RegExp, string][] = [
  [/环境异常|完成验证后即可继续访问/, "WeChat verification page"],
  [/^just a moment\.{3}$/im, "Cloudflare challenge"],
  [/attention required!? \| cloudflare/i, "Cloudflare block page"],
  [/checking (if the site connection is secure|your browser before accessing)/i, "browser check"],
  [/enable javascript and cookies to continue/i, "browser check"],
  [/请完成(安全)?验证|安全验证|人机验证|滑动验证/, "verification page"],
  [/^Sina Visitor System$/m, "Weibo visitor check"],
  [/您当前请求存在异常|暂时限制本次访问/, "Zhihu rate limit"],
  [/\b(are you a robot|captcha|access denied|unusual traffic)\b/i, "bot check"],
];

export function detectBlockPage(title: string | null, text: string): string | null {
  if (text.length > MAX_BLOCK_PAGE_CHARS) return null;
  const hay = `${title ?? ""}\n${text}`;
  for (const [re, label] of SIGNATURES) if (re.test(hay)) return label;
  return null;
}
