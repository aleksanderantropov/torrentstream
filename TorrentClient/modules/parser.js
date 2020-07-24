const bencode = require('bencode');
const Buffer = require('buffer').Buffer;
const crypto = require('crypto');
const fs = require('fs');

module.exports = class {
    constructor() {
        this.BLOCK_SIZE = Math.pow(2, 14);
        this.torrent = null;
        this.details = {
            sizeNumber: null,
            sizeBuffer: null,
            pieceSize: null,
            lastPieceSize: null,
            lastPieceIndex: null,
            nBlocks: null,
            nBlocksLast: null,
            hashedInfo: null
        };
    }

    read(torrentFile) {
        return new Promise( async (resolve, reject) => {
            fs.readFile(torrentFile, (err, torrentData) => {
                if (err) return reject('CNTRD');

                // torrent object
                try {
                    this.torrent = bencode.decode( torrentData );
                } catch (e) {
                    return reject('CNTPRS');
                }
                // size as number
                const files = this.torrent.info.files;
                this.details.sizeNumber = files ?
                    files.map( file => file.length ).reduce( (size, file) => size + file ) 
                    : this.torrent.info.length;

                // size as buffer
                this.details.sizeBuffer = Buffer.alloc(8).writeBigInt64BE( BigInt(this.details.sizeNumber) );
                // details
                this.details.pieceSize = this.torrent.info['piece length'];
                this.details.lastPieceSize = this.details.sizeNumber % this.details.pieceSize;
                this.details.lastPieceIndex = Math.floor(this.details.sizeNumber / this.details.pieceSize);
                this.details.nBlocks = Math.ceil( this.details.pieceSize / this.BLOCK_SIZE );
                this.details.nBlocksLast = Math.ceil( this.details.lastPieceSize / this.BLOCK_SIZE );
                // hash info
                const info = bencode.encode(this.torrent.info);
                this.details.hashedInfo = crypto.createHash('sha1').update(info).digest();

                resolve();
            });
        });
    }

    getPieceSize(pieceIndex) {
        return pieceIndex == this.details.lastPieceIndex ? this.details.lastPieceSize : this.details.pieceSize;
    }

    getNumberOfBlocks(pieceIndex) {
        return pieceIndex == this.details.lastPieceIndex ? this.details.nBlocksLast : this.details.nBlocks;
    }

    getBlockSize(pieceIndex, blockIndex) {
        const pieceSize = this.getPieceSize(pieceIndex);
        const lastBlockSize = pieceSize % this.BLOCK_SIZE;
        const lastBlockIndex = Math.floor(pieceSize / this.BLOCK_SIZE);
        return (blockIndex == lastBlockIndex && lastBlockSize != 0
            ? lastBlockSize : this.BLOCK_SIZE);
    }
}
