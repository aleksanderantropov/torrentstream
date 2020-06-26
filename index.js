const express = require('express');
const app = express();
const fs = require('fs');
const TorrentClient = require('./torrent-client/client');

app.use(express.static('video'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/html/index.html');
});

let ffmpegStatus = 'idle';
let path = 'media/Плохие парни навсегда_2020_BDRip/Плохие парни навсегда_2020_BDRip.avi';
app.get('/hls', (req, res) => {

    createManifest();

    // serve page
    res.sendFile(__dirname + '/html/hls.html');

    // torrentDownload();
    const timerId = setInterval(() => {
        if (ffmpegStatus == 'idle')
            startFfmpeg(path);
    }, 2000);

    const torrentClient = new TorrentClient('media');
    torrentClient.download('torrent-files/bad-boys.torrent')
        .then(() => {
            clearInterval(timerId);
        });
});

app.get('/check', (req, res) => {
    const timerId = setInterval(() => {
        if (fs.existsSync('video/hls/hls1.ts')) {
            clearInterval(timerId);
            res.writeHead(200, {'Content-Type': 'text/playin'});
            res.end('Success');
        }
    }, 1000);
});

app.listen(80);

function createManifest() {
    const manifest = fs.openSync('video/hls/hls.m3u8', 'w+');
    fs.writeSync(manifest, '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:2.000000,\nhls0.ts\n');
    fs.closeSync(manifest);
}

// simulate torrent downloading
function torrentDownload() {
    const fileRead = fs.openSync('video/hls/fragment_arcansas.avi', 'r');
    const fileWrite = fs.openSync('video/hls/fragment_arcansas_generated.avi', 'w+');
    const buf = new Buffer.alloc(100000);
    let readBytes = 0;

    const timerId = setInterval(() => {
        if (readsome() <= 0)
            clearInterval(timerId);
    }, 4000);

    function readsome() {
        const result = fs.readSync(fileRead, buf, 0, 100000, readBytes);
        if (result > 0)
            fs.writeSync(fileWrite, buf, 0, result, readBytes);
        if (ffmpegStatus == 'idle')
            startFfmpeg(ffmpegStatus);
        readBytes += result;
        return result;
    }
}

function startFfmpeg(path) {
    console.log('start ffmpeg');
    ffmpegStatus = 'converting';
    const offset = countOffset();
    const spawn = require('child_process').spawn;
    const cmd = 'ffmpeg';
    const options = [
        '-i', path,
        '-c:v', 'libx264',
        '-r', 24,
        '-x264opts', 'fps=24:bitrate=2000:pass=1:vbv-maxrate=4000:vbv-bufsize=8000:keyint=24:min-keyint=24:scenecut=0:no-scenecut',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', 'default_base_moof+frag_keyframe',
        '-f', 'hls',
        '-hls_time', 6,
        '-hls_playlist_type', 'event',
        '-hls_flags', 'omit_endlist',
        'video/hls/hls.m3u8'
    ];
    const process = spawn(cmd, options);
    process.stdout.on('data', data => {
        console.log(data)
    });
    process.stderr.setEncoding('utf8');
    process.stderr.on('data', data => console.log(data));
    process.on('close', () => {
        ffmpegStatus = 'idle';
        console.log('ffmpeg finish');
    });

    function countOffset() {
        const data = fs.readFileSync('video/hls/hls.m3u8').toString();
        const pattern = /#EXTINF:2.0/g;
        return (data.match(pattern) || []).length * 2;
    }
}