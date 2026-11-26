const { spawn } = require('child_process');
// Voice notes recorded in the browser are turned into MP3 before they go to WhatsApp. OGG/OPUS made here was refused by
// WhatsApp after upload ("Media upload error"); MP3 (audio/mpeg) is accepted everywhere and plays on every phone.
function toMp3(buf) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3', 'pipe:1']);
    const out = []; let err = '';
    p.stdout.on('data', d => out.push(d)); p.stderr.on('data', d => { err += d; });
    p.on('error', e => reject(new Error(e.code === 'ENOENT' ? 'Voice notes need ffmpeg installed on the server' : e.message)));
    p.on('close', code => code === 0 && out.length ? resolve(Buffer.concat(out)) : reject(new Error('Could not convert the voice note. ' + err.slice(0, 120))));
    p.stdin.on('error', () => {}); p.stdin.end(buf);
  });
}
module.exports = { toMp3 };
