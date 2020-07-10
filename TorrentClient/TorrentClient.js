const Parser = require('./modules/parser');
const Blocks = require('./modules/blocks');
const Files = require('./modules/files');
const Request = require('./modules/request');
const Trackers = require('./modules/trackers');
const Peers = require('./modules/peers');
const fs = require('fs');
const fpromise = require('fs/promises');
const { exit } = require('process');
const events = require('events');

module.exports = class {
    constructor(path) {
        this.path = path;
        // can be deleted in production
        this.buffer = Buffer.alloc(100);
        // tracker failed connections
        this.failed = 0;
        this.events = new events();
    }

    initialize(torrentFile) {
        return new Promise(async resolve => {
            // parse torrent file into object
            this.parser = new Parser();
            await this.parser.read(torrentFile);
            // create pieces and blocks to track download process
            this.blocks = new Blocks( this.parser );
            // create files
            this.files = new Files(this.path, this.blocks, this.parser);
            // this.left = this.parser.details.sizeNumber;
            this.left = 82372;
            // save file paths that we will download
            this.downloads = this.files.files.map(file => file.path.toString());
            this.requests = new Request(this.left, this.parser.details.hashedInfo);
            this.peers = new Peers(this.requests, this.blocks, this.parser);
            this.trackers = new Trackers(this.parser.torrent, this.requests, this.peers);
            // create path and project folder
            await fpromise.mkdir(this.files.path, {recursive: true})
                .catch(() => {
                    console.log('TorrentClient: Couldn\'t create directory: ', this.path);
                    process.exit(1);
                });
            // events
            this.trackers.events.on('connect-fail', () => {
                this.failed++;
                this.write('Couldn\'t connect to tracker.');
                if (this.failed == this.trackers.trackers.length * (this.trackers.retries + 1) ) {
                    this.write('Exceeded number of retries. Couldn\'t connect to tracker.\n');
                    resolve(-1);
                }
            });
            // unnecessary event - can be deleted in production
            this.files.events.on( 'piece-written', () => {
                // print progress
                const received = this.blocks.received.reduce( (total, blocks) => blocks.filter(b => b).length + total, 0);
                const percent = Math.floor(received / this.total * 100);
                this.write('Complete: ' + percent + '% [' + received + ' / ' + this.total + ']', false);
                this.events.emit('piece-written');
            });
            resolve();
        });
    }

    getPeers() {
        return new Promise(async resolve => {
            // load peers from file if exists
            const downloadDir = this.path + '/' + this.parser.torrent.info.name;
            fs.readFile(downloadDir + '/peers.json', (err, data) => {
                if (!err) {
                    try {
                        this.write('Uploading peers from a file.');
                        const decoded = JSON.parse(data.toString());
                        this.peers.add(decoded);
                    } catch (e) {
                        this.write('Couldn\'t parse JSON file: ', downloadDir + '/peers.json');
                    }
                }
            });

            // connect to tracker and get peers
            this.write('Requesting peers from trackers.');
            this.trackers.connect();
            // output peers to a file
            this.peers.events.on( 'peers-added', () => fs.writeFile(this.files.path + 'peers.json', JSON.stringify(this.peers.outputList), () => resolve()) );
        });
    }

    download(filename) {
        return new Promise(async resolve => {
            this.write('Checking files.');
            // check if file exists and how much data we already have
            const status = await this.files.checkFile(filename).catch((err) => console.log(err));
            this.events.emit('files-checked');
            if (status == 'downloaded') {
                this.write('Download complete.');
                return (resolve(1));
            }

            this.write('Creating files.');
            // if something needs to be downloaded, create fds for writing
            await this.files.createFile(filename).catch((err) => console.log(err));

            // for stats
            this.total = this.blocks.received.reduce( (total, blocks) => blocks.length + total, 0);

            this.write('Connecting to peers.');
            this.peers.connect();

            // rerequest new peers
            this.trackers.rerequest();

            // events
            this.peers.events.on( 'peers-added', () => {
                if (!this.files.downloaded) {
                    this.write('Connecting to peers.');
                    this.peers.connect();
                    // rerequest new peers after a timeout
                    this.trackers.rerequest(this.files.left, this.files.downloaded);
                }
            });
            this.peers.events.on( 'piece-received', piece => {
                this.files.writeFile(filename, piece);
            });
            this.files.events.on( 'finish', () => {
                this.write('Download complete.');
                this.files.close(filename);
                resolve(1);
            });
        });
    }

    // can be deleted in production
    write(message, clear = true) {
        if (clear)
            process.stdout.write(this.buffer);
        process.stdout.write('\rTorrentClient: ' + message + '\r');
    }

    close() {
        this.peers.close();
        this.trackers.close();
    }
}
