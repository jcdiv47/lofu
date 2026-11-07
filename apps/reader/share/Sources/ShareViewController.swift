import SwiftUI
import UIKit

/// "lofu" in another app's share sheet: saves the shared link straight
/// away, says so, and closes. Nothing to fill in; the bookmark lands in
/// Unsorted, and the server reads the page afterwards. iOS shows a share
/// extension in a full-height sheet whatever its presentation style, so the
/// page fills the sheet rather than floating a card over the app.
final class ShareViewController: UIViewController {
  private let model = ShareModel()

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = UIColor(Look.paper)
    let card = UIHostingController(
      rootView: ShareCard(model: model, close: { [weak self] in self?.close() }))
    card.view.backgroundColor = .clear
    addChild(card)
    card.view.frame = view.bounds
    card.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(card.view)
    card.didMove(toParent: self)

    let items = extensionContext?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
    Task {
      await model.save(items)
      if case .saved = model.state {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        try? await Task.sleep(for: .seconds(1.2))
        close()
      }
    }
  }

  private var closed = false

  private func close() {
    guard !closed else { return }
    closed = true
    extensionContext?.completeRequest(returningItems: nil)
  }
}

@MainActor @Observable
final class ShareModel {
  enum State: Equatable {
    case saving
    case saved(Saved)
    case failed(String)
  }

  private(set) var state = State.saving
  private var link: String?

  func save(_ items: [NSExtensionItem]) async {
    link = await sharedLink(in: items)
    await retry()
  }

  func retry() async {
    guard let link else {
      state = .failed("There's no web address in what was shared.")
      return
    }
    guard let login = Login.load() else {
      state = .failed("Open lofu and connect it to your server, then share again.")
      return
    }
    state = .saving
    do {
      state = .saved(try await saveBookmark(link, with: login))
    } catch {
      state = .failed(error.localizedDescription)
    }
  }

  var address: String {
    guard let link, let u = URL(string: link) else { return link ?? "" }
    return (u.host() ?? link).replacingOccurrences(of: "^www\\.", with: "", options: .regularExpression)
  }
}

/// The palette of `lib/look.ts`: warm paper, iron-gall ink, the red stamp.
private enum Look {
  static let paper = dynamic(0xF3ECE0, 0x1B1915)
  static let ink = dynamic(0x1F1B16, 0xECE4D6)
  static let inkSoft = dynamic(0x5D554A, 0xB3A998)
  static let stamp = dynamic(0xC2412D, 0xF0694F)

  private static func dynamic(_ light: UInt32, _ dark: UInt32) -> Color {
    Color(
      uiColor: UIColor { t in
        let v = t.userInterfaceStyle == .dark ? dark : light
        return UIColor(
          red: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255,
          blue: CGFloat(v & 0xFF) / 255, alpha: 1)
      })
  }
}

struct ShareCard: View {
  let model: ShareModel
  let close: () -> Void

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Text("lofu")
          .font(.system(size: 22, design: .serif).italic())
          .foregroundStyle(Look.ink)
        Spacer()
        Button("Done", action: close)
          .font(.system(size: 17, weight: .semibold))
          .foregroundStyle(Look.ink)
      }
      .padding(.horizontal, 20)
      .padding(.top, 18)

      Spacer()
      VStack(spacing: 14) {
        status
          .frame(height: 56)
        Text(headline)
          .font(.system(size: 26, weight: .semibold, design: .serif))
          .foregroundStyle(Look.ink)
        Text(detail)
          .font(.system(size: 16))
          .foregroundStyle(isFailed ? Look.stamp : Look.inkSoft)
          .multilineTextAlignment(.center)
          .lineLimit(4)
          .fixedSize(horizontal: false, vertical: true)
      }
      .padding(.horizontal, 32)
      .frame(maxWidth: 520)
      .accessibilityElement(children: .combine)
      Spacer()

      if isFailed {
        button("Try again") { Task { await model.retry() } }
          .padding(.horizontal, 20)
          .padding(.bottom, 12)
          .frame(maxWidth: 520)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Look.paper)
    .animation(.snappy, value: model.state)
  }

  @ViewBuilder private var status: some View {
    switch model.state {
    case .saving:
      ProgressView().controlSize(.large).tint(Look.inkSoft)
    case .saved:
      Image(systemName: "checkmark.circle.fill")
        .font(.system(size: 52))
        .foregroundStyle(Look.ink)
        .transition(.scale.combined(with: .opacity))
    case .failed:
      Image(systemName: "exclamationmark.circle.fill")
        .font(.system(size: 52))
        .foregroundStyle(Look.stamp)
    }
  }

  private var isFailed: Bool {
    if case .failed = model.state { true } else { false }
  }

  private var headline: String {
    switch model.state {
    case .saving: "Saving…"
    case .saved(let s): s.isNew ? "Saved" : "Already saved"
    case .failed: "Couldn't save"
    }
  }

  private var detail: String {
    switch model.state {
    case .saving: model.address
    case .saved(let s): s.domain.isEmpty ? model.address : s.domain
    case .failed(let message): message
    }
  }

  private func button(_ title: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Text(title)
        .font(.system(size: 17, weight: .semibold))
        .frame(maxWidth: .infinity, minHeight: 50)
        .foregroundStyle(Look.paper)
        .background(Look.ink, in: .capsule)
    }
    .buttonStyle(.plain)
  }
}
