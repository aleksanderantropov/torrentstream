const events = require('events');
const net = require('net');

module.exports = class {
    constructor(requests, blocks, parser, files) {
        this.requests = requests;
        this.blocks = blocks;
        this.parser = parser;
        this.files = files;
        this.list = [];
        this.events = new events();
    }

    // add new peers, filter out duplicates
    add(list) {
        // filter leave only items that satisfy a condition
        this.list = this.list.concat(list).filter( (peer, index, self) =>
            // findIndex returns the index of the first element that satisfies testing function
            // therefore condition is only first indices of same peers
            index === self.findIndex( item => (item.port == peer.port && item.ip == peer.ip) )
        );
        // emit event (it's being listened to in client.js)
        this.events.emit('peers-added');
    }

    connect() {
        this.list.forEach( p => {
            if ( !p.connected ) {
                p.peer = new Peer(this.requests, this.blocks, this.parser, this.files);
                p.peer.connect(p.ip, p.port);
                p.connected = true;
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
    constructor(requests, blocks, parser, files) {
        this.requests = requests;
        this.blocks = blocks;
        this.parser = parser;
        this.files = files;
        // first message is always a handshake
        this.handshake = true;
        // we start as choked with a new peer and wait for unchoke
        this.choked = true;
        // we will queue pieces to download
        this.queue = [];
        // we will save what peer has to restore lost pieces
        this.have = [];
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
                    this.haveHandler(message.payload);
                    break ;
                case 5:
                    this.bitfieldHandler(message.payload);
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
        this.have.forEach( piece => {
            if ( this.blocks.needed(piece) ) this.queueAdd(piece);
        });
        this.request();
    }
    // add to have, queue and start request
    haveHandler(payload) {
        const empty = !this.queue.length;

        // piece index
        const index = payload.readUInt32BE(0);
        // add to have
        this.have.push(index);
        // check if we need the piece - add to queue
        if ( this.blocks.needed(index) ) {
            this.queueAdd(index);
            // write interested
            if ( !this.interested ) {
                this.interested = true;
                this.socket.write( this.requests.interested() );
            }
        }
        // if queue was empty, start request
        if (empty)
            this.request();
    }
    // split 1 message that contains all pieces peer has into piece indices and add to have, queue and start request
    bitfieldHandler(payload) {
        const empty = !this.queue.length;

        // we received all pieces in 1 message, break into pieces and add to queue
        // each bit represents a piece: 0 - doesn't have, 1 - has
        // we split each byte into bits and read them
        payload.forEach( (byte, index) => {
            // split byte into 8 bits
            for (let i = 0; i < 8; i++) {
                // check that the most right bit is 1 = we have that piece
                if (byte & 1) {
                    // each index is 8 pieces, the most right bit is first piece in the sequence (and we check left)
                    const piece = index * 8 + 7 - i;
                    this.have.push(piece);
                    // check if we need this piece and queue it
                    if ( this.blocks.needed(index) ) {
                        this.queueAdd(index);
                        // write interested
                        if ( !this.interested ) {
                            this.interested = true;
                            this.socket.write( this.requests.interested() );
                        }
                    }
                }
                // shift to the right discarding the most left bit to read bit by bit
                byte = byte >> 1;
            }
        });
        // if queue was empty, start request
        if (empty) this.request();
    }
    // we received a piece, add to received, write to file, check if we are all done, request next
    pieceHandler(piece) {
        // add to received
        this.blocks.received[piece.index][piece.begin / this.parser.BLOCK_SIZE] = true;
        // write to file
        this.files.write(piece);
        // check if we are done
        if ( this.blocks.complete() ) {
            // we are done
            return ;
        }
        else if ( this.blocks.lost ) {
            // add missing to queue
            this.blocks.missing().forEach( piece => this.queueAdd(piece, true) );
        }
        this.request();
    }
    // get first element off the queue and request
    request() {
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
    queueAdd(pindex, checkHave = null) {
        if ( checkHave && !this.have.includes(pindex) )
            return ;
        const length = this.parser.getNumberOfBlocks(pindex);
        // split piece into blocks and add to queue
        for (let bindex = 0; bindex < length; bindex++) {
            this.queue.push({
                index: pindex,
                begin: bindex * this.parser.BLOCK_SIZE,
                length: this.parser.getBlockSize(pindex, bindex)
            });
        }
        // sort by piece index
        this.queue.sort( (a, b) => a.index > b.index);
    }
}