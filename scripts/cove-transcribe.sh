#!/usr/bin/env bash
# Transcribe an audio file to text on-device. No API key, nothing leaves the Mac.
# Usage: bash scripts/cove-transcribe.sh <audio-file>   # prints the transcript
#
# Used by the cove-voice-note skill to turn a voice note into a task. The
# backend is installed by scripts/install-cove-voice.sh into .venv-voice.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AUDIO="${1:?usage: cove-transcribe.sh <audio-file>}"
PY="$REPO_DIR/.venv-voice/bin/python"
MODEL="${COVE_WHISPER_MODEL:-mlx-community/whisper-small.en-mlx}"

if [ ! -x "$PY" ]; then
  echo "Voice transcription is not set up. Run: bash scripts/install-cove-voice.sh" >&2
  exit 1
fi
if [ ! -f "$AUDIO" ]; then
  echo "Audio file not found: $AUDIO" >&2
  exit 1
fi

# mlx-whisper (Apple Silicon): print only the transcript to stdout (verbose=False
# keeps mlx's per-segment logging off stdout; model download progress is stderr).
if "$PY" -c "import mlx_whisper" 2>/dev/null; then
  "$PY" -c "import mlx_whisper,sys; print(mlx_whisper.transcribe(sys.argv[1], path_or_hf_repo=sys.argv[2], verbose=False)['text'].strip())" "$AUDIO" "$MODEL"
elif "$PY" -c "import faster_whisper" 2>/dev/null; then
  FW_MODEL="${COVE_WHISPER_MODEL_FW:-small.en}"
  "$PY" -c "from faster_whisper import WhisperModel;import sys;m=WhisperModel(sys.argv[2]);segs,_=m.transcribe(sys.argv[1]);print(' '.join(s.text for s in segs).strip())" "$AUDIO" "$FW_MODEL"
else
  echo "No transcription backend in the voice environment. Re-run: bash scripts/install-cove-voice.sh" >&2
  exit 1
fi
