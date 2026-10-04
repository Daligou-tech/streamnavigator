#!/usr/bin/env bash
# Renders one engine-built video end to end:
#   bash video/build.sh <name>        (reads video/<name>/spec.js)
# Output: brag-output/<name>/brag.mp4, brag.jpg; work files in work/.
set -euo pipefail
cd "$(dirname "$0")/.."
export NODE_PATH="${NODE_PATH:-$(npm root -g)}"
name="$1"; out="brag-output/$name"; mkdir -p "$out/work"
if [ -f "video/$name/index.html" ]; then src="video/$name/index.html"; else src="video/engine/index.html?v=$name"; fi
node video/render.js "$src" "$out/work/x" --score "$out/work/score.json"
node video/synth.js "$out/work/score.json" "$out/work/audio.wav"
dur=$(node -e "console.log(require('./$out/work/score.json').duration)")
poster=$(node -e "console.log(($dur - 0.6).toFixed(2))")
node video/render.js "$src" "$out/work/x.mp4" --stills "$poster"
cp "$out/work/still-$poster.jpg" "$out/brag.jpg"
node video/render.js "$src" "$out/work/noposter.mp4" --audio "$out/work/audio.wav" > /dev/null
ffmpeg -loglevel error -y -i "$out/work/noposter.mp4" -i "$out/brag.jpg" \
  -filter_complex "[0:v][1:v]overlay=enable='eq(n,0)'" -c:v libx264 -crf 18 -pix_fmt yuv420p \
  -c:a copy -movflags +faststart "$out/brag.mp4"
echo "$out/brag.mp4 $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$out/brag.mp4")s"
