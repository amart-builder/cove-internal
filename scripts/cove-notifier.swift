import AppKit
import Foundation
import UserNotifications

private struct NotificationOptions {
    let title: String
    let subtitle: String?
    let message: String
    let identifier: String
    let openURL: URL?
    let sound: Bool

    static func parse(_ arguments: [String]) throws -> NotificationOptions? {
        guard !arguments.isEmpty else { return nil }
        var values: [String: String] = [:]
        var index = 0
        while index < arguments.count {
            let key = arguments[index]
            guard key.hasPrefix("--"), index + 1 < arguments.count else {
                throw ParseError.invalidArguments
            }
            values[key] = arguments[index + 1]
            index += 2
        }
        guard let message = values["--message"], !message.isEmpty else {
            throw ParseError.invalidArguments
        }
        let openURL = values["--open-url"].flatMap(URL.init(string:))
        return NotificationOptions(
            title: values["--title"] ?? "Cove",
            subtitle: values["--subtitle"],
            message: message,
            identifier: values["--group"] ?? UUID().uuidString,
            openURL: openURL,
            sound: values["--sound"] != nil
        )
    }

    enum ParseError: Error {
        case invalidArguments
    }
}

@main
private final class CoveNotifier: NSObject, NSApplicationDelegate,
    UNUserNotificationCenterDelegate
{
    private let defaultBoardURL = URL(string: "http://127.0.0.1:3200/tasks")!
    private var options: NotificationOptions?
    private var openedFromNotification = false

    static func main() {
        let app = NSApplication.shared
        let delegate = CoveNotifier()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        do {
            options = try NotificationOptions.parse(
                Array(CommandLine.arguments.dropFirst())
            )
        } catch {
            FileHandle.standardError.write(
                Data("Usage: CoveNotifier --title <title> --message <message> [--subtitle <subtitle>] [--sound <name>] [--group <id>] [--open-url <url>]\n".utf8)
            )
            exit(2)
        }

        guard let options else {
            // Notification Center relaunches the sender app after a click. Give
            // its response callback a moment to arrive before using the board
            // as the safe default for a manual app launch.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.75) { [weak self] in
                guard let self, !self.openedFromNotification else { return }
                NSWorkspace.shared.open(self.defaultBoardURL)
                NSApp.terminate(nil)
            }
            return
        }

        center.requestAuthorization(options: [.alert, .sound]) { granted, error in
            guard error == nil, granted else {
                FileHandle.standardError.write(
                    Data("Cove notification permission is not enabled.\n".utf8)
                )
                exit(1)
            }
            let content = UNMutableNotificationContent()
            content.title = options.title
            content.subtitle = options.subtitle ?? ""
            content.body = options.message
            if options.sound { content.sound = .default }
            if let openURL = options.openURL {
                content.userInfo = ["openURL": openURL.absoluteString]
            }
            let request = UNNotificationRequest(
                identifier: options.identifier,
                content: content,
                trigger: nil
            )
            center.add(request) { addError in
                if let addError {
                    FileHandle.standardError.write(
                        Data("Cove notification failed: \(addError.localizedDescription)\n".utf8)
                    )
                    exit(1)
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.75) {
                    NSApp.terminate(nil)
                }
            }
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        openedFromNotification = true
        let rawURL = response.notification.request.content.userInfo["openURL"] as? String
        NSWorkspace.shared.open(rawURL.flatMap(URL.init(string:)) ?? defaultBoardURL)
        completionHandler()
        NSApp.terminate(nil)
    }
}
