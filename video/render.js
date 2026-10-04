// Renders a composition page frame by frame and encodes it with ffmpeg.
// A composition exposes window.DURATION and window.seek(t) (t in seconds);
// every frame is a pure function of t, so the render is deterministic.
//
//   node video/render.js <composition.html[?query]> <out.mp4> [--audio a.wav] [--stills 1,4.5,9] [--score score.json]
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const [src, out] = args;
const opt = (k) => { const i = args.indexOf(k); return i > -1 ? args[i + 1] : null; };
const audio = opt('--audio');
const stills = opt('--stills');
const scoreOut = opt('--score');
const FPS = 30, W = 1920, H = 1080;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const [file, query] = src.split('?');
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto('file://' + path.resolve(file) + (query ? '?' + query : ''));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => typeof window.seek === 'function');
  const duration = await page.evaluate(() => window.DURATION);

  if (scoreOut) {
    const base = JSON.parse(fs.readFileSync(path.join(__dirname, 'engine', 'score-base.json'), 'utf8'));
    const sfx = await page.evaluate(() => window.SCORE);
    fs.writeFileSync(scoreOut, JSON.stringify({ ...base, duration, sfx }));
    await browser.close();
    return;
  }
  if (stills) {
    const dir = path.dirname(out);
    for (const t of stills.split(',').map(Number)) {
      await page.evaluate((t) => window.seek(t), t);
      await page.screenshot({ path: path.join(dir, `still-${t.toFixed(2)}.jpg`), type: 'jpeg', quality: 85 });
    }
    await browser.close();
    return;
  }

  const ff = spawn('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
    ...(audio ? ['-i', audio, '-c:a', 'aac', '-b:a', '192k', '-shortest'] : []),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium',
    '-movflags', '+faststart', out,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });

  const frames = Math.round(duration * FPS);
  for (let f = 0; f < frames; f++) {
    await page.evaluate((t) => window.seek(t), f / FPS);
    const buf = await page.screenshot({ type: 'png' });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (f % 60 === 0) process.stdout.write(`frame ${f}/${frames}\n`);
  }
  ff.stdin.end();
  await new Promise((r, j) => ff.on('close', (c) => (c ? j(new Error('ffmpeg ' + c)) : r())));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
