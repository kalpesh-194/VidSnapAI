(function () {
    const form = document.getElementById("reelForm");
    if (!form) {
        return;
    }

    const refs = {
        mediaInput: document.getElementById("mediaInput"),
        mediaList: document.getElementById("mediaList"),
        titleInput: document.getElementById("titleInput"),
        durationInput: document.getElementById("durationInput"),
        songSelect: document.getElementById("songSelect"),
        captionInput: document.getElementById("captionInput"),
        submitBtn: document.getElementById("submitBtn"),
        canvas: document.getElementById("reelCanvas"),
        resultVideo: document.getElementById("resultVideo"),
        previewPlaceholder: document.getElementById("previewPlaceholder"),
        statusText: document.getElementById("statusText"),
        progressFill: document.getElementById("progressFill"),
        resultActions: document.getElementById("resultActions"),
        downloadLink: document.getElementById("downloadLink"),
        galleryLink: document.getElementById("galleryLink"),
    };

    const maxVideoSeconds = 6;
    const recorderMimeTypes = [
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm",
    ];

    let selectedFiles = [];

    refs.mediaInput.addEventListener("change", function () {
        selectedFiles = Array.from(refs.mediaInput.files).filter(isSupportedMedia);
        renderMediaList();
        resetResult();
        setStatus(selectedFiles.length ? `${selectedFiles.length} file(s) ready` : "Ready", 0);
    });

    form.addEventListener("submit", async function (event) {
        event.preventDefault();
        await createReel();
    });

    function isSupportedMedia(file) {
        return file.type.startsWith("image/") || file.type.startsWith("video/");
    }

    function renderMediaList() {
        refs.mediaList.innerHTML = "";

        if (selectedFiles.length === 0) {
            refs.mediaList.classList.add("empty");
            refs.mediaList.textContent = "No media selected yet.";
            return;
        }

        refs.mediaList.classList.remove("empty");
        const fragment = document.createDocumentFragment();

        selectedFiles.forEach(function (file, index) {
            const item = document.createElement("div");
            item.className = "media-chip";

            const icon = document.createElement("i");
            icon.className = `fas ${file.type.startsWith("image/") ? "fa-image" : "fa-video"}`;

            const name = document.createElement("span");
            name.textContent = `${index + 1}. ${file.name}`;

            const size = document.createElement("small");
            size.textContent = formatBytes(file.size);

            item.append(icon, name, size);
            fragment.appendChild(item);
        });

        refs.mediaList.appendChild(fragment);
    }

    async function createReel() {
        if (!window.MediaRecorder || !refs.canvas.captureStream) {
            setStatus("This browser cannot record reels. Try Chrome or Edge.", 0, true);
            return;
        }

        if (selectedFiles.length === 0) {
            setStatus("Choose at least one picture or clip first.", 0, true);
            refs.mediaInput.focus();
            return;
        }

        const ctx = refs.canvas.getContext("2d");
        const title = refs.titleInput.value.trim() || "Untitled Reel";
        const caption = refs.captionInput.value.trim();
        const imageSeconds = clamp(parseFloat(refs.durationInput.value) || 2.5, 1, 8);
        const song = getSelectedSong();
        let items = [];
        let audioController = null;
        let recorderStream = null;

        setBusy(true);
        resetResult();
        refs.previewPlaceholder.hidden = true;
        refs.resultVideo.hidden = true;
        refs.canvas.hidden = false;

        try {
            setStatus("Loading media...", 5);
            items = await loadMediaItems(selectedFiles, imageSeconds);

            if (items.length === 0) {
                throw new Error("No supported media files were selected.");
            }

            const totalDuration = items.reduce(function (sum, item) {
                return sum + item.duration;
            }, 0);

            drawFrame(ctx, items[0], 0, caption, 0);
            const thumbnail = refs.canvas.toDataURL("image/jpeg", 0.84);

            if (song.url) {
                setStatus("Loading music...", 10);
                audioController = await prepareAudio(song.url);
            }

            const mimeType = getRecorderMimeType();
            const options = mimeType
                ? { mimeType: mimeType, videoBitsPerSecond: 5000000 }
                : { videoBitsPerSecond: 5000000 };

            recorderStream = refs.canvas.captureStream(30);
            if (audioController) {
                audioController.stream.getAudioTracks().forEach(function (track) {
                    recorderStream.addTrack(track);
                });
            }

            const recorder = new MediaRecorder(recorderStream, options);
            const chunks = [];
            const finished = new Promise(function (resolve, reject) {
                recorder.ondataavailable = function (event) {
                    if (event.data && event.data.size > 0) {
                        chunks.push(event.data);
                    }
                };
                recorder.onerror = function () {
                    reject(new Error("The browser stopped the recording."));
                };
                recorder.onstop = function () {
                    const type = mimeType ? mimeType.split(";")[0] : "video/webm";
                    resolve(new Blob(chunks, { type: type }));
                };
            });

            recorder.start(250);
            if (audioController) {
                await audioController.start();
            }

            await playTimeline(ctx, items, caption, totalDuration);
            recorder.stop();
            const reelBlob = await finished;

            if (reelBlob.size === 0) {
                throw new Error("The reel was created empty. Please try again.");
            }

            setStatus("Saving reel...", 96);
            const result = await saveGeneratedReel(reelBlob, {
                title: title,
                caption: caption,
                duration: totalDuration,
                mediaCount: selectedFiles.length,
                songName: song.name,
                thumbnail: thumbnail,
            });

            showResult(result.reel_url, title);
            setStatus("Saved to gallery", 100);
        } catch (error) {
            console.error(error);
            refs.canvas.hidden = true;
            refs.resultVideo.hidden = true;
            refs.previewPlaceholder.hidden = false;
            setStatus(error.message || "Could not create the reel.", 0, true);
        } finally {
            if (audioController) {
                audioController.stop();
            }
            if (recorderStream) {
                recorderStream.getTracks().forEach(function (track) {
                    track.stop();
                });
            }
            items.forEach(function (item) {
                URL.revokeObjectURL(item.url);
            });
            setBusy(false);
        }
    }

    async function loadMediaItems(files, imageSeconds) {
        const items = [];

        for (const file of files) {
            const url = URL.createObjectURL(file);

            if (file.type.startsWith("image/")) {
                const image = await loadImage(url);
                items.push({
                    kind: "image",
                    file: file,
                    media: image,
                    url: url,
                    duration: imageSeconds,
                    width: image.naturalWidth,
                    height: image.naturalHeight,
                });
                continue;
            }

            if (file.type.startsWith("video/")) {
                const video = await loadVideo(url);
                const duration = clamp(video.duration || imageSeconds, 1, maxVideoSeconds);
                items.push({
                    kind: "video",
                    file: file,
                    media: video,
                    url: url,
                    duration: duration,
                    width: video.videoWidth,
                    height: video.videoHeight,
                });
            }
        }

        return items;
    }

    function loadImage(url) {
        return new Promise(function (resolve, reject) {
            const image = new Image();
            image.onload = function () {
                resolve(image);
            };
            image.onerror = function () {
                reject(new Error("One of the pictures could not be loaded."));
            };
            image.src = url;
        });
    }

    function loadVideo(url) {
        return new Promise(function (resolve, reject) {
            const video = document.createElement("video");
            let resolved = false;

            function finish() {
                if (resolved) {
                    return;
                }
                resolved = true;
                resolve(video);
            }

            video.preload = "auto";
            video.muted = true;
            video.playsInline = true;
            video.onloadedmetadata = function () {
                if (Number.isFinite(video.duration) && video.duration > 0) {
                    video.currentTime = Math.min(0.05, video.duration);
                } else {
                    finish();
                }
            };
            video.onseeked = finish;
            video.oncanplay = finish;
            video.onerror = function () {
                reject(new Error("One of the video clips could not be loaded."));
            };
            video.src = url;
        });
    }

    async function prepareAudio(songUrl) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) {
            return null;
        }

        try {
            const response = await fetch(songUrl);
            if (!response.ok) {
                return null;
            }
            const buffer = await response.arrayBuffer();
            const audioContext = new AudioContextClass();
            const decoded = await audioContext.decodeAudioData(buffer);
            const destination = audioContext.createMediaStreamDestination();
            const source = audioContext.createBufferSource();
            const gain = audioContext.createGain();

            source.buffer = decoded;
            source.loop = true;
            gain.gain.value = 0.75;
            source.connect(gain);
            gain.connect(destination);

            return {
                stream: destination.stream,
                async start() {
                    await audioContext.resume();
                    source.start(0);
                },
                stop() {
                    try {
                        source.stop();
                    } catch (error) {
                        // The source may already be stopped if recording failed early.
                    }
                    audioContext.close();
                },
            };
        } catch (error) {
            console.warn("Music could not be added to the reel.", error);
            return null;
        }
    }

    async function playTimeline(ctx, items, caption, totalDuration) {
        let elapsedBefore = 0;

        for (let index = 0; index < items.length; index += 1) {
            const item = items[index];

            if (item.kind === "video") {
                item.media.currentTime = 0;
                try {
                    await item.media.play();
                } catch (error) {
                    console.warn("Video playback was blocked for one clip.", error);
                }
            }

            const startedAt = performance.now();

            while (true) {
                const elapsed = (performance.now() - startedAt) / 1000;
                const segmentProgress = clamp(elapsed / item.duration, 0, 1);
                const globalProgress = clamp((elapsedBefore + elapsed) / totalDuration, 0, 1);

                drawFrame(ctx, item, segmentProgress, caption, globalProgress);
                setStatus(`Creating ${index + 1} of ${items.length}`, 12 + globalProgress * 82);

                if (elapsed >= item.duration) {
                    break;
                }

                await nextFrame();
            }

            if (item.kind === "video") {
                item.media.pause();
            }

            elapsedBefore += item.duration;
        }
    }

    function drawFrame(ctx, item, progress, caption, globalProgress) {
        const canvas = ctx.canvas;
        const width = canvas.width;
        const height = canvas.height;
        const media = item.media;
        const sourceWidth = item.kind === "video" ? media.videoWidth : media.naturalWidth;
        const sourceHeight = item.kind === "video" ? media.videoHeight : media.naturalHeight;

        ctx.fillStyle = "#101418";
        ctx.fillRect(0, 0, width, height);

        if (sourceWidth && sourceHeight) {
            const zoom = item.kind === "image" ? 1.06 + progress * 0.08 : 1;
            const drawWidth = width * zoom;
            const drawHeight = height * zoom;
            const panX = item.kind === "image" ? Math.sin(progress * Math.PI) * 26 : 0;
            const panY = item.kind === "image" ? (progress - 0.5) * 34 : 0;

            drawCover(
                ctx,
                media,
                sourceWidth,
                sourceHeight,
                (width - drawWidth) / 2 + panX,
                (height - drawHeight) / 2 + panY,
                drawWidth,
                drawHeight
            );
        }

        drawVignette(ctx);
        drawProgress(ctx, globalProgress);

        if (caption) {
            drawCaption(ctx, caption);
        }
    }

    function drawCover(ctx, media, sourceWidth, sourceHeight, targetX, targetY, targetWidth, targetHeight) {
        const sourceRatio = sourceWidth / sourceHeight;
        const targetRatio = targetWidth / targetHeight;
        let cropX = 0;
        let cropY = 0;
        let cropWidth = sourceWidth;
        let cropHeight = sourceHeight;

        if (sourceRatio > targetRatio) {
            cropWidth = sourceHeight * targetRatio;
            cropX = (sourceWidth - cropWidth) / 2;
        } else {
            cropHeight = sourceWidth / targetRatio;
            cropY = (sourceHeight - cropHeight) / 2;
        }

        ctx.drawImage(
            media,
            cropX,
            cropY,
            cropWidth,
            cropHeight,
            targetX,
            targetY,
            targetWidth,
            targetHeight
        );
    }

    function drawVignette(ctx) {
        const width = ctx.canvas.width;
        const height = ctx.canvas.height;
        const top = ctx.createLinearGradient(0, 0, 0, height * 0.32);
        top.addColorStop(0, "rgba(0, 0, 0, 0.45)");
        top.addColorStop(1, "rgba(0, 0, 0, 0)");
        ctx.fillStyle = top;
        ctx.fillRect(0, 0, width, height * 0.34);

        const bottom = ctx.createLinearGradient(0, height * 0.54, 0, height);
        bottom.addColorStop(0, "rgba(0, 0, 0, 0)");
        bottom.addColorStop(1, "rgba(0, 0, 0, 0.68)");
        ctx.fillStyle = bottom;
        ctx.fillRect(0, height * 0.54, width, height * 0.46);
    }

    function drawProgress(ctx, progress) {
        const width = ctx.canvas.width;
        const barWidth = width - 112;
        const x = 56;
        const y = 44;

        ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
        ctx.fillRect(x, y, barWidth, 7);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(x, y, barWidth * clamp(progress, 0, 1), 7);
    }

    function drawCaption(ctx, caption) {
        const width = ctx.canvas.width;
        const height = ctx.canvas.height;
        const maxWidth = width - 110;
        const lines = wrapText(ctx, caption, maxWidth);
        const lineHeight = 54;
        const startY = height - 156 - (lines.length - 1) * lineHeight;

        ctx.font = "700 42px Segoe UI, Arial, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.shadowColor = "rgba(0, 0, 0, 0.68)";
        ctx.shadowBlur = 14;
        ctx.fillStyle = "#ffffff";

        lines.forEach(function (line, index) {
            ctx.fillText(line, width / 2, startY + index * lineHeight, maxWidth);
        });

        ctx.shadowBlur = 0;
    }

    function wrapText(ctx, text, maxWidth) {
        ctx.font = "700 42px Segoe UI, Arial, sans-serif";
        const words = text.split(/\s+/).filter(Boolean);
        const lines = [];
        let currentLine = "";

        words.forEach(function (word) {
            const nextLine = currentLine ? `${currentLine} ${word}` : word;
            if (ctx.measureText(nextLine).width <= maxWidth || !currentLine) {
                currentLine = nextLine;
            } else {
                lines.push(currentLine);
                currentLine = word;
            }
        });

        if (currentLine) {
            lines.push(currentLine);
        }

        return lines.slice(0, 4);
    }

    async function saveGeneratedReel(blob, details) {
        const formData = new FormData();
        formData.append("reel", blob, `${safeFileName(details.title)}.webm`);
        formData.append("title", details.title);
        formData.append("caption", details.caption);
        formData.append("duration", String(details.duration));
        formData.append("media_count", String(details.mediaCount));
        formData.append("song_name", details.songName || "No music");
        formData.append("thumbnail", details.thumbnail);

        const response = await fetch("/api/reels", {
            method: "POST",
            body: formData,
        });
        const payload = await response.json().catch(function () {
            return {};
        });

        if (!response.ok) {
            throw new Error(payload.error || "The reel could not be saved.");
        }

        return payload;
    }

    function showResult(reelUrl, title) {
        refs.canvas.hidden = true;
        refs.previewPlaceholder.hidden = true;
        refs.resultVideo.hidden = false;
        refs.resultVideo.src = reelUrl;
        refs.resultActions.hidden = false;
        refs.downloadLink.href = reelUrl;
        refs.downloadLink.download = `${safeFileName(title)}.webm`;
        refs.galleryLink.href = "/gallery";
    }

    function resetResult() {
        refs.resultVideo.pause();
        refs.resultVideo.removeAttribute("src");
        refs.resultVideo.load();
        refs.resultVideo.hidden = true;
        refs.canvas.hidden = true;
        refs.previewPlaceholder.hidden = false;
        refs.resultActions.hidden = true;
        refs.progressFill.style.width = "0%";
    }

    function getSelectedSong() {
        const option = refs.songSelect.options[refs.songSelect.selectedIndex];
        return {
            url: refs.songSelect.value,
            name: option ? option.textContent.trim() : "No music",
        };
    }

    function getRecorderMimeType() {
        return recorderMimeTypes.find(function (type) {
            return MediaRecorder.isTypeSupported(type);
        }) || "";
    }

    function setBusy(isBusy) {
        refs.submitBtn.disabled = isBusy;
        refs.submitBtn.classList.toggle("is-busy", isBusy);
    }

    function setStatus(message, percent, isError) {
        refs.statusText.textContent = message;
        refs.statusText.classList.toggle("error", Boolean(isError));
        refs.progressFill.style.width = `${clamp(percent || 0, 0, 100)}%`;
    }

    function nextFrame() {
        return new Promise(function (resolve) {
            requestAnimationFrame(resolve);
        });
    }

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    function formatBytes(bytes) {
        if (bytes < 1024) {
            return `${bytes} B`;
        }
        if (bytes < 1024 * 1024) {
            return `${(bytes / 1024).toFixed(1)} KB`;
        }
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    function safeFileName(value) {
        return (value || "reel")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 60) || "reel";
    }
}());
