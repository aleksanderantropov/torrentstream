const events = require('events');
const net = require('net');
const { exit } = require('process');

module.exports = class {
    constructor(requests, blocks, parser) {
        this.requests = requests;
        this.blocks = blocks;
        this.parser = parser;
        this.list = [];
        this.outputList = [];
        this.events = new events();
    }

    // add new peers, filter out duplicates
    add(list) {
        list = list.map(peer => {
            return {
                ip: peer.ip,
                port: peer.port,
                connected: null
            }
        });
        // filter leave only items that satisfy a condition
        this.list = this.list.concat(list).filter( (peer, index, self) =>
            // findIndex returns the index of the first element that satisfies testing function
            // therefore condition is only first indices of same peers
            index === self.findIndex( item => (item.port == peer.port && item.ip == peer.ip) )
        );
        this.outputList = this.list.map(peer => {
            return {ip: peer.ip, port: peer.port};
        });
        // emit event (it's being listened to in client.js)
        this.events.emit('peers-added');
    }

    connect() {
        this.list.forEach( p => {
            if ( !p.connected ) {
                p.peer = new Peer(this.requests, this.blocks, this.parser);
                p.peer.connect(p.ip, p.port);
                p.connected = true;
                p.peer.events.on('piece-received', piece => this.events.emit('piece-received', piece));
            }
        });
    }
    
    // close peer connections
    close() {
        this.list.forEach( p => {
            if (p.connected) {
                p.peer.socket.end();
                p.connected = false;
            }
        });
    }
}

class Peer {
    constructor(requests, blocks, parser) {
        this.events = new events();
        this.requests = requests;
        this.blocks = blocks;
        this.parser = parser;
        // first message is always a handshake
        this.handshake = true;
        // we start as choked with a new peer and wait for unchoke
        this.choked = true;
        // we will queue pieces to download
        this.queue = [];
        // we are interested in what peer has
        this.interested = false;
    }

    connect(ip, port) {
        this.socket = new net.Socket().on('error', () => {});
        this.socket.connect(port, ip, () => this.socket.write( this.requests.handshake() ) );
        // we can receive data in chunks
        let buffer = Buffer.alloc(0);
        this.socket.on('data', chunk => {         
            buffer = Buffer.concat( [buffer, chunk] );
            while ( buffer.length >= 4 && buffer.length >= getLength() ) {
                const messageLength = getLength();
                // split buffer into messages
                this.handle( buffer.slice(0, messageLength) );
                // remove handled part
                buffer = buffer.slice(messageLength);
                this.handshake = false;
            }
        });
        // get length of the next message
        const getLength = () => {
            return this.handshake ? buffer.readUInt8(0) + 49 : buffer.readInt32BE(0) + 4;
        }
    }

    handle(m) {
        if (!this.handshake) {
            const message = this.requests.parse(m);
            switch (message.id) {
                case 0:
                    this.chokeHandler();
                    break ;
                case 1:
                    this.unchokeHandler();
                    break ;
                case 4:
                case 5:
                    this.forceDownloadHandler();
                    break ;
                case 7:
                    this.pieceHandler(message.payload);
                    break ;
            }
        }
    }
    // set choke and drop all queued pieces
    chokeHandler() {
        this.choked = true;
        this.queue = [];
    }
    // unchoke, add have to queue and request a piece
    unchokeHandler() {
        this.choked = false;
        // fill queue with what we need
        this.blocks.missing().forEach( piece => this.queueAdd(piece) );
        this.requestNext();
    }
    forceDownloadHandler() {
        const empty = !this.queue.length;

        if ( !this.interested ) {
            this.interested = true;
            this.socket.write( this.requests.interested() );
        } 
        if (empty) this.requestNext();
    }
    // we received a piece, add to received, write to file, check if we are all done, request next
    pieceHandler(piece) {
        // add to received
        this.blocks.received[piece.index][piece.begin / this.parser.BLOCK_SIZE] = true;
        // emit event to write piece in outer function
        this.events.emit('piece-received', piece);
        // check if we are done
        if ( this.blocks.complete() ) {
            // we are done
            return ;
        }
        else if ( this.blocks.lost ) {
            // add missing to queue
            this.blocks.missing().forEach( piece => this.queueAdd(piece) );
        }
        this.requestNext();
    }
    // get first element off the queue and request
    requestNext() {
        // wait to be unchoked to start requesting
        if (this.choked) return ;

        while ( this.queue.length ) {
            const piece = this.queue.shift();
            // block index
            const bindex = piece.begin / this.parser.BLOCK_SIZE;
            if ( this.blocks.needed( piece.index, bindex ) ) {
                this.socket.write( this.requests.piece(piece) );
                this.blocks.requested[piece.index][bindex] = true;
                break ;
            }
        }
    }
    // split piece into blocks and add to queue
    queueAdd(pindex) {
        const length = this.parser.getNumberOfBlocks(pindex);
        // split piece into blocks and add to queue
        for (let bindex = 0; bindex < length; bindex++) {
            this.queue.push({
                index: pindex,
                begin: bindex * this.parser.BLOCK_SIZE,
                length: this.parser.getBlockSize(pindex, bindex)
            });
        }
    }
}