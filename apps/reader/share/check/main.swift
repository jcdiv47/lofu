import Foundation

// Runs `Links.extractUrl` over `[[input, expected-or-null], …]` (the JSON at
// argv[1]) and prints the cases it gets wrong. `packages/shared/test/links.test.ts`
// builds and runs it, so the share extension finds the links the app does.
let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let cases = try JSONSerialization.jsonObject(with: data) as! [[Any]]
var failed = 0
for c in cases {
  let input = c[0] as! String
  let expected = c[1] as? String
  let got = Links.extractUrl(input)
  if got != expected {
    failed += 1
    print("extractUrl(\(input.debugDescription)) = \(got.debugDescription), expected \(expected.debugDescription)")
  }
}
exit(failed == 0 ? 0 : 1)
