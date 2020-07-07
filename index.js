const express = require('express');
const app = express();
const fs = require('fs');
const TorrentClient = require('./torrent-client/client');
const events = require('events');
const { exit } = require('process');

app.use(express.static('video'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/html/index.html');
});

let ffmpegStatus = 'idle';
let fileExists = false;
let movie, subtitles, timerId;

const torrentClient = new TorrentClient('video/hls');

app.get('/hls', (req, res) => {
    // serve page
    res.sendFile(__dirname + '/html/hls.html');

    torrentClient.initialize('torrent-files/mall.torrent')
        .then(() => torrentClient.getPeers())
        .then(async () => {
            const files = torrentClient.downloads;
            console.log(files);
            // check if we have subtitles
            subtitles = files.filter(file => file.match(/.srt|.webvtt|.ass/));
            movie = files.filter(file => file.match(/.avi|.mp4|.mkv|.webm|.vob|.ogg|.ogv|.flv|.amv|.mov/));
            console.log('starting to download subtitles');
            if (subtitles)
                await torrentClient.download(subtitles);
            // createMasterManifest();
            console.log('starting to download the movie');
            torrentClient.events.on('files-check', () => startFfmpeg(torrentClient.files.path, movie, subtitles));
            torrentClient.download(movie)
                .then(() => clearInterval(timerId));
        })
        .catch(err => console.log(err));
});

app.get('/check', (req, res) => {
    const timerId = setInterval(() => {
        if (torrentClient && torrentClient.files && fs.existsSync(torrentClient.files.path + 'hls.m3u8')) {
            clearInterval(timerId);
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({path: 'hls/' + torrentClient.parser.torrent.info.name + '/'}));
        }
    }, 1000);
});

app.listen(80);

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

async function startFfmpeg(path, video, subtitles) {
    if (!fileExists) {
        fs.exists(torrentClient.files.path + movie, exists => {
            if (exists)
                fs.stat(torrentClient.files.path + movie, (err, stat) => {
                    if (!err && stat.size > 30000)
                        fileExists = true;
                });
        });
    }
    if (ffmpegStatus != 'idle' || !fileExists) {
        setTimeout(() => startFfmpeg(path, video, subtitles), 2000);
        return ;
    }
    console.log('start ffmpeg');
    ffmpegStatus = 'converting';
    const offset = countOffset(path);
    console.log('offset: ', offset);
    const spawn = require('child_process').spawn;
    const cmd = 'ffmpeg';
    let options = [];
    options.push('-i', path + video);
    if (subtitles)
        options.push('-i', path + subtitles);
    options.push(
        '-ss', offset,
        '-c:v', 'libx264',
        '-c:a', 'aac',
    );
    if (subtitles)
        options.push( '-c:s', 'webvtt' );
    options.push(
        '-start_number', 0,
        '-var_stream_map', 'v:0,a:0,s:0',
        '-master_pl_name', 'hls.m3u8',
        '-f', 'hls',
        '-hls_time', 4,
        '-hls_playlist_type', 'event',
        '-hls_flags', 'append_list',
        path + 't.m3u8'
    );
    const process = spawn(cmd, options);
    process.stdout.on('data', data => console.log(data));
    process.stderr.setEncoding('utf8');
    process.stderr.on('data', data => {
        console.log(data);
    });
    process.on('close', () => {
        ffmpegStatus = 'idle';
        console.log('ffmpeg finish');
    });

    function countOffset(path) {
        console.log(path);
        if (!fs.existsSync(path + 't.m3u8')) return (0);
        const data = fs.readFileSync(path + 't.m3u8').toString();
        console.log(data);
        const pattern = /#EXTINF:(?<duration>\d+\.\d+)/g;
        const result = [...data.matchAll(pattern)];
        let duration = 0;
        for (let i = 0; i < result.length - 1; i++)
            duration += parseFloat(result[i][1]);
        return (duration);
    }
}