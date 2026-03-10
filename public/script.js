document.addEventListener('DOMContentLoaded', () => {
    // Initialize Tone.js
    let player;
    let pitchShift;
    let isLoaded = false;

    // Initialize Wavesurfer (Visual Only initially, but we sync it)
    const wavesurfer = WaveSurfer.create({
        container: '#waveform',
        waveColor: '#4F4A85',
        progressColor: '#383351',
        cursorColor: '#00f0ff',
        barWidth: 2,
        barRadius: 3,
        cursorWidth: 1,
        height: 100,
        barGap: 3,
        interact: true, // Allow seeking
        backend: 'MediaElement' // Use MediaElement to easier sync with Tone? No, Tone needs its own buffer usually for best pitch shift
    });

    let currentFilename = null;
    let currentFileUrl = null;

    // Elements
    const fileInput = document.getElementById('audio-upload');
    const fileNameDisplay = document.getElementById('file-name');
    const btnPlay = document.getElementById('btn-play');
    const btnStop = document.getElementById('btn-stop');
    const btnProcess = document.getElementById('btn-process');
    const downloadLink = document.getElementById('download-link');
    
    const speedSlider = document.getElementById('speed-slider');
    const pitchSlider = document.getElementById('pitch-slider');
    const bypassCheck = document.getElementById('bypass-check');
    const bypassOptions = document.getElementById('bypass-options');
    const bypassLevel = document.getElementById('bypass-level');
    
    const speedValDisplay = document.getElementById('speed-val');
    const pitchValDisplay = document.getElementById('pitch-val');

    // YouTube Downloader
    const ytSearchQuery = document.getElementById('yt-search-query');
    const btnYtSearch = document.getElementById('btn-yt-search');
    const ytResults = document.getElementById('yt-results');

    if (btnYtSearch) {
        btnYtSearch.addEventListener('click', async () => {
            const query = ytSearchQuery.value;
            if (!query) return;

            ytResults.innerHTML = '<div style="color:white; padding:10px;">Searching...</div>';

            try {
                const response = await fetch(`/search-yt?q=${encodeURIComponent(query)}`);
                const videos = await response.json();
                
                ytResults.innerHTML = '';
                
                if (videos.error) {
                    ytResults.innerHTML = `<div style="color:red; padding:10px;">Error: ${videos.error}</div>`;
                    return;
                }

                videos.forEach(video => {
                    const card = document.createElement('div');
                    card.className = 'yt-card';
                    card.innerHTML = `
                        <img src="${video.thumbnail}" class="yt-thumb">
                        <div class="yt-info">
                            <div class="yt-title">${video.title}</div>
                            <div class="yt-meta">${video.author} • ${video.timestamp}</div>
                            <button class="yt-download-btn" onclick="downloadYt('${video.url}')">⬇ Load Audio</button>
                        </div>
                    `;
                    ytResults.appendChild(card);
                });

            } catch (err) {
                console.error(err);
                ytResults.innerHTML = '<div style="color:red; padding:10px;">Search Failed</div>';
            }
        });
    }

    // Global function for onclick
    window.downloadYt = async (url) => {
        const btn = event.target;
        const originalText = btn.textContent;
        btn.textContent = "Loading...";
        btn.disabled = true;

        try {
            const response = await fetch('/download-yt', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: url })
            });
            const data = await response.json();

            if (data.filename) {
                // Simulate upload success
                currentFilename = data.filename;
                currentFileUrl = `/uploads/${data.filename}`; 
                
                fileNameDisplay.textContent = "YouTube: " + data.originalName;
                
                // Initialize Tone Context
                await Tone.start();
                
                // Load into wavesurfer
                wavesurfer.load(currentFileUrl);
                
                // Enable controls
                btnProcess.disabled = false;
                
                // Reset sliders
                speedSlider.value = 1.0;
                pitchSlider.value = 0;
                bypassCheck.checked = false;
                bypassOptions.classList.add('hidden');
                updateDisplays();

                // Scroll to player
                document.querySelector('.player-card').scrollIntoView({ behavior: 'smooth' });
                Swal.fire('Success', 'Audio loaded from YouTube!', 'success');
            } else {
                Swal.fire('Error', "Download failed: " + (data.error || "Unknown error"), 'error');
            }
        } catch (err) {
            console.error(err);
            Swal.fire('Error', "Download failed", 'error');
        } finally {
            btn.textContent = originalText;
            btn.disabled = false;
        }
    };

    // Setup Tone.js Player Chain
    // (We removed this block in previous edit, but we need to re-add the Upload Listener!)
    
    // Upload Handling - RE-ADDED
    fileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        fileNameDisplay.textContent = file.name;

        const formData = new FormData();
        formData.append('audio', file);

        try {
            fileNameDisplay.textContent = "Uploading...";
            const response = await fetch('/upload', {
                method: 'POST',
                body: formData
            });
            const data = await response.json();
            
            if (data.filename) {
                currentFilename = data.filename;
                currentFileUrl = `/uploads/${data.filename}`;
                fileNameDisplay.textContent = data.originalName;
                
                // Initialize Tone Context (user gesture required usually, but this is async)
                // We'll init on Play instead to be safe, or here if allowed.
                
                // Load into wavesurfer
                wavesurfer.load(currentFileUrl);
                
                // Enable controls
                btnProcess.disabled = false;
                
                // Reset sliders
                speedSlider.value = 1.0;
                pitchSlider.value = 0;
                bypassCheck.checked = false;
                bypassOptions.classList.add('hidden');
                updateDisplays();
            }
        } catch (err) {
            console.error(err);
            fileNameDisplay.textContent = "Upload Failed";
        }
    });

    // Hook into Wavesurfer once ready
    wavesurfer.on('ready', () => {
        // Get the media element from wavesurfer
        const media = wavesurfer.getMediaElement();
        
        if (media) {
            // Create Tone Source from MediaElement
            // Check if we already have a node for this element to avoid errors
            if (!media._toneSource) {
                const source = Tone.context.createMediaElementSource(media);
                media._toneSource = source; // Tag it
                
                pitchShift = new Tone.PitchShift({
                    pitch: 0
                }).toDestination();
                
                // Connect
                Tone.connect(source, pitchShift);
            }
        }
    });

    // Player Controls
    btnPlay.addEventListener('click', async () => {
        await Tone.start();
        wavesurfer.playPause();
    });
    
    btnStop.addEventListener('click', () => wavesurfer.stop());

    wavesurfer.on('play', () => btnPlay.textContent = '⏸');
    wavesurfer.on('pause', () => btnPlay.textContent = '▶');
    wavesurfer.on('finish', () => btnPlay.textContent = '▶');

    // Real-time Update Functions
    function updateAudioParams() {
        const speed = parseFloat(speedSlider.value);
        const pitch = parseFloat(pitchSlider.value);
        
        // Update Speed (Playback Rate)
        wavesurfer.setPlaybackRate(speed);
        
        // Update Pitch
        if (pitchShift) {
            pitchShift.pitch = pitch;
        }
    }

    // Sliders UI Events
    speedSlider.addEventListener('input', (e) => {
        updateDisplays();
        updateAudioParams();
        // If manual change, uncheck bypass
        if (bypassCheck.checked) {
             // Optional: bypassCheck.checked = false;
             // bypassOptions.classList.add('hidden');
        }
    });

    pitchSlider.addEventListener('input', (e) => {
        updateDisplays();
        updateAudioParams();
    });
    
    bypassCheck.addEventListener('change', () => {
        if (bypassCheck.checked) {
            bypassOptions.classList.remove('hidden');
            // Trigger update based on selected level
            bypassLevel.dispatchEvent(new Event('change'));
        } else {
            bypassOptions.classList.add('hidden');
        }
    });

    bypassLevel.addEventListener('change', () => {
        if (!bypassCheck.checked) return;
        
        const level = bypassLevel.value;
        // Visual preview values only
        if (level === 'light') {
            speedSlider.value = 1.05;
            pitchSlider.value = 0.5;
        } else if (level === 'medium') {
            speedSlider.value = 1.1;
            pitchSlider.value = 1;
        } else if (level === 'heavy') {
            speedSlider.value = 1.15;
            pitchSlider.value = 2;
        }
        updateDisplays();
        updateAudioParams();
    });

    function updateDisplays() {
        speedValDisplay.textContent = speedSlider.value + 'x';
        const val = pitchSlider.value;
        pitchValDisplay.textContent = (val > 0 ? '+' : '') + val + ' st';
    }

    // Process Audio (Backend)
    btnProcess.addEventListener('click', async () => {
        if (!currentFilename) return;

        btnProcess.textContent = "PROCESSING...";
        btnProcess.disabled = true;

        const payload = {
            filename: currentFilename,
            speed: speedSlider.value,
            pitch: pitchSlider.value,
            bypass: bypassCheck.checked,
            bypassLevel: bypassLevel.value
        };

        try {
            const response = await fetch('/process', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await response.json();

            if (data.url) {
                // We DO NOT load the processed audio into the player,
                // because we want the user to keep tweaking the original if they want.
                // We just provide the download link.
                // OR we can ask user? Usually better to just give download.
                
                // Update Download Link
                downloadLink.href = data.url;
                downloadLink.classList.remove('disabled');
                downloadLink.textContent = `DOWNLOAD PROCESSED (${data.filename})`; 
                
                // Visual feedback
                btnProcess.textContent = "DONE! CLICK DOWNLOAD BELOW";
                
                // Enable Roblox Upload Button
                document.getElementById('btn-upload-roblox').classList.remove('disabled');
                
                setTimeout(() => {
                    btnProcess.textContent = "APPLY & PROCESS (SAVE)";
                    btnProcess.disabled = false;
                }, 2000);
            }
        } catch (err) {
            console.error(err);
            btnProcess.textContent = "ERROR";
        }
    });
    
    // Roblox Upload Handling
    const btnUploadRoblox = document.getElementById('btn-upload-roblox');
    const uploadStatus = document.getElementById('upload-status');
    const statusText = document.getElementById('status-text');
    const statusIndicator = document.querySelector('.status-indicator');
    
    // Upload Type Toggle
    const uploadType = document.getElementById('upload-type');
    const userIdGroup = document.getElementById('user-id-group');
    const groupIdGroup = document.getElementById('group-id-group');

    if (uploadType) {
        uploadType.addEventListener('change', () => {
            if (uploadType.value === 'user') {
                userIdGroup.classList.remove('hidden');
                groupIdGroup.classList.add('hidden');
            } else {
                userIdGroup.classList.add('hidden');
                groupIdGroup.classList.remove('hidden');
            }
        });
    }

    if (btnUploadRoblox) {
        btnUploadRoblox.addEventListener('click', async () => {
            const apiKey = document.getElementById('roblox-api-key').value;
            const name = document.getElementById('asset-name').value;
            const desc = document.getElementById('asset-desc').value;
            
            let userId = null;
            let groupId = null;

            if (uploadType.value === 'user') {
                userId = document.getElementById('roblox-user-id').value;
                if (!userId) {
                    Swal.fire('Error', 'Please enter User ID', 'error');
                    return;
                }
            } else {
                groupId = document.getElementById('roblox-group-id').value;
                if (!groupId) {
                    Swal.fire('Error', 'Please enter Group ID', 'error');
                    return;
                }
            }
            
            // Get filename from download link
            const downloadUrl = downloadLink.href;
            if (!downloadUrl || downloadUrl.includes('#')) {
                Swal.fire('Info', 'Please process audio first!', 'info');
                return;
            }
            
            // downloadUrl might be full url http://localhost:3000/download/processed_...
            const filename = downloadUrl.split('/').pop();

            if (!apiKey) {
                Swal.fire('Error', 'Please enter Roblox API Key', 'error');
                return;
            }
            // userId/groupId checks are handled above

            // UI Update
            btnUploadRoblox.disabled = true;
            uploadStatus.classList.remove('hidden');
            statusText.textContent = "Uploading to Roblox... (This may take a moment)";
            statusIndicator.className = "status-indicator loading";

            try {
                const response = await fetch('/upload-roblox', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        filename: filename,
                        apiKey: apiKey,
                        userId: userId,
                        groupId: groupId,
                        name: name,
                        description: desc
                    })
                });

                const data = await response.json();

                if (data.status === 'success') {
                    statusText.textContent = `SUCCESS! Asset ID: ${data.assetId}`;
                    statusIndicator.className = "status-indicator success";
                    btnUploadRoblox.disabled = false;
                    Swal.fire('Success', `Upload successful! Asset ID: ${data.assetId}`, 'success');
                } else if (data.status === 'pending') {
                    statusText.textContent = `PENDING... Operation ID: ${data.operationId}`;
                    statusIndicator.className = "status-indicator loading";
                } else {
                    throw new Error(data.error || data.details || 'Unknown error');
                }
            } catch (err) {
                console.error(err);
                statusText.textContent = `FAILED: ${err.message || 'Check console'}`;
                statusIndicator.className = "status-indicator error";
                btnUploadRoblox.disabled = false;
                Swal.fire('Upload Failed', err.message || 'Check console for details', 'error');
            }
        });
    }

    // Presets
    window.applyPreset = (type) => {
        switch(type) {
            case 'nightcore':
                speedSlider.value = 1.25;
                pitchSlider.value = 3;
                break;
            case 'slowed':
                speedSlider.value = 0.8;
                pitchSlider.value = -2;
                break;
            case 'chipmunk':
                speedSlider.value = 1.0;
                pitchSlider.value = 7;
                break;
            case 'deep':
                speedSlider.value = 1.0;
                pitchSlider.value = -5;
                break;
            case 'reset':
                speedSlider.value = 1.0;
                pitchSlider.value = 0;
                bypassCheck.checked = false;
                break;
        }
        updateDisplays();
        updateAudioParams();
    };
});
