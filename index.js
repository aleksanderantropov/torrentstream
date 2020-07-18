const express = require('express');
const app = express();

const TorrentClient = require('./TorrentClient/TorrentClient');
const Stream = require('./Stream/Stream');

app.use(express.static('video'));

let torrent;
app.get('/movie', async (req, res) => {

    switch (req.query.action) {
        // User 
        case 'play':
            // User pressed play: download files and start stream
            stream = new Stream();
            await stream.initialize(torrent).catch(() => {});
            if (stream.errors.length) return answer(res, {errors: stream.errors});
            stream.createPlaylist();
            if (stream.files.subtitles) {
                await torrent.download(stream.files.subtitles).catch(() => {});
                await stream.convertSubtitles().catch(() => {});
            }
            torrent.download(stream.files.movie).catch(() => {});
            torrent.events.on('piece-written', () => stream.downloaded += torrent.parser.BLOCK_SIZE);
            torrent.events.on('files-checked', size => stream.downloaded += size);
            stream.convertVideo();
            stream.events.on('manifest-created',
                () => answer(res, {path: stream.path, playlist: stream.playlist, subtitles: stream.subtitles}));
            break ;
        default:
            // User opens the page: initialize torrent and get peers
            if (!torrent) torrent = new TorrentClient('video');
            torrent.initialize('torrent-files/gump.torrent')
                .then(() => torrent.getPeers().catch(() => {}));
           
            res.sendFile(__dirname + '/html/index.html');
            break ;
    }
});

app.listen(80);

function answer(res, object) {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(object));
}