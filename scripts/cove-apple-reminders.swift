import Foundation
import EventKit
import CryptoKit
import Darwin

// A JSON command boundary for one private iCloud list. No shell or UI automation.
// The helper never reads reminder contents outside the configured Cove list.
struct BridgeError: Error { let message: String }
func fail(_ message: String) throws -> Never { throw BridgeError(message: message) }
func required(_ value: Any?, _ name: String, max: Int = 2000) throws -> String {
    guard let text = value as? String, !text.isEmpty, text.count <= max,
          !text.contains("\0") else { try fail("Invalid \(name).") }
    return text
}
func canonical(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
func digest(_ value: Any) throws -> String { SHA256.hash(data: try canonical(value)).map { String(format: "%02x", $0) }.joined() }
func timestamp(_ date: Date?) -> Any { date.map { ISO8601DateFormatter().string(from: $0) } ?? NSNull() }
func dueDate(_ reminder: EKReminder) -> Date? {
    guard var components = reminder.dueDateComponents else { return nil }
    if components.calendar == nil { components.calendar = Calendar(identifier: .gregorian) }
    return components.date
}
func linkedTask(_ reminder: EKReminder) -> String? {
    if let url = reminder.url, url.scheme == "https", url.host == "claude.ai", url.path.hasPrefix("/code/"),
       let fragment = url.fragment, fragment.hasPrefix("cove-task=") {
        let id = String(fragment.dropFirst("cove-task=".count))
        if id.range(of: "^[A-Za-z0-9_-]{1,200}$", options: .regularExpression) != nil { return id }
    }
    // Migrate only the beta's already-linked reminders on their next explicit save.
    if let line = reminder.notes?.components(separatedBy: "\n").first, line.hasPrefix("Cove task: ") {
        let id = String(line.dropFirst("Cove task: ".count))
        if id.range(of: "^[A-Za-z0-9_-]{1,200}$", options: .regularExpression) != nil { return id }
    }
    return nil
}
func record(_ reminder: EKReminder) throws -> [String: Any] {
    let alarmDates = (reminder.alarms ?? []).map { alarm -> [String: Any] in
        ["absolute": timestamp(alarm.absoluteDate), "relative": alarm.relativeOffset]
    }
    var result: [String: Any] = [
        "taskId": linkedTask(reminder) ?? "", "id": reminder.calendarItemIdentifier, "calendarId": reminder.calendar.calendarIdentifier,
        "title": reminder.title ?? "", "notes": reminder.notes ?? "", "completed": reminder.isCompleted,
        "dueAt": timestamp(dueDate(reminder)), "allDay": reminder.dueDateComponents?.hour == nil,
        "timezone": reminder.dueDateComponents?.timeZone?.identifier ?? "",
        "priority": reminder.priority, "url": reminder.url?.absoluteString ?? "", "alarms": alarmDates,
        "modifiedAt": timestamp(reminder.lastModifiedDate),
    ]
    result["revision"] = try digest(result)
    return result
}
func fetch(_ store: EKEventStore, calendar: EKCalendar) async throws -> [EKReminder] {
    let reminders = await withCheckedContinuation { (continuation: CheckedContinuation<[EKReminder], Never>) in
        store.fetchReminders(matching: store.predicateForReminders(in: [calendar])) { continuation.resume(returning: $0 ?? []) }
    }
    guard reminders.count <= 10000 else { try fail("The Cove reminder list is too large to synchronize safely.") }
    return reminders
}
func ownCalendar(_ store: EKEventStore, _ request: [String: Any]) throws -> EKCalendar {
    let id = try required(request["calendarId"], "Cove calendar ID", max: 300)
    guard let calendar = store.calendar(withIdentifier: id), calendar.title == "Cove",
          calendar.allowsContentModifications, calendar.allowedEntityTypes.contains(.reminder),
          calendar.source.sourceType == .calDAV, calendar.source.title.caseInsensitiveCompare("iCloud") == .orderedSame else {
        try fail("The configured writable iCloud Cove list is unavailable. No reminder was changed.")
    }
    return calendar
}
func run(_ request: [String: Any]) async throws -> [String: Any] {
    let command = try required(request["command"], "command", max: 40)
    let store = EKEventStore()
    if command == "status" {
        return ["authorized": EKEventStore.authorizationStatus(for: .reminder) == .fullAccess,
                "notificationSupported": true, "urgentAlarmSupported": false,
                "urgentAlarmReason": "Apple EventKit does not expose Reminders' Urgent alarm switch."]
    }
    if command == "authorize" {
        let granted = try await store.requestFullAccessToReminders()
        return ["authorized": granted]
    }
    guard EKEventStore.authorizationStatus(for: .reminder) == .fullAccess else {
        try fail("Reminders access is not granted. Open the Cove Reminders setup permission prompt.")
    }
    if command == "sources" {
        // Return source metadata, never other people's reminders.
        return ["sources": store.sources.filter { $0.sourceType == .calDAV }.map {
            ["id": $0.sourceIdentifier, "title": $0.title]
        }]
    }
    if command == "ensure-list" {
        let sourceId = try required(request["sourceId"], "iCloud source ID", max: 300)
        guard let source = store.source(withIdentifier: sourceId), source.sourceType == .calDAV,
              source.title.caseInsensitiveCompare("iCloud") == .orderedSame else {
            try fail("Select the operator's iCloud Reminders account.")
        }
        let matches = store.calendars(for: .reminder).filter { $0.title == "Cove" && $0.source.sourceIdentifier == sourceId }
        guard matches.isEmpty else { try fail("A Cove list already exists. Select its exact ID during setup rather than creating a duplicate.") }
        let calendar = EKCalendar(for: .reminder, eventStore: store)
        calendar.title = "Cove"; calendar.source = source
        try store.saveCalendar(calendar, commit: true)
        return ["calendarId": calendar.calendarIdentifier, "title": calendar.title, "created": true]
    }
    if command == "calendars" {
        return ["calendars": store.calendars(for: .reminder).filter { $0.title == "Cove" }.map {
            ["id": $0.calendarIdentifier, "title": $0.title, "sourceId": $0.source.sourceIdentifier,
             "sourceTitle": $0.source.title, "writable": $0.allowsContentModifications] as [String: Any]
        }]
    }
    let calendar = try ownCalendar(store, request)
    let reminders = try await fetch(store, calendar: calendar)
    if command == "list" {
        // Only items bearing our link marker belong to this bridge.
        let owned = reminders.filter { linkedTask($0) != nil }
        return ["reminders": try owned.map(record)]
    }
    guard command == "save" else { try fail("Unsupported command.") }
    let taskId = try required(request["taskId"], "task ID", max: 200)
    guard taskId.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { try fail("Invalid task ID.") }
    let matches = reminders.filter { linkedTask($0) == taskId }
    guard matches.count <= 1 else { try fail("Duplicate linked Apple reminders require review. No change made.") }
    let reminder: EKReminder
    let existing = matches.first
    if let id = request["id"] as? String {
        guard let match = existing, match.calendarItemIdentifier == id else { try fail("The linked reminder is missing or moved. No replacement was created.") }
        let before = try record(match)
        guard request["revision"] as? String == before["revision"] as? String else { try fail("Apple reminder changed. Read it again before updating.") }
        reminder = match
    } else if let match = existing {
        // Recover an interrupted creation without replaying an edit.
        return ["saved": false, "recovered": true, "reminder": try record(match)]
    } else {
        reminder = EKReminder(eventStore: store); reminder.calendar = calendar
    }
    let title = try required(request["title"], "reminder title", max: 300)
    let notes = try required(request["notes"], "reminder notes", max: 6000)
    let time = try required(request["dueAt"], "reminder time", max: 50)
    let parser = ISO8601DateFormatter()
    guard let date = parser.date(from: time) else { try fail("Use a full ISO timestamp with an explicit offset.") }
    let tzName = try required(request["timezone"], "timezone", max: 100)
    guard let timezone = TimeZone(identifier: tzName) else { try fail("Invalid timezone.") }
    guard let completed = request["completed"] as? Bool else { try fail("Missing completion state.") }
    let priority = request["priority"] as? Int ?? 0
    guard [0, 1, 5, 9].contains(priority) else { try fail("Invalid priority.") }
    let urlText = try required(request["url"], "Cove conversation link", max: 500)
    guard let url = URL(string: urlText), url.scheme == "https", url.host == "claude.ai",
          url.path.hasPrefix("/code/"), url.fragment == "cove-task=\(taskId)" else { try fail("Use the configured linked Cove conversation URL.") }
    var systemCalendar = Calendar(identifier: .gregorian); systemCalendar.timeZone = timezone
    var components = systemCalendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
    components.calendar = systemCalendar; components.timeZone = timezone
    let oldDue = dueDate(reminder)
    let oldAlarms = reminder.alarms ?? []
    reminder.title = title; reminder.notes = notes; reminder.dueDateComponents = components
    reminder.startDateComponents = components; reminder.priority = priority; reminder.url = url
    reminder.isCompleted = completed
    // An EKAlarm is an ordinary Reminders notification, not the iPhone Urgent alarm.
    if existing == nil {
        reminder.alarms = [EKAlarm(absoluteDate: date)]
    } else if oldDue != date {
        // Move only the bridge's due-time alarm. Preserve additional user alarms.
        reminder.alarms = oldAlarms.map { alarm in
            if let absolute = alarm.absoluteDate, let previous = oldDue, abs(absolute.timeIntervalSince(previous)) < 1 {
                return EKAlarm(absoluteDate: date)
            }
            return alarm
        }
    }
    if request["ensureAlarm"] as? Bool == true {
        let alarms = reminder.alarms ?? []
        let hasDueAlarm = alarms.contains { alarm in
            if let absolute = alarm.absoluteDate { return abs(absolute.timeIntervalSince(date)) < 1 }
            return alarm.relativeOffset == 0
        }
        if !hasDueAlarm { reminder.alarms = alarms + [EKAlarm(absoluteDate: date)] }
    }
    // Completing a reminder suppresses its alerts in Apple's own system.
    // Keep alarm preferences intact so reopening does not silently lose them.
    try store.save(reminder, commit: true)
    return ["saved": true, "reminder": try record(reminder)]
}

@main struct CoveReminders {
    static func main() async {
        do {
            let request: [String: Any]
            if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--authorize" {
                // LaunchServices gives this app its own permission identity.
                request = ["command": "authorize"]
            } else {
                let input = FileHandle.standardInput.readDataToEndOfFile()
                guard input.count <= 100_000, let parsed = try JSONSerialization.jsonObject(with: input) as? [String: Any] else {
                    try fail("Expected one bounded JSON request.")
                }
                request = parsed
            }
            // This lock belongs to the app process, not the short-lived `open`
            // launcher. It prevents overlapping saves after a caller times out.
            var operationLock: Int32 = -1
            if request["command"] as? String != "authorize" {
                let lockURL = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("native-operation.lock")
                operationLock = Darwin.open(lockURL.path, O_CREAT | O_RDWR, mode_t(0o600))
                guard operationLock >= 0 else { try fail("Cove Reminders operation lock is unavailable.") }
                guard flock(operationLock, LOCK_EX | LOCK_NB) == 0 else {
                    Darwin.close(operationLock); operationLock = -1
                    try fail("Cove Reminders is busy. Retry after its current operation finishes.")
                }
            }
            defer { if operationLock >= 0 { flock(operationLock, LOCK_UN); Darwin.close(operationLock) } }
            let result = try await run(request)
            FileHandle.standardOutput.write(try canonical(["ok": true, "result": result])); print("")
        } catch {
            let message = (error as? BridgeError)?.message ?? "Apple Reminders operation failed. Check permissions and current state before retrying."
            let result: [String: Any] = ["ok": false, "error": message]
            if let bytes = try? canonical(result) { FileHandle.standardOutput.write(bytes); print("") }
            exit(1)
        }
    }
}
