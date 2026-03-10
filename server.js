const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffprobePath = require('@ffprobe-installer/ffprobe').path;

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const path = require('path');
const fs = require('fs');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');
const ytdl = require('ytdl-core');

function extractBalancedJson(text, anchor) {
    const anchorIndex = text.indexOf(anchor);
    if (anchorIndex === -1) return null;
    const startBrace = text.indexOf('{', anchorIndex);
    if (startBrace === -1) return null;

    let i = startBrace;
    let depth = 0;
    let inString = false;
    let escape = false;

    for (; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escape) {
                escape = false;
                continue;
            }
            if (ch === '\\') {
                escape = true;
                continue;
            }
            if (ch === '"') inString = false;
            continue;
        }

        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === '{') depth++;
        if (ch === '}') depth--;
        if (depth === 0) {
            const jsonStr = text.slice(startBrace, i + 1);
            return JSON.parse(jsonStr);
        }
    }

    return null;
}

function collectVideoRenderers(node, out) {
    if (!node) return;
    if (Array.isArray(node)) {
        for (const item of node) collectVideoRenderers(item, out);
        return;
    }
    if (typeof node !== 'object') return;

    if (node.videoRenderer && node.videoRenderer.videoId) {
        out.push(node.videoRenderer);
        return;
    }

    for (const value of Object.values(node)) {
        collectVideoRenderers(value, out);
    }
}

const app = express();
const BIND_HOST = '0.0.0.0';
const PUBLIC_HOST = process.env.PUBLIC_HOST || process.env.SERVER_IP || process.env.HOST || 'localhost';
const PORT = Number(process.env.PORT || process.env.SERVER_PORT) || 6566;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PROCESSED_DIR = path.join(__dirname, 'processed');

// Middleware
app.use(cors());
app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.json());

// Ensure directories exist
for (const dir of [UPLOADS_DIR, PROCESSED_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Configure Multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});

const upload = multer({ storage: storage });

// Routes

// YouTube Search
app.get('/search-yt', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Query required' });

    try {
        if (ytdl.validateURL(query)) {
            const info = await ytdl.getInfo(query);
            const details = info.videoDetails;
            const thumbnails = Array.isArray(details.thumbnails) ? details.thumbnails : [];
            const bestThumb = thumbnails.length ? thumbnails[thumbnails.length - 1].url : '';
            return res.json([{
                title: details.title,
                timestamp: details.lengthSeconds ? `${Math.floor(Number(details.lengthSeconds) / 60)}:${String(Number(details.lengthSeconds) % 60).padStart(2, '0')}` : 'N/A',
                author: details.author?.name || details.ownerChannelName || 'Unknown',
                videoId: details.videoId,
                url: `https://www.youtube.com/watch?v=${details.videoId}`,
                thumbnail: bestThumb,
                seconds: Number(details.lengthSeconds) || 0
            }]);
        }

        const { data: html } = await axios.get('https://www.youtube.com/results', {
            params: { search_query: query },
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            timeout: 15000
        });

        const initialData =
            extractBalancedJson(html, 'var ytInitialData =') ||
            extractBalancedJson(html, 'ytInitialData =');

        if (!initialData) {
            return res.json([]);
        }

        const renderers = [];
        collectVideoRenderers(initialData, renderers);

        const videos = [];
        for (const r of renderers) {
            if (videos.length >= 10) break;
            const videoId = r.videoId;
            if (!videoId) continue;

            const title =
                r.title?.runs?.map(x => x.text).join('') ||
                r.title?.simpleText ||
                'Unknown';

            const author =
                r.ownerText?.runs?.map(x => x.text).join('') ||
                r.longBylineText?.runs?.map(x => x.text).join('') ||
                'Unknown';

            const timestamp = r.lengthText?.simpleText || 'N/A';
            const thumbs = Array.isArray(r.thumbnail?.thumbnails) ? r.thumbnail.thumbnails : [];
            const thumbnail = thumbs.length ? thumbs[thumbs.length - 1].url : '';

            videos.push({
                title,
                timestamp,
                author,
                videoId,
                url: `https://www.youtube.com/watch?v=${videoId}`,
                thumbnail,
                seconds: 0
            });
        }

        res.json(videos);
    } catch (err) {
        console.error('Search Error:', err);
        res.status(500).json({ error: 'Search failed' });
    }
});

// YouTube Download
app.post('/download-yt', async (req, res) => {
    const { url } = req.body;
    if (!url || !ytdl.validateURL(url)) {
        return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    try {
        const info = await ytdl.getInfo(url);
        const rawTitle = info.videoDetails?.title || 'youtube_audio';
        const safeTitle = rawTitle.replace(/[^\w\s-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'youtube_audio';
        const timestamp = Date.now();
        const baseFilename = `yt_${timestamp}_${safeTitle}`;
        const outputPath = path.join(UPLOADS_DIR, `${baseFilename}.mp3`);

        const stream = ytdl(url, {
            filter: 'audioonly',
            quality: 'highestaudio',
            highWaterMark: 1 << 25
        });

        await new Promise((resolve, reject) => {
            ffmpeg(stream)
                .audioCodec('libmp3lame')
                .format('mp3')
                .on('end', resolve)
                .on('error', reject)
                .save(outputPath);
        });

        res.json({ 
            filename: baseFilename + '.mp3',
            originalName: rawTitle
        });

    } catch (err) {
        console.error('YouTube Download Error:', err);
        res.status(500).json({ error: 'Processing failed: ' + err.message });
    }
});

// Upload File
app.post('/upload', upload.single('audio'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    res.json({ filename: req.file.filename, originalName: req.file.originalname });
});

// Process Audio
app.post('/process', (req, res) => {
    const { filename, speed, pitch, bypass, bypassLevel } = req.body;
    
    if (!filename) {
        return res.status(400).json({ error: 'Filename required' });
    }

    const inputPath = path.join(UPLOADS_DIR, filename);
    const outputFilename = `processed_${Date.now()}.ogg`; // Roblox prefers OGG
    const outputPath = path.join(PROCESSED_DIR, outputFilename);

    let command = ffmpeg(inputPath);

    // Audio Filters
    let audioFilters = [];

    // Base values
    let speedVal = parseFloat(speed) || 1.0;
    let pitchVal = parseFloat(pitch) || 0; // Semitones

    if (bypass) {
        // Advanced Bypass Logic based on Level
        // Randomized to avoid hash matching
        const rand = (min, max) => Math.random() * (max - min) + min;

        if (bypassLevel === 'heavy') {
            // AGGRESSIVE: High pitch/speed change + Echo + EQ + Volume variation
            speedVal = rand(1.15, 1.25);
            pitchVal = rand(2.0, 3.5);
            
            // 1. Echo/Reverb (Short delay)
            audioFilters.push('aecho=0.8:0.6:20:0.3');
            // 2. EQ: Cut Mids, Boost Bass/Treble
            audioFilters.push('equalizer=f=1000:width_type=h:width=200:g=-5');
            audioFilters.push('bass=g=3');
            // 3. Vibrato (Very subtle)
            audioFilters.push('vibrato=f=5:d=0.1');

        } else if (bypassLevel === 'light') {
            // LIGHT: Minimal change
            speedVal = rand(1.02, 1.05);
            pitchVal = rand(0.5, 1.0);
            // Slight EQ
            audioFilters.push('equalizer=f=1000:width_type=h:width=200:g=-1');

        } else {
            // MEDIUM (Default): Good balance
            speedVal = rand(1.08, 1.15);
            pitchVal = rand(1.0, 2.0);
            
            audioFilters.push('equalizer=f=1000:width_type=h:width=200:g=-3');
            audioFilters.push('aecho=0.8:0.88:10:0.2');
        }
    }

    // FFmpeg logic for independent speed and pitch
    // asetrate changes both pitch and speed.
    // atempo changes speed without changing pitch.
    
    // 1. Calculate frequency change for pitch shift
    // Standard sample rate is usually 44100 or 48000. 
    // We'll assume 44100 for calculation but fluent-ffmpeg handles the stream.
    // Ideally we probe the file first, but for simplicity let's use a standard multiplier.
    
    // asetrate = sample_rate * r
    // r = 2^(n/12) where n is semitones.
    const pitchMultiplier = Math.pow(2, pitchVal / 12);
    
    // If we use asetrate, the speed also changes by pitchMultiplier.
    // To get the final 'speedVal', we need to adjust atempo.
    // Current Speed = pitchMultiplier.
    // Desired Speed = speedVal.
    // Correction = speedVal / pitchMultiplier.
    
    let atempoVal = speedVal / pitchMultiplier;

    // Constrain atempo (FFmpeg limit is 0.5 to 2.0 per filter, can chain them)
    // We chain multiple atempo filters if needed.
    
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Error probing file' });
        }

        const sampleRate = metadata.streams.find(s => s.codec_type === 'audio')?.sample_rate || 44100;
        const newSampleRate = Math.round(sampleRate * pitchMultiplier);

        // Add filters
        // 1. Change pitch (and speed)
        command.audioFilters(`asetrate=${newSampleRate}`);

        // 2. Correct speed
        // Split atempoVal into chunks between 0.5 and 2.0
        while (atempoVal > 2.0) {
            command.audioFilters('atempo=2.0');
            atempoVal /= 2.0;
        }
        while (atempoVal < 0.5) {
            command.audioFilters('atempo=0.5');
            atempoVal /= 0.5;
        }
        command.audioFilters(`atempo=${atempoVal}`);

        command
            .format('ogg')
            .on('end', () => {
                res.json({ 
                    url: `/download/${outputFilename}`,
                    filename: outputFilename
                });
            })
            .on('error', (err) => {
                console.error('Error processing:', err);
                res.status(500).json({ error: 'Error processing audio' });
            })
            .save(outputPath);
    });
});

// Download
app.get('/download/:filename', (req, res) => {
    const filePath = path.join(PROCESSED_DIR, req.params.filename);
    if (fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

// Roblox Upload Route
app.post('/upload-roblox', async (req, res) => {
    const { filename, apiKey, userId, groupId, name, description } = req.body;

    if (!filename || !apiKey) {
        return res.status(400).json({ error: 'Missing required fields (Filename, API Key)' });
    }

    if (!userId && !groupId) {
        return res.status(400).json({ error: 'Must provide User ID or Group ID' });
    }

    const filePath = path.join(PROCESSED_DIR, filename);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Audio file not found' });
    }

    try {
        const form = new FormData();
        
        let creatorConfig = {};
        if (groupId) {
            creatorConfig = {
                creator: {
                    groupId: String(groupId)
                }
            };
        } else {
            creatorConfig = {
                creator: {
                    userId: String(userId)
                }
            };
        }

        const requestPayload = {
            assetType: 'Audio',
            displayName: name || `Audio_${Date.now()}`,
            description: description || 'Uploaded via NRHD Audio Bypass',
            creationContext: creatorConfig
        };

        form.append('request', JSON.stringify(requestPayload));
        form.append('fileContent', fs.createReadStream(filePath));

        // 1. Initiate Upload
        const response = await axios.post('https://apis.roblox.com/assets/v1/assets', form, {
            headers: {
                ...form.getHeaders(),
                'x-api-key': apiKey
            }
        });

        const operationId = response.data.path; // e.g., operations/123...
        
        if (!operationId) {
            return res.status(500).json({ error: 'Failed to get operation ID from Roblox' });
        }

        // 2. Poll for Completion
        let result = null;
        let attempts = 0;
        const maxAttempts = 10; // Poll for 20 seconds max

        while (!result && attempts < maxAttempts) {
            attempts++;
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s

            const opResponse = await axios.get(`https://apis.roblox.com/assets/v1/${operationId}`, {
                headers: { 'x-api-key': apiKey }
            });

            if (opResponse.data.done) {
                result = opResponse.data;
            }
        }

        if (!result) {
            return res.status(202).json({ 
                status: 'pending', 
                message: 'Upload started but processing is taking time.',
                operationId: operationId 
            });
        }

        if (result.error) {
            return res.status(400).json({ error: 'Roblox API Error', details: result.error });
        }

        // 3. Success - Get Asset ID
        // Response format: { response: { assetId: '...' } }
        const assetId = result.response?.assetId;
        
        // Check Moderation Status (Optional, requires GET asset)
        // Usually, immediately after upload, it might be 'Reviewing'.
        
        res.json({
            status: 'success',
            assetId: assetId,
            message: 'Upload successful! Asset ID: ' + assetId
        });

    } catch (err) {
        console.error('Roblox Upload Error:', err.response?.data || err.message);
        res.status(500).json({ 
            error: 'Upload Failed', 
            details: err.response?.data?.message || err.message 
        });
    }
});

app.listen(PORT, BIND_HOST, () => {
    console.log(`Server running at http://${PUBLIC_HOST}:${PORT}`);
});
