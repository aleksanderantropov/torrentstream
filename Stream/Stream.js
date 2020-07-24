const fs = require('fs');
const spawn = require('child_process').spawn;
const Events = require('events');
const { Stream } = require('stream');
const { Console } = require('console');
const { disconnect } = require('process');

module.exports = class {
    constructor(path, downloads) {
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
            },
            ffmpeg: {
                downloadThreshold: 3000000,
                hls_time: 4,
                entriesThreshold: 10,
                discontinuityThreshold: 3,
                patterns: {
                    duration: /#EXTINF:(?<duration>\d+\.\d+)/g,
                    discontinuity: /#EXT-X-DISCONTINUITY/g
                }
            }
        }

        this.path = null;
        this.files = null;
        this.playlist = null;

        // converted subtitles
        this.subtitles = null;
        
    }

    initialize(path, downloads) {
        return new Promise( (resolve, reject) => {
            this.path = path;
            this.downloads = downloads;
            this.status = 'idle';
            this.ready = false;
            this.restart = true;
            this.downloaded = 0;
            this.slowConversion = false;

            const movies = this.downloads.filter(file => file.match(this.settings.patterns.movies))
            if (!movies.length) return reject('NKNWNFRMT');
    
            this.files = {
                movie: movies.length ? movies[0] : null,
                subtitles: this.downloads.filter(file => file.match(this.settings.patterns.subtitles))
            }
            
            fs.readFile(this.path + this.settings.manifest, (err, data) => {
                this.converted = !err && data.toString().match(/#EXT-X-ENDLIST/) !== null;
                resolve();
            });
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
        return new Promise( (resolve, reject) => {
            const data =
            "#EXTM3U\n" +
            "#EXT-X-VERSION:3\n" +
            '#EXT-X-STREAM-INF:BANDWIDTH=' + this.settings.bandwidth["1000k"] +
            ',CODECS="' + this.settings.codecs["h.264 High"] + ',' + this.settings.codecs["aac"] + '"\n' +
            this.settings.manifest + "\n\n";

            fs.exists(this.path + this.settings.playlist, exists => {
                this.playlist = this.settings.playlist;
                if (exists) resolve();
                else
                    fs.writeFile(this.path + this.settings.playlist, data, (err) => {
                        if (err) return reject('CNTCRT');
                        resolve();
                    });
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
        if (this.converted) this.events.emit('manifest-created');
        else if (this.status == 'idle' && this.downloaded > this.settings.ffmpeg.downloadThreshold) {
            console.log('Stream: Converting video');
            this.status = 'converting';

            let offset, entries, discontinuity;
            [offset, entries, discontinuity] = await this.parseManifest().catch(() => {});
            console.log('offset: ' + offset);
            // If there are a lot of underconverted pices (usually because of slow download rate), enable 're' mode that slows down conversion
            if (this.slowConversion == false && entries <= this.settings.ffmpeg.entriesThreshold && discontinuity >= this.settings.ffmpeg.discontinuityThreshold)
                this.slowConversion = true;

            let options = [
                '-i', this.path + this.files.movie,
                '-ss', offset,
                '-r', 24, // framerate
                '-g', 48, // group pictures
                '-keyint_min', 24, // insert a key frame every 24 frames
                '-c:v', 'libx264',
                '-b:v', '1000k',
                '-c:a', 'aac',
                '-b:a', '128k',
                '-movflags', 'frag_keyframe+empty_moov',
                '-f', 'hls',
                '-hls_time', this.settings.ffmpeg.hls_time,
                '-hls_init_time', this.settings.ffmpeg.hls_time,
                '-hls_playlist_type', 'event',
                '-hls_flags', 'append_list+omit_endlist',
                this.path + this.settings.manifest
            ];

            if (this.slowConversion) options.unshift('-re');
            
            this.process = spawn('ffmpeg', options);
            this.process.stderr.on('data', () => this.checkManifest() );

            this.process.stderr.setEncoding('utf8'); // debug
            // this.process.stderr.on('data', data => console.log(data) ); // debug

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
            this.status = 'cancelled';
            this.process.kill();
        }
    }

    parseManifest() {
        return new Promise(resolve => {
            fs.exists(this.path + this.settings.manifest, exists => {
                if (!exists) return resolve( [0, 0, 0] );

                const data = fs.readFileSync(this.path + this.settings.manifest).toString();
                const discontinuityMatch = [ ...data.matchAll( this.settings.ffmpeg.patterns.discontinuity ) ];
                const durationMatch = [ ...data.matchAll( this.settings.ffmpeg.patterns.duration ) ];

                let duration = 0;
                for (var i = 0; i < durationMatch.length; i++){
                    duration += parseFloat(durationMatch[i][1]);
                }

                resolve( [duration, i, discontinuityMatch.length] );
            });
        });
    }

    checkManifest() {
        if (this.ready === false) {
            fs.exists(this.path + this.settings.manifest, exists => {
                if (exists) {
                    this.ready = true;
                    this.events.emit('manifest-created');
                }
            });
        }
    }
}