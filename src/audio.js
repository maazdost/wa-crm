const { spawn } = require('child_process');
// WhatsApp voice notes must be OGG with the Opus codec. Browsers record WebM/Opus (Chrome) or MP4 (Safari), so convert.
function toOggOpus(buf) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', '-f', 'ogg', 'pipe:1']);
    const out = []; let err = '';
    p.stdout.on('data', d => out.push(d)); p.stderr.on('data', d => { err += d; });
    p.on('error', e => reject(new Error(e.code === 'ENOENT' ? 'Voice notes need ffmpeg installed on the server' : e.message)));
    p.on('close', code => code === 0 && out.length ? resolve(Buffer.concat(out)) : reject(new Error('Could not convert the voice note. ' + err.slice(0, 120))));
    p.stdin.on('error', () => {}); p.stdin.end(buf);
  });
}
module.exports = { toOggOpus };
