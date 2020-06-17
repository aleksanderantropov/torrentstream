// This module exports methods to work with files that we download via torrent
// Check method checks if files that we download already exist
// and checks data inside of them to determine how much data we need to download
const fs = require('fs');
const fpromise = require('fs/promises');
const buffer = require('buffer').Buffer;
const events = require('events');

module.exports = class {
    constructor(filepath, blocks, parser) {
        this.path = filepath + '/' + parser.torrent.info.name + '/';
        this.blocks = blocks;
        this.parser = parser;
        this.files = parser.torrent.info.files;
        this.fileDetails = [];
        this.fds = [];
        this.left = 0;
        this.downloaded = false;
        // represents blocks already written to files
        this.written = (() => {
            const nPieces = parser.torrent.info.pieces.length / 20;
            const array = new Array(nPieces).fill(null);
            return array.map( (value, pieceIndex) => {
                const nBlocks = parser.getNumberOfBlocks(pieceIndex);
                return new Array(nBlocks).fill(false);
            });
        })();
        this.events = new events();

        // get file details
        let byteStart = 0;
        parser.torrent.info.files.forEach(file => {
            this.fileDetails.push({
                length: file.length,
                byteStart: byteStart,
                byteEnd: byteStart + file.length - 1
            });
            byteStart += file.length;
        });
    }

    async check() {
        // create path and project folder
        await fpromise.mkdir(this.path, {recursive: true});
        // open/create end files
        this.filehandles = await Promise.all(
            this.files.map(
                async file => fpromise.open( this.path + file.path.toString(), 'a+' )
            )
        );
        // check what blocks do we have
        await this.checkBlocks();
        this.close();
        return this.left;
    }

    async checkBlocks() {
        for (let offset = 0, pieceIndex = 0, blockIndex = 0, fileIndex = 0; offset < this.parser.details.sizeNumber; blockIndex++) {
            // manage indices
            if ( blockIndex + 1 > this.parser.getNumberOfBlocks(pieceIndex) ) {
                blockIndex = 0;
                pieceIndex++;
            }
            if ( offset > this.fileDetails[fileIndex].byteEnd)
                fileIndex++;
            // check block and compare against an empty buffer of 1/5 size
            const blockSize = this.parser.getBlockSize(pieceIndex, blockIndex);
            const buffer = Buffer.alloc(blockSize);
            const emptyComparison = Buffer.alloc(blockSize/3);
            // read from file(s)
            for (let remaining = blockSize, bufferOffset = 0, position = offset; remaining > 0;) {
                position += bufferOffset - this.fileDetails[fileIndex].byteStart;
                const filehandle = this.filehandles[fileIndex];
                const result = await filehandle.read(buffer, bufferOffset, remaining, position < 0 ? 0 : position);
                if (result.bytesRead == 0)
                    break ;
                remaining -= result.bytesRead;
                bufferOffset += result.bytesRead;
            }
            // compare
            if ( buffer.includes(emptyComparison) )
                this.left += blockSize;
            else
                this.written[pieceIndex][blockIndex] = true;
            // iterate
            offset += blockSize;
        }
        // copy written to requested and received
        this.blocks.requested = this.written.map( blocks => blocks.slice() );
        this.blocks.received = this.written.map( blocks => blocks.slice() );
    }

    async create() {
        // check every file
        const stats = await Promise.all(
            this.files.map( file => fpromise.stat( this.path + file.path.toString() ))
        );
        // create fds and copy non-zero files
        this.fds = await Promise.all(
            stats.map( (file, index) => {
                const path = this.path + this.files[index].path.toString();
                if (file.size > 0) {
                    return new Promise( resolve => {
                        fs.open(path + '(temp)', 'w+', (err, fd) => {
                            const readable = fs.createReadStream( path );
                            const writable = fs.createWriteStream('', {fd: fd, autoClose: false});
                            readable.pipe(writable);
                            readable.on('end', async () => {
                                await fpromise.unlink(path);
                                await fpromise.rename(path + '(temp)', path);
                                resolve(fd);
                            });
                        });
                    });
                } else {
                    return new Promise( resolve => {
                        fs.open(path, 'w+', (err, fd) => resolve(fd) );
                    });
                }
            })
        );
    }

    // writes a piece to a file
    write(piece) {
        if (this.downloaded)
            return ;
        const begin = piece.index * this.parser.details.pieceSize + piece.begin;
        // find block index
        const blockIndex = piece.begin / this.parser.BLOCK_SIZE;
        // find file index
        let findex = this.fileDetails.findIndex( file => file.byteEnd > begin );
        // boffset, foffset - buffer and file offset, blength - buffer length
        for (let length = piece.block.length, boffset = 0; length > 0; findex++) {
            const fd = this.fds[findex];
            const foffset = begin - this.fileDetails[findex].byteStart > 0 ? begin - this.fileDetails[findex].byteStart : 0;
            const blength = this.fileDetails[findex].length - foffset > length ? length : this.fileDetails[findex].length - foffset;
            length -= blength;
            fs.write(fd, piece.block, boffset, blength, foffset, () => {
                if (length > 0) return ;
                
                this.written[piece.index][blockIndex] = true;
                this.events.emit('piece-written', piece.index, blockIndex);
                if ( this.complete() ) {
                    this.downloaded = true;
                    this.events.emit('finish');
                }
            });
            boffset += blength;
        }
    }

    close() {
        this.filehandles.forEach( filehandle => filehandle.close() );
        this.filehandles = [];
        this.fds.forEach( fd => fs.close(fd, () => {}) );
        this.fds = [];
    }

    complete() {
        return this.written.every( blocks => blocks.every(block => block) );
    }
}