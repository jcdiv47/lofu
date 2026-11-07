import Foundation

/// `extractUrl` from `packages/shared/src/links.ts`: the first web link in
/// shared text ("【Title】 http://xhslink.com/a/xyz 复制本条信息…"). The
/// server needs the link alone; it unwraps and follows short links itself.
/// `packages/shared/test/links.test.ts` runs this against the same cases.
enum Links {
  /// Characters a link never contains in share text: spaces, CJK punctuation, quotes.
  private static let stop =
    #"\s<>"'`\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65\u2018-\u201f\u4e00-\u9fff"#
  private static let withScheme = try! NSRegularExpression(
    pattern: "https?://[^\(stop)]+", options: .caseInsensitive)
  /// `www.example.com/…` or `xhslink.com/a/xyz`: a host with a dot, then a path or `www.`.
  private static let bare = try! NSRegularExpression(
    pattern: "(?:^|[\(stop)(])((?:[a-z0-9-]+\\.)+[a-z]{2,}(?::\\d+)?(?:/[^\(stop)]*)?)",
    options: .caseInsensitive)
  private static let space = try! NSRegularExpression(pattern: #"\s"#)
  private static let topLevel = try! NSRegularExpression(
    pattern: #"\.[a-z]{2,}$"#, options: .caseInsensitive)

  /// The first web link in `text`, or nil. Links without a scheme count when
  /// they start with `www.`, have a path, or are all of the text, so a
  /// sentence that mentions "e.g." or "Node.js" doesn't become a link.
  static func extractUrl(_ text: String) -> String? {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if t.isEmpty { return nil }
    // One link and nothing else: as it is, CJK path and all.
    if !matches(space, t), t.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil,
      isHttp(t)
    {
      return t
    }
    if let m = first(withScheme, t, group: 0) {
      let u = trimTail(m)
      if isHttp(u) { return u }
    }
    if let b = first(bare, t, group: 1) {
      let raw = trimTail(b)
      let host = String(raw.split(whereSeparator: { $0 == "/" || $0 == ":" }).first ?? "")
      let plausible = raw == t || raw.contains("/") || host.lowercased().hasPrefix("www.")
      if plausible, matches(topLevel, host), isHttp("https://\(raw)") { return "https://\(raw)" }
    }
    return nil
  }

  /// Drops the punctuation a sentence puts after a link, keeping balanced brackets.
  private static func trimTail(_ url: String) -> String {
    var u = url
    while let last = u.last {
      if ".,;:!?'\"*".contains(last) {
        u.removeLast()
      } else if last == ")", count(u, "(") < count(u, ")") {
        u.removeLast()
      } else if last == "]", count(u, "[") < count(u, "]") {
        u.removeLast()
      } else {
        break
      }
    }
    return u
  }

  private static func count(_ s: String, _ ch: Character) -> Int { s.filter { $0 == ch }.count }

  private static func isHttp(_ s: String) -> Bool {
    guard let u = URL(string: s), let scheme = u.scheme?.lowercased(), let host = u.host() else {
      return false
    }
    return (scheme == "http" || scheme == "https") && host.contains(".")
  }

  private static func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
    re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
  }

  private static func first(_ re: NSRegularExpression, _ s: String, group: Int) -> String? {
    guard let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)),
      let r = Range(m.range(at: group), in: s)
    else { return nil }
    return String(s[r])
  }
}
