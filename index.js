const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('video'));

app.get('/movie', async (req, res) => {
    res.sendFile(__dirname + '/html/index.html');
});
app.get('/movie2', async (req, res) => {
    res.sendFile(__dirname + '/html/index2.html');
});
app.get('/movie3', async (req, res) => {
    res.sendFile(__dirname + '/html/index3.html');
});

let torrents = [];
let streams = [];
const TorrentClient = require('./TorrentClient/TorrentClient');
const Stream = require('./Stream/Stream');
io.on('connection', async socket => {
    const movie = socket.handshake.query.movie;
    const torrentFile = socket.handshake.query.torrentFile;

    console.log(movie);

    if (!torrents[movie]) torrents[movie] = new TorrentClient('video');
    if (!streams[movie]) streams[movie] = new Stream();

    socket.join(movie);

    socket.on('play', async () => {
        if (torrents[movie].status == 'idle') {
            torrents[movie].initialize(torrentFile)
            .then( () => streams[movie].initialize( torrents[movie].files.path, torrents[movie].downloads ) )
            .then( () => streams[movie].createPlaylist() )
            .then( () => {
                const subtitlesFile = streams[movie].files.subtitles.length ? streams[movie].files.subtitles[0] : null;
                if (subtitlesFile) return torrents[movie].download( subtitlesFile );
                return Promise.resolve();
            })
            .then( () => streams[movie].convertSubtitles() )
            .then( () => {
                torrents[movie].events.on('piece-written', () => streams[movie].downloaded += torrents[movie].parser.BLOCK_SIZE);
                torrents[movie].events.on('files-checked', size => streams[movie].downloaded += size);
                streams[movie].events.on('manifest-created', () =>{
                    socket.emit('stream', {path: streams[movie].path, playlist: streams[movie].playlist, subtitles: streams[movie].subtitles});
                    torrents[movie].events.removeAllListeners('piece-written');
                    torrents[movie].events.removeAllListeners('files-checked');
                });

                streams[movie].convertVideo();

                return torrents[movie].download( streams[movie].files.movie );
            })
            .then( () => {
                streams[movie].slowConversion = false;
                streams[movie].restart = false;
            })
            .catch(error => {
                if (torrents[movie]) torrents[movie].close();
                if (streams[movie]) streams[movie].close();
                console.log('emit error: ' + error);
                socket.in(movie).emit('errors', error);
                // for some reason socket.in doesn't send to self
                socket.emit('errors', error);
            });
        } else {
            if (streams[movie].ready)
                socket.emit('stream', {path: streams[movie].path, playlist: streams[movie].playlist, subtitles: streams[movie].subtitles});
            else
                streams[movie].events.on('manifest-created', () =>{
                    socket.emit('stream', {path: streams[movie].path, playlist: streams[movie].playlist, subtitles: streams[movie].subtitles});
                });
        }
    });

    socket.on('disconnect', () => {
        if (io.sockets.adapter.rooms[movie] === undefined) {
            if (torrents[movie]) torrents[movie].close();
            if (streams[movie]) streams[movie].close();
        }
    });

});

http.listen(80);
