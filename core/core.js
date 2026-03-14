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
            return apiBase.replace('http://', 'ws://').replace('https://', 'wss://');
        })(),
        SYNC_AFTER_RECONNECT: true,
        PING_INTERVAL: 30000,
        API_VERSION: 'v1',
        RECONNECT_GIVE_UP_DELAY: 300000,
        MAX_CACHE_SIZE: 200,
        MAX_MEDIA_CACHE_SIZE: 100,
        CLEANUP_INTERVAL: 60000,
        MEDIA_MAX_RETRIES: 5,
        MEDIA_RETRY_DELAY: 2000,
        // Новая конфигурация для поддержки статусов медиа
        SUPPORTS_MEDIA_STATUS: true,
        MEDIA_STATUS_POLL_INTERVAL: 5000
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
        mediaCache: new Map(),
        mediaErrorCache: new Set(),
        mediaLoading: new Set(),
        mediaPending: new Map(),
        mediaRetryCount: new Map(),
        mediaRetryTimeouts: new Map(),
        // Новое: хранилище статусов медиа
        mediaStatusStore: new Map(), // media_id -> {status, progress, lastUpdate}
        scrollTimeout: null,
        recentMessages: new Map(),
        lastDocumentHeight: 0,
        theme: localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
        visiblePosts: new Set(),
        isTransitioning: false,
        pendingTheme: null,
        domCache: null,
        scrollPosition: 0,
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
        batchProcessed: new Set(),
        pendingEdits: new Set(),
        pendingNews: new Set(),
        // Новое: поддерживаемые версии протокола
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
        
        if (State.resizeObserver) {
            State.resizeObserver.disconnect();
            State.resizeObserver = null;
        }
        
        if (State.wsPingInterval) {
            clearInterval(State.wsPingInterval);
            State.wsPingInterval = null;
        }
        
        State.mediaRetryTimeouts.forEach(clearTimeout);
        State.mediaRetryTimeouts.clear();
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
            
            // Очистка старых статусов медиа
            for (const [mediaId, data] of State.mediaStatusStore.entries()) {
                if (now - data.lastUpdate > 300000) { // 5 минут
                    State.mediaStatusStore.delete(mediaId);
                }
            }
            
            const ttl = CONFIG.DEDUP_TTL * 2;
            for (const [key, time] of State.recentMessages.entries()) {
                if (now - time > ttl) {
                    State.recentMessages.delete(key);
                }
            }
            
            const fiveMinutesAgo = now - 300000;
            for (const [messageId, data] of State.mediaPending.entries()) {
                if (data.timestamp < fiveMinutesAgo) {
                    State.mediaPending.delete(messageId);
                    State.mediaRetryCount.delete(messageId);
                }
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

    const throttle = (fn, limit) => {
        let inThrottle;
        return function(...args) {
            if (!inThrottle) {
                fn.apply(this, args);
                inThrottle = true;
                safeSetTimeout(() => inThrottle = false, limit);
            }
        };
    };

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
        },
        
        async fetchMediaOnce(messageId) {
            if (!Security.validateMessageId(messageId)) return null;
            if (State.mediaCache.has(messageId)) return State.mediaCache.get(messageId);
            
            try {
                const url = `${CONFIG.API_BASE}/api/media/by-message/${messageId}?channel_id=${CONFIG.CHANNEL_ID}`;
                const response = await fetch(url);
                
                if (!response.ok) {
                    if (response.status === 404) {
                        return { error: 'not_found', status: 404, retry: true };
                    }
                    throw new Error(`HTTP ${response.status}`);
                }
                
                const data = await response.json();
                if (data && data.url) {
                    State.mediaCache.set(messageId, data);
                    
                    if (State.mediaCache.size > CONFIG.MAX_MEDIA_CACHE_SIZE * 1.2) {
                        CacheManager.cleanup();
                    }
                    
                    return data;
                }
            } catch (err) {
                console.error(`Error fetching media for ${messageId}:`, err);
                return { error: err.message, retry: true };
            }
            return null;
        },
        
        // НОВЫЙ: Получение статуса медиа
        async fetchMediaStatus(messageId) {
            if (!Security.validateMessageId(messageId)) return null;
            
            try {
                const url = `${CONFIG.API_BASE}/api/media/status/${messageId}?channel_id=${CONFIG.CHANNEL_ID}`;
                const response = await fetch(url);
                
                if (!response.ok) {
                    if (response.status === 404) return null;
                    throw new Error(`HTTP ${response.status}`);
                }
                
                return await response.json();
            } catch (err) {
                console.error(`Error fetching media status for ${messageId}:`, err);
                return null;
            }
        },
        
        clearMediaCache() {
            State.mediaCache.clear();
            State.mediaErrorCache.clear();
            State.mediaPending.clear();
            State.mediaRetryCount.clear();
            State.mediaRetryTimeouts.forEach(clearTimeout);
            State.mediaRetryTimeouts.clear();
            State.mediaStatusStore.clear();
        }
    };

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
            if (State.isTransitioning) {
                State.pendingTheme = State.theme === 'dark' ? 'light' : 'dark';
                return;
            }
            State.isTransitioning = true;
            
            this.hideVideo();
            
            const newTheme = State.theme === 'dark' ? 'light' : 'dark';
            requestAnimationFrame(() => {
                State.theme = newTheme;
                localStorage.setItem('theme', newTheme);
                this.applyTheme(newTheme, true);
                State.isTransitioning = false;
                if (State.pendingTheme) {
                    const temp = State.pendingTheme;
                    State.pendingTheme = null;
                    State.theme = temp;
                    this.toggle();
                }
            });
        }
    };

    // ============================================
    // УЛУЧШЕННЫЙ MediaManager с поддержкой статусов
    // ============================================
    
    const MediaManager = {
        replaceMediaContainer(postEl, html, messageId) {
            const old = postEl.querySelector('.media-container, .media-loading, .media-unavailable, .media-placeholder, .media-pending, .media-processing');
            if (!old) return null;
            
            old.outerHTML = html;
            
            const newContainer = postEl.querySelector('.media-container');
            if (newContainer) {
                newContainer.replaceWith(newContainer.cloneNode(true));
                const freshContainer = postEl.querySelector('.media-container');
                freshContainer.dataset.messageId = messageId;
            }
            
            return postEl.querySelector('.media-container');
        },
        
        // НОВЫЙ: Обновление UI на основе статуса
        updateMediaStatus(messageId, status, progress) {
            const postEl = document.querySelector(`.post[data-message-id="${messageId}"]`);
            if (!postEl) return false;
            
            const mediaContainer = postEl.querySelector('.media-container, .media-loading, .media-pending, .media-processing, .media-unavailable');
            
            if (!mediaContainer) {
                // Если контейнера нет, но есть статус - создаем
                if (status !== 'ready') {
                    const postContent = postEl.querySelector('.post-content');
                    if (postContent) {
                        let statusHTML = '';
                        switch(status) {
                            case 'downloading':
                                statusHTML = `<div class="media-processing">📥 Downloading... ${progress}%</div>`;
                                break;
                            case 'processing':
                                statusHTML = `<div class="media-processing">⚙️ Processing... ${progress}%</div>`;
                                break;
                            case 'uploading':
                                statusHTML = `<div class="media-processing">☁️ Uploading to CDN... ${progress}%</div>`;
                                break;
                            case 'failed':
                                statusHTML = `<div class="media-unavailable">❌ Media failed to load</div>`;
                                break;
                            default:
                                statusHTML = `<div class="media-loading"><img src="/tg/core/loader.svg" alt="Loading" class="media-loader"></div>`;
                        }
                        postContent.insertAdjacentHTML('beforeend', statusHTML);
                    }
                }
                return true;
            }
            
            // Обновляем существующий контейнер
            if (status === 'ready') {
                // Если статус ready, но медиа еще не загружено - запрашиваем
                const post = State.posts.get(messageId);
                if (post && !post.media_url) {
                    this.loadMedia(messageId);
                }
            } else if (status === 'downloading' || status === 'processing' || status === 'uploading') {
                if (mediaContainer.classList.contains('media-loading') || 
                    mediaContainer.classList.contains('media-pending')) {
                    mediaContainer.outerHTML = `<div class="media-processing">${this.getStatusText(status)} ${progress}%</div>`;
                } else if (mediaContainer.classList.contains('media-processing')) {
                    mediaContainer.textContent = `${this.getStatusText(status)} ${progress}%`;
                }
            } else if (status === 'failed') {
                mediaContainer.outerHTML = '<div class="media-unavailable">❌ Media failed to load</div>';
                State.mediaErrorCache.add(messageId);
            }
            
            return true;
        },
        
        getStatusText(status) {
            switch(status) {
                case 'downloading': return '📥 Downloading';
                case 'processing': return '⚙️ Processing';
                case 'uploading': return '☁️ Uploading to CDN';
                default: return '⏳ Processing';
            }
        },
        
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
                        
                        if (!mediaContainer.querySelector('.media-placeholder')) {
                            const placeholder = document.createElement('div');
                            placeholder.className = 'media-placeholder';
                            placeholder.textContent = '📹';
                            mediaContainer.appendChild(placeholder);
                        }
                        return true;
                    }
                    
                    const img = mediaContainer.querySelector('img');
                    if (img) {
                        img.dataset.src = img.src;
                        img.style.display = 'none';
                        mediaContainer.classList.add('media-unloaded');
                        
                        if (!mediaContainer.querySelector('.media-placeholder')) {
                            const placeholder = document.createElement('div');
                            placeholder.className = 'media-placeholder';
                            placeholder.textContent = '📷';
                            mediaContainer.appendChild(placeholder);
                        }
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
                const post = State.posts.get(messageId);
                if (post && post.media_url) {
                    const placeholder = mediaContainer.querySelector('.media-placeholder');
                    if (placeholder) placeholder.remove();
                    
                    const html = UI.renderMedia(post.media_url, post.media_type);
                    this.replaceMediaContainer(postEl, html, messageId);
                    
                    const newVideo = postEl.querySelector('video');
                    if (newVideo && UI.isElementInViewport(postEl)) {
                        VideoManager.playVideo(newVideo);
                    }
                    return true;
                }
            }
            return false;
        },
        
        retryMedia(messageId) {
            if (State.mediaRetryTimeouts.has(messageId)) {
                clearTimeout(State.mediaRetryTimeouts.get(messageId));
                State.mediaRetryTimeouts.delete(messageId);
            }
            
            const retryCount = State.mediaRetryCount.get(messageId) || 0;
            
            if (retryCount >= CONFIG.MEDIA_MAX_RETRIES) {
                UI.updatePostMediaUnavailable(messageId, 'max_retries');
                State.mediaRetryCount.delete(messageId);
                return;
            }
            
            const delay = CONFIG.MEDIA_RETRY_DELAY * Math.pow(1.5, retryCount) + (Math.random() * 1000);
            
            const timeoutId = safeSetTimeout(() => {
                State.mediaRetryTimeouts.delete(messageId);
                this.loadMedia(messageId, true);
            }, delay);
            
            State.mediaRetryTimeouts.set(messageId, timeoutId);
        },
        
        loadMedia(messageId, isRetry = false) {
            if (State.mediaLoading.has(messageId)) {
                return;
            }
            
            const post = State.posts.get(messageId);
            if (!post || !post.has_media) return;
            
            if (post.media_url) return;
            if (State.mediaErrorCache.has(messageId)) return;
            
            // Проверяем статус из хранилища
            const statusInfo = State.mediaStatusStore.get(messageId);
            if (statusInfo) {
                this.updateMediaStatus(messageId, statusInfo.status, statusInfo.progress);
                
                // Если статус 'processing' или 'uploading', планируем повторную проверку
                if (statusInfo.status === 'processing' || statusInfo.status === 'uploading') {
                    safeSetTimeout(() => {
                        this.loadMedia(messageId);
                    }, CONFIG.MEDIA_STATUS_POLL_INTERVAL);
                    return;
                }
            }
            
            if (isRetry) {
                const postEl = document.querySelector(`.post[data-message-id="${messageId}"]`);
                if (postEl) {
                    const pendingEl = postEl.querySelector('.media-pending, .media-loading, .media-processing');
                    if (!pendingEl) {
                        const unavailableEl = postEl.querySelector('.media-unavailable');
                        if (unavailableEl) {
                            unavailableEl.outerHTML = '<div class="media-loading"><img src="/tg/core/loader.svg" alt="Loading" class="media-loader"></div>';
                        }
                    }
                }
            }
            
            State.mediaLoading.add(messageId);
            
            API.fetchMediaOnce(messageId).then(mediaInfo => {
                State.mediaLoading.delete(messageId);
                
                if (mediaInfo && mediaInfo.url) {
                    post.media_url = mediaInfo.url;
                    post.media_type = mediaInfo.file_type || post.media_type;
                    UI.updatePost(messageId, {
                        media_url: mediaInfo.url,
                        media_type: post.media_type
                    });
                    State.mediaRetryCount.delete(messageId);
                    State.mediaStatusStore.delete(messageId);
                    return;
                }
                
                if (mediaInfo && mediaInfo.error === 'not_found') {
                    // Проверяем статус через API
                    API.fetchMediaStatus(messageId).then(statusInfo => {
                        if (statusInfo && statusInfo.exists) {
                            if (statusInfo.status) {
                                this.updateMediaStatus(messageId, statusInfo.status, statusInfo.progress || 0);
                                
                                // Если не ready, планируем повторную проверку
                                if (statusInfo.status !== 'ready') {
                                    State.mediaStatusStore.set(messageId, {
                                        status: statusInfo.status,
                                        progress: statusInfo.progress || 0,
                                        lastUpdate: Date.now()
                                    });
                                    
                                    safeSetTimeout(() => {
                                        this.loadMedia(messageId);
                                    }, CONFIG.MEDIA_STATUS_POLL_INTERVAL);
                                }
                            }
                        } else {
                            // Статус не найден - пробуем повторить
                            const currentRetries = State.mediaRetryCount.get(messageId) || 0;
                            State.mediaRetryCount.set(messageId, currentRetries + 1);
                            
                            const postEl = document.querySelector(`.post[data-message-id="${messageId}"]`);
                            if (postEl) {
                                const container = postEl.querySelector('.media-loading, .media-pending');
                                if (!container) {
                                    const postContent = postEl.querySelector('.post-content');
                                    if (postContent && !postContent.querySelector('.media-loading, .media-pending')) {
                                        postContent.insertAdjacentHTML('beforeend', '<div class="media-loading"><img src="/tg/core/loader.svg" alt="Loading" class="media-loader"></div>');
                                    }
                                }
                            }
                            
                            this.retryMedia(messageId);
                        }
                    });
                    return;
                }
                
                const currentRetries = State.mediaRetryCount.get(messageId) || 0;
                State.mediaRetryCount.set(messageId, currentRetries + 1);
                
                if (currentRetries < CONFIG.MEDIA_MAX_RETRIES - 1) {
                    this.retryMedia(messageId);
                } else {
                    UI.updatePostMediaUnavailable(messageId, 'error');
                }
                
            }).catch(() => {
                State.mediaLoading.delete(messageId);
                
                const currentRetries = State.mediaRetryCount.get(messageId) || 0;
                State.mediaRetryCount.set(messageId, currentRetries + 1);
                
                if (currentRetries < CONFIG.MEDIA_MAX_RETRIES - 1) {
                    this.retryMedia(messageId);
                } else {
                    UI.updatePostMediaUnavailable(messageId, 'error');
                }
            });
        },
        
        handleMediaReady(messageId, mediaUrl, mediaType) {
            const post = State.posts.get(messageId);
            if (post) {
                post.media_url = mediaUrl;
                post.media_type = mediaType || post.media_type;
                UI.updatePost(messageId, { 
                    media_url: mediaUrl, 
                    media_type: post.media_type 
                });
            }
            
            State.mediaPending.delete(messageId);
            State.mediaLoading.delete(messageId);
            State.mediaRetryCount.delete(messageId);
            State.mediaStatusStore.delete(messageId);
            
            if (State.mediaRetryTimeouts.has(messageId)) {
                clearTimeout(State.mediaRetryTimeouts.get(messageId));
                State.mediaRetryTimeouts.delete(messageId);
            }
            
            State.mediaCache.set(messageId, { url: mediaUrl, file_type: mediaType });
            
            if (State.mediaCache.size > CONFIG.MAX_MEDIA_CACHE_SIZE * 1.2) {
                CacheManager.cleanup();
            }
        },
        
        // НОВЫЙ: Обработка статуса медиа
        handleMediaStatus(messageId, status, progress, mediaId) {
            const post = State.posts.get(messageId);
            if (!post || !post.has_media) return;
            
            // Сохраняем статус
            State.mediaStatusStore.set(messageId, {
                status,
                progress,
                mediaId,
                lastUpdate: Date.now()
            });
            
            // Обновляем UI
            this.updateMediaStatus(messageId, status, progress);
            
            // Если статус 'ready' - загружаем медиа
            if (status === 'ready') {
                safeSetTimeout(() => {
                    this.loadMedia(messageId);
                }, 500);
            }
        },
        
        showMediaPending(messageId) {
            const postEl = document.querySelector(`.post[data-message-id="${messageId}"]`);
            if (!postEl) return;
            
            const container = postEl.querySelector('.media-loading, .media-container, .media-unavailable, .media-pending');
            if (container) {
                container.outerHTML = '<div class="media-pending">⏳ Media processing...</div>';
            } else {
                const postContent = postEl.querySelector('.post-content');
                if (postContent) {
                    postContent.insertAdjacentHTML('beforeend', '<div class="media-pending">⏳ Media processing...</div>');
                }
            }
        }
    };

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
                        MediaManager.loadMedia(msgId);
                        MediaManager.restoreMediaIfNeeded(msgId);
                        
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
        
        cacheDOM() {
            const posts = document.querySelectorAll('.post');
            if (posts.length === 0) return;
            
            const postsToCache = Array.from(posts).slice(-20);
            const fragment = document.createDocumentFragment();
            postsToCache.forEach(post => {
                fragment.appendChild(post.cloneNode(true));
            });
            State.domCache = fragment;
            State.scrollPosition = window.scrollY;
        },
        
        restoreDOM() {
            if (!State.domCache) return false;
            const feed = document.getElementById('feed');
            feed.innerHTML = '';
            feed.appendChild(State.domCache.cloneNode(true));
            
            feed.querySelectorAll('.post').forEach(post => {
                const originalPost = State.posts.get(Number(post.dataset.messageId));
                if (originalPost) {
                    post.dataset.mediaUrl = originalPost.media_url || '';
                    post.dataset.mediaType = originalPost.media_type || '';
                }
                requestAnimationFrame(() => {
                    post.classList.add('visible');
                });
            });
            
            this.initIntersectionObserver();
            return true;
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
                                preload="auto"
                                style="max-width:100%; max-height:500px; background:#282c3000;"
                                onplay="window.__videoManager?.handleVideoPlay(this)"
                                onpause="window.__videoManager?.handleVideoPause(this)">
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
                                preload="metadata" 
                                playsinline
                                style="max-width:100%; max-height:500px; background:#282c3000;"
                                onplay="window.__videoManager?.handleVideoPlay(this)"
                                onpause="window.__videoManager?.handleVideoPause(this)">
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
                            decoding="async"
                            onerror="this.onerror=null; this.parentElement.innerHTML='<div class=\\'media-error\\'>📷 Failed to load image</div>';"
                        >
                    </div>
                `;
            }
        },
        
        createPostElement(post) {
            const postEl = document.createElement('div');
            postEl.className = 'post';
            postEl.dataset.messageId = post.message_id;
            postEl.dataset.mediaUrl = post.media_url || '';
            postEl.dataset.mediaType = post.media_type || '';
            
            const date = Formatters.formatDate(post.date);
            const views = Formatters.formatViews(post.views);
            const text = Formatters.formatText(post.text);
            
            let mediaHTML = '';
            if (post.media_url) {
                mediaHTML = this.renderMedia(post.media_url, post.media_type);
            } else if (post.has_media) {
                // Проверяем статус из хранилища
                const statusInfo = State.mediaStatusStore.get(post.message_id);
                if (statusInfo) {
                    switch(statusInfo.status) {
                        case 'downloading':
                            mediaHTML = `<div class="media-processing">📥 Downloading... ${statusInfo.progress}%</div>`;
                            break;
                        case 'processing':
                            mediaHTML = `<div class="media-processing">⚙️ Processing... ${statusInfo.progress}%</div>`;
                            break;
                        case 'uploading':
                            mediaHTML = `<div class="media-processing">☁️ Uploading to CDN... ${statusInfo.progress}%</div>`;
                            break;
                        case 'failed':
                            mediaHTML = '<div class="media-unavailable">❌ Media failed to load</div>';
                            break;
                        default:
                            mediaHTML = '<div class="media-loading"><img src="/tg/core/loader.svg" alt="Loading" class="media-loader"></div>';
                    }
                } else {
                    const retryCount = State.mediaRetryCount.get(post.message_id) || 0;
                    if (retryCount >= CONFIG.MEDIA_MAX_RETRIES) {
                        mediaHTML = '<div class="media-unavailable">📷 Media unavailable</div>';
                    } else {
                        mediaHTML = '<div class="media-loading"><img src="/tg/core/loader.svg" alt="Loading" class="media-loader"></div>';
                    }
                }
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
            
            return postEl;
        },
        
        updatePost(messageId, data, options = {}) {
            const postEl = document.querySelector(`.post[data-message-id="${messageId}"]`);
            if (!postEl) {
                if (data.media_url) {
                    State.mediaPending.set(messageId, {
                        media_url: data.media_url,
                        media_type: data.media_type,
                        timestamp: Date.now()
                    });
                }
                return false;
            }
            
            const currentPost = State.posts.get(Number(messageId));
            
            if (currentPost) {
                const hasChanges = 
                    (data.edit_date && currentPost.edit_date !== data.edit_date) ||
                    (data.text !== undefined && currentPost.text !== data.text) ||
                    (data.views !== undefined && currentPost.views !== data.views) ||
                    (data.forwards !== undefined && currentPost.forwards !== data.forwards) ||
                    (data.media_url && currentPost.media_url !== data.media_url);
                
                if (!hasChanges) {
                    return false;
                }
                
                State.posts.set(Number(messageId), {...currentPost, ...data});
            }
            
            let changed = false;
            
            if (data.text !== undefined) {
                const textEl = postEl.querySelector('.post-text');
                if (textEl) {
                    const newText = Formatters.formatText(data.text || '');
                    if (textEl.innerHTML !== newText) {
                        textEl.innerHTML = newText;
                        changed = true;
                    }
                }
            }
            
            if (data.edit_date) {
                const dateEl = postEl.querySelector('.post-date');
                if (dateEl) {
                    const newDate = Formatters.formatDate(data.edit_date);
                    if (!dateEl.innerHTML.includes(newDate)) {
                        dateEl.innerHTML = newDate;
                        if (!dateEl.innerHTML.includes('(edited)')) {
                            dateEl.innerHTML += ' <span class="edited-mark">(edited)</span>';
                        }
                        changed = true;
                    }
                }
            }
            
            if (data.views !== undefined) {
                const viewsEl = postEl.querySelector('.views-count');
                if (viewsEl) {
                    const newViews = `👁 ${Formatters.formatViews(data.views)}`;
                    if (viewsEl.textContent !== newViews) {
                        viewsEl.textContent = newViews;
                        changed = true;
                    }
                }
            }
            
            if (data.forwards !== undefined) {
                const forwardsEl = postEl.querySelector('.forwards-count');
                if (forwardsEl) {
                    const newForwards = `🔁 ${data.forwards}`;
                    if (forwardsEl.textContent !== newForwards) {
                        forwardsEl.textContent = newForwards;
                        changed = true;
                    }
                }
            }
            
            if (data.media_url) {
                const mediaContainer = postEl.querySelector('.media-container, .media-loading, .media-unavailable, .media-pending, .media-processing');
                if (mediaContainer) {
                    const video = mediaContainer.querySelector('video');
                    if (video) VideoManager.pauseVideo(video);
                    
                    const newMedia = this.renderMedia(data.media_url, data.media_type);
                    MediaManager.replaceMediaContainer(postEl, newMedia, messageId);
                    
                    postEl.dataset.mediaUrl = data.media_url;
                    postEl.dataset.mediaType = data.media_type || '';
                    changed = true;
                } else {
                    const postContent = postEl.querySelector('.post-content');
                    if (postContent) {
                        const newMedia = this.renderMedia(data.media_url, data.media_type);
                        postContent.insertAdjacentHTML('beforeend', newMedia);
                        
                        postEl.dataset.mediaUrl = data.media_url;
                        postEl.dataset.mediaType = data.media_type || '';
                        changed = true;
                    }
                }
            }
            
            if (changed && !options.batch) {
                postEl.classList.add('updated');
                safeSetTimeout(() => postEl.classList.remove('updated'), 2000);
            }
            
            return changed;
        },
        
        updatePostQuiet(messageId, data) {
            return this.updatePost(messageId, data, { batch: true });
        },
        
        updatePostMediaUnavailable(messageId, reason = 'failed') {
            const postEl = document.querySelector(`.post[data-message-id="${messageId}"]`);
            if (!postEl) return false;
            
            const mediaContainer = postEl.querySelector('.media-loading, .media-pending, .media-container, .media-processing');
            if (mediaContainer) {
                const video = mediaContainer.querySelector('video');
                if (video) VideoManager.pauseVideo(video);
                
                let message = '📷 Media unavailable';
                switch(reason) {
                    case 'timeout':
                        message = '⏱️ Media took too long to load';
                        break;
                    case 'not_found':
                        message = '📷 Media not found';
                        break;
                    case 'max_retries':
                        message = '📷 Media failed to load after multiple attempts';
                        break;
                    case 'error':
                        message = '📷 Error loading media';
                        break;
                }
                mediaContainer.outerHTML = `<div class="media-unavailable">${message}</div>`;
                State.mediaErrorCache.add(Number(postEl.dataset.messageId));
                return true;
            }
            
            return false;
        },
        
        deletePost(messageId) {
            const postEl = document.querySelector(`.post[data-message-id="${messageId}"]`);
            if (!postEl) return false;
            
            if (this.observer) {
                this.observer.unobserve(postEl);
            }
            
            const video = postEl.querySelector('video');
            if (video) VideoManager.pauseVideo(video);
            
            postEl.classList.add('deleted');
            
            safeSetTimeout(() => {
                postEl.remove();
                State.posts.delete(messageId);
                const index = State.postOrder.indexOf(Number(messageId));
                if (index !== -1) State.postOrder.splice(index, 1);
                State.mediaPending.delete(messageId);
                State.mediaLoading.delete(messageId);
                State.mediaRetryCount.delete(messageId);
                State.mediaStatusStore.delete(messageId);
                State.fullMessageCache.delete(messageId);
            }, 300);
            
            return true;
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
            
            posts.forEach(post => {
                if (post.has_media && !post.media_url) {
                    safeSetTimeout(() => {
                        MediaManager.loadMedia(post.message_id);
                    }, 500);
                }
            });
        },
        
        addPostToTop(post) {
            const messageId = post.message_id;
            
            const existingEl = document.querySelector(`.post[data-message-id="${messageId}"]`);
            if (existingEl) {
                if (State.posts.has(messageId)) {
                    const currentPost = State.posts.get(messageId);
                    if (currentPost.text !== post.text || 
                        currentPost.media_url !== post.media_url ||
                        currentPost.views !== post.views) {
                        this.updatePost(messageId, post);
                    }
                }
                return;
            }
            
            if (State.posts.has(messageId)) {
                State.posts.delete(messageId);
                const index = State.postOrder.indexOf(messageId);
                if (index !== -1) State.postOrder.splice(index, 1);
            }
            
            const queueIndex = State.newPosts.findIndex(p => p.message_id === messageId);
            if (queueIndex !== -1) {
                State.newPosts.splice(queueIndex, 1);
            }
            
            const feed = document.getElementById('feed');
            const postEl = this.createPostElement(post);
            
            let inserted = false;
            for (const child of feed.children) {
                const childId = parseInt(child.dataset.messageId);
                if (childId < messageId) {
                    feed.insertBefore(postEl, child);
                    inserted = true;
                    break;
                }
            }
            
            if (!inserted) {
                if (feed.firstChild) {
                    feed.insertBefore(postEl, feed.firstChild);
                } else {
                    feed.appendChild(postEl);
                }
            }
            
            State.posts.set(messageId, {...post});
            if (!State.postOrder.includes(messageId)) {
                State.postOrder.unshift(messageId);
                State.postOrder.sort((a, b) => b - a);
            }
            
            postEl.offsetHeight;
            requestAnimationFrame(() => {
                postEl.classList.add('visible', 'new');
            });
            
            safeSetTimeout(() => postEl.classList.remove('new'), 3000);
            
            if (this.observer) {
                this.observer.observe(postEl);
            }
            
            this.trimOldPosts();
            
            if (post.has_media && !post.media_url) {
                safeSetTimeout(() => {
                    MediaManager.loadMedia(messageId);
                }, 500);
            }
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
        },
        
        cleanup() {
            if (this.observer) {
                this.observer.disconnect();
                this.observer = null;
            }
            VideoManager.stopAllVideos();
            API.clearMediaCache();
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
                content.innerHTML = `<video src="${fullUrl}" controls autoplay playsinline 
                    onplay="window.__videoManager?.handleVideoPlay(this)"
                    onpause="window.__videoManager?.handleVideoPause(this)"></video>`;
                this.activeVideo = content.querySelector('video');
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
                UI.cacheDOM();
                UI.cleanup();
                State.posts.clear();
                State.postOrder = [];
                State.mediaPending.clear();
                State.mediaLoading.clear();
                State.mediaRetryCount.clear();
                State.mediaStatusStore.clear();
                State.mediaRetryTimeouts.forEach(clearTimeout);
                State.mediaRetryTimeouts.clear();
                document.getElementById('feed').innerHTML = '';
                State.offset = 0;
                State.hasMore = true;
                API.clearMediaCache();
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
                    
                    data.messages.forEach(post => {
                        if (post.has_media && !State.mediaErrorCache.has(post.message_id)) {
                            MediaManager.loadMedia(post.message_id);
                        }
                    });
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
    // ИСПРАВЛЕННЫЙ WebSocketManager с поддержкой v3.0
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
        
        // ОСНОВНОЙ ОБРАБОТЧИК - исправлен для поддержки v3.0
        handleMessage(data) {
            // Обработка welcome сообщения
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
            
            // Обработка batch-сообщений
            if (data.type === 'event_batch') {
                this.handleEventBatch(data);
                return;
            }
            
            // Пропускаем служебные сообщения
            if (['ping', 'pong', 'heartbeat', 'buffering', 
                 'flush_start', 'flush_complete', 'subscribed', 'error'].includes(data.type)) {
                return;
            }
            
            // Проверка версии - поддерживаем 2.0 и 3.0
            if (data.version && !State.supportedVersions.includes(data.version)) {
                return;
            }
            
            // Проверка канала
            if (data.channel_id !== parseInt(CONFIG.CHANNEL_ID)) return;
            
            // Если начальная загрузка не завершена, сохраняем в очередь
            if (!State.initialLoadComplete) {
                State.pendingEvents.push({
                    data: data.data || data,
                    type: data.type
                });
                return;
            }
            
            // Дедупликация для одиночных событий
            const messageKey = `${data.channel_id}-${data.message_id}-${data.type}`;
            const lastReceived = State.recentMessages.get(messageKey);
            const ttl = data.type === 'edit' ? 2000 : CONFIG.DEDUP_TTL;
            
            if (lastReceived && (Date.now() - lastReceived < ttl)) {
                return;
            }
            
            State.recentMessages.set(messageKey, Date.now());
            
            // Обработка по типу
            this.handleSingleEvent(data);
        },
        
        // Обработка одиночных событий
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
                    this.handleMediaReady(data);
                    break;
                case 'media_status': // НОВЫЙ тип
                    this.handleMediaStatus(data);
                    break;
            }
        },
        
        // НОВЫЙ: Обработка статусов медиа
        handleMediaStatus(data) {
            console.log(`Media status: msg=${data.message_id}, status=${data.status}, progress=${data.progress}%`);
            MediaManager.handleMediaStatus(
                data.message_id, 
                data.status, 
                data.progress, 
                data.media_id
            );
        },
        
        // Обработка batch-событий (оптимизированная)
        handleEventBatch(batch) {
            console.log(`Processing batch of ${batch.events.length} events, is_replay: ${batch.is_replay}`);
            
            // Группируем события по типу
            const edits = [];
            const news = [];
            const deletes = [];
            const mediaReadies = [];
            const mediaStatuses = []; // НОВЫЙ
            
            batch.events.forEach(event => {
                if (event.channel_id !== parseInt(CONFIG.CHANNEL_ID)) return;
                
                // Проверка версии
                if (event.version && !State.supportedVersions.includes(event.version)) return;
                
                // Дедупликация внутри batch
                const messageKey = `${event.channel_id}-${event.message_id}-${event.type}`;
                if (State.batchProcessed.has(messageKey)) return;
                State.batchProcessed.add(messageKey);
                
                switch (event.type) {
                    case 'edit':
                        edits.push(event);
                        break;
                    case 'new':
                        news.push(event);
                        break;
                    case 'delete':
                        deletes.push(event);
                        break;
                    case 'media_ready':
                        mediaReadies.push(event);
                        break;
                    case 'media_status': // НОВЫЙ
                        mediaStatuses.push(event);
                        break;
                }
            });
            
            // Очищаем Set после обработки batch
            safeSetTimeout(() => {
                State.batchProcessed.clear();
            }, 100);
            
            // Обрабатываем edit-события одним запросом
            if (edits.length > 0) {
                this.handleBatchEdits(edits, batch.is_replay);
            }
            
            // Обрабатываем новые сообщения
            if (news.length > 0) {
                this.handleBatchNews(news);
            }
            
            // Обрабатываем удаления
            deletes.forEach(event => this.handleDeleteMessage(event));
            
            // Обрабатываем media_ready
            mediaReadies.forEach(event => this.handleMediaReady(event));
            
            // Обрабатываем media_status (НОВЫЙ)
            mediaStatuses.forEach(event => this.handleMediaStatus(event));
        },
        
        // Пакетная обработка edit-событий
        async handleBatchEdits(editEvents, isReplay = false) {
            console.log(`Processing ${editEvents.length} edit events in batch`);
            
            const messageIds = editEvents.map(e => e.message_id);
            
            messageIds.forEach(id => MessageAPI.invalidateMessage(id));
            
            const messages = await MessageAPI.fetchBatchMessages(messageIds);
            
            let updatedCount = 0;
            Object.entries(messages).forEach(([id, fullMessage]) => {
                const messageId = parseInt(id);
                const post = State.posts.get(messageId);
                
                if (!post) return;
                
                const hasChanges = 
                    (fullMessage.text !== undefined && post.text !== fullMessage.text) ||
                    (fullMessage.views !== undefined && post.views !== fullMessage.views) ||
                    (fullMessage.media?.url && post.media_url !== fullMessage.media.url) ||
                    (fullMessage.edit_date && post.edit_date !== fullMessage.edit_date);
                
                if (hasChanges) {
                    UI.updatePostQuiet(messageId, this.normalizePostData(fullMessage));
                    updatedCount++;
                }
            });
            
            if (updatedCount > 0) {
                console.log(`Updated ${updatedCount} posts in batch`);
            }
        },
        
        // Пакетная обработка новых сообщений
        handleBatchNews(newEvents) {
            const messageIds = newEvents.map(e => e.message_id);
            MessageAPI.fetchBatchMessages(messageIds).then(messages => {
                const posts = Object.values(messages);
                posts.sort((a, b) => b.message_id - a.message_id);
                
                let addedCount = 0;
                posts.forEach(post => {
                    const normalizedPost = this.normalizePostData(post);
                    if (!State.posts.has(post.message_id) && 
                        !State.newPosts.some(p => p.message_id === post.message_id)) {
                        
                        if (window.scrollY < 400) {
                            UI.addPostToTop(normalizedPost);
                            addedCount++;
                        } else {
                            State.newPosts.push(normalizedPost);
                        }
                    }
                });
                
                if (addedCount > 0) {
                    console.log(`Added ${addedCount} new posts from batch`);
                }
                UI.updateNewPostsBadge();
            });
        },
        
        // Нормализация данных поста
        normalizePostData(fullMessage) {
            return {
                message_id: fullMessage.message_id,
                text: fullMessage.text || '',
                date: fullMessage.date,
                views: fullMessage.views || 0,
                forwards: fullMessage.forwards || 0,
                has_media: fullMessage.has_media || !!fullMessage.media,
                media_type: fullMessage.media?.file_type || fullMessage.media_type,
                media_url: fullMessage.media?.url || fullMessage.media_url,
                media_pending: fullMessage.media && !fullMessage.media.uploaded,
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
        
        handleMediaReady(data) {
            MediaManager.handleMediaReady(data.message_id, data.media_url, data.media_type);
            MessageAPI.invalidateMessage(data.message_id);
        },
        
        handleDeleteMessage(data) {
            State.posts.delete(data.message_id);
            const index = State.postOrder.indexOf(data.message_id);
            if (index !== -1) State.postOrder.splice(index, 1);
            
            UI.deletePost(data.message_id);
            State.mediaPending.delete(data.message_id);
            State.mediaLoading.delete(data.message_id);
            State.mediaRetryCount.delete(data.message_id);
            State.mediaStatusStore.delete(data.message_id);
            State.fullMessageCache.delete(data.message_id);
        },
        
        processFullMessage(fullMessage, type = 'new') {
            const messageId = fullMessage.message_id;
            const actualType = type === 'edit' ? 'edit' : 'new';
            
            const post = this.normalizePostData(fullMessage);
            
            const existingPost = State.posts.get(messageId);
            const existingInQueue = State.newPosts.some(p => p.message_id === messageId);
            const existingInDOM = document.querySelector(`.post[data-message-id="${messageId}"]`);
            
            if (actualType === 'edit') {
                if (existingInDOM) {
                    if (existingPost) {
                        const hasChanges = 
                            post.text !== existingPost.text ||
                            post.views !== existingPost.views ||
                            post.media_url !== existingPost.media_url;
                        
                        if (hasChanges) {
                            UI.updatePost(messageId, post);
                            State.posts.set(messageId, {...post});
                        }
                    } else {
                        UI.updatePost(messageId, post);
                    }
                } else if (existingInQueue) {
                    const index = State.newPosts.findIndex(p => p.message_id === messageId);
                    if (index !== -1) {
                        State.newPosts[index] = {...post};
                    }
                } else if (existingPost) {
                    State.posts.set(messageId, {...post});
                }
            } else {
                if (existingInDOM || existingPost || existingInQueue) {
                    return;
                }
                
                if (window.scrollY < 400) {
                    UI.addPostToTop(post);
                } else {
                    State.newPosts.push(post);
                    UI.updateNewPostsBadge();
                }
            }
            
            if (post.has_media && !post.media_url) {
                safeSetTimeout(() => {
                    MediaManager.loadMedia(messageId);
                }, 500);
            }
        },
        
        flushNewPosts() {
            if (State.newPosts.length === 0) return;
            
            const postsToFlush = [...State.newPosts].sort((a, b) => b.message_id - a.message_id);
            
            State.newPosts = [];
            UI.updateNewPostsBadge();
            
            let addedCount = 0;
            postsToFlush.forEach(post => {
                const inDOM = document.querySelector(`.post[data-message-id="${post.message_id}"]`);
                if (inDOM) return;
                
                UI.addPostToTop(post);
                addedCount++;
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
            
            const jitterRange = baseDelay * 0.3;
            const jitter = (Math.random() * jitterRange * 2) - jitterRange;
            const delay = Math.max(1000, baseDelay + jitter);
            
            safeSetTimeout(() => {
                if (!State.wsConnected && !this.giveUp) {
                    const lastEventId = State.lastEventId || 0;
                    const wsUrl = lastEventId > 0 
                        ? `${CONFIG.WS_BASE}?last_event_id=${lastEventId}`
                        : CONFIG.WS_BASE;
                    this.connect(wsUrl);
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
        
        if (!UI.restoreDOM()) {
            loadInitialAndProcessPending();
        }
        
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
        
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && State.newPosts.length > 0) {
                WebSocketManager.flushNewPosts();
            }
        });
        
        window.addEventListener('beforeunload', () => {
            UI.cacheDOM();
            cleanupResources();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();