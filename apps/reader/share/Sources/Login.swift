import Foundation
import Security

/// The app's server address and token. The app puts them in a Keychain
/// group the two share (`src/lib.rs`, `login`) whenever it starts or
/// connects; the group's name is in both Info.plists (`LofuKeychainGroup`).
struct Login: Sendable {
  let server: String
  let token: String

  static func load() -> Login? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "LofuKeychainGroup") as? String,
      !group.isEmpty
    else { return nil }
    let query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: "app.lofu.reader",
      kSecAttrAccount: "login",
      kSecAttrAccessGroup: group,
      kSecReturnData: true,
      kSecMatchLimit: kSecMatchLimitOne,
    ]
    var out: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess,
      let data = out as? Data,
      let login = try? JSONDecoder().decode(Stored.self, from: data),
      !login.server.isEmpty, !login.token.isEmpty
    else { return nil }
    return Login(server: login.server, token: login.token)
  }

  private struct Stored: Decodable {
    let server: String
    let token: String
  }
}

/// What the server answered: the bookmark as it stands (the server reads the
/// page afterwards), and whether it was new.
struct Saved: Sendable, Equatable {
  let title: String
  let domain: String
  let isNew: Bool
}

struct SaveError: LocalizedError {
  let errorDescription: String?
  init(_ message: String) { errorDescription = message }
}

/// `POST /v1/bookmarks`, as the app's *+* does (`lib/api.ts`). Saving a link
/// that's already saved returns the bookmark (200 rather than 201).
func saveBookmark(_ url: String, with login: Login) async throws -> Saved {
  let server = login.server.replacingOccurrences(
    of: "/+$", with: "", options: .regularExpression)
  guard let endpoint = URL(string: "\(server)/v1/bookmarks") else {
    throw SaveError("The server address in lofu isn't a web address.")
  }
  var request = URLRequest(url: endpoint, timeoutInterval: 20)
  request.httpMethod = "POST"
  request.setValue("Bearer \(login.token)", forHTTPHeaderField: "authorization")
  request.setValue("application/json", forHTTPHeaderField: "content-type")
  request.httpBody = try JSONEncoder().encode(["url": url])

  let data: Data
  let response: URLResponse
  do {
    (data, response) = try await URLSession.shared.data(for: request)
  } catch {
    throw SaveError("Can't reach \(server).")
  }
  let status = (response as? HTTPURLResponse)?.statusCode ?? 0
  guard (200..<300).contains(status) else {
    if status == 401 { throw SaveError("The server didn't accept lofu's token.") }
    let message = (try? JSONDecoder().decode(ServerError.self, from: data))?.error
    throw SaveError(message ?? "The server answered HTTP \(status).")
  }
  let b = try? JSONDecoder().decode(Bookmark.self, from: data)
  return Saved(title: b?.title ?? url, domain: b?.domain ?? "", isNew: status == 201)
}

private struct Bookmark: Decodable {
  let title: String
  let domain: String
}

private struct ServerError: Decodable {
  let error: String
}
