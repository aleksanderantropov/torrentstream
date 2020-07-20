const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('video'));

app.get('/movie', async (req, res) => {
    res.sendFile(__dirname + '/html/index.html');
});

let torrents = [];
let streams = [];
const TorrentClient = require('./TorrentClient/TorrentClient');
const Stream = require('./Stream/Stream');
io.on('connection', async socket => {
    const movie = socket.handshake.query.movie;
    const torrentFile = socket.handshake.query.torrentFile;

    if (!torrents[movie]) torrents[movie] = new TorrentClient('video');
    if (!streams[movie]) streams[movie] = new Stream();

    socket.on('play', async () => {
        torrents[movie].initialize(torrentFile)
        .then( () => streams[movie].initialize( torrents[movie] ) )
        .then( () => streams[movie].createPlaylist() )
        .then( () => {
            const subtitlesFile = streams[movie].files.subtitles.length ? streams[movie].files.subtitles[0] : null;
            if (subtitlesFile) return torrents[movie].download( subtitlesFile );
            return Promise.resolve();
        })
        .then( () => streams[movie].convertSubtitles() )
        .then( () => {
            streams[movie].convertVideo();

            torrents[movie].events.on('piece-written', () => streams[movie].downloaded += torrents[movie].parser.BLOCK_SIZE);
            torrents[movie].events.on('files-checked', size => streams[movie].downloaded += size);
            streams[movie].events.on('manifest-created', () => {
                console.log('manifest-created');
                socket.emit('stream', {path: streams[movie].path, playlist: streams[movie].playlist, subtitles: streams[movie].subtitles});
            });

            return torrents[movie].download( streams[movie].files.movie );
        })
        .then( () => streams[movie].slowConversion = false)
        .catch(error => {
            if (torrents[movie]) torrents[movie].close();
            if (streams[movie]) streams[movie].close();
            socket.emit('errors', error);
        });
    });

    socket.on('disconnect', () => {
        if (torrents[movie]) torrents[movie].close();
        if (streams[movie]) streams[movie].close();
    });

});

http.listen(80);
