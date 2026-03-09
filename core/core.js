(function() {
    'use strict';

    const CONFIG = {
        API_BASE: document.querySelector('meta[name="mirror:api-base"]')?.content || 'https://0808.us.nekhebet.su:8081',
        CHANNEL_ID: document.querySelector('meta[name="mirror:channel-id"]')?.content,
        CHANNEL_TITLE: document.querySelector('meta[name="mirror:channel-title"]')?.content,
        CHANNEL_USERNAME: document.querySelector('meta[name="mirror:channel-username"]')?.content,
        CHANNEL_AVATAR: document.querySelector('meta[name="mirror:channel-avatar"]')?.content || '∵',
        INITIAL_LIMIT: 20,
        MAX_RECONNECT_ATTEMPTS: 10,
        RECONNECT_BASE_DELAY: 1000,
        MEDIA_POLL_INTERVAL: 2000,
        MAX_MEDIA_POLL_ATTEMPTS: 12,
        MAX_VISIBLE_POSTS: 100,
        LAZY_LOAD_OFFSET: 500,
        IMAGE_UNLOAD_DISTANCE: 5000,
        DEDUP_TTL: 500,
        WS_BASE: (() => {
            const apiBase = document.querySelector('meta[name="mirror:api-base"]')?.content || 'https://0808.us.nekhebet.su:8081';
            return apiBase.replace('http://', 'ws://').replace('https://', 'wss://');
        })(),
        MEDIA_RETRY_DELAY: 10000,
        SYNC_AFTER_RECONNECT: true,
        PING_INTERVAL: 30000,
        MAX_PLACEHOLDER_RETRIES: 3,
        API_VERSION: 'v1',
        MAX_RECONNECT_ATTEMPTS_TOTAL: 30,
        RECONNECT_GIVE_UP_DELAY: 300000
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
        mediaPollingQueue: new Map(),
        pendingMedia: new Map(),
        scrollTimeout: null,
        recentMessages: new Map(),
        lastDocumentHeight: 0,
        theme: localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
        visiblePosts: new Set(),
        isTransitioning: false,
        pendingTheme: null,
        domCache: null,
        scrollPosition: 0,
        mediaRetryTimeouts: new Map(),
        intervals: [],
        timeouts: [],
        resizeObserver: null,
        wsPingInterval: null,
        fullMessageCache: new Map(),
        loadingMessages: new Set(),
        initialLoadComplete: false,
        pendingEvents: []
    };

    function cleanupResources() {
        State.intervals.forEach(clearInterval);
        State.intervals = [];
        
        State.timeouts.forEach(clearTimeout);
        State.timeouts = [];
        
        State.mediaRetryTimeouts.forEach((timeoutId) => {
            clearTimeout(timeoutId);
        });
        State.mediaRetryTimeouts.clear();
        
        State.mediaPollingQueue.forEach((data) => {
            if (data.timeoutId) clearTimeout(data.timeoutId);
        });
        State.mediaPollingQueue.clear();
        
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
        },
        validateMediaId(id) {
            return /^[0-9a-f-]+$/.test(id);
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
            
            let escaped = Security.escapeHtml(text);
            
            escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+?)(?:\s+"[^"]*")?\)/g, (match, linkText, url) => {
                url = url.replace(/[<>"']/g, '');
                const safeUrl = Security.sanitizeUrl(url);
                if (safeUrl === '#') return match;
                
                let domain = '';
                try {
                    const urlObj = new URL(url);
                    domain = urlObj.hostname.replace('www.', '');
                } catch {
                    domain = url;
                }
                
                const escapedLinkText = Security.escapeHtml(linkText);
                return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer nofollow" class="tg-link" title="${url}" data-domain="${domain}">${escapedLinkText}</a>`;
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
                            wrapped = `<code class="tg-inline-code">${content}</code>`;
                            break;
                        case 'pre':
                            wrapped = `<pre class="tg-code-block"><code>${content}</code></pre>`;
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
                escaped = escaped.replace(/```([\s\S]*?)```/g, '<pre class="tg-code-block"><code>$1</code></pre>');
                escaped = escaped.replace(/`([^`]+)`/g, '<code class="tg-inline-code">$1</code>');
                
                const formatters = [
                    { pattern: /\*\*\*(.*?)\*\*\*/g, replacement: '<b><i>$1</i></b>' },
                    { pattern: /\*\*(.*?)\*\*/g, replacement: '<b>$1</b>' },
                    { pattern: /__(.*?)__/g, replacement: '<u>$1</u>' },
                    { pattern: /\*(.*?)\*/g, replacement: '<i>$1</i>' },
                    { pattern: /_(.*?)_/g, replacement: '<i>$1</i>' },
                    { pattern: /~~(.*?)~~/g, replacement: '<s>$1</s>' },
                    { pattern: /\|\|(.*?)\|\|/g, replacement: '<span class="tg-spoiler" onclick="this.classList.toggle(\'revealed\')">$1</span>' }
                ];
                
                for (const formatter of formatters) {
                    escaped = escaped.replace(formatter.pattern, formatter.replacement);
                }
            }

            const LINK_MARKER = '%%%LINK%%%';
            let parts = [];
            let lastIndex = 0;
            
            const linkRegex = /<a[^>]*>.*?<\/a>/g;
            let match;
            while ((match = linkRegex.exec(escaped)) !== null) {
                parts.push({
                    type: 'text',
                    content: escaped.substring(lastIndex, match.index)
                });
                parts.push({
                    type: 'link',
                    content: match[0]
                });
                lastIndex = match.index + match[0].length;
            }
            parts.push({
                type: 'text',
                content: escaped.substring(lastIndex)
            });
            
            const urlRegex = /(https?:\/\/[^\s<"')]+)(?![^<]*>)/g;
            escaped = parts.map(part => {
                if (part.type === 'text') {
                    return part.content.replace(urlRegex, (url) => {
                        const safeUrl = Security.sanitizeUrl(url);
                        if (safeUrl === '#') return url;
                        
                        let displayDomain = '';
                        try {
                            const urlObj = new URL(url);
                            displayDomain = urlObj.hostname.replace('www.', '');
                        } catch {
                            displayDomain = url;
                        }
                        
                        let displayText = url;
                        if (url.length > 50) {
                            displayText = url.substring(0, 40) + '…' + url.substring(url.length - 10);
                        }
                        
                        return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer nofollow" class="tg-link" data-domain="${displayDomain}" title="${url}">${displayText}</a>`;
                    });
                }
                return part.content;
            }).join('');

            escaped = escaped.replace(/^&gt;&gt;&gt; (.*)$/gm, '<blockquote class="tg-quote level-3">$1</blockquote>');
            escaped = escaped.replace(/^&gt;&gt; (.*)$/gm, '<blockquote class="tg-quote level-2">$1</blockquote>');
            escaped = escaped.replace(/^&gt; (.*)$/gm, '<blockquote class="tg-quote level-1">$1</blockquote>');

            parts = [];
            lastIndex = 0;
            const tagRegex = /<a[^>]*>.*?<\/a>|<[^>]+>/g;
            while ((match = tagRegex.exec(escaped)) !== null) {
                parts.push({
                    type: 'text',
                    content: escaped.substring(lastIndex, match.index)
                });
                parts.push({
                    type: 'tag',
                    content: match[0]
                });
                lastIndex = match.index + match[0].length;
            }
            parts.push({
                type: 'text',
                content: escaped.substring(lastIndex)
            });
            
            escaped = parts.map(part => {
                if (part.type === 'text') {
                    return part.content
                        .replace(/(?<!\w)@(\w+)/g, '<span class="tg-mention" data-mention="@$1">@$1</span>')
                        .replace(/(?<!\w)#(\w+)/g, '<span class="tg-hashtag" data-hashtag="#$1">#$1</span>');
                }
                return part.content;
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
                console.log(`Using cached message ${messageId}`);
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
                console.log(`Fetching message ${messageId} from API`);
                const response = await fetch(url);
                
                if (!response.ok) {
                    if (response.status === 404) {
                        console.log(`Message ${messageId} not found`);
                        return null;
                    }
                    throw new Error(`HTTP ${response.status}`);
                }
                
                const data = await response.json();
                
                State.fullMessageCache.set(messageId, data);
                
                if (State.fullMessageCache.size > 200) {
                    const firstKey = State.fullMessageCache.keys().next().value;
                    State.fullMessageCache.delete(firstKey);
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
            console.log(`Invalidating cache for message ${messageId}`);
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
        
        async fetchMedia(messageId) {
            if (!Security.validateMessageId(messageId)) return null;
            if (State.mediaErrorCache.has(messageId)) return null;
            if (State.mediaCache.has(messageId)) return State.mediaCache.get(messageId);
            
            if (State.mediaPollingQueue.has(messageId)) {
                const { attempts } = State.mediaPollingQueue.get(messageId);
                if (attempts >= CONFIG.MAX_MEDIA_POLL_ATTEMPTS) {
                    State.mediaErrorCache.add(messageId);
                    State.mediaPollingQueue.delete(messageId);
                    return null;
                }
            }
            
            try {
                let url = `${CONFIG.API_BASE}/api/media/by-message/${messageId}`;
                url += `?channel_id=${CONFIG.CHANNEL_ID}`;
                const response = await fetch(url);
                
                if (!response.ok) {
                    if (response.status === 404) {
                        console.log(`Media for message ${messageId} not ready yet (404)`);
                        return null;
                    }
                    throw new Error(`HTTP ${response.status}`);
                }
                
                const data = await response.json();
                if (data && data.url) {
                    State.mediaCache.set(messageId, data);
                    if (State.mediaPollingQueue.has(messageId)) {
                        const { timeoutId } = State.mediaPollingQueue.get(messageId);
                        if (timeoutId) clearTimeout(timeoutId);
                        State.mediaPollingQueue.delete(messageId);
                    }
                    return data;
                }
            } catch (err) {
                console.error(`Error fetching media for ${messageId}:`, err);
            }
            return null;
        },
        
        pollMedia(messageId, callback, maxAttempts = CONFIG.MAX_MEDIA_POLL_ATTEMPTS) {
            if (State.mediaPollingQueue.has(messageId) || State.mediaErrorCache.has(messageId)) return;
            
            const poll = (attempt) => {
                if (attempt > maxAttempts) {
                    if (State.mediaPollingQueue.has(messageId)) {
                        const { timeoutId } = State.mediaPollingQueue.get(messageId);
                        if (timeoutId) clearTimeout(timeoutId);
                        State.mediaPollingQueue.delete(messageId);
                    }
                    State.mediaErrorCache.add(messageId);
                    callback(null, true);
                    return;
                }
                
                API.fetchMedia(messageId).then(mediaInfo => {
                    if (mediaInfo && mediaInfo.url) {
                        State.mediaCache.set(messageId, mediaInfo);
                        if (State.mediaPollingQueue.has(messageId)) {
                            const { timeoutId } = State.mediaPollingQueue.get(messageId);
                            if (timeoutId) clearTimeout(timeoutId);
                            State.mediaPollingQueue.delete(messageId);
                        }
                        callback(mediaInfo.url, false);
                    } else {
                        if (State.mediaPollingQueue.has(messageId)) {
                            const { timeoutId } = State.mediaPollingQueue.get(messageId);
                            if (timeoutId) clearTimeout(timeoutId);
                        }
                        const timeoutId = safeSetTimeout(() => poll(attempt + 1), CONFIG.MEDIA_POLL_INTERVAL);
                        State.mediaPollingQueue.set(messageId, { attempts: attempt, timeoutId });
                    }
                }).catch(() => {
                    const timeoutId = safeSetTimeout(() => poll(attempt + 1), CONFIG.MEDIA_POLL_INTERVAL);
                    State.mediaPollingQueue.set(messageId, { attempts: attempt, timeoutId });
                });
            };
            
            poll(1);
        },
        
        cancelMediaPoll(messageId) {
            if (State.mediaPollingQueue.has(messageId)) {
                const { timeoutId } = State.mediaPollingQueue.get(messageId);
                if (timeoutId) clearTimeout(timeoutId);
                State.mediaPollingQueue.delete(messageId);
            }
            
            if (State.mediaRetryTimeouts.has(messageId)) {
                clearTimeout(State.mediaRetryTimeouts.get(messageId));
                State.mediaRetryTimeouts.delete(messageId);
            }
        },
        
        cancelAllMediaPoll() {
            State.mediaPollingQueue.forEach((data, messageId) => {
                if (data.timeoutId) clearTimeout(data.timeoutId);
                State.mediaPollingQueue.delete(messageId);
            });
            
            State.mediaRetryTimeouts.forEach((timeoutId, messageId) => {
                clearTimeout(timeoutId);
                State.mediaRetryTimeouts.delete(messageId);
            });
        },
        
        clearMediaCache() {
            State.mediaCache.clear();
            State.mediaErrorCache.clear();
            State.pendingMedia.clear();
            this.cancelAllMediaPoll();
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
                this.video.play().catch(() => {});
            }
        },
        
        hideVideo() {
            if (this.video) {
                this.video.classList.remove('visible');
                this.video.pause();
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

    const MediaManager = {
        replaceMediaContainer(postEl, html, messageId) {
            const old = postEl.querySelector('.media-container, .media-loading, .media-unavailable, .media-placeholder');
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
                        video.dataset.src = video.src;
                        video.pause();
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
                    
                    const html = UI.renderMedia(post.media_url, post.media_type, false);
                    this.replaceMediaContainer(postEl, html, messageId);
                    
                    const newVideo = postEl.querySelector('video');
                    if (newVideo && UI.isElementInViewport(postEl)) {
                        newVideo.play().catch(() => {});
                    }
                    return true;
                }
            }
            return false;
        },
        
        loadMedia(messageId) {
            const post = State.posts.get(messageId);
            if (!post || !post.has_media || post.media_url) return;
            
            console.log(`Loading media for message ${messageId}`);
            
            const pendingMedia = State.pendingMedia.get(messageId);
            if (pendingMedia) {
                post.media_url = pendingMedia.media_url;
                post.media_type = pendingMedia.media_type;
                UI.updatePost(messageId, {
                    media_url: pendingMedia.media_url,
                    media_type: pendingMedia.media_type
                });
                State.pendingMedia.delete(messageId);
                return;
            }
            
            API.fetchMedia(messageId).then(mediaInfo => {
                if (mediaInfo && mediaInfo.url) {
                    console.log(`Media loaded for message ${messageId}:`, mediaInfo.url);
                    post.media_url = mediaInfo.url;
                    post.media_type = mediaInfo.file_type || post.media_type;
                    UI.updatePost(messageId, {
                        media_url: mediaInfo.url,
                        media_type: post.media_type
                    });
                } else {
                    console.log(`Media not ready for message ${messageId}, will retry later`);
                    this.retryMediaLoad(messageId);
                }
            }).catch(err => {
                console.log(`Media fetch failed for ${messageId}:`, err.message);
                this.retryMediaLoad(messageId);
            });
        },

        retryMediaLoad(messageId) {
            API.pollMedia(messageId, (url, failed) => {
                if (url) {
                    const post = State.posts.get(messageId);
                    if (post) {
                        post.media_url = url;
                        UI.updatePost(messageId, { media_url: url });
                    }
                } else if (failed) {
                    UI.updatePostMediaUnavailable(messageId);
                }
            });
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
                    } else {
                        State.visiblePosts.delete(msgId);
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
        
        renderMedia(url, type, addClickPlaceholder = true) {
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
            
            const dataAttr = addClickPlaceholder ? '' : ' data-media-container="true"';
            
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
                        <div class="media-container"${dataAttr}>
                            <video 
                                src="${fullUrl}" 
                                autoplay 
                                loop 
                                muted 
                                playsinline
                                preload="auto"
                                style="max-width:100%; max-height:500px; background:#282c3000;">
                                Your browser does not support video.
                            </video>
                        </div>
                    `;
                } else {
                    return `
                        <div class="media-container"${dataAttr}>
                            <video 
                                src="${fullUrl}" 
                                controls 
                                preload="metadata" 
                                playsinline
                                style="max-width:100%; max-height:500px; background:#282c3000;">
                                Your browser does not support video.
                            </video>
                        </div>
                    `;
                }
            } else {
                return `
                    <div class="media-container"${dataAttr}>
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
            
            const pendingMedia = State.pendingMedia.get(post.message_id);
            let mediaHTML = '';
            if (pendingMedia) {
                mediaHTML = this.renderMedia(pendingMedia.media_url, pendingMedia.media_type, true);
                post.media_url = pendingMedia.media_url;
                post.media_type = pendingMedia.media_type;
                State.pendingMedia.delete(post.message_id);
            } else if (post.media_url) {
                mediaHTML = this.renderMedia(post.media_url, post.media_type, true);
            } else if (post.has_media) {
                mediaHTML = post.media_unavailable
                    ? '<div class="media-unavailable">Media unavailable</div>'
                    : '<div class="media-loading"><img src="/tg/core/loader.svg" alt="Loading" class="media-loader"></div>';
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
        
        updatePost(messageId, data) {
            const postEl = document.querySelector(`.post[data-message-id="${messageId}"]`);
            if (!postEl) {
                console.log(`Post ${messageId} not in DOM, storing in pendingMedia`);
                if (data.media_url) {
                    State.pendingMedia.set(messageId, {
                        media_url: data.media_url,
                        media_type: data.media_type
                    });
                }
                return false;
            }
            
            console.log(`Updating post ${messageId} in DOM`);
            let changed = false;
            
            if (data.text !== undefined) {
                const textEl = postEl.querySelector('.post-text');
                if (textEl) {
                    const newText = Formatters.formatText(data.text || '');
                    if (textEl.innerHTML !== newText) {
                        textEl.innerHTML = newText;
                        changed = true;
                        console.log(`Text updated for ${messageId}`);
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
                        console.log(`Date updated for ${messageId}`);
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
                const mediaContainer = postEl.querySelector('.media-container, .media-loading, .media-unavailable');
                if (mediaContainer) {
                    console.log(`Updating media for ${messageId}`);
                    const newMedia = this.renderMedia(data.media_url, data.media_type, true);
                    MediaManager.replaceMediaContainer(postEl, newMedia, messageId);
                    
                    postEl.dataset.mediaUrl = data.media_url;
                    postEl.dataset.mediaType = data.media_type || '';
                    changed = true;
                } else {
                    const postContent = postEl.querySelector('.post-content');
                    if (postContent) {
                        console.log(`Adding media container for ${messageId}`);
                        const newMedia = this.renderMedia(data.media_url, data.media_type, true);
                        postContent.insertAdjacentHTML('beforeend', newMedia);
                        
                        postEl.dataset.mediaUrl = data.media_url;
                        postEl.dataset.mediaType = data.media_type || '';
                        changed = true;
                    }
                }
            }
            
            if (changed) {
                postEl.classList.add('updated');
                safeSetTimeout(() => postEl.classList.remove('updated'), 2000);
                console.log(`✅ Post ${messageId} updated successfully`);
            } else {
                console.log(`No changes for post ${messageId}`);
            }
            
            return changed;
        },
        
        updatePostMediaUnavailable(messageId) {
            const postEl = document.querySelector(`.post[data-message-id="${messageId}"]`);
            if (!postEl) return false;
            
            const mediaContainer = postEl.querySelector('.media-loading');
            if (mediaContainer) {
                mediaContainer.outerHTML = '<div class="media-unavailable">📷 Media unavailable</div>';
                const post = State.posts.get(Number(messageId));
                if (post) post.media_unavailable = true;
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
            
            postEl.classList.add('deleted');
            
            safeSetTimeout(() => {
                postEl.remove();
                State.posts.delete(messageId);
                const index = State.postOrder.indexOf(Number(messageId));
                if (index !== -1) State.postOrder.splice(index, 1);
                API.cancelMediaPoll(messageId);
                State.pendingMedia.delete(messageId);
                State.fullMessageCache.delete(messageId);
                console.log(`Post ${messageId} removed from DOM`);
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
                    MediaManager.loadMedia(post.message_id);
                }
            });
        },
        
        addPostToTop(post) {
            const feed = document.getElementById('feed');
            const postEl = this.createPostElement(post);
            
            if (feed.firstChild) {
                feed.insertBefore(postEl, feed.firstChild);
            } else {
                feed.appendChild(postEl);
            }
            
            requestAnimationFrame(() => {
                postEl.classList.add('visible', 'new');
            });
            
            safeSetTimeout(() => postEl.classList.remove('new'), 3000);
            
            if (this.observer) {
                this.observer.observe(postEl);
            }
            
            this.trimOldPosts();
            
            if (post.has_media && !post.media_url) {
                // Даем небольшую задержку перед загрузкой медиа
                safeSetTimeout(() => {
                    MediaManager.loadMedia(post.message_id);
                }, 500);
            }
            
            State.postOrder.sort((a, b) => b - a);
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
            API.clearMediaCache();
        }
    };

    const Lightbox = {
        open(url, type) {
            if (!url) return;
            const lightbox = document.getElementById('lightbox');
            const content = document.getElementById('lightboxContent');
            const fullUrl = url.startsWith('http') ? url : `${CONFIG.API_BASE}${url}`;
            const isVideo = type === 'video' || type === 'Video' || url.match(/\.(mp4|webm|mov)$/i);
            
            content.innerHTML = isVideo
                ? `<video src="${fullUrl}" controls autoplay playsinline></video>`
                : `<img src="${fullUrl}" alt="Media">`;
            
            lightbox.classList.add('active');
            document.body.style.overflow = 'hidden';
        },
        
        close() {
            const lightbox = document.getElementById('lightbox');
            lightbox.classList.remove('active');
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
                State.pendingMedia.clear();
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
                            State.posts.set(post.message_id, post);
                            State.postOrder.push(post.message_id);
                            newMessages.push(post);
                        }
                    });
                    
                    State.postOrder.sort((a, b) => b - a);
                    
                    if (newMessages.length > 0) {
                        UI.renderPosts(newMessages);
                    }
                    
                    data.messages.forEach(post => {
                        if (post.has_media) {
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

    const Toast = {
        show(message, type = 'info', duration = 3000) {
            const container = document.getElementById('toastContainer');
            if (!container) return;
            
            const toast = document.createElement('div');
            toast.className = `toast ${type}`;
            const icons = { info: 'ℹ️', success: '✅', warning: '⚠️', error: '❌' };
            toast.innerHTML = `${icons[type] || 'ℹ️'} ${message}`;
            
            container.appendChild(toast);
            
            safeSetTimeout(() => {
                toast.style.opacity = '0';
                toast.style.transform = 'translate(-50%, 20px)';
                safeSetTimeout(() => toast.remove(), 300);
            }, duration);
        },
        info(message) { this.show(message, 'info'); },
        success(message) { this.show(message, 'success'); },
        warning(message) { this.show(message, 'warning'); },
        error(message) { this.show(message, 'error'); }
    };

    async function loadInitialAndProcessPending() {
        UI.showSkeletonLoaders();
        await MessageLoader.loadMessages(true);
        
        State.initialLoadComplete = true;
        
        while (State.pendingEvents.length > 0) {
            const event = State.pendingEvents.shift();
            WebSocketManager.processFullMessage(event.data, event.isEdit);
        }
        
        UI.initIntersectionObserver();
    }

    const WebSocketManager = {
        giveUp: false,
        giveUpTimer: null,
        
        connect() {
            if (!this.giveUpTimer) {
                this.giveUpTimer = safeSetTimeout(() => {
                    console.log('Max reconnection time reached, giving up');
                    this.giveUp = true;
                    Toast.error('Unable to connect to server. Please refresh the page.');
                }, CONFIG.RECONNECT_GIVE_UP_DELAY);
            }
            
            try {
                State.ws = new WebSocket(CONFIG.WS_BASE);
                
                State.ws.onopen = () => {
                    State.wsConnected = true;
                    State.wsReconnectAttempts = 0;
                    
                    if (this.giveUpTimer) {
                        clearTimeout(this.giveUpTimer);
                        this.giveUpTimer = null;
                    }
                    this.giveUp = false;
                    
                    UI.updateConnectionStatus(true);
                    Toast.success('Connected to server');
                    
                    if (CONFIG.CHANNEL_ID) {
                        const subscribeMsg = {
                            type: 'subscribe',
                            channel_id: parseInt(CONFIG.CHANNEL_ID)
                        };
                        State.ws.send(JSON.stringify(subscribeMsg));
                        console.log(`Subscribed to channel ${CONFIG.CHANNEL_ID}`);
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
                    Toast.warning('Disconnected from server');
                    
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
                        if (!State.posts.has(post.message_id)) {
                            UI.addPostToTop(post);
                            State.posts.set(post.message_id, post);
                            State.postOrder.unshift(post.message_id);
                        }
                    });
                    
                    State.postOrder.sort((a, b) => b - a);
                    Toast.info(`Loaded ${newPosts.length} missed messages`);
                }
            } catch (err) {
                console.error('Sync after reconnect failed:', err);
            }
        },
        
        handleMessage(data) {
            if (['ping', 'pong', 'welcome', 'heartbeat', 'buffering', 'flush_start', 'flush_complete', 'subscribed', 'error'].includes(data.type)) {
                if (data.type === 'subscribed') {
                    console.log(`Successfully subscribed to channel ${data.channel_id}`);
                }
                if (data.type === 'welcome') {
                    console.log('Received welcome from server, protocol version:', data.version);
                }
                return;
            }
            
            if (data.version !== '2.0') {
                console.warn(`Unsupported protocol version: ${data.version}`);
                return;
            }
            
            if (data.channel_id !== parseInt(CONFIG.CHANNEL_ID)) return;
            
            if (!State.initialLoadComplete) {
                console.log(`Queuing event for message ${data.message_id} until initial load completes`);
                State.pendingEvents.push({
                    data: data.data,
                    isEdit: data.type === 'edit'
                });
                return;
            }
            
            const messageKey = `${data.channel_id}-${data.message_id}-${data.type}`;
            const lastReceived = State.recentMessages.get(messageKey);
            if (lastReceived && (Date.now() - lastReceived < CONFIG.DEDUP_TTL)) {
                console.log('Duplicate message ignored:', messageKey);
                return;
            }
            
            State.recentMessages.set(messageKey, Date.now());
            
            if (State.recentMessages.size > 100) {
                const now = Date.now();
                for (const [key, time] of State.recentMessages.entries()) {
                    if (now - time > CONFIG.DEDUP_TTL) State.recentMessages.delete(key);
                }
            }
            
            console.log('WebSocket message received:', data.type, data.message_id);
            
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
                default:
                    console.log('Unknown message type:', data.type);
            }
        },
        
        async handleNewMessage(data) {
            if (State.posts.has(data.message_id)) {
                console.log('Message already exists:', data.message_id);
                return;
            }
            
            if (data.data) {
                this.processFullMessage(data.data);
                return;
            }
            
            const fullMessage = await MessageAPI.fetchFullMessage(data.message_id);
            if (fullMessage) {
                this.processFullMessage(fullMessage);
            } else {
                console.error(`Failed to load full message ${data.message_id}`);
            }
        },
        
        async handleEditMessage(data) {
            console.log(`Handling edit for message ${data.message_id}`);
            MessageAPI.invalidateMessage(data.message_id);

            const fullMessage = await MessageAPI.fetchFullMessage(data.message_id);
            if (fullMessage) {
                console.log(`Processing edit for message ${data.message_id} with data:`, fullMessage);
                this.processFullMessage(fullMessage, true);
            } else {
                console.error(`Failed to load edited message ${data.message_id}`);
            }
        },
        
        processFullMessage(fullMessage, isEdit = false) {
            const messageId = fullMessage.message_id;
            
            console.log(`Processing ${isEdit ? 'edit' : 'new'} message ${messageId}`);
            
            const post = {
                message_id: messageId,
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
            
            // Проверяем существующее сообщение
            const existingPost = State.posts.get(messageId);
            
            if (isEdit) {
                if (existingPost) {
                    // Обновляем 
                    State.posts.set(messageId, post);
                    
                    // Важно: проверяем, появилось ли медиа
                    if (!existingPost.media_url && post.media_url) {
                        console.log(`Media now available for message ${messageId}`);
                        UI.updatePost(messageId, post);
                    } else {
                        // Обычное обновление (текст, дата и т.д.)
                        UI.updatePost(messageId, post);
                    }
                } else {
                    // Сообщения нет в State - возможно в очереди
                    console.log(`Post ${messageId} not in State.posts, checking newPosts queue`);
                    
                    const indexInNew = State.newPosts.findIndex(p => p.message_id === messageId);
                    if (indexInNew !== -1) {
                        console.log(`Updating message ${messageId} in newPosts queue`);
                        State.newPosts[indexInNew] = post;
                    } else {
                        // Это может быть edit для сообщения, которое мы только что добавили
                        // или сообщение с задержкой медиа - не добавляем повторно
                        console.log(`Edit for message ${messageId} - might be media ready notification`);
                        State.posts.set(messageId, post);
                    }
                }
            } else {
                // Новое сообщение
                this.addPost(post);
            }
            
            // Загружаем медиа, если оно есть, но еще не загружено
            if (post.has_media && !post.media_url) {
                console.log(`Scheduling media load for message ${messageId}`);
                // Даем небольшую задержку перед первой попыткой загрузки медиа
                safeSetTimeout(() => {
                    MediaManager.loadMedia(messageId);
                }, 500);
            }
            
            // Если медиа появилось в edit, но уже было в new - обновляем
            if (isEdit && existingPost && !existingPost.media_url && post.media_url) {
                console.log(`Media ready for message ${messageId}, updating immediately`);
                UI.updatePost(messageId, post);
            }
        },
        
        addPost(post) {
            // Проверяем, нет ли уже такого сообщения
            if (State.posts.has(post.message_id)) {
                console.log(`Post ${post.message_id} already exists, skipping add`);
                return;
            }
            
            if (window.scrollY < 200) {
                console.log('Adding new post immediately:', post.message_id);
                UI.addPostToTop(post);
                State.posts.set(post.message_id, post);
                State.postOrder.unshift(post.message_id);
                State.postOrder.sort((a, b) => b - a);
            } else {
                // Проверяем, нет ли уже в очереди
                const existsInQueue = State.newPosts.some(p => p.message_id === post.message_id);
                if (!existsInQueue) {
                    console.log('Queuing new post:', post.message_id);
                    State.newPosts.push(post);
                    UI.updateNewPostsBadge();
                } else {
                    console.log(`Post ${post.message_id} already in queue, skipping`);
                }
            }
        },
        
        handleDeleteMessage(data) {
            console.log('Delete message:', data.message_id);
            
            State.posts.delete(data.message_id);
            const index = State.postOrder.indexOf(data.message_id);
            if (index !== -1) State.postOrder.splice(index, 1);
            
            UI.deletePost(data.message_id);
            API.cancelMediaPoll(data.message_id);
            State.pendingMedia.delete(data.message_id);
            State.fullMessageCache.delete(data.message_id);
        },
        
        flushNewPosts() {
            if (State.newPosts.length === 0) return;
            
            console.log(`Flushing ${State.newPosts.length} new posts`);
            
            while (State.newPosts.length > 0) {
                const post = State.newPosts.shift();
                UI.addPostToTop(post);
                State.posts.set(post.message_id, post);
                State.postOrder.unshift(post.message_id);
            }
            
            State.postOrder.sort((a, b) => b - a);
            UI.updateNewPostsBadge();
            Toast.success('New messages loaded');
        },
        
        reconnect() {
            if (this.giveUp || State.wsReconnectAttempts >= CONFIG.MAX_RECONNECT_ATTEMPTS_TOTAL) {
                console.log('Max reconnection attempts reached, stopping');
                Toast.error('Lost connection to server. Please refresh the page.');
                return;
            }
            
            State.wsReconnectAttempts++;
            const delay = Math.min(
                CONFIG.RECONNECT_BASE_DELAY * Math.pow(1.5, State.wsReconnectAttempts), 
                30000
            );
            
            console.log(`Reconnecting in ${delay}ms (attempt ${State.wsReconnectAttempts}/${CONFIG.MAX_RECONNECT_ATTEMPTS_TOTAL})`);
            
            safeSetTimeout(() => {
                if (!State.wsConnected && !this.giveUp) {
                    console.log('Attempting to reconnect...');
                    this.connect();
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
        ThemeManager.init();
        UI.updateChannelInfo();
        
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
            window.scrollTo({ top: 0, behavior: 'smooth' });
            WebSocketManager.flushNewPosts();
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
