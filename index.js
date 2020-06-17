const http = require('http');
const express = require('express');
const app = express();
const fs = require('fs');
const tc = require('./torrent-client/client');


app.use(express.static('video'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/html/index.html');
});

app.get('/play', (req, res) => {
    res.sendFile(__dirname + '/html/player.html');
});

app.get('/video', (req, res) => {
    // const torrentClient = new tc('video');
    // torrentClient.download('torrent-files/bad-boys.torrent', 'bbf.mp4');
    const path = 'video/bbf.mp4';
    const stat = fs.statSync(path);
    const fileSize = stat.size;
    console.log('request: ', req.headers);
    const range = req.headers.range;
    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = (end - start) + 1;
        const file = fs.createReadStream(path, {start, end});
        const head = {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': 'video/mp4'
        }
        res.writeHead(206, head);
        file.pipe(res);
    } else {
        const head = {
            'Content-Length': fileSize,
            'Content-Type': 'video/mp4'
        }
        res.writeHead(200, head);
        fs.createReadStream(path).pipe(res);
    }
});

app.listen(80);