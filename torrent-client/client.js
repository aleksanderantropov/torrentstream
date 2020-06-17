const Parser = require('./modules/parser');
const Blocks = require('./modules/blocks');
const Files = require('./modules/files');
const Request = require('./modules/request');
const Trackers = require('./modules/trackers');
const Peers = require('./modules/peers');

module.exports = class {
    constructor(path) {
        this.path = path;
        // can be deleted in production
        this.buffer = Buffer.alloc(100);
    }

    download(torrentFile) {
        return new Promise(async resolve => {
            // tracker failed connections
            let failed = 0;
            // parse torrent file into object
            const parser = new Parser();
            await parser.read(torrentFile);
            // create pieces and blocks to track download process
            const blocks = new Blocks( parser );
            // check how much left to download and mark blocks we already have
            const files = new Files(this.path, blocks, parser);
            const left = await files.check();

            // all write functions can be deleted in production
            const total = blocks.received.reduce( (total, blocks) => blocks.length + total, 0);
            this.write('Left to download: ' + left + '. Requesting peers.');

            // everything is downloaded
            if (left == 0)
                return resolve(0);

            // starting/continuing download
            await files.create();
            // connect to tracker and get peers
            const requests = new Request(left, parser.details.hashedInfo);
            const peers = new Peers(requests, blocks, parser, files);
            const trackers = new Trackers(parser.torrent, requests, peers);
            trackers.connect();

            // events
            trackers.events.on('connect-fail', () => {
                failed++;
                this.write('Couldn\'t connect to tracker.');
                if (failed == trackers.trackers.length * (trackers.retries + 1) ) {
                    this.write('Exceeded number of retries. Couldn\'t connect to tracker.\n');
                    resolve(-1);
                }
            });
            peers.events.on( 'peers-added', () => {
                if (!files.downloaded) {
                    this.write('Connecting to peers.');
                    peers.connect();
                    // rerequest new peers after a timeout
                    trackers.rerequest();
                }
            });
            files.events.on( 'finish', () => {
                peers.close();
                files.close();
                trackers.close();
                this.write('Download complete.');
                resolve(1);
            });
            // unnecessary event - can be deleted in production
            files.events.on( 'piece-written', () => {
                // print progress
                const received = blocks.received.reduce( (total, blocks) => blocks.filter(b => b).length + total, 0);
                const percent = Math.floor(received / total * 100);
                this.write('Complete: ' + percent + '% [' + received + ' / ' + total + ']', false);
            });
        });
    }
    // can be deleted in production
    write(message, clear = true) {
        if (clear)
            process.stdout.write(this.buffer);
        process.stdout.write('\r' + message + '\r');
    }
}
