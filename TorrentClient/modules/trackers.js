const url = require('url');
const dgram = require('dgram');
const bencode = require('bencode');
const events = require('events');
const socks5 = require('socks5-http-client');
const proxy = require('../proxy');

module.exports = class {
    constructor(torrent, requests, peers, files) {
        this.requests = requests;
        this.events = new events();
        this.peers = peers;
        this.files = files;
        this.urls = [];

        this.urls.push( url.parse( torrent.announce.toString() ) );
        if ( torrent['announce-list'] )
            torrent['announce-list'].forEach( path => {
                const parsed = url.parse( path.toString() );
                if ( !parsed.href.includes('local') ) this.urls.push( parsed );
            });

        this.trackers = [];  
    }

    // connect to trackers
    connect() {
        this.urls.forEach( url => this.trackers.push( new Tracker(url, this.requests, this.peers, this.events, this.files) ) );
    }
    close() {
        this.trackers.forEach( tracker => {
            clearTimeout(tracker.timer);
            if (tracker.socket) tracker.socket.close();
        });
        this.trackers = [];
    }
}

class Tracker {
    constructor(url, requests, peers, events, files) {
        this.url = url;
        this.requests = requests;
        this.peers = peers;
        this.failed = false;
        // rerequest interval
        this.interval = 10000;
        this.events = events;
        this.files = files;

        if (url.protocol == 'udp:') {
            this.socket = dgram.createSocket('udp4')
                .on( 'error', () => {
                    this.failed = true;
                    this.events.emit('connect-fail');
                })
                .on( 'message', response => {
                    this.failed = false;
                    this.manageUdp(response);
                });
            this.sendUdp( this.requests.connectUdp() );
        }
        if (url.protocol == 'http:') {
            this.httpOptions = {
                // proxy
                socksHost: proxy.host,
                socksPort: proxy.port,
                socksUsername: proxy.username,
                socksPassword: proxy.password,
                hostname: url.host,
                path: url.path + '?' + this.requests.connectHttp(),
                headers: {
                    'Host': url.host,
                    'User-Agent': 'CustomTorrent',
                    'Accept-Encoding': 'gzip',
                    'Connection': 'Close'
                }
            };
            this.sendHttp(this.httpOptions);
        }
    }

    // send a udp request
    sendUdp(request) {
        this.socket.send(request, 0, request.length, this.url.port ? this.url.port : 80, this.url.hostname, err => {
            if (err) {
                this.failed = true;
                this.events.emit('connect-fail'); 
            } else {
                this.failed = false;
            }
        });
    }
    // manage response from a udp tracker server
    manageUdp(response) {
        const responseCode = response.readUInt32BE();
        // 0 - connection response, 1 - announce response
        if (responseCode == 0) {
            this.connectionId = response.slice(8);
            this.sendUdp( this.requests.announceUdp(this.connectionId) );
        } else if (responseCode == 1) {
            this.interval = response.readUInt32BE(8) > this.interval ? response.readUInt32BE(8) : this.interval;
            // each peer consist of 6 bytes: 4 bytes ip and 2 bytes port
            const peers = this.groupPeers( response.slice(20) )
                .map( address => {
                    return {
                        ip: address.slice(0, 4).join('.'),
                        port: address.readUInt16BE(4)
                    }
                });
            this.peers.add(peers);
            this.rerequest();
        }
    }
    // send http announce request
    sendHttp(options) {
        socks5.get(options, response => {
            if (response.statusCode == 200) {
                let data = Buffer.alloc(0);
                // read stream
                response.on( 'data', chunk => data = Buffer.concat([data, chunk]) );
                response.on( 'end', () => this.manageHttp( bencode.decode(data) ) );
                this.failed = false;
            } else {
                this.failed = true;
                this.events.emit('connect-fail');
            }
        }).on('error', () => {
            this.failed = true;
            this.events.emit('connect-fail');
        });
    }
    // manage http response
    manageHttp(data) {
        this.interval = data.interval > this.interval ? data.interval : this.interval;
        // each peer consist of 6 bytes: 4 bytes ip and 2 bytes port
        const peers = this.groupPeers(data.peers)
            .map( address => {
                return {
                    ip: address.slice(0, 4).join('.'),
                    port: address.readUInt16BE(4)
                }
            });
        this.peers.add(peers);
        this.rerequest();
    }
    // convert response buffer into an array
    groupPeers(response) {
        let peers = [];
        const peerLength = 6;
        for (let i = 0; i < response.length; i += peerLength)
            peers.push( response.slice(i, i + peerLength) );
        return peers;
    }
    // rerequest new peers
    rerequest() {
        this.timer = setTimeout( ()=> {
            if (this.url.protocol == 'udp:' && this.connectionId)
                this.sendUdp( this.requests.announceUdp(this.connectionId, this.files.left, this.files.downloaded) );

            if (this.url.protocol == 'http:')
                this.sendHttp(this.httpOptions);
        }, this.interval);
    }
}