const express = require('express');
const app = express();

const TorrentClient = require('./TorrentClient/TorrentClient');
const Stream = require('./Stream/Stream');

app.use(express.static('video'));

let torrent, stream;
app.get('/movie', async (req, res) => {

    switch (req.query.action) {
        // User 
        case 'play':
            // User pressed play: download files and start stream
            stream = new Stream();
            await stream.initialize(torrent).catch(() => {});
            if (stream.errors.length) return answer(res, {errors: stream.errors});
            stream.createPlaylist();
            await torrent.download(stream.files.subtitles).catch(() => {});
            await stream.convertSubtitles().catch(() => {});
            torrent.download(stream.files.movie).then(() => torrent.close());
            torrent.events.on('piece-written', () => stream.convertVideo());
            torrent.events.on('files-checked', () => stream.convertVideo());
            stream.events.on('manifest-created',
                () => answer(res, {path: stream.path, playlist: stream.playlist, subtitles: stream.subtitles}));
            break ;
        default:
            // User opens the page: initialize torrent and get peers
            torrent = new TorrentClient('video');
            torrent.initialize('torrent-files/mall.torrent')
                .then(() => torrent.getPeers());

            res.sendFile(__dirname + '/html/index.html');
            break ;
    }
});

app.listen(80);

function answer(res, object) { 
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(object));
}