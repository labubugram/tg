(function() {
    'use strict';

    const CONFIG = {
        API_BASE: document.querySelector('meta[name="mirror:api-base"]')?.content || 'https://nekhebet.su',
        CHANNEL_ID: document.querySelector('meta[name="mirror:channel-id"]')?.content,
        CHANNEL_TITLE: document.querySelector('meta[name="mirror:channel-title"]')?.content,
        CHANNEL_USERNAME: document.querySelector('meta[name="mirror:channel-username"]')?.content,
        CHANNEL_AVATAR: document.querySelector('meta[name="mirror:channel-avatar"]')?.content || '∵',
        INITIAL_LIMIT: 20,
        MAX_RECONNECT_ATTEMPTS: 10,
        RECONNECT_BASE_DELAY: 1000,
        MAX_VISIBLE_POSTS: 100,
        LAZY_LOAD_OFFSET: 500,
        IMAGE_UNLOAD_DISTANCE: 5000,
        DEDUP_TTL: 200,
        WS_BASE: (() => {
            const apiBase = document.querySelector('meta[name="mirror:api-base"]')?.content;
            return apiBase ? apiBase.replace('http://', 'ws://').replace('https://', 'wss://') : 'wss://nekhebet.su';
        })(),
        SYNC_AFTER_RECONNECT: true,
        PING_INTERVAL: 30000,
        API_VERSION: 'v1',
        RECONNECT_GIVE_UP_DELAY: 300000,
        MAX_CACHE_SIZE: 200,
        MAX_MEDIA_CACHE_SIZE: 100,
        CLEANUP_INTERVAL: 60000,
        MEDIA_MAX_RETRIES: 10,
        MEDIA_RETRY_DELAY: 2000,
        MEDIA_POLL_MAX_ATTEMPTS: 20,
        MEDIA_POLL_BASE_DELAY: 2000,
        MEDIA_POLL_MAX_DELAY: 10000,
        VIDEO_PRELOAD: 'metadata',
        RETRY_ON_NETWORK_ERROR: true,
        USE_LAZY_LOADING: true,
        MEDIA_READY_RECHECK_DELAY: 500
    };

    const State = {
        posts: new Map(),
        postOrder: [],
        newPosts: [],
        offset: 0,
        hasMore: true,
        isLoading: false,
        ws: null,
        wsConnected: false,
        wsReconnectAttempts: 0,
        
        // ========== УПРОЩЕННЫЙ MEDIA LAYER ==========
        mediaCache: new Map(),           // messageId -> url (только готовые)
        mediaLoading: new Set(),          // messageId -> загружается
        mediaRetryTimeouts: new Map(),    // messageId -> timeout
        
        visiblePosts: new Set(),
        
        theme: localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
        
        intervals: [],
        timeouts: [],
        resizeObserver: null,
        wsPingInterval: null,
        
        fullMessageCache: new Map(),
        loadingMessages: new Set(),
        initialLoadComplete: false,
        pendingEvents: [],
        lastEventId: 0,
        currentlyPlayingVideo: null,
        
        supportedVersions: ['2.0', '3.0'],
        serverVersion: '3.0'
    };

    // ============================================
    // УТИЛИТЫ
    // ============================================
    
    function cleanupResources() {
        State.intervals.forEach(clearInterval);
        State.intervals = [];
        State.timeouts.forEach(clearTimeout);
        State.timeouts = [];
        
        State.mediaRetryTimeouts.forEach(clearTimeout);
        State.mediaRetryTimeouts.clear();
        
        if (State.resizeObserver) {
            State.resizeObserver.disconnect();
            State.resizeObserver = null;
        }
        
        if (State.wsPingInterval) {
            clearInterval(State.wsPingInterval);
            State.wsPingInterval = null;
        }
    }

    function safeSetTimeout(fn, delay) {
        const id = setTimeout(() => {
            const index = State.timeouts.indexOf(id);
            if (index > -1) State.timeouts.splice(index, 1);
            fn();
        }, delay);
        State.timeouts.push(id);
        return id;
    }

    function safeSetInterval(fn, delay) {
        const id = setInterval(fn, delay);
        State.intervals.push(id);
        return id;
    }

    const CacheManager = {
        cleanup() {
            const now = Date.now();
            
            if (State.fullMessageCache.size > CONFIG.MAX_CACHE_SIZE) {
                const keysToDelete = Array.from(State.fullMessageCache.keys())
                    .slice(0, State.fullMessageCache.size - CONFIG.MAX_CACHE_SIZE);
                keysToDelete.forEach(key => State.fullMessageCache.delete(key));
            }
            
            if (State.mediaCache.size > CONFIG.MAX_MEDIA_CACHE_SIZE) {
                const keysToDelete = Array.from(State.mediaCache.keys())
                    .slice(0, State.mediaCache.size - CONFIG.MAX_MEDIA_CACHE_SIZE);
                keysToDelete.forEach(key => State.mediaCache.delete(key));
            }
        },
        
        startCleanupInterval() {
            return safeSetInterval(() => this.cleanup(), CONFIG.CLEANUP_INTERVAL);
        }
    };

    const Security = {
        escapeHtml(unsafe) {
            return unsafe
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;")
                .replace(/`/g, "&#96;");
        },
        sanitizeUrl(url) {
            try {
                const parsed = new URL(url);
                if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '#';
                if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') return '#';
                return url;
            } catch {
                return '#';
            }
        },
        validateMessageId(id) {
            return Number.isInteger(Number(id)) && Number(id) > 0;
        }
    };

    const Formatters = {
        formatDate(date) {
            const d = new Date(date);
            const now = new Date();
            const isToday = d.toDateString() === now.toDateString();
            const yesterday = new Date(now);
            yesterday.setDate(now.getDate() - 1);
            const isYesterday = d.toDateString() === yesterday.toDateString();
            const time = d.toLocaleTimeString('ru-RU', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            });
            if (isToday) return `Today at ${time}`;
            if (isYesterday) return `Yesterday at ${time}`;
            return d.toLocaleDateString('ru-RU', {
                day: '2-digit',
                month: 'long',
                year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric'
            }) + ` at ${time}`;
        },
        
        formatViews(views) {
            if (!views) return '0';
            if (views >= 1000000) return `${(views / 1000000).toFixed(1)}M`;
            if (views >= 1000) return `${(views / 1000).toFixed(1)}K`;
            return views.toString();
        },
        
        formatText(text, entities = []) {
            if (!text) return '';
            
            const escapeHtml = (unsafe) => {
                return unsafe
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;');
            };

            const isEmoji = (char) => {
                const codePoint = char.codePointAt(0);
                return (codePoint >= 0x1F300 && codePoint <= 0x1F9FF) || 
                       (codePoint >= 0x2600 && codePoint <= 0x26FF) ||   
                       (codePoint >= 0x2700 && codePoint <= 0x27BF) ||   
                       (codePoint >= 0x1F1E6 && codePoint <= 0x1F1FF) || 
                       codePoint === 0x200D || 
                       (codePoint >= 0xE0020 && codePoint <= 0xE007F);   
            };
            
            const emojiSequences = [];
            let processed = '';
            for (let i = 0; i < text.length; i++) {
                const char = text[i];
                if (isEmoji(char)) {
                    let sequence = '';
                    while (i < text.length && isEmoji(text[i])) {
                        sequence += text[i];
                        i++;
                    }
                    i--;
                    const placeholder = `%%%EMOJI${emojiSequences.length}%%%`;
                    emojiSequences.push(sequence);
                    processed += placeholder;
                } else {
                    processed += char;
                }
            }

            const codeBlocks = [];
            let processedWithCode = processed;

            processedWithCode = processedWithCode.replace(/```([\s\S]*?)```/g, (match, code) => {
                const placeholder = `%%%CODEBLOCK${codeBlocks.length}%%%`;
                codeBlocks.push({
                    type: 'pre',
                    content: code
                });
                return placeholder;
            });

            processedWithCode = processedWithCode.replace(/`([^`]+)`/g, (match, code) => {
                const placeholder = `%%%CODEBLOCK${codeBlocks.length}%%%`;
                codeBlocks.push({
                    type: 'inline',
                    content: code
                });
                return placeholder;
            });

            let escaped = escapeHtml(processedWithCode);

            escaped = escaped.replace(/%%%EMOJI(\d+)%%%/g, (match, index) => {
                return emojiSequences[parseInt(index)] || match;
            });

            escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+?)(?:\s+"[^"]*")?\)/g, (match, linkText, url) => {
                url = url.replace(/[<>"']/g, '');
                const safeUrl = Security.sanitizeUrl(url);
                if (safeUrl === '#') return match;
                
                const escapedLinkText = escapeHtml(linkText);
                return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer nofollow" class="tg-link">${escapedLinkText}</a>`;
            });

            if (entities && entities.length > 0) {
                const sortedEntities = [...entities].sort((a, b) => b.offset - a.offset);
                
                for (const entity of sortedEntities) {
                    const { offset, length, type } = entity;
                    if (offset < 0 || offset + length > escaped.length) continue;
                    
                    const before = escaped.substring(0, offset);
                    const content = escaped.substring(offset, offset + length);
                    const after = escaped.substring(offset + length);
                    
                    let wrapped = content;
                    
                    switch (type) {
                        case 'bold':
                        case 'Bold':
                            wrapped = `<b>${content}</b>`;
                            break;
                        case 'italic':
                        case 'Italic':
                            wrapped = `<i>${content}</i>`;
                            break;
                        case 'underline':
                        case 'Underline':
                            wrapped = `<u>${content}</u>`;
                            break;
                        case 'strikethrough':
                        case 'Strikethrough':
                            wrapped = `<s>${content}</s>`;
                            break;
                        case 'code':
                        case 'pre':
                            wrapped = content;
                            break;
                        case 'spoiler':
                        case 'Spoiler':
                            wrapped = `<span class="tg-spoiler" onclick="this.classList.toggle('revealed')">${content}</span>`;
                            break;
                        case 'text_link':
                            if (entity.url) {
                                const safeUrl = Security.sanitizeUrl(entity.url);
                                wrapped = `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer nofollow" class="tg-link">${content}</a>`;
                            }
                            break;
                        case 'mention':
                            wrapped = `<span class="tg-mention" data-mention="${content}">${content}</span>`;
                            break;
                        case 'hashtag':
                            wrapped = `<span class="tg-hashtag" data-hashtag="${content}">${content}</span>`;
                            break;
                    }
                    
                    escaped = before + wrapped + after;
                }
            } else {
                escaped = escaped.replace(/\*\*\*(.*?)\*\*\*/g, '<b><i>$1</i></b>');
                escaped = escaped.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
                escaped = escaped.replace(/__(.*?)__/g, '<u>$1</u>');
                escaped = escaped.replace(/\*(.*?)\*/g, '<i>$1</i>');
                escaped = escaped.replace(/_(.*?)_/g, '<i>$1</i>');
                escaped = escaped.replace(/~~(.*?)~~/g, '<s>$1</s>');
                escaped = escaped.replace(/\|\|(.*?)\|\|/g, '<span class="tg-spoiler" onclick="this.classList.toggle(\'revealed\')">$1</span>');
            }

            escaped = escaped.replace(/%%%CODEBLOCK(\d+)%%%/g, (match, index) => {
                const block = codeBlocks[parseInt(index)];
                if (!block) return match;
                
                const content = escapeHtml(block.content);
                if (block.type === 'pre') {
                    return `<pre class="tg-code-block"><code>${content}</code></pre>`;
                } else {
                    return `<code class="tg-inline-code">${content}</code>`;
                }
            });

            const parts = [];
            let lastIndex = 0;
            const linkRegex = /<a[^>]*>.*?<\/a>/g;
            let match;
            while ((match = linkRegex.exec(escaped)) !== null) {
                parts.push(escaped.substring(lastIndex, match.index));
                parts.push(match[0]);
                lastIndex = match.index + match[0].length;
            }
            parts.push(escaped.substring(lastIndex));
            
            escaped = parts.map(part => {
                if (part.startsWith('<a')) return part;
                
                return part.replace(/(https?:\/\/[^\s<"')]+)(?![^<]*>)/g, (url) => {
                    const safeUrl = Security.sanitizeUrl(url);
                    if (safeUrl === '#') return url;
                    
                    let displayText = url;
                    if (url.length > 50) {
                        displayText = url.substring(0, 40) + '…' + url.substring(url.length - 10);
                    }
                    
                    return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer nofollow" class="tg-link">${displayText}</a>`;
                });
            }).join('');

            escaped = escaped.replace(/^&gt;&gt;&gt; (.*)$/gm, '<blockquote class="tg-quote level-3">$1</blockquote>');
            escaped = escaped.replace(/^&gt;&gt; (.*)$/gm, '<blockquote class="tg-quote level-2">$1</blockquote>');
            escaped = escaped.replace(/^&gt; (.*)$/gm, '<blockquote class="tg-quote level-1">$1</blockquote>');

            const tagParts = [];
            lastIndex = 0;
            const tagRegex = /<[^>]+>/g;
            while ((match = tagRegex.exec(escaped)) !== null) {
                tagParts.push({
                    type: 'text',
                    content: escaped.substring(lastIndex, match.index)
                });
                tagParts.push({
                    type: 'tag',
                    content: match[0]
                });
                lastIndex = match.index + match[0].length;
            }
            tagParts.push({
                type: 'text',
                content: escaped.substring(lastIndex)
            });
            
            escaped = tagParts.map(part => {
                if (part.type === 'tag') return part.content;
                
                return part.content
                    .replace(/(?<!\w)@(\w+)/g, '<span class="tg-mention" data-mention="@$1">@$1</span>')
                    .replace(/(?<!\w)#(\w+)/g, '<span class="tg-hashtag" data-hashtag="#$1">#$1</span>');
            }).join('');

            escaped = escaped.replace(/\n/g, '<br>');

            return escaped;
        }
    };

    const debounce = (fn, delay, options = {}) => {
        let timeoutId;
        let lastCall = 0;
        return function(...args) {
            const now = Date.now();
            if (options.leading && now - lastCall > delay) {
                fn.apply(this, args);
                lastCall = now;
            }
            clearTimeout(timeoutId);
            timeoutId = safeSetTimeout(() => {
                if (!options.leading || Date.now() - lastCall > delay) {
                    fn.apply(this, args);
                }
                timeoutId = null;
            }, delay);
        };
    };

    // ============================================
    // MessageAPI
    // ============================================
    
    const MessageAPI = {
        async fetchFullMessage(messageId) {
            if (!Security.validateMessageId(messageId)) return null;
            
            if (State.fullMessageCache.has(messageId)) {
                return State.fullMessageCache.get(messageId);
            }
            
            if (State.loadingMessages.has(messageId)) {
                return new Promise(resolve => {
                    const checkInterval = setInterval(() => {
                        if (State.fullMessageCache.has(messageId)) {
                            clearInterval(checkInterval);
                            resolve(State.fullMessageCache.get(messageId));
                        }
                    }, 100);
                    safeSetTimeout(() => {
                        clearInterval(checkInterval);
                        resolve(null);
                    }, 5000);
                });
            }
            
            State.loadingMessages.add(messageId);
            
            try {
                const url = `${CONFIG.API_BASE}/api/${CONFIG.API_VERSION}/messages/${messageId}?channel_id=${CONFIG.CHANNEL_ID}`;
                const response = await fetch(url);
                
                if (!response.ok) {
                    if (response.status === 404) {
                        return null;
                    }
                    throw new Error(`HTTP ${response.status}`);
                }
                
                const data = await response.json();
                
                State.fullMessageCache.set(messageId, data);
                
                if (State.fullMessageCache.size > CONFIG.MAX_CACHE_SIZE * 1.2) {
                    CacheManager.cleanup();
                }
                
                return data;
                
            } catch (err) {
                console.error(`Error fetching full message ${messageId}:`, err);
                return null;
            } finally {
                State.loadingMessages.delete(messageId);
            }
        },
        
        async fetchBatchMessages(messageIds) {
            if (!messageIds || messageIds.length === 0) return {};
            
            const neededIds = messageIds.filter(id => !State.fullMessageCache.has(id));
            if (neededIds.length === 0) {
                const result = {};
                messageIds.forEach(id => {
                    if (State.fullMessageCache.has(id)) {
                        result[id] = State.fullMessageCache.get(id);
                    }
                });
                return result;
            }
            
            try {
                const response = await fetch(`${CONFIG.API_BASE}/api/${CONFIG.API_VERSION}/messages/batch`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        channel_id: parseInt(CONFIG.CHANNEL_ID),
                        message_ids: neededIds
                    })
                });
                
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                
                const data = await response.json();
                
                if (data.messages) {
                    Object.entries(data.messages).forEach(([id, msg]) => {
                        State.fullMessageCache.set(parseInt(id), msg);
                    });
                }
                
                if (State.fullMessageCache.size > CONFIG.MAX_CACHE_SIZE * 1.2) {
                    CacheManager.cleanup();
                }
                
                const result = {};
                messageIds.forEach(id => {
                    if (State.fullMessageCache.has(id)) {
                        result[id] = State.fullMessageCache.get(id);
                    }
                });
                
                return result;
                
            } catch (err) {
                console.error('Error fetching batch messages:', err);
                return {};
            }
        },
        
        invalidateMessage(messageId) {
            State.fullMessageCache.delete(messageId);
        }
    };

    // ============================================
    // API для постов
    // ============================================
    
    const API = {
        async fetchMessages(offset = 0, limit = CONFIG.INITIAL_LIMIT) {
            try {
                const response = await fetch(`${CONFIG.API_BASE}/api/channel/posts?channel_id=${CONFIG.CHANNEL_ID}&offset=${offset}&limit=${limit}`);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data = await response.json();
                
                if (data.posts && data.posts.length > 0) {
                    const messageIds = data.posts.map(p => p.message_id);
                    const fullMessages = await MessageAPI.fetchBatchMessages(messageIds);
                    
                    data.posts = data.posts.map(post => {
                        if (fullMessages[post.message_id]) {
                            return {
                                ...post,
                                ...fullMessages[post.message_id],
                                media_type: fullMessages[post.message_id].media_type || post.media_type,
                                has_media: !!(fullMessages[post.message_id].media_type || post.media_type)
                            };
                        }
                        return post;
                    });
                }
                
                return {
                    messages: data.posts || [],
                    hasMore: (data.posts || []).length === limit
                };
            } catch (err) {
                console.error('Error fetching messages:', err);
                return { messages: [], hasMore: false };
            }
        },
        
        async fetchMessagesSince(afterId, limit = 50) {
            try {
                const response = await fetch(`${CONFIG.API_BASE}/api/channel/posts/since?channel_id=${CONFIG.CHANNEL_ID}&after_id=${afterId}&limit=${limit}`);
                if (!response.ok) {
                    if (response.status === 404) return { posts: [] };
                    throw new Error(`HTTP ${response.status}`);
                }
                const data = await response.json();
                
                if (data.posts && data.posts.length > 0) {
                    const messageIds = data.posts.map(p => p.message_id);
                    const fullMessages = await MessageAPI.fetchBatchMessages(messageIds);
                    
                    data.posts = data.posts.map(post => {
                        if (fullMessages[post.message_id]) {
                            return {
                                ...post,
                                ...fullMessages[post.message_id]
                            };
                        }
                        return post;
                    });
                }
                
                return data;
            } catch (err) {
                console.error('Error fetching messages since:', err);
                return { posts: [] };
            }
        }
    };

    // ============================================
    // MediaAPI - УПРОЩЕННЫЙ
    // ============================================
    
    const MediaAPI = {
        async fetchMedia(messageId) {
            if (!Security.validateMessageId(messageId)) return null;
            
            try {
                const url = `${CONFIG.API_BASE}/api/media/by-message/${messageId}?channel_id=${CONFIG.CHANNEL_ID}`;
                const response = await fetch(url);
                
                if (response.status === 404) {
                    return null;
                }
                
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                
                const data = await response.json();
                
                // Если медиа готово - возвращаем URL
                if (data.status === 'ready' && data.url) {
                    return { url: data.url, type: data.file_type };
                }
                
                // Если не готово - возвращаем null (будем пробовать позже)
                return null;
                
            } catch (err) {
                console.error(`Failed to load media for message ${messageId}:`, err);
                return null;
            }
        }
    };

    // ============================================
    // VideoManager
    // ============================================
    
    const VideoManager = {
        stopAllVideos() {
            if (State.currentlyPlayingVideo) {
                State.currentlyPlayingVideo.pause();
                State.currentlyPlayingVideo = null;
            }
            
            document.querySelectorAll('video').forEach(video => {
                if (!video.paused) {
                    video.pause();
                }
            });
        },
        
        pauseVideo(video) {
            if (video && !video.paused) {
                video.pause();
                if (State.currentlyPlayingVideo === video) {
                    State.currentlyPlayingVideo = null;
                }
            }
        },
        
        playVideo(video) {
            if (!video) return;
            
            if (State.currentlyPlayingVideo && State.currentlyPlayingVideo !== video) {
                State.currentlyPlayingVideo.pause();
            }
            
            video.play().catch(() => {});
            State.currentlyPlayingVideo = video;
        },
        
        handleVideoPlay(video) {
            if (State.currentlyPlayingVideo && State.currentlyPlayingVideo !== video) {
                State.currentlyPlayingVideo.pause();
            }
            State.currentlyPlayingVideo = video;
        },
        
        handleVideoPause(video) {
            if (State.currentlyPlayingVideo === video) {
                State.currentlyPlayingVideo = null;
            }
        }
    };

    const ThemeManager = {
        video: null,
        videoTimeoutId: null,
        
        init() {
            this.video = document.getElementById('bgVideo');
            if (this.video) {
                if (this.video.canPlayType) {
                    const canPlay = this.video.canPlayType('video/mp4');
                    if (canPlay === 'probably' || canPlay === 'maybe') {
                        this.video.load();
                        window.addEventListener('load', () => this.scheduleVideo());
                    }
                }
            }
            this.applyTheme(State.theme, false);
        },
        
        applyTheme(theme, animate = true) {
            if (animate) {
                document.documentElement.classList.add('theme-transitioning');
            }
            document.documentElement.setAttribute('data-theme', theme);
            if (theme === 'dark') {
                this.scheduleVideo();
            } else {
                this.hideVideo();
            }
            if (animate) {
                safeSetTimeout(() => {
                    document.documentElement.classList.remove('theme-transitioning');
                }, 400);
            }
        },
        
        scheduleVideo() {
            if (!this.video) return;
            if (this.videoTimeoutId) clearTimeout(this.videoTimeoutId);
            this.videoTimeoutId = safeSetTimeout(() => this.showVideo(), 10000);
        },
        
        showVideo() {
            if (this.video) {
                this.video.classList.add('visible');
                VideoManager.playVideo(this.video);
            }
        },
        
        hideVideo() {
            if (this.video) {
                this.video.classList.remove('visible');
                VideoManager.pauseVideo(this.video);
            }
            if (this.videoTimeoutId) {
                clearTimeout(this.videoTimeoutId);
                this.videoTimeoutId = null;
            }
        },
        
        toggle() {
            const newTheme = State.theme === 'dark' ? 'light' : 'dark';
            State.theme = newTheme;
            localStorage.setItem('theme', newTheme);
            this.applyTheme(newTheme, true);
        }
    };

    // ============================================
    // MediaManager - УПРОЩЕННЫЙ
    // ============================================
    
    const MediaManager = {
        async loadMedia(messageId, attempt = 0) {
            // Уже загружено
            if (State.mediaCache.has(messageId)) {
                this.updatePostMedia(messageId, State.mediaCache.get(messageId));
                return true;
            }
            
            // Уже загружается
            if (State.mediaLoading.has(messageId)) {
                return false;
            }
            
            // Слишком много попыток
            if (attempt >= CONFIG.MEDIA_MAX_RETRIES) {
                console.log(`Media ${messageId} failed after ${attempt} attempts`);
                return false;
            }
            
            State.mediaLoading.add(messageId);
            
            try {
                const media = await MediaAPI.fetchMedia(messageId);
                
                if (media?.url) {
                    // Успех - сохраняем и обновляем UI
                    State.mediaCache.set(messageId, media.url);
                    this.updatePostMedia(messageId, media.url);
                    
                    // Очищаем retry timeout если был
                    if (State.mediaRetryTimeouts.has(messageId)) {
                        clearTimeout(State.mediaRetryTimeouts.get(messageId));
                        State.mediaRetryTimeouts.delete(messageId);
                    }
                    
                    return true;
                } else {
                    // Не готово - планируем повтор
                    State.mediaLoading.delete(messageId);
                    
                    const delay = Math.min(
                        CONFIG.MEDIA_RETRY_DELAY * Math.pow(1.5, attempt),
                        CONFIG.MEDIA_POLL_MAX_DELAY
                    );
                    
                    const timeoutId = safeSetTimeout(() => {
                        State.mediaRetryTimeouts.delete(messageId);
                        this.loadMedia(messageId, attempt + 1);
                    }, delay);
                    
                    State.mediaRetryTimeouts.set(messageId, timeoutId);
                    return false;
                }
                
            } catch (err) {
                console.error(`Error loading media ${messageId}:`, err);
                State.mediaLoading.delete(messageId);
                
                // Планируем повтор при ошибке
                const delay = Math.min(
                    CONFIG.MEDIA_RETRY_DELAY * Math.pow(1.5, attempt),
                    CONFIG.MEDIA_POLL_MAX_DELAY
                );
                
                const timeoutId = safeSetTimeout(() => {
                    State.mediaRetryTimeouts.delete(messageId);
                    this.loadMedia(messageId, attempt + 1);
                }, delay);
                
                State.mediaRetryTimeouts.set(messageId, timeoutId);
                return false;
            }
        },
        
        // Принудительная перезагрузка (для media_ready)
        forceLoadMedia(messageId) {
            // Очищаем существующие таймауты
            if (State.mediaRetryTimeouts.has(messageId)) {
                clearTimeout(State.mediaRetryTimeouts.get(messageId));
                State.mediaRetryTimeouts.delete(messageId);
            }
            
            // Удаляем из loading чтобы можно было загрузить снова
            State.mediaLoading.delete(messageId);
            
            // Пробуем загрузить сразу
            this.loadMedia(messageId, 0);
        },
        
        updatePostMedia(messageId, url) {
            const postEl = document.querySelector(`.post[data-message-id="${messageId}"]`);
            if (!postEl) return;
            
            const container = postEl.querySelector('.media-loading, .media-pending');
            if (!container) return;
            
            const post = State.posts.get(messageId);
            const mediaType = post?.media_type;
            
            const newMedia = UI.renderMedia(url, mediaType);
            container.outerHTML = newMedia;
            
            postEl.dataset.mediaUrl = url;
            
            setTimeout(() => UI.attachMediaHandlers(postEl), 0);
        },
        
        // Загрузить медиа для видимых постов
        loadVisibleMedia() {
            State.visiblePosts.forEach(messageId => {
                if (!State.mediaCache.has(messageId)) {
                    this.loadMedia(messageId);
                }
            });
        },
        
        // Выгрузить медиа при скролле
        unloadMedia(messageId) {
            if (!CONFIG.IMAGE_UNLOAD_DISTANCE) return false;
            
            const postEl = document.querySelector(`.post[data-message-id="${messageId}"]`);
            if (!postEl) return false;
            
            const rect = postEl.getBoundingClientRect();
            const viewportHeight = window.innerHeight;
            const distanceFromViewport = Math.min(
                Math.abs(rect.top - viewportHeight),
                Math.abs(rect.bottom)
            );
            
            if (distanceFromViewport > CONFIG.IMAGE_UNLOAD_DISTANCE) {
                const mediaContainer = postEl.querySelector('.media-container');
                if (mediaContainer && !mediaContainer.classList.contains('media-unloaded')) {
                    const video = mediaContainer.querySelector('video');
                    if (video) {
                        VideoManager.pauseVideo(video);
                        video.dataset.src = video.src;
                        video.removeAttribute('src');
                        video.load();
                        mediaContainer.classList.add('media-unloaded');
                        return true;
                    }
                    
                    const img = mediaContainer.querySelector('img');
                    if (img) {
                        img.dataset.src = img.src;
                        img.style.display = 'none';
                        mediaContainer.classList.add('media-unloaded');
                        return true;
                    }
                }
            }
            return false;
        },
        
        restoreMediaIfNeeded(messageId) {
            const postEl = document.querySelector(`.post[data-message-id="${messageId}"]`);
            if (!postEl) return false;
            
            const mediaContainer = postEl.querySelector('.media-container');
            if (mediaContainer && mediaContainer.classList.contains('media-unloaded')) {
                const url = State.mediaCache.get(messageId);
                if (url) {
                    const img = mediaContainer.querySelector('img');
                    const video = mediaContainer.querySelector('video');
                    
                    if (img) {
                        img.src = img.dataset.src || url;
                        img.style.display = '';
                        mediaContainer.classList.remove('media-unloaded');
                    } else if (video) {
                        video.src = video.dataset.src || url;
                        video.load();
                        mediaContainer.classList.remove('media-unloaded');
                        if (UI.isElementInViewport(postEl)) {
                            VideoManager.playVideo(video);
                        }
                    }
                    return true;
                }
            }
            return false;
        }
    };

    // ============================================
    // UI
    // ============================================
    
    const UI = {
        observer: null,
        
        initIntersectionObserver() {
            if (this.observer) {
                this.observer.disconnect();
            }
            this.observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    const post = entry.target;
                    const msgId = Number(post.dataset.messageId);
                    
                    if (entry.isIntersecting) {
                        State.visiblePosts.add(msgId);
                        
                        // Загружаем медиа если нужно
                        if (!State.mediaCache.has(msgId)) {
                            MediaManager.loadMedia(msgId);
                        } else {
                            MediaManager.restoreMediaIfNeeded(msgId);
                        }
                        
                        // Видео
                        const video = post.querySelector('video');
                        if (video && video.dataset.src && !video.src) {
                            video.src = video.dataset.src;
                            delete video.dataset.src;
                            VideoManager.playVideo(video);
                        }
                    } else {
                        State.visiblePosts.delete(msgId);
                        
                        const video = post.querySelector('video');
                        if (video && !video.paused) {
                            VideoManager.pauseVideo(video);
                        }
                        
                        MediaManager.unloadMedia(msgId);
                    }
                });
            }, {
                rootMargin: `${CONFIG.LAZY_LOAD_OFFSET}px`,
                threshold: 0.01
            });
            
            document.querySelectorAll('.post').forEach(post => {
                this.observer.observe(post);
            });
        },
        
        isElementInViewport(el) {
            const rect = el.getBoundingClientRect();
            return (
                rect.top >= 0 &&
                rect.left >= 0 &&
                rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
                rect.right <= (window.innerWidth || document.documentElement.clientWidth)
            );
        },
        
        trimOldPosts() {
            const posts = document.querySelectorAll('.post');
            if (posts.length > CONFIG.MAX_VISIBLE_POSTS) {
                const toRemove = Array.from(posts).slice(0, posts.length - CONFIG.MAX_VISIBLE_POSTS);
                toRemove.forEach(el => {
                    if (this.observer) {
                        this.observer.unobserve(el);
                    }
                    const video = el.querySelector('video');
                    if (video) VideoManager.pauseVideo(video);
                    el.remove();
                });
            }
        },
        
        updateChannelInfo() {
            document.getElementById('channelTitle').textContent = CONFIG.CHANNEL_TITLE;
            document.getElementById('channelUsername').textContent = `@${CONFIG.CHANNEL_USERNAME}`;
            const avatarEl = document.getElementById('channelAvatar');
            if (avatarEl) {
                avatarEl.innerHTML = `<img src="/tg/core/avatar.svg" style="width:54px; height:54px; object-fit:cover;" alt="Channel avatar" loading="lazy">`;
            }
        },
        
        updateConnectionStatus(connected) {
            const dot = document.getElementById('statusDot');
            dot.classList.toggle('offline', !connected);
        },
        
        updateNewPostsBadge() {
            const badge = document.getElementById('newPostsBadge');
            const countSpan = document.getElementById('newPostsCount');
            if (State.newPosts.length > 0) {
                countSpan.textContent = State.newPosts.length;
                badge.classList.remove('hidden');
            } else {
                badge.classList.add('hidden');
            }
        },
        
        showSkeletonLoaders() {
            const feed = document.getElementById('feed');
            feed.innerHTML = '';
            for (let i = 0; i < 3; i++) {
                const skeleton = document.createElement('div');
                skeleton.className = 'skeleton';
                feed.appendChild(skeleton);
            }
        },
        
        renderMedia(url, type) {
            if (!url) return '';
            const fullUrl = url.startsWith('http') ? url : `${CONFIG.API_BASE}${url}`;
            
            let isVideo = false;
            let typeStr = '';
            if (type) {
                typeStr = String(type).toLowerCase();
                isVideo = typeStr.includes('video') || 
                         typeStr.includes('document') || 
                         typeStr.includes('animation') || 
                         typeStr === 'messagemediadocument' || 
                         typeStr.includes('gif') || 
                         typeStr.includes('mp4') ||
                         typeStr.includes('webm') ||
                         typeStr.includes('mov');
            } else if (fullUrl.match(/\.(mp4|webm|mov|gif)$/i)) {
                isVideo = true;
            }
            
            if (isVideo) {
                const isGifLike = 
                    fullUrl.match(/\.gif$/i) || 
                    (type && (
                        typeStr.includes('gif') || 
                        typeStr.includes('animation')
                    )) ||
                    fullUrl.includes('/gif/') ||
                    fullUrl.includes('_gif.') ||
                    fullUrl.includes('.gif?');
                
                if (isGifLike) {
                    return `
                        <div class="media-container">
                            <video 
                                src="${fullUrl}" 
                                autoplay 
                                loop 
                                muted 
                                playsinline
                                preload="${CONFIG.VIDEO_PRELOAD}"
                                style="max-width:100%; max-height:500px; background:#282c3000;">
                                Your browser does not support video.
                            </video>
                        </div>
                    `;
                } else {
                    return `
                        <div class="media-container">
                            <video 
                                src="${fullUrl}" 
                                controls 
                                preload="${CONFIG.VIDEO_PRELOAD}" 
                                playsinline
                                style="max-width:100%; max-height:500px; background:#282c3000;">
                                Your browser does not support video.
                            </video>
                        </div>
                    `;
                }
            } else {
                return `
                    <div class="media-container">
                        <img
                            src="${fullUrl}"
                            alt="Media"
                            loading="lazy"
                            decoding="async">
                    </div>
                `;
            }
        },
        
        attachMediaHandlers(postEl) {
            const videos = postEl.querySelectorAll('video');
            videos.forEach(video => {
                video.addEventListener('play', () => VideoManager.handleVideoPlay(video));
                video.addEventListener('pause', () => VideoManager.handleVideoPause(video));
            });
        },
        
        createPostElement(post) {
            const postEl = document.createElement('div');
            postEl.className = 'post';
            postEl.dataset.messageId = post.message_id;
            postEl.dataset.mediaUrl = post.media_url || '';
            
            const date = Formatters.formatDate(post.date);
            const views = Formatters.formatViews(post.views);
            const text = Formatters.formatText(post.text);
            
            let mediaHTML = '';
            
            if (post.media_url) {
                mediaHTML = this.renderMedia(post.media_url, post.media_type);
            } else if (post.has_media) {
                mediaHTML = '<div class="media-loading"><img src="/tg/core/loader.svg" alt="Loading" class="media-loader"></div>';
            }
            
            postEl.innerHTML = `
                <div class="post-content">
                    <div class="post-header">
                        <div class="post-avatar">
                            <img src="/tg/core/avatar.svg" style="width:36px; height:36px; object-fit:cover;" alt="Channel avatar" loading="lazy">
                        </div>
                        <div class="post-author-info">
                            <div class="post-author-name">
                                ${CONFIG.CHANNEL_TITLE}
                                <span class="post-username">@${CONFIG.CHANNEL_USERNAME}</span>
                            </div>
                            <div class="post-date">
                                ${date}
                                ${post.is_edited ? '<span class="edited-mark">(edited)</span>' : ''}
                            </div>
                        </div>
                    </div>
                    <div class="post-text">${text || '<i></i>'}</div>
                    ${mediaHTML}
                </div>
                <div class="post-footer">
                    <span class="views-count">👁 ${views}</span>
                </div>
            `;
            
            setTimeout(() => this.attachMediaHandlers(postEl), 0);
            
            return postEl;
        },
        
        renderPosts(posts) {
            const feed = document.getElementById('feed');
            const fragment = document.createDocumentFragment();
            
            posts.forEach(post => {
                const postEl = this.createPostElement(post);
                fragment.appendChild(postEl);
            });
            
            feed.appendChild(fragment);
            
            feed.querySelectorAll('.post').forEach(post => {
                requestAnimationFrame(() => post.classList.add('visible'));
            });
            
            if (this.observer) {
                feed.querySelectorAll('.post').forEach(post => {
                    this.observer.observe(post);
                });
            }
            
            this.trimOldPosts();
        },
        
        addPostToTop(post) {
            const messageId = post.message_id;
            
            const existingEl = document.querySelector(`.post[data-message-id="${messageId}"]`);
            if (existingEl) return;
            
            const feed = document.getElementById('feed');
            const postEl = this.createPostElement(post);
            
            if (feed.firstChild) {
                feed.insertBefore(postEl, feed.firstChild);
            } else {
                feed.appendChild(postEl);
            }
            
            State.posts.set(messageId, {...post});
            
            postEl.offsetHeight;
            requestAnimationFrame(() => {
                postEl.classList.add('visible', 'new');
            });
            
            safeSetTimeout(() => postEl.classList.remove('new'), 3000);
            
            if (this.observer) {
                this.observer.observe(postEl);
            }
            
            this.trimOldPosts();
        },
        
        setLoaderVisible(visible) {
            const trigger = document.getElementById('infiniteScrollTrigger');
            if (trigger) {
                trigger.textContent = visible ? 'Loading...' : '↓ Load more';
            }
        },
        
        showScrollTopButton(visible) {
            const btn = document.getElementById('scrollTopBtn');
            if (btn) btn.style.display = visible ? 'flex' : 'none';
        }
    };

    const Lightbox = {
        activeVideo: null,
        
        open(url, type) {
            if (!url) return;
            
            VideoManager.stopAllVideos();
            
            const lightbox = document.getElementById('lightbox');
            const content = document.getElementById('lightboxContent');
            const fullUrl = url.startsWith('http') ? url : `${CONFIG.API_BASE}${url}`;
            const isVideo = type === 'video' || type === 'Video' || url.match(/\.(mp4|webm|mov)$/i);
            
            if (isVideo) {
                content.innerHTML = `<video src="${fullUrl}" controls autoplay playsinline preload="auto"></video>`;
                this.activeVideo = content.querySelector('video');
                
                if (this.activeVideo) {
                    this.activeVideo.addEventListener('play', () => VideoManager.handleVideoPlay(this.activeVideo));
                    this.activeVideo.addEventListener('pause', () => VideoManager.handleVideoPause(this.activeVideo));
                }
            } else {
                content.innerHTML = `<img src="${fullUrl}" alt="Media">`;
            }
            
            lightbox.classList.add('active');
            document.body.style.overflow = 'hidden';
        },
        
        close() {
            const lightbox = document.getElementById('lightbox');
            lightbox.classList.remove('active');
            
            if (this.activeVideo) {
                VideoManager.pauseVideo(this.activeVideo);
                this.activeVideo = null;
            }
            
            document.getElementById('lightboxContent').innerHTML = '';
            document.body.style.overflow = '';
        }
    };

    const MessageLoader = {
        async loadMessages(reset = false) {
            if (State.isLoading) return;
            
            if (reset) {
                State.posts.clear();
                State.postOrder = [];
                State.newPosts = [];
                State.mediaCache.clear();
                document.getElementById('feed').innerHTML = '';
                State.offset = 0;
                State.hasMore = true;
            }
            
            if (!State.hasMore) {
                document.getElementById('infiniteScrollTrigger').style.display = 'none';
                return;
            }
            
            State.isLoading = true;
            UI.setLoaderVisible(true);
            
            try {
                const data = await API.fetchMessages(State.offset, CONFIG.INITIAL_LIMIT);
                
                if (data.messages && data.messages.length > 0) {
                    State.hasMore = data.hasMore !== false;
                    State.offset += data.messages.length;
                    
                    const newMessages = [];
                    data.messages.forEach(post => {
                        if (!State.posts.has(post.message_id)) {
                            State.posts.set(post.message_id, {...post});
                            State.postOrder.push(post.message_id);
                            newMessages.push(post);
                        }
                    });
                    
                    State.postOrder.sort((a, b) => b - a);
                    
                    if (newMessages.length > 0) {
                        UI.renderPosts(newMessages);
                    }
                } else {
                    State.hasMore = false;
                }
            } catch (err) {
                console.error('Error loading messages:', err);
            } finally {
                State.isLoading = false;
                UI.setLoaderVisible(false);
            }
        },
        
        async loadInitial() {
            UI.showSkeletonLoaders();
            await this.loadMessages(true);
            UI.initIntersectionObserver();
        }
    };

    async function loadInitialAndProcessPending() {
        UI.showSkeletonLoaders();
        await MessageLoader.loadMessages(true);
        
        State.initialLoadComplete = true;
        
        while (State.pendingEvents.length > 0) {
            const event = State.pendingEvents.shift();
            WebSocketManager.processFullMessage(event.data, event.type);
        }
        
        UI.initIntersectionObserver();
    }

    // ============================================
    // WebSocketManager
    // ============================================
    
    const WebSocketManager = {
        giveUp: false,
        giveUpTimer: null,
        
        connect(wsUrl = CONFIG.WS_BASE) {
            if (!this.giveUpTimer) {
                this.giveUpTimer = safeSetTimeout(() => {
                    this.giveUp = true;
                }, CONFIG.RECONNECT_GIVE_UP_DELAY);
            }
            
            try {
                State.ws = new WebSocket(wsUrl);
                
                State.ws.onopen = () => {
                    State.wsConnected = true;
                    State.wsReconnectAttempts = 0;
                    
                    if (this.giveUpTimer) {
                        clearTimeout(this.giveUpTimer);
                        this.giveUpTimer = null;
                    }
                    this.giveUp = false;
                    
                    UI.updateConnectionStatus(true);
                    
                    if (CONFIG.CHANNEL_ID) {
                        const subscribeMsg = {
                            type: 'subscribe',
                            channel_id: parseInt(CONFIG.CHANNEL_ID)
                        };
                        State.ws.send(JSON.stringify(subscribeMsg));
                    }
                    
                    if (CONFIG.SYNC_AFTER_RECONNECT && State.postOrder.length > 0) {
                        this.syncAfterReconnect();
                    }
                    
                    State.wsPingInterval = safeSetInterval(() => {
                        if (State.ws && State.ws.readyState === WebSocket.OPEN) {
                            State.ws.send(JSON.stringify({ type: 'ping' }));
                        }
                    }, CONFIG.PING_INTERVAL);
                };
                
                State.ws.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        this.handleMessage(data);
                    } catch (err) {
                        console.error('Error parsing WebSocket message:', err);
                    }
                };
                
                State.ws.onclose = () => {
                    State.wsConnected = false;
                    UI.updateConnectionStatus(false);
                    
                    if (State.wsPingInterval) {
                        clearInterval(State.wsPingInterval);
                        State.wsPingInterval = null;
                    }
                    
                    if (!this.giveUp) {
                        this.reconnect();
                    }
                };
                
                State.ws.onerror = (err) => {
                    console.error('WebSocket error:', err);
                };
            } catch (err) {
                console.error('WebSocket connection error:', err);
                if (!this.giveUp) {
                    this.reconnect();
                }
            }
        },
        
        async syncAfterReconnect() {
            const lastPostId = State.postOrder[0];
            if (!lastPostId) return;
            
            try {
                const data = await API.fetchMessagesSince(lastPostId, 50);
                if (data.posts && data.posts.length > 0) {
                    const newPosts = data.posts.reverse();
                    newPosts.forEach(post => {
                        this.processFullMessage(post, 'new');
                    });
                }
            } catch (err) {
                console.error('Sync after reconnect failed:', err);
            }
        },
        
        handleMessage(data) {
            if (data.type === 'welcome') {
                if (data.version && State.supportedVersions.includes(data.version)) {
                    State.serverVersion = data.version;
                    console.log(`Connected to server v${data.version}`);
                }
                return;
            }
            
            if (data.event_id && data.event_id > State.lastEventId) {
                State.lastEventId = data.event_id;
            }
            
            if (data.type === 'event_batch') {
                this.handleEventBatch(data);
                return;
            }
            
            if (data.channel_id !== parseInt(CONFIG.CHANNEL_ID)) return;
            
            if (!State.initialLoadComplete) {
                State.pendingEvents.push({
                    data: data.data || data,
                    type: data.type
                });
                return;
            }
            
            this.handleSingleEvent(data);
        },
        
        handleSingleEvent(data) {
            switch (data.type) {
                case 'new':
                    this.handleNewMessage(data);
                    break;
                case 'edit':
                    this.handleEditMessage(data);
                    break;
                case 'delete':
                    this.handleDeleteMessage(data);
                    break;
                case 'media_ready':
                    // Просто пробуем загрузить снова
                    MediaManager.forceLoadMedia(data.message_id);
                    break;
            }
        },
        
        handleEventBatch(batch) {
            console.log(`Processing batch of ${batch.events.length} events`);
            
            batch.events.forEach(event => {
                if (event.channel_id !== parseInt(CONFIG.CHANNEL_ID)) return;
                
                switch (event.type) {
                    case 'new':
                        this.handleNewMessage(event);
                        break;
                    case 'edit':
                        this.handleEditMessage(event);
                        break;
                    case 'delete':
                        this.handleDeleteMessage(event);
                        break;
                    case 'media_ready':
                        MediaManager.forceLoadMedia(event.message_id);
                        break;
                }
            });
        },
        
        normalizePostData(fullMessage) {
            return {
                message_id: fullMessage.message_id,
                text: fullMessage.text || '',
                date: fullMessage.date,
                views: fullMessage.views || 0,
                has_media: fullMessage.has_media || !!fullMessage.media,
                media_type: fullMessage.media?.file_type || fullMessage.media_type,
                media_url: fullMessage.media?.url || fullMessage.media_url,
                is_edited: fullMessage.is_edited || false,
                edit_date: fullMessage.edit_date
            };
        },
        
        async handleNewMessage(data) {
            if (data.data) {
                this.processFullMessage(data.data, 'new');
                return;
            }
            
            const fullMessage = await MessageAPI.fetchFullMessage(data.message_id);
            if (fullMessage) {
                this.processFullMessage(fullMessage, 'new');
            }
        },
        
        async handleEditMessage(data) {
            if (data.data) {
                this.processFullMessage(data.data, 'edit');
                return;
            }
            
            MessageAPI.invalidateMessage(data.message_id);
            
            const fullMessage = await MessageAPI.fetchFullMessage(data.message_id);
            if (fullMessage) {
                this.processFullMessage(fullMessage, 'edit');
            }
        },
        
        handleDeleteMessage(data) {
            State.posts.delete(data.message_id);
            const index = State.postOrder.indexOf(data.message_id);
            if (index !== -1) State.postOrder.splice(index, 1);
            
            const postEl = document.querySelector(`.post[data-message-id="${data.message_id}"]`);
            if (postEl) postEl.remove();
        },
        
        processFullMessage(fullMessage, type = 'new') {
            const messageId = fullMessage.message_id;
            
            const post = this.normalizePostData(fullMessage);
            
            if (document.querySelector(`.post[data-message-id="${messageId}"]`)) {
                return;
            }
            
            if (window.scrollY < 400) {
                UI.addPostToTop(post);
            } else {
                State.newPosts.push(post);
                UI.updateNewPostsBadge();
            }
        },
        
        flushNewPosts() {
            if (State.newPosts.length === 0) return;
            
            const postsToFlush = [...State.newPosts].sort((a, b) => b.message_id - a.message_id);
            
            State.newPosts = [];
            UI.updateNewPostsBadge();
            
            postsToFlush.forEach(post => {
                UI.addPostToTop(post);
            });
        },
        
        reconnect() {
            if (this.giveUp || State.wsReconnectAttempts >= CONFIG.MAX_RECONNECT_ATTEMPTS) {
                return;
            }
            
            State.wsReconnectAttempts++;
            
            const baseDelay = Math.min(
                CONFIG.RECONNECT_BASE_DELAY * Math.pow(1.5, State.wsReconnectAttempts), 
                30000
            );
            
            const delay = Math.max(1000, baseDelay);
            
            safeSetTimeout(() => {
                if (!State.wsConnected && !this.giveUp) {
                    this.connect(CONFIG.WS_BASE);
                }
            }, delay);
        }
    };

    const ScrollHandler = {
        init() {
            State.lastDocumentHeight = document.documentElement.scrollHeight;
            
            State.resizeObserver = new ResizeObserver(() => {
                State.lastDocumentHeight = document.documentElement.scrollHeight;
            });
            State.resizeObserver.observe(document.documentElement);
            
            window.addEventListener('scroll', this.throttledHandle.bind(this), { passive: true });
        },
        
        handle(scrollY) {
            UI.showScrollTopButton(scrollY > 500);
            
            if (scrollY + window.innerHeight >= State.lastDocumentHeight - 500) {
                this.debouncedLoadMore();
            }
            
            if (scrollY < 200 && State.newPosts.length > 0) {
                WebSocketManager.flushNewPosts();
            }
        },
        
        throttledHandle: (() => {
            let ticking = false;
            let lastScrollY = 0;
            return function() {
                lastScrollY = window.scrollY;
                if (!ticking) {
                    requestAnimationFrame(() => {
                        this.handle(lastScrollY);
                        ticking = false;
                    });
                    ticking = true;
                }
            };
        })(),
        
        debouncedLoadMore: debounce(() => {
            if (!State.isLoading && State.hasMore) {
                MessageLoader.loadMessages();
            }
        }, 300, { leading: true, trailing: false })
    };

    function init() {
        window.__videoManager = VideoManager;
        
        ThemeManager.init();
        UI.updateChannelInfo();
        
        CacheManager.startCleanupInterval();
        
        loadInitialAndProcessPending();
        
        WebSocketManager.connect();
        ScrollHandler.init();

        document.getElementById('feed').addEventListener('click', (e) => {
            const container = e.target.closest('.media-container');
            if (container) {
                const post = container.closest('.post');
                if (post && post.dataset.mediaUrl) {
                    Lightbox.open(post.dataset.mediaUrl, post.dataset.mediaType);
                    e.preventDefault();
                    e.stopPropagation();
                }
            }
        });

        document.getElementById('channelAvatar').addEventListener('click', () => ThemeManager.toggle());
        
        document.getElementById('newPostsBadge').addEventListener('click', () => {
            WebSocketManager.flushNewPosts();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
        
        document.getElementById('scrollTopBtn').addEventListener('click', () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
        
        document.getElementById('lightboxClose').addEventListener('click', Lightbox.close);
        
        document.getElementById('lightbox').addEventListener('click', (e) => {
            if (e.target === document.getElementById('lightbox')) Lightbox.close();
        });
        
        window.addEventListener('online', () => {
            console.log('Network is online');
            MediaManager.loadVisibleMedia();
        });
        
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && State.newPosts.length > 0) {
                WebSocketManager.flushNewPosts();
            }
        });
        
        window.addEventListener('beforeunload', () => {
            cleanupResources();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();