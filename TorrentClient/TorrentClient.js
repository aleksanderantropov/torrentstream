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
const { Console } = require('console');

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
            this.left = this.parser.details.sizeNumber;
            // save file paths that we will download
            this.downloads = this.files.files.map(file => file.path.toString());
            this.requests = new Request(this.left, this.parser.details.hashedInfo);
            this.peers = new Peers(this.requests, this.blocks, this.parser);
            this.trackers = new Trackers(this.parser.torrent, this.requests, this.peers, this.files);
            this.peers.settings.maxEmptyConnects = this.trackers.urls.length  * 2;
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
            this.files.events.on( 'piece-written', () => this.events.emit('piece-written') );
            resolve();
        });
    }

    download(filename) {
        return new Promise(async (resolve, reject) => {
            this.write('Checking files: ' + filename);

            // check if file exists and how much data we already have
            const status = await this.files.checkFile(filename).catch((err) => console.log(err));
            this.events.emit('files-checked', this.files.details[filename].size);
            if (status == 'downloaded') {
                this.write('Download complete.');
                return (resolve());
            }

            // request new peers
            this.write('Connecting to trackers.');
            this.trackers.connect();

            // if something needs to be downloaded, create fds for writing
            this.write('Creating files.');
            await this.files.createFile(filename).catch( err => reject(err) );

            // events
            this.peers.events.on( 'peers-added', () => {
                this.write('Connecting to peers.');
                if ( this.peers.connect() == -1) reject('CNTCNNCT');
            });
            this.peers.events.on( 'piece-received', piece => this.files.writeFile(filename, piece) );
            this.files.events.on( 'finish', () => {
                this.write('Download complete.');
                this.close();
                resolve();
            });
        });
    }

    // can be deleted in production
    write(message) {
        console.log('\rTorrentClient: ' + message + '\r');
    }

    close() {
        if (this.peers) {
            this.peers.close();
            this.peers.events.removeAllListeners('peers-added');
            this.peers.events.removeAllListeners('piece-received');
        }
        if (this.trackers) this.trackers.close();
        if (this.files) this.files.close();
        
    }
}
