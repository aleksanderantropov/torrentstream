const express = require('express');
const app = express();
const fs = require('fs');
const TorrentClient = require('./TorrentClient/TorrentClient');
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
            const path = torrentClient.files.path;

            // check if we have subtitles
            const subsFilter = files.filter(file => file.match(/.srt|.webvtt|.ass/));
            movie = files.filter(file => file.match(/.avi|.mp4|.mkv|.webm|.vob|.ogg|.ogv|.flv|.amv|.mov/));

            console.log('Creating master playlist');
            createMasterPlaylist(path);
            if (subsFilter) {
                console.log('starting to download subtitles');
                await torrentClient.download(subsFilter);
                subtitles = await convertSubtitles(path, subsFilter);
            }
            console.log('starting to download the movie');
            torrentClient.events.on('files-check', () => convertVideo(path, movie));
            torrentClient.download(movie)
                .then(() => clearInterval(timerId));
        })
        .catch(err => console.log(err));
});

app.get('/check', (req, res) => {
    
    const timerId = setInterval(() => {
        if (torrentClient.parser && subtitles) {
            const directory = torrentClient.parser.torrent.info.name;
            const path = torrentClient.files.path;
            clearInterval(timerId);
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(
                JSON.stringify({
                    path: 'hls/' + directory,
                    subtitles: '/' + subtitles,
                    master: '/master.m3u8'
                })
            );
        }
    }, 1000);
});

app.listen(80);

function createMasterPlaylist(path) {
    const data =
        "#EXTM3U\n" +
        "#EXT-X-VERSION:3\n" +
        '#EXT-X-STREAM-INF:BANDWIDTH=1240800,CODECS="avc1.64001f,mp4a.40.2"\n' +
        "hls.m3u8\n\n";
    fs.writeFile(path + '/master.m3u8', data, (err) => {
        if (err) console.log('Couldn\'t write to file: ', path + '/master.m3u8');
    });
}

async function convertSubtitles(path, subtitles) {
    return new Promise(resolve => {
        const spawn = require('child_process').spawn;
        const cmd = 'ffmpeg';
        console.log(path + subtitles, path + 'subtitles.vtt');
        let options = [
            '-y',
            '-i', path + subtitles,
            path + 'subtitles.vtt'
        ];
        const process = spawn(cmd, options);
        // process.stdout.on('data', data => console.log(data));
        // process.stderr.setEncoding('utf8');
        // process.stderr.on('data', data => {
        //     console.log(data);
        // });
        process.on('close', () => {
            resolve('subtitles.vtt');
        });
    });
}

async function convertVideo(path, video, subtitles) {
    if (!fileExists) {
        fs.exists(path + video, exists => {
            if (exists)
                fs.stat(path + video, (err, stat) => {
                    if (!err && stat.size > 30000)
                        fileExists = true;
                });
        });
    }
    if (ffmpegStatus != 'idle' || !fileExists) {
        setTimeout(() => convertVideo(path, video, subtitles), 2000);
        return ;
    }
    console.log('converting video');
    ffmpegStatus = 'converting';
    const offset = countOffset(path);
    console.log('offset: ', offset);
    const spawn = require('child_process').spawn;
    const cmd = 'ffmpeg';
    let options = [
        '-i', path + video,
        '-ss', offset,
        '-c:v', 'libx264',
        '-b:v', '1000k',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-f', 'hls',
        '-hls_time', 4,
        '-hls_playlist_type', 'event',
        '-hls_flags', 'append_list+omit_endlist',
        path + 'hls.m3u8'
    ];
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
        if (!fs.existsSync(path + 'hls.m3u8')) return (0);
        const data = fs.readFileSync(path + 'hls.m3u8').toString();
        const pattern = /#EXTINF:(?<duration>\d+\.\d+)/g;
        const result = [...data.matchAll(pattern)];
        let duration = 0;
        for (let i = 0; i < result.length; i++){
            duration += parseFloat(result[i][1]);
        }
        return (duration);
    }
}