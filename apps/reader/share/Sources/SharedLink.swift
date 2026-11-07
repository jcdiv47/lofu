import Foundation
import UniformTypeIdentifiers

/// The web link in what was shared: a URL (Safari, most apps) before text,
/// which may be share text with the link inside ("【Title】 http://xhslink.com/…").
@MainActor func sharedLink(in items: [NSExtensionItem]) async -> String? {
  let providers = items.flatMap { $0.attachments ?? [] }
  for p in providers where p.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
    if let s = await load(p, UTType.url), let u = URL(string: s),
      ["http", "https"].contains(u.scheme?.lowercased() ?? "")
    {
      return s
    }
  }
  var texts: [String] = []
  for p in providers where p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
    if let s = await load(p, UTType.plainText) { texts.append(s) }
  }
  texts += items.compactMap { $0.attributedContentText?.string }
  return texts.lazy.compactMap(Links.extractUrl).first
}

/// An attachment as text: a URL's address, or the string itself.
@MainActor private func load(_ provider: NSItemProvider, _ type: UTType) async -> String? {
  await withCheckedContinuation { done in
    provider.loadItem(forTypeIdentifier: type.identifier) { item, _ in
      switch item {
      case let u as URL: done.resume(returning: u.absoluteString)
      case let s as String: done.resume(returning: s)
      case let s as NSAttributedString: done.resume(returning: s.string)
      case let d as Data:
        done.resume(
          returning: type == .url
            ? URL(dataRepresentation: d, relativeTo: nil)?.absoluteString
            : String(data: d, encoding: .utf8))
      default: done.resume(returning: nil)
      }
    }
  }
}
