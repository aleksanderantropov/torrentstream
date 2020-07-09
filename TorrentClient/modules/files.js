// This module exports methods to work with files that we download via torrent
// Check method checks if files that we download already exist
// and checks data inside of them to determine how much data we need to download
const fs = require('fs');
const fpromise = require('fs/promises');
const buffer = require('buffer').Buffer;
const events = require('events');
const { exit } = require('process');
const { resolve } = require('path');
const { SSL_OP_EPHEMERAL_RSA } = require('constants');

module.exports = class {
    constructor(filepath, blocks, parser) {
        this.path = filepath + '/' + parser.torrent.info.name + '/';
        this.blocks = blocks;
        this.parser = parser;
        this.files = parser.torrent.info.files;
        this.details = [];
        this.finished = false;
        this.left = 0;
        this.downloaded = 0;
        // represents blocks already written to files
        this.written = (() => {
            const nPieces = parser.torrent.info.pieces.length / 20;
            const array = new Array(nPieces).fill(null);
            return array.map( (value, pieceIndex) => {
                const nBlocks = parser.getNumberOfBlocks(pieceIndex);
                return new Array(nBlocks).fill(true);
            });
        })();
        this.events = new events();

        // get file details
        let byteStart = 0;
        parser.torrent.info.files.forEach(file => {
            this.details[file.path.toString()] = {
                fd: null,
                size: 0,
                length: file.length,
                byteStart: byteStart,
                byteEnd: byteStart + file.length - 1,
                pieceStart: Math.floor(byteStart / this.parser.details.pieceSize),
                blockStart: Math.floor(byteStart % this.parser.details.pieceSize / this.parser.BLOCK_SIZE),
                pieceEnd: Math.floor((byteStart + file.length - 1) / this.parser.details.pieceSize),
                blockEnd: Math.floor((byteStart + file.length - 1) % this.parser.details.pieceSize / this.parser.BLOCK_SIZE)
            };
            byteStart += file.length;
        });
    }

    async checkFile(filename) {
        // get file parameters
        let file = this.details[filename];
        if (!file)
        {
            console.log('TorrentClient: Couldn\'t open file: ', filename);
            process.exit(1);
        }
        // check if we have the file 
        file.size = await new Promise(resolve =>
            fs.stat(this.path + filename, (err, stat) => {
                if (!err) resolve(stat.size);
                resolve(0);
            })
        );

        // we have file
        if (file.size == file.length) return ('downloaded');

        // we don't have file: set appropriate blocks as false
        if (file.size == 0) {
            this.written = this.written.map( (blocks, piece) => {
                return (
                    piece < file.pieceStart || piece > file.pieceEnd ?
                    blocks :
                    blocks.map( (data, block) => !isFile(piece, block) )
                )
            });
        }
        // if we have part of the file: read from file to verify blocks
        else {
            // open file
            const filehandle = await fpromise.open(this.path + filename)
                .catch(() => {
                    console.log('TorrentClient: Couldn\'t open file: ', this.path + filename);
                    process.exit(1);
                });
            // read from file block by block and compare with empty block
            for (let p = file.pieceStart; p <= file.pieceEnd; p++) {
                let b = p == file.pieceStart ? file.blockStart : 0;
                while (b < this.written[p].length)
                {
                    const blockSize = this.parser.getBlockSize(p, b);
                    const result = await filehandle.read(Buffer.alloc(blockSize), 0, blockSize, null)
                        .catch(() => {
                            console.log('TorrentClient: Couldn\'t read from file: ', this.path + filename);
                            process.exit(1);
                        });
                    if (result.bytesRead != blockSize)
                        this.written[p][b] = false;
                    if (p == file.pieceEnd && b == file.blockEnd)
                        break ;
                    b++;
                }
            }
            await filehandle.close();
        }
        this.left = file.length - file.size;
        // copy to blocks
        this.blocks.received = this.written.map( blocks => blocks.slice() );
        this.blocks.requested = this.written.map( blocks => blocks.slice() );

        function isFile(piece, block) {
            if (piece >= file.pieceStart && piece <= file.pieceEnd) {
                if (file.pieceStart == file.pieceEnd) {
                    return (block >= file.blockStart && block <= file.blockEnd);
                } else {
                    if (piece == file.pieceStart) {
                        return (block >= file.blockStart);
                    } else if (piece == file.pieceEnd)
                        return (block <= file.blockEnd);
                    else
                        return (true);
                }
            } else
                return (false);
        }
    }

    async createFile(filename) {
        return new Promise(async resolve => {
            const file = this.details[filename];

            // create file
            if (file.size == 0) {
                fs.open(this.path + filename, 'w+', (err, fd) => {
                    if (err) {
                        console.log('TorrentClient: Couldn\'t open file: ',  this.path + filename);
                        process.exit(1);
                    }
                    file.fd = fd;
                    resolve();
                })
            }
            // copy file
            else {
                await fpromise.rename(this.path + filename, this.path + filename + '(temp)')
                    .catch(err => {
                        console.log('TorrentClient: Couldn\'t rename file: ',  this.path + filename);
                        console.log(err);
                        process.exit(1);
                    });
                fs.open(this.path + filename, 'w+', (err, fd) => {
                    if (err) {
                        console.log('TorrentClient: Couldn\'t open file: ',  this.path + filename);
                        process.exit(1);
                    }
                    const readable = fs.createReadStream( this.path + filename + '(temp)');
                    const writable = fs.createWriteStream('', {fd: fd, autoClose: false});
                    readable.pipe(writable);
                    readable.on('end', async () => {
                        await fpromise.unlink(this.path + filename + '(temp)')
                            .catch(err => {
                                console.log('TorrentClient: Couldn\'t delete file: ',  this.path + filename + '(temp)');
                                console.log(err);
                                process.exit(1);
                            });
                        file.fd = fd;
                        resolve();
                    });
                });
            }
        });
    }

    writeFile(filename, piece) {
        if (this.finished) return ;

        const file = this.details[filename];
        const byteStart = piece.index * this.parser.details.pieceSize + piece.begin;
        const offset = byteStart < file.byteStart ? file.byteStart - byteStart : 0;
        const position = byteStart - file.byteStart + offset;
        const length = piece.block.length + byteStart > file.byteEnd ? file.byteEnd - byteStart + 1 : piece.block.length;
        fs.write(file.fd, piece.block, offset, length - offset, position, err => {
            if (err) {
                console.log('TorrentClient: Couldn\'t write to file: ', this.path + filename);
                process.exit(1);
            }

            this.downloaded += length - offset;
            this.left -= length - offset;
            
            const blockIndex = piece.begin / this.parser.BLOCK_SIZE;
            this.written[piece.index][blockIndex] = true;

            this.events.emit('piece-written', piece.index, blockIndex);

            if ( this.complete() ) {
                this.finished = true;
                this.events.emit('finish');
            }
        });
    }

    close(filename) {
        fs.close( this.details[filename].fd, () => {} );
    }

    complete() {
        return this.written.every( blocks => blocks.every(block => block) );
    }
}