#!/usr/bin/env bash
# Renders one engine-built video end to end:
#   bash video/build.sh <name>        (reads video/<name>/spec.js)
# Output: brag-output/<name>/brag.mp4, brag.jpg; work files in work/.
set -euo pipefail
cd "$(dirname "$0")/.."
export NODE_PATH="${NODE_PATH:-$(npm root -g)}"
name="$1"; out="brag-output/$name"; mkdir -p "$out/work"
# FORMAT=v renders the vertical 1080x1920 cut to vertical.mp4 / vertical.jpg
if [ "${FORMAT:-}" = v ]; then size=1080x1920; tag=vertical; qs="fmt=v"; else size=1920x1080; tag=brag; qs=""; fi
if [ -f "video/$name/index.html" ]; then src="video/$name/index.html${qs:+?$qs}"; else src="video/engine/index.html?v=$name${qs:+&$qs}"; fi
node video/render.js "$src" "$out/work/x" --score "$out/work/score.json"
node video/synth.js "$out/work/score.json" "$out/work/audio.wav"
dur=$(node -e "console.log(require('./$out/work/score.json').duration)")
poster=${POSTER_T:-$(node -e "console.log(($dur - 0.6).toFixed(2))")}
node video/render.js "$src" "$out/work/x.mp4" --stills "$poster" --size $size
cp "$out/work/still-$poster.jpg" "$out/$tag.jpg"
node video/render.js "$src" "$out/work/noposter.mp4" --size $size --audio "$out/work/audio.wav" > /dev/null
ffmpeg -loglevel error -y -i "$out/work/noposter.mp4" -i "$out/$tag.jpg" \
  -filter_complex "[0:v][1:v]overlay=enable='eq(n,0)'" -c:v libx264 -crf 18 -pix_fmt yuv420p \
  -c:a copy -movflags +faststart "$out/$tag.mp4"
echo "$out/$tag.mp4 $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$out/$tag.mp4")s"
