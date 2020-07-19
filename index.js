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

            if (stream.files.subtitles.length) {
                await torrent.download(stream.files.subtitles[0])
                    .catch(error => {
                        console.log('error subs: ', error);
                        stream.close();
                        torrent.close();
                        stream.errors.push(error);
                    });
                if (stream.errors.length) return answer(res, {errors: stream.errors});
                await stream.convertSubtitles().catch(() => {});
            }
            torrent.download(stream.files.movie)
                .then(() => stream.restart = false)
                .catch(error => {
                    console.log('error movie: ', error);
                    stream.close();
                    torrent.close();
                    stream.errors.push(error);
                });
            if (stream.errors.length) return answer(res, {errors: stream.errors});
            stream.convertVideo();
            torrent.events.on('piece-written', () => stream.downloaded += torrent.parser.BLOCK_SIZE);
            torrent.events.on('files-checked', size => stream.downloaded += size);
            stream.events.on('manifest-created',
                () => answer(res, {path: stream.path, playlist: stream.playlist, subtitles: stream.subtitles})
            );
            // stream.listenHeartbeat();
            break ;
        // case 'heartbeat':
        //     console.log('HEARTBEAT RECEIVED');
        //     if (stream && stream.status != 'cancelled') stream.listenHeartbeat();
        //     break ;
        case 'die':
            if (stream && torrent) {
                console.log('die');
                stream.close();
                torrent.close(stream.files.movie);
            }
            break ;
        default:
            // security measure
            if (stream && stream.process) stream.process.kill();
            // User opens the page: initialize torrent and get peers
            if (!torrent) torrent = new TorrentClient('video');
            torrent.initialize('torrent-files/john-wick.torrent')
                .then(() => torrent.getPeers())
                .then(() => torrent.trackers.close())
                .catch(() => {});
           
            res.sendFile(__dirname + '/html/index.html');
            break ;
    }
});

app.listen(80);

function answer(res, object) {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(object));
}
