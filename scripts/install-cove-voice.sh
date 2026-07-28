#!/usr/bin/env bash
# Optional: set up on-device voice-note transcription for Cove.
# After this, the user can send a voice note on Telegram or iMessage and Claude
# turns it into a task. Everything runs locally: no API key, nothing leaves the
# Mac. Safe to re-run.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$REPO_DIR/.venv-voice"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is required. Install it (brew install python), then re-run." >&2
  exit 1
fi

# ffmpeg decodes the voice formats (Telegram .ogg, iMessage .m4a/.caf).
if ! command -v ffmpeg >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "Installing ffmpeg (needed to read voice files)..."
    brew install ffmpeg
  else
    echo "ffmpeg is required and Homebrew is not installed. Install Homebrew (brew.sh), then re-run." >&2
    exit 1
  fi
fi

ARCH="$(uname -m)"
if [ "$ARCH" = "arm64" ]; then
  PYBIN="$(command -v python3)"
else
  # faster-whisper relies on ctranslate2, whose prebuilt wheels lag the newest
  # Python. On Intel, prefer 3.12/3.11 if the user has one installed.
  PYBIN="$(command -v python3.12 || command -v python3.11 || command -v python3)"
fi

echo "Creating the voice environment ($("$PYBIN" --version))..."
"$PYBIN" -m venv "$VENV"
"$VENV/bin/pip" install --quiet --upgrade pip

if [ "$ARCH" = "arm64" ]; then
  echo "Apple Silicon detected. Installing mlx-whisper (fast, on-device)..."
  "$VENV/bin/pip" install --quiet mlx-whisper
else
  echo "Intel Mac detected. Installing faster-whisper (on-device)..."
  if ! "$VENV/bin/pip" install --quiet faster-whisper; then
    echo "Could not install the transcription backend. On Intel Macs it needs Python 3.12 or older." >&2
    echo "Fix: brew install python@3.12, then re-run this script." >&2
    exit 1
  fi
fi

# Warm up + verify: speak a known phrase with macOS `say`, transcribe it, and
# confirm the words come back. First run also downloads the model.
echo "Testing transcription (downloads the model on first run; can take a minute)..."
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
say -o "$TMP/test.aiff" "Add a test task to my Cove board"
HEARD="$(bash "$REPO_DIR/scripts/cove-transcribe.sh" "$TMP/test.aiff" 2>/dev/null || true)"
echo "Heard: $HEARD"
if echo "$HEARD" | grep -qi "task"; then
  echo "Voice transcription is ready. The user can now send voice notes via Telegram or iMessage and Claude will turn them into tasks."
else
  echo "Transcription ran but the test phrase did not come through clearly." >&2
  echo "It may still work on real voice notes. Test with: bash scripts/cove-transcribe.sh <audio-file>" >&2
  exit 1
fi
