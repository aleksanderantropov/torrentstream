const fs = require('fs');
const spawn = require('child_process').spawn;
const Events = require('events');

module.exports = class {
    constructor() {
        this.status = 'idle';
        this.ready = false;

        this.events = new Events();

        this.settings = {
            bandwidth: {
                "1000k": 1240800
            },
            codecs: {
                "h.264 High": "avc1.64001f",
                aac: "mp4a.40.2"
            },
            subtitles: "subtitles.vtt",
            manifest: "hls.m3u8",
            playlist: "playlist.m3u8",
            patterns: {
                movies: /.avi|.mp4|.mkv|.webm|.vob|.ogg|.ogv|.flv|.amv|.mov/,
                subtitles: /.srt|.webvtt|.ass/
            }
        }

        this.path = null;
        this.files = null;

        // converted subtitles
        this.subtitles = null;
        this.playlist = null;
    }

    initialize(torrent) {
        return new Promise(resolve => {
            const interval = setInterval(() => {
                if (torrent.downloads && torrent.files.path) {
                    clearInterval(interval);
                    this.path = torrent.files.path;

                    const movies = torrent.downloads.filter(file => file.match(this.settings.patterns.movies))
                    this.errors = movies.length ? [] : ['Video format is not supported.'];
            
                    this.files = {
                        movie: movies.length ? movies[0] : null,
                        subtitles: torrent.downloads.filter(file => file.match(this.settings.patterns.subtitles))
                    }
                    resolve();
                }
            }, 1000);
        });
    }

    createPlaylist() {
        const data =
            "#EXTM3U\n" +
            "#EXT-X-VERSION:3\n" +
            '#EXT-X-STREAM-INF:BANDWIDTH=' + this.settings.bandwidth["1000k"] +
            ',CODECS="' + this.settings.codecs["h.264 High"] + ',' + this.settings.codecs["aac"] + '"\n' +
            this.settings.manifest + "\n\n";

        fs.exists(this.path + this.settings.playlist, exists => {
            if (exists) return (this.playlist = this.settings.playlist);

            fs.writeFile(this.path + this.settings.playlist, data, (err) => {
                if (err) console.log('Stream: Couldn\'t create playlist: ', this.path + this.settings.playlist);
                this.playlist = this.settings.playlist;
            });
        });
    }

    // at the moment handles only 1 subtitle file
    convertSubtitles() {
        return new Promise(resolve => {
            if (!this.files.subtitles.length) resolve();

            const temp = this.files.subtitles[0];
            let options = [
                '-y',
                '-i', this.path + temp,
                this.path + this.settings.subtitles
            ];
            const process = spawn('ffmpeg', options);
            process.on('close', () => {
                this.subtitles = this.settings.subtitles;
                resolve();
            });
        });
    }

    async convertVideo() {
        if (this.status == 'converting') return ;
        
        console.log('Stream: Converting video');
        this.status = 'converting';
        let options = [
            '-i', this.path + this.files.movie,
            '-ss', await this.countOffset().catch(() => {}),
            '-c:v', 'libx264',
            '-b:v', '1000k',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-f', 'hls',
            '-hls_time', 4,
            '-hls_playlist_type', 'event',
            '-hls_flags', 'append_list+omit_endlist',
            this.path + this.settings.manifest
        ];
        const process = spawn('ffmpeg', options);
        process.stdout.on('data', (data) => {
            // console.log(data);
            this.checkManifest();
        });
        process.stderr.setEncoding('utf8');
        process.stderr.on('data', (data) => {
            // console.log(data);
            this.checkManifest();
        });
        process.on('close', () => {
            this.status = 'idle';
            console.log('Stream: End converting video');
        });
    }

    countOffset() {
        return new Promise(resolve => {
            fs.open(this.path + this.settings.manifest, 'r', (err, fd) => {
                if (err) resolve(0);
                else {
                    fs.readFile(fd, (err, data) => {
                        if (err) {
                            console.log('Stream: Couldn\'t read file: ', this.path + this.settings.manifest);
                            process.exit(1);
                        }
                        data = data.toString();
                        const pattern = /#EXTINF:(?<duration>\d+\.\d+)/g;
                        const result = [...data.matchAll(pattern)];
                        let duration = 0;
                        for (let i = 0; i < result.length; i++){
                            duration += parseFloat(result[i][1]);
                        }
                        resolve(duration);
                    });
                }
            })            
        });
    }

    checkManifest() {
        if (this.ready === false) {
            this.ready = true;
            fs.exists(this.path + this.settings.manifest, exists => {
                if (exists)
                    this.events.emit('manifest-created');
                else
                    this.ready = false;
            });
        }
    }
}