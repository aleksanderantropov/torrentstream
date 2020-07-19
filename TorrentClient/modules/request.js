const Buffer = require('buffer').Buffer;
const crypto = require('crypto');

module.exports = class {
    constructor(left, hashedInfo, requests) {
        this.left = left;
        this.port = 6881;
        this.hashedInfo = hashedInfo;
        this.peerId = crypto.randomBytes(20);
        this.requests = requests;
    }

    generateId() {
        this.peerId = crypto.randomBytes(20);
    }

    connectUdp() {
        const buffer = Buffer.alloc(16);
        // connection id
        // write and unsigned 32-bit integer in big-endian format
        buffer.writeUInt32BE(0x417, 0);
        buffer.writeUInt32BE(0x27101980, 4);
        // action
        buffer.writeUInt32BE(0, 8);
        // transaction id
        crypto.randomBytes(4).copy(buffer, 12);
        return buffer;
    }

    announceUdp(connectionId, left = this.left, downloaded = 0) {
        const buffer = Buffer.alloc(98);
        // connectionId
        connectionId.copy(buffer, 0);
        // action
        buffer.writeUInt32BE(1, 8);
        // transaction id
        crypto.randomBytes(4).copy(buffer, 12);
        // info hash
        this.hashedInfo.copy(buffer, 16);
        // peerId: unique client id
        this.peerId.copy(buffer, 36);
        // downloaded: total amount of downloaded since sent 'started' event = 0
        Buffer.from('' + downloaded).copy(buffer, 56);
        // left
        Buffer.from('' + left).copy(buffer, 64);
        // uploaded: total amount of uploaded since sent 'started' event = 0
        Buffer.alloc(8).copy(buffer, 72);
        // event: started
        buffer.writeUInt32BE(0, 80);
        // ip address of client machine (optional)
        buffer.writeUInt32BE(0, 84);
        //key: for tracker to identify us (optional)
        crypto.randomBytes(4).copy(buffer, 88);
        // num want: number of peers we want to receive (optional)
        buffer.writeInt32BE(100, 92);
        // port
        buffer.writeUInt16BE(this.port, 96);
        return buffer;
    }

    connectHttp() {
        let request = '';
        request += 'info_hash=' + this.urlEncode(this.hashedInfo);
        request += '&peer_id=' + this.urlEncode(this.peerId);
        request += '&port=' + this.port;
        request += '&uploaded=0';
        request += '&downloaded=0';
        request += '&left=' + this.left;
        request += '&event=started';
        request += '&compact=1';
        return request;
    }

    urlEncode(data) {
        let encoded = '';
        for (let i = 0; i < data.length; i++) {
            const item = data.toString('utf8', i, i + 1);
            const regex = /[A-Za-z0-9\.\-_~]/;
            const found = item.match(regex);
            if (found)
                encoded += item;
            else {
                const hex = data.toString('hex', i, i + 1);
                encoded += '%' + hex.toUpperCase();
            }
        }
        return encoded;
    };

    handshake() {
        const buffer = Buffer.alloc(68);
        // pstrlen 
        buffer.writeUInt8(19, 0);
        // pstr
        buffer.write('BitTorrent protocol', 1);
        // reserved
        buffer.writeUInt32BE(0, 20);
        buffer.writeUInt32BE(0, 24);
        // hashed info
        this.hashedInfo.copy(buffer, 28);
        // peer id
        this.peerId.copy(buffer, 48);
        return buffer;
    }

    interested() {
        const buffer = Buffer.alloc(5);
        // length
        buffer.writeUInt32BE(1, 0);
        // id
        buffer.writeUInt8(2, 4);
        return buffer;
    }

    piece(piece) {
        const buffer = Buffer.alloc(17);
        // length
        buffer.writeUInt32BE(13, 0);
        // id
        buffer.writeUInt8(6, 4);
        buffer.writeUInt32BE(piece.index, 5);
        buffer.writeUInt32BE(piece.begin, 9);
        buffer.writeUInt32BE(piece.length, 13);
        return buffer;
    }

    parse(message) {
        // all messages with id are > 4
        const id = message.length > 4 ? message.readInt8(4) : null;
        // all messages with payload are > 5
        let payload = message.length > 5 ? message.slice(5) : null;
        // 7 - incoming piece
        if (id == 7) {
            payload = {
                index: payload.readInt32BE(0),
                begin: payload.readInt32BE(4),
                block: payload.slice(8)
            }
        }
        return {
            id: id,
            size: message.readInt32BE(0),
            payload: payload
        }
    }
}