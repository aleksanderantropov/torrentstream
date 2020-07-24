const events = require('events');
const net = require('net');

module.exports = class {
    constructor(requests, blocks, parser) {
        this.settings = {
            maxEmptyConnects: 5
        }
        this.requests = requests;
        this.blocks = blocks;
        this.parser = parser;
        this.list = [];
        this.events = new events();
        this.connects = 0;
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
        let connections = 0; //debug
        this.list.forEach( p => {
            if ( !p.peer || !p.peer.connected ) {
                connections++; //debug
                p.peer = new Peer(this.requests, this.blocks, this.parser);
                p.peer.connect(p.ip, p.port);
                p.peer.events.on('piece-received', piece => this.events.emit('piece-received', piece));
            }
        });

        // if after some time all peers are choked, exit
        if (this.connects >= this.settings.maxEmptyConnects) {
            if ( this.list.filter(peer => !peer.peer.choked).length == 0 ) {
                console.log('Exceeded connections');
                return (-1);
            } else
                this.connects = 0;
        } else 
            this.connects++;

        console.log('Connected to new peers: ' + connections); // debug
    }
    
    // close peer connections
    close() {
        this.list.forEach( p => {
            if ( p.peer && p.peer.connected ) {
                p.peer.chokeHandler();
                clearTimeout(p.peer.lostTimer);
            }
        });
        this.list = [];
        this.connects = 0;
    }
}

class Peer {
    constructor(requests, blocks, parser) {
        this.settings =  {
            lostTimeout: 3000,
        };
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
        this.socket = new net.Socket().on('error', () => {});
        
        this.connected = true;
    }

    connect(ip, port) {
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
        this.socket.on('close', () => {
            this.connected = false;
            this.requests.generateId();
            this.socket.removeAllListeners('data');
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
        this.socket.end();
    }
    // unchoke, add have to queue and request a piece
    unchokeHandler() {
        const empty = !this.queue.length;

        this.choked = false;
        // fill queue with what we need
        this.blocks.missing().forEach( piece => this.queueAdd(piece) );

        if (empty) this.requestNext();
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
        const bindex = piece.begin / this.parser.BLOCK_SIZE;
        
        // clear timeout for lost
        clearTimeout(this.lostTimer);
        
        // if we haven't received it yet
        if (!this.blocks.received[piece.index][bindex]) {
            // add to received
            this.blocks.received[piece.index][bindex] = true;
            // emit event to write piece in outer function
            this.events.emit('piece-received', piece);
        }
        // check if we are done
        if ( this.blocks.complete() ) {
            // we are done
            return ;
        }
        else if ( this.blocks.lost.length ) {
            // add lost to queue
            this.queueAddLost();
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
                this.trackLost(piece.index, bindex);
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
    
    trackLost(pindex, bindex) {
        this.lostTimer = setTimeout(() => {
            if (!this.blocks.received[pindex][bindex]) {
                this.blocks.requested[pindex][bindex] = false;
                this.blocks.lost.push({pindex: pindex, bindex: bindex});
                this.chokeHandler();
            }
        }, this.settings.lostTimeout);
    }

    queueAddLost() {
        while ( this.blocks.lost.length ) {
            const piece = this.blocks.lost.shift();
            this.queue.unshift({
                index: piece.pindex,
                begin: piece.bindex * this.parser.BLOCK_SIZE,
                length: this.parser.getBlockSize(piece.pindex, piece.bindex)
            });
        }
    }
}