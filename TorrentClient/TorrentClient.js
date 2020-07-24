const Parser = require('./modules/parser');
const Blocks = require('./modules/blocks');
const Files = require('./modules/files');
const Request = require('./modules/request');
const Trackers = require('./modules/trackers');
const Peers = require('./modules/peers');
const fpromise = require('fs/promises');
const events = require('events');

module.exports = class {
    constructor(path) {
        this.path = path;
        // can be deleted in production
        this.buffer = Buffer.alloc(100);
        this.events = new events();
        this.status = 'idle';
    }

    initialize(torrentFile) {
        return new Promise(async (resolve, reject) => {
            // parse torrent file into object
            this.status = 'initialized';
            this.parser = new Parser();
            this.parser.read(torrentFile)
            .then(() => {
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
                // events
                this.files.events.on( 'piece-written', () => this.events.emit('piece-written') );
                // create path and project folder
                return fpromise.mkdir(this.files.path, {recursive: true}).catch(() => reject('CNTMKDR'));
            })
            .then( () => resolve() )
            .catch( err => reject(err) );
        });
    }

    download(filename) {
        return new Promise(async (resolve, reject) => {
            this.write('Checking files: ' + filename);

            // check if file exists and how much data we already have
            this.files.checkFile(filename)
            .then( status => {
                this.events.emit('files-checked', this.files.details[filename].size);

                if (status == 'downloaded') {
                    this.write('Download complete.');
                    return (resolve());
                }

                // request new peers
                this.write('Connecting to trackers.');
                this.trackers.connect();

                this.trackers.events.on( 'connect-fail', () => {
                    const failed = this.trackers.trackers.filter( tracker => tracker.failed );
                    if ( failed.length == this.trackers.urls.length ) reject('CNTCNNCT');
                });
                
                // if something needs to be downloaded, create fds for writing
                this.write('Creating files.');
                return this.files.createFile(filename)
            })
            .then( () => {
                if (this.peers.list.length) this.peers.connect();
                // events
                this.peers.events.on( 'peers-added', () => {
                    this.write('Connecting to peers.');
                    if ( this.peers.connect() == -1) reject('CNTCNNCT');
                });
                this.peers.events.on( 'piece-received', piece => this.files.writeFile(filename, piece).catch( err => reject(err) ) );
                this.files.events.on( 'finish', () => {
                    this.write('Download complete.');
                    this.close();
                    resolve();
                });
            })
            .catch( err => reject(err) );
        });
    }

    // can be deleted in production
    write(message) {
        console.log('\rTorrentClient: ' + message + '\r');
    }

    close() {
        this.status = 'idle';
        if (this.peers) {
            this.peers.close();
            this.peers.events.removeAllListeners('peers-added');
            this.peers.events.removeAllListeners('piece-received');
        }
        if (this.trackers) this.trackers.close();
        if (this.files) this.files.close(); 
    }
}
