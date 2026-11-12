#!/bin/sh
# Generates public/bench/sample.wav: ~10 s of synthetic English speech, 16 kHz mono PCM16.
# Used by the setup benchmark (PLAN §14.5). Requires macOS (`say` + `afconvert`).
set -e
cd "$(dirname "$0")/.."
TMP=$(mktemp -d)
say -r 170 -o "$TMP/sample.aiff" "Good morning everyone. Let's get started with the weekly sync. First item on the agenda is the release timeline. We are planning to ship the new version on Friday, assuming the remaining tests pass."
afconvert -f WAVE -d LEI16@16000 -c 1 "$TMP/sample.aiff" public/bench/sample.wav
rm -rf "$TMP"
echo "Wrote public/bench/sample.wav"
