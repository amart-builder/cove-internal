---
name: cove-voice-note
description: >-
  Turn a voice note or audio message into a Cove task. Use when the user sends
  a voice note, voice memo, or audio attachment (over Telegram or iMessage) that
  sounds like a task or reminder. Transcribes the audio on-device, then adds the
  task to the board.
---

# Voice note to task

When the user sends a voice note instead of typing, turn it into a task.

## 1. Get the audio file

- **Telegram:** the channel message has an `attachment_file_id`. Call
  `download_attachment` with it to get a local file path.
- **iMessage:** use the audio attachment's file path from the channel message.

## 2. Transcribe it on-device

Nothing leaves the Mac:

The Cove repo folder is usually `~/cove` (`~/forge` on installs made before the
rename). Use whichever one exists:

```bash
bash ~/cove/scripts/cove-transcribe.sh "<audio file path>"
```

This prints the transcript. If it says voice is not set up, the user has not
opted in yet; offer to run `bash ~/cove/scripts/install-cove-voice.sh` for
them, then try again.

## 3. Add the task

Treat the transcript as a task request and follow the **cove-task** skill: pick
a due date (asking the calendar and current load if none was given), add it to
the board, set the reminder, and reply.

Confirm what you heard, so a mis-hear is easy to catch. For example: *"Got your
voice note. Added 'email the contractor', due Friday at 9am. Let me know if you
want me to text remind you as well."*

If the transcript clearly is not a task (a question, or a note to talk through),
do not force it onto the board. Respond naturally instead.
