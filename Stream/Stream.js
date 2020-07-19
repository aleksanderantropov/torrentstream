const fs = require('fs');
const spawn = require('child_process').spawn;
const Events = require('events');
const { Stream } = require('stream');
const { Console } = require('console');

module.exports = class {
    constructor() {
        this.status = 'idle';
        this.ready = false;
        this.restart = true;
        this.downloaded = 0;

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
                subtitles: /.srt|.webvtt|.ass/,
                ffmpegoutput: /frame=\s*(?<frame>\S*)\s*fps=\s*(?<fps>\S*)\s*q=\s*(?<q>\S*)\s*size=\s*(?<size>\S*)\s*time=\s*(?<time>\S*)\s*bitrate=\s*(?<bitrate>\S*)\s*.*\s*speed=\s*(?<speed>\S*)/,
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
                if (torrent && torrent.downloads && torrent.files.path) {
                    this.torrent = torrent;
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

    finalizeManifest() {
        fs.readFile(this.path + this.settings.manifest, (err, data) => {
            if (!err) {
                data = data.toString();
                data += '#EXT-X-ENDLIST\n';
                fs.writeFile(this.path + this.settings.manifest, data, (err) => {});
            }
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
            this.process = spawn('ffmpeg', options);
            this.process.on('close', () => {
                this.subtitles = this.settings.subtitles;
                resolve();
            });
        });
    }

    async convertVideo() {
        const isFinalized = await new Promise(resolve => {
            fs.readFile(this.path + this.settings.manifest, (err, data) => {
                if (!err && data.toString().match(/#EXT-X-ENDLIST/)) resolve(true);
                else resolve(false);
            })
        });

        if (isFinalized)
            this.events.emit('manifest-created');
        else if (this.status == 'idle' && this.downloaded > 1000000) {
            console.log('Stream: Converting video');
            this.status = 'converting';
            const offset = await this.countOffset().catch(() => {});
            console.log('offset: ', offset);

            let options = [
                // '-re', // read at native frame-rate; slow-down the reading
                '-i', this.path + this.files.movie,
                '-ss', offset,
                '-r', 24, // framerate
                '-g', 48, // group pictures
                '-keyint_min', 24, // insert a key frame every 24 frames
                '-c:v', 'libx264',
                // '-preset', 'fast',
                '-b:v', '1000k',
                '-c:a', 'aac',
                '-b:a', '128k',
                '-f', 'hls',
                '-hls_time', 4,
                '-hls_playlist_type', 'event',
                '-hls_flags', 'append_list+omit_endlist',
                this.path + this.settings.manifest
            ];
            
            this.process = spawn('ffmpeg', options);
            this.process.stderr.on('data', () => this.checkManifest());
            this.process.stderr.setEncoding('utf8');
            this.process.stderr.on('data', data => {
                console.log(data);
            });
            this.process.on('close', (code, signal) => {
                console.log('Stream: End converting video');
                if (signal == 'SIGTERM') {
                    clearTimeout(this.videoTimer);
                } else if (this.restart) {
                    this.status = 'idle';
                    this.videoTimer = setTimeout(() => this.convertVideo(), 5000);
                } else {
                    this.status = 'finished';
                    this.finalizeManifest();
                }
            });
        } else if (this.restart)
            this.videoTimer = setTimeout(() => this.convertVideo(), 5000);
    }

    close() {
        if (this.process)  {
            console.log('KILL');
            this.status = 'cancelled';
            this.process.kill();
        }
    }

    countOffset() {
        return new Promise(resolve => {
            fs.exists(this.path + this.settings.manifest, exists => {
                if (!exists) return (resolve(0));

                const data = fs.readFileSync(this.path + this.settings.manifest).toString();
                const pattern = /#EXTINF:(?<duration>\d+\.\d+)/g;
                const result = [...data.matchAll(pattern)];
                let duration = 0;
                for (let i = 0; i < result.length; i++){
                    duration += parseFloat(result[i][1]);
                }
                resolve(duration);
            });
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