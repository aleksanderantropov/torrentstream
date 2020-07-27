// This module exports methods to work with files that we download via torrent
// Check method checks if files that we download already exist
// and checks data inside of them to determine how much data we need to download
const fs = require('fs');
const buffer = require('buffer').Buffer;
const events = require('events');

module.exports = class {
    constructor(filepath, blocks, parser) {
        this.path = filepath + '/' + parser.torrent.info.name + '/';
        this.blocks = blocks;
        this.parser = parser;
        this.files = parser.torrent.info.files;
        this.details = [];
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

        this.settings = {
            maxRetries: 5,
            retryTimeout: 1000
        }
    }

    checkFile(filename) {
        return new Promise( async (resolve, reject) => {
            // get file parameters
            let file = this.details[filename];
            if (!file) return reject('WRNGFL');
   
            // check if we have the file 
            file.size = await new Promise(resolve =>
                fs.stat(this.path + filename, (err, stat) => {
                    if (!err) resolve(stat.size);
                    resolve(0);
                })
            );

            // we have file
            if (file.size == file.length) return resolve('downloaded');

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
                await new Promise( (resolve, reject) => {
                    fs.open(this.path + filename, async (err, fd) => {
                        if (err) return reject('CNTPN');
                        // read from file block by block and compare with empty block
                        for (let p = file.pieceStart; p <= file.pieceEnd; p++) {
                            let b = p == file.pieceStart ? file.blockStart : 0;

                            while (b < this.written[p].length) {
                                const blockSize = this.parser.getBlockSize(p, b);

                                await new Promise( (resolve, reject) => {
                                    fs.read(fd, Buffer.alloc(blockSize), 0, blockSize, null, (err, bytesRead, buffer) => {
                                        if (err) return reject('CNTRD');
                                        if (bytesRead != blockSize) this.written[p][b] = false;
                                        resolve();
                                    });
                                }).catch( err => reject(err) );

                                if (p == file.pieceEnd && b == file.blockEnd) break ;

                                b++;
                            }
                        }
                        fs.close(fd, err => {
                            if (err) reject('CNTCLS');
                            else resolve();
                        })
                    });
                }).catch( err => reject(err) );
            }
            this.left = file.length - file.size;
            // copy to blocks
            this.blocks.initialize(this.written);
            
            resolve();

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
        });
    }

    async createFile(filename) {
        console.log('Creating file: ', filename);
        return new Promise(async (resolve, reject) => {
            const file = this.details[filename];

            // create file
            if (file.size == 0) {
                fs.open(this.path + filename, 'w+', (err, fd) => {
                    if (err) reject('CNTPN');
                    file.fd = fd;
                    resolve();
                })
            }
            // copy file
            else {
                fs.rename(this.path + filename, this.path + filename + '(temp)', err => {
                    if (err) return reject('CNTRNM');

                    fs.open(this.path + filename, 'w+', (err, fd) => {
                        if (err) return reject('CNTPN');

                        const readable = fs.createReadStream( this.path + filename + '(temp)' );
                        const writable = fs.createWriteStream('', {fd: fd, autoClose: false});

                        readable.pipe(writable);
                        readable.on('error', () => reject('CNTRD'));
                        readable.on('end', () => {
                            fs.unlink(this.path + filename + '(temp)', err => {
                                if (err) return reject('CNTDL');
                                file.fd = fd;
                                resolve();
                            });
                        });
                    });
                });
            }
        });
    }

    writeFile(filename, piece) {
        return new Promise( (resolve, reject) => {
            const file = this.details[filename];
            if (file.fd === null) return resolve();
            
            const byteStart = piece.index * this.parser.details.pieceSize + piece.begin;
            const offset = byteStart < file.byteStart ? file.byteStart - byteStart : 0;
            const position = byteStart - file.byteStart + offset;
            const length = piece.block.length + byteStart > file.byteEnd ? file.byteEnd - byteStart + 1 : piece.block.length;
            // console.log('Writing to file: ', filename, piece.index, piece.begin / this.parser.BLOCK_SIZE);
            fs.write(file.fd, piece.block, offset, length - offset, position, err => {
                if (err) return reject('CNTWRT');

                this.downloaded += length - offset;
                this.left -= length - offset;
                
                const blockIndex = piece.begin / this.parser.BLOCK_SIZE;
                this.written[piece.index][blockIndex] = true;

                this.events.emit('piece-written', piece.index, blockIndex);

                if ( this.isComplete() ) this.events.emit('finish');

                resolve();
            });
        });
    }

    close() {
        for (let file in this.details) {
            if (this.details[file].fd === null) continue ;
            fs.close( this.details[file].fd, err => {
                this.details[file].fd = null;
            });    
        }
    }

    isComplete() {
        return this.written.every( blocks => blocks.every(block => block) );
    }
}