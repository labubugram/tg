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
        WS_BASE: (() => {
            const apiBase = document.querySelector('meta[name="mirror:api-base"]')?.content;
            return apiBase ? apiBase.replace('http://', 'ws://').replace('https://', 'wss://') : 'wss://nekhebet.su';
        })(),
        SYNC_AFTER_RECONNECT: true,
        PING_INTERVAL: 30000,
        API_VERSION: 'v1',
        RECONNECT_GIVE_UP_DELAY: 300000,
        MAX_CACHE_SIZE: 100,
        MAX_MEDIA_CACHE_SIZE: 50,
        CLEANUP_INTERVAL: 120000,
        MEDIA_MAX_RETRIES: 3,
        MEDIA_RETRY_DELAY: 5000,
        MEDIA_POLL_MAX_DELAY: 15000,
        VIDEO_PRELOAD: 'metadata',
        RETRY_ON_NETWORK_ERROR: true,
        MEDIA_READY_RECHECK_DELAY: 1000
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
        mediaLoading: new Set(),
        mediaRetryTimeouts: new Map(),
        mediaFailed: new Set(),
        
        visiblePosts: new Set(),
        mediaRequested: new Set(),
        
        theme: localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
        
        intervals: [],
        timeouts: [],
        resizeObserver: null,
        wsPingInterval: null,
        
        fullMessageCache: new Map(),
        initialLoadComplete: false,
        pendingEvents: [],
        lastEventId: 0,
        currentlyPlayingVideo: null,
        
        supportedVersions: ['2.0', '3.0'],
        serverVersion: '3.0'
    };

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
            return unsafe.replace(/[&<>"']/g, function(m) {
                if (m === '&') return '&amp;';
                if (m === '<') return '&lt;';
                if (m === '>') return '&gt;';
                if (m === '"') return '&quot;';
                return '&#039;';
            });
        },
        sanitizeUrl(url) {
            try {
                const parsed = new URL(url);
                if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '#';
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
            const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', hour12: false });
            if (isToday) return `Today at ${time}`;
            if (isYesterday) return `Yesterday at ${time}`;
            return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long' }) + ` at ${time}`;
        },
        formatViews(views) {
            if (!views) return '0';
            if (views >= 1000000) return `${(views / 1000000).toFixed(1)}M`;
            if (views >= 1000) return `${(views / 1000).toFixed(1)}K`;
            return views.toString();
        },
        formatText(text) {
            if (!text) return '';
            return Security.escapeHtml(text)
                .replace(/\*\*\*(.*?)\*\*\*/g, '<b><i>$1</i></b>')
                .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
                .replace(/__(.*?)__/g, '<u>$1</u>')
                .replace(/\*(.*?)\*/g, '<i>$1</i>')
                .replace(/_(.*?)_/g, '<i>$1</i>')
                .replace(/~~(.*?)~~/g, '<s>$1</s>')
                .replace(/\|\|(.*?)\|\|/g, '<span class="tg-spoiler">$1</span>')
                .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="tg-link">$1</a>')
                .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" class="tg-link">$1</a>')
                .replace(/\n/g, '<br>');
        }
    };

    const debounce = (fn, delay) => {
        let timeoutId;
        return function(...args) {
            clearTimeout(timeoutId);
            timeoutId = safeSetTimeout(() => fn.apply(this, args), delay);
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
            if (State.fullMessageCache.has(messageId)) return State.fullMessageCache.get(messageId);
            
            try {
                const response = await fetch(`${CONFIG.API_BASE}/api/${CONFIG.API_VERSION}/messages/${messageId}?channel_id=${CONFIG.CHANNEL_ID}`);
                if (!response.ok) return null;
                const data = await response.json();
                State.fullMessageCache.set(messageId, data);
                return data;
            } catch {
                return null;
            }
        },
        async fetchBatchMessages(messageIds) {
            const neededIds = messageIds.filter(id => !State.fullMessageCache.has(id));
            if (neededIds.length === 0) {
                const result = {};
                messageIds.forEach(id => {
                    if (State.fullMessageCache.has(id)) result[id] = State.fullMessageCache.get(id);
                });
                return result;
            }
            try {
                const response = await fetch(`${CONFIG.API_BASE}/api/${CONFIG.API_VERSION}/messages/batch`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ channel_id: parseInt(CONFIG.CHANNEL_ID), message_ids: neededIds })
                });
                if (!response.ok) return {};
                const data = await response.json();
                if (data.messages) {
                    Object.entries(data.messages).forEach(([id, msg]) => State.fullMessageCache.set(parseInt(id), msg));
                }
                const result = {};
                messageIds.forEach(id => {
                    if (State.fullMessageCache.has(id)) result[id] = State.fullMessageCache.get(id);
                });
                return result;
            } catch {
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
                if (!response.ok) throw new Error();
                const data = await response.json();
                if (data.posts?.length) {
                    const messageIds = data.posts.map(p => p.message_id);
                    const fullMessages = await MessageAPI.fetchBatchMessages(messageIds);
                    data.posts = data.posts.map(post => ({
                        ...post,
                        ...(fullMessages[post.message_id] || {}),
                        has_media: !!(fullMessages[post.message_id]?.media_type || post.media_type)
                    }));
                }
                return { messages: data.posts || [], hasMore: (data.posts || []).length === limit };
            } catch {
                return { messages: [], hasMore: false };
            }
        },
        async fetchMessagesSince(afterId, limit = 50) {
            try {
                const response = await fetch(`${CONFIG.API_BASE}/api/channel/posts/since?channel_id=${CONFIG.CHANNEL_ID}&after_id=${afterId}&limit=${limit}`);
                if (!response.ok) return { posts: [] };
                const data = await response.json();
                if (data.posts?.length) {
                    const messageIds = data.posts.map(p => p.message_id);
                    const fullMessages = await MessageAPI.fetchBatchMessages(messageIds);
                    data.posts = data.posts.map(post => fullMessages[post.message_id] ? {...post, ...fullMessages[post.message_id]} : post);
                }
                return data;
            } catch {
                return { posts: [] };
            }
        }
    };

    const MediaAPI = {
        async fetchMedia(messageId) {
            if (!Security.validateMessageId(messageId)) return null;
            try {
                const response = await fetch(`${CONFIG.API_BASE}/api/media/by-message/${messageId}?channel_id=${CONFIG.CHANNEL_ID}`);
                if (response.status === 404) return null;
                if (!response.ok) throw new Error();
                const data = await response.json();
                return (data.status === 'ready' && data.url) ? { url: data.url, type: data.file_type } : null;
            } catch {
                return null;
            }
        }
    };

    const VideoManager = {
        stopAllVideos() {
            if (State.currentlyPlayingVideo) {
                State.currentlyPlayingVideo.pause();
                State.currentlyPlayingVideo = null;
            }
            document.querySelectorAll('video').forEach(v => { if (!v.paused) v.pause(); });
        },
        pauseVideo(video) {
            if (video && !video.paused) {
                video.pause();
                if (State.currentlyPlayingVideo === video) State.currentlyPlayingVideo = null;
            }
        },
        playVideo(video) {
            if (!video) return;
            if (State.currentlyPlayingVideo && State.currentlyPlayingVideo !== video) {
                State.currentlyPlayingVideo.pause();
            }
            video.play().catch(() => {});
            State.currentlyPlayingVideo = video;
        }
    };

    const ThemeManager = {
        video: null,
        videoTimeoutId: null,
        init() {
            this.video = document.getElementById('bgVideo');
            this.applyTheme(State.theme, false);
        },
        applyTheme(theme, animate = true) {
            if (animate) document.documentElement.classList.add('theme-transitioning');
            document.documentElement.setAttribute('data-theme', theme);
            if (animate) safeSetTimeout(() => document.documentElement.classList.remove('theme-transitioning'), 400);
        },
        toggle() {
            const newTheme = State.theme === 'dark' ? 'light' : 'dark';
            State.theme = newTheme;
            localStorage.setItem('theme', newTheme);
            this.applyTheme(newTheme, true);
        }
    };

    const MediaManager = {
        async loadMedia(messageId, attempt = 0) {
            if (State.mediaCache.has(messageId) || State.mediaFailed.has(messageId)) return true;
            if (State.mediaLoading.has(messageId)) return false;
            if (attempt >= CONFIG.MEDIA_MAX_RETRIES) {
                State.mediaFailed.add(messageId);
                this.showMediaUnavailable(messageId);
                return false;
            }
            
            State.mediaLoading.add(messageId);
            State.mediaRequested.add(messageId);
            
            try {
                const media = await MediaAPI.fetchMedia(messageId);
                if (media?.url) {
                    State.mediaCache.set(messageId, media.url);
                    this.updatePostMedia(messageId, media.url);
                    if (State.mediaRetryTimeouts.has(messageId)) {
                        clearTimeout(State.mediaRetryTimeouts.get(messageId));
                        State.mediaRetryTimeouts.delete(messageId);
                    }
                    return true;
                } else {
                    State.mediaLoading.delete(messageId);
                    const delay = Math.min(CONFIG.MEDIA_RETRY_DELAY * Math.pow(1.5, attempt), CONFIG.MEDIA_POLL_MAX_DELAY);
                    const timeoutId = safeSetTimeout(() => {
                        State.mediaRetryTimeouts.delete(messageId);
                        this.loadMedia(messageId, attempt + 1);
                    }, delay);
                    State.mediaRetryTimeouts.set(messageId, timeoutId);
                    return false;
                }
            } catch {
                State.mediaLoading.delete(messageId);
                const delay = Math.min(CONFIG.MEDIA_RETRY_DELAY * Math.pow(1.5, attempt), CONFIG.MEDIA_POLL_MAX_DELAY);
                const timeoutId = safeSetTimeout(() => {
                    State.mediaRetryTimeouts.delete(messageId);
                    this.loadMedia(messageId, attempt + 1);
                }, delay);
                State.mediaRetryTimeouts.set(messageId, timeoutId);
                return false;
            }
        },
        forceLoadMedia(messageId) {
            if (State.mediaFailed.has(messageId)) return;
            if (State.mediaRetryTimeouts.has(messageId)) {
                clearTimeout(State.mediaRetryTimeouts.get(messageId));
                State.mediaRetryTimeouts.delete(messageId);
            }
            State.mediaLoading.delete(messageId);
            this.loadMedia(messageId, 0);
        },
        showMediaUnavailable(messageId) {
            const postEl = document.querySelector(`.post[data-message-id="${messageId}"]`);
            if (!postEl) return;
            const loader = postEl.querySelector('.media-loading');
            if (loader) loader.innerHTML = '<div class="media-unavailable">📷 Media not available</div>';
        },
        updatePostMedia(messageId, url) {
            const postEl = document.querySelector(`.post[data-message-id="${messageId}"]`);
            if (!postEl) return;
            const container = postEl.querySelector('.media-loading');
            if (!container) return;
            const post = State.posts.get(messageId);
            container.outerHTML = UI.renderMedia(url, post?.media_type);
            postEl.dataset.mediaUrl = url;
            setTimeout(() => UI.attachMediaHandlers(postEl), 0);
        },
        loadVisibleMedia: throttle(function() {
            State.visiblePosts.forEach(msgId => {
                if (!State.mediaCache.has(msgId) && !State.mediaFailed.has(msgId) && !State.mediaRequested.has(msgId)) {
                    this.loadMedia(msgId);
                }
            });
        }, 2000),
        unloadMedia(messageId) {
            if (!CONFIG.IMAGE_UNLOAD_DISTANCE) return false;
            const postEl = document.querySelector(`.post[data-message-id="${messageId}"]`);
            if (!postEl) return false;
            const rect = postEl.getBoundingClientRect();
            const viewportHeight = window.innerHeight;
            if (Math.min(Math.abs(rect.top - viewportHeight), Math.abs(rect.bottom)) > CONFIG.IMAGE_UNLOAD_DISTANCE) {
                const container = postEl.querySelector('.media-container');
                if (container && !container.classList.contains('media-unloaded')) {
                    const video = container.querySelector('video');
                    if (video) {
                        VideoManager.pauseVideo(video);
                        video.dataset.src = video.src;
                        video.removeAttribute('src');
                        video.load();
                        container.classList.add('media-unloaded');
                        return true;
                    }
                    const img = container.querySelector('img');
                    if (img) {
                        img.dataset.src = img.src;
                        img.style.display = 'none';
                        container.classList.add('media-unloaded');
                        return true;
                    }
                }
            }
            return false;
        },
        restoreMediaIfNeeded(messageId) {
            const postEl = document.querySelector(`.post[data-message-id="${messageId}"]`);
            if (!postEl) return false;
            const container = postEl.querySelector('.media-container');
            if (container?.classList.contains('media-unloaded')) {
                const url = State.mediaCache.get(messageId);
                if (url) {
                    const img = container.querySelector('img');
                    const video = container.querySelector('video');
                    if (img) {
                        img.src = img.dataset.src || url;
                        img.style.display = '';
                        container.classList.remove('media-unloaded');
                    } else if (video) {
                        video.src = video.dataset.src || url;
                        video.load();
                        container.classList.remove('media-unloaded');
                    }
                    return true;
                }
            }
            return false;
        }
    };

    const UI = {
        observer: null,
        initIntersectionObserver() {
            if (this.observer) this.observer.disconnect();
            this.observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    const post = entry.target;
                    const msgId = Number(post.dataset.messageId);
                    if (entry.isIntersecting) {
                        State.visiblePosts.add(msgId);
                        if (!State.mediaCache.has(msgId) && !State.mediaFailed.has(msgId)) {
                            MediaManager.loadMedia(msgId);
                        } else {
                            MediaManager.restoreMediaIfNeeded(msgId);
                        }
                        const video = post.querySelector('video');
                        if (video?.dataset.src && !video.src) {
                            video.src = video.dataset.src;
                            delete video.dataset.src;
                            VideoManager.playVideo(video);
                        }
                    } else {
                        State.visiblePosts.delete(msgId);
                        const video = post.querySelector('video');
                        if (video && !video.paused) VideoManager.pauseVideo(video);
                        MediaManager.unloadMedia(msgId);
                    }
                });
            }, { rootMargin: `${CONFIG.LAZY_LOAD_OFFSET}px`, threshold: 0.01 });
            document.querySelectorAll('.post').forEach(post => this.observer.observe(post));
        },
        isElementInViewport(el) {
            const rect = el.getBoundingClientRect();
            return rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth;
        },
        trimOldPosts() {
            const posts = document.querySelectorAll('.post');
            if (posts.length > CONFIG.MAX_VISIBLE_POSTS) {
                Array.from(posts).slice(0, posts.length - CONFIG.MAX_VISIBLE_POSTS).forEach(el => {
                    if (this.observer) this.observer.unobserve(el);
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
            if (avatarEl) avatarEl.innerHTML = `<img src="/tg/core/avatar.svg" style="width:54px; height:54px; object-fit:cover;" alt="Channel avatar" loading="lazy">`;
        },
        updateConnectionStatus(connected) {
            document.getElementById('statusDot')?.classList.toggle('offline', !connected);
        },
        updateNewPostsBadge() {
            const badge = document.getElementById('newPostsBadge');
            const countSpan = document.getElementById('newPostsCount');
            if (State.newPosts.length) {
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
            const isVideo = type?.toLowerCase().includes('video') || fullUrl.match(/\.(mp4|webm|mov|gif)$/i);
            if (isVideo) {
                const isGif = fullUrl.match(/\.gif$/i) || type?.toLowerCase().includes('gif');
                return `<div class="media-container"><video src="${fullUrl}" ${isGif ? 'autoplay loop muted' : 'controls'} playsinline preload="${CONFIG.VIDEO_PRELOAD}" style="max-width:100%; max-height:500px;"></video></div>`;
            }
            return `<div class="media-container"><img src="${fullUrl}" alt="Media" loading="lazy" decoding="async"></div>`;
        },
        attachMediaHandlers(postEl) {
            postEl.querySelectorAll('video').forEach(video => {
                video.addEventListener('play', () => {
                    if (State.currentlyPlayingVideo && State.currentlyPlayingVideo !== video) {
                        State.currentlyPlayingVideo.pause();
                    }
                    State.currentlyPlayingVideo = video;
                });
                video.addEventListener('pause', () => {
                    if (State.currentlyPlayingVideo === video) State.currentlyPlayingVideo = null;
                });
            });
        },
        createPostElement(post) {
            const postEl = document.createElement('div');
            postEl.className = 'post';
            postEl.dataset.messageId = post.message_id;
            postEl.dataset.mediaUrl = post.media_url || '';
            
            let mediaHTML = '';
            if (post.media_url) {
                mediaHTML = this.renderMedia(post.media_url, post.media_type);
            } else if (post.has_media && !State.mediaFailed.has(post.message_id)) {
                mediaHTML = '<div class="media-loading"><img src="/tg/core/loader.svg" alt="Loading" class="media-loader"></div>';
            }
            
            postEl.innerHTML = `
                <div class="post-content">
                    <div class="post-header">
                        <div class="post-avatar"><img src="/tg/core/avatar.svg" style="width:36px; height:36px;" alt="Channel avatar" loading="lazy"></div>
                        <div class="post-author-info">
                            <div class="post-author-name">${CONFIG.CHANNEL_TITLE} <span class="post-username">@${CONFIG.CHANNEL_USERNAME}</span></div>
                            <div class="post-date">${Formatters.formatDate(post.date)}${post.is_edited ? ' <span class="edited-mark">(edited)</span>' : ''}</div>
                        </div>
                    </div>
                    <div class="post-text">${Formatters.formatText(post.text) || '<i></i>'}</div>
                    ${mediaHTML}
                </div>
                <div class="post-footer"><span class="views-count">👁 ${Formatters.formatViews(post.views)}</span></div>
            `;
            
            setTimeout(() => this.attachMediaHandlers(postEl), 0);
            return postEl;
        },
        renderPosts(posts) {
            const fragment = document.createDocumentFragment();
            posts.forEach(post => fragment.appendChild(this.createPostElement(post)));
            document.getElementById('feed').appendChild(fragment);
            document.querySelectorAll('.post').forEach(post => {
                requestAnimationFrame(() => post.classList.add('visible'));
                if (this.observer) this.observer.observe(post);
            });
            this.trimOldPosts();
        },
        addPostToTop(post) {
            if (document.querySelector(`.post[data-message-id="${post.message_id}"]`)) return;
            const feed = document.getElementById('feed');
            const postEl = this.createPostElement(post);
            feed.insertBefore(postEl, feed.firstChild);
            State.posts.set(post.message_id, {...post});
            requestAnimationFrame(() => postEl.classList.add('visible', 'new'));
            safeSetTimeout(() => postEl.classList.remove('new'), 3000);
            if (this.observer) this.observer.observe(postEl);
            this.trimOldPosts();
        },
        updatePost(messageId, newData, fullMessage) {
            const postEl = document.querySelector(`.post[data-message-id="${messageId}"]`);
            const oldPost = State.posts.get(messageId);
            if (!postEl || !oldPost) return;
            
            let changed = false;
            if (oldPost.text !== newData.text) {
                const textEl = postEl.querySelector('.post-text');
                if (textEl) {
                    textEl.innerHTML = Formatters.formatText(newData.text || '');
                    changed = true;
                }
            }
            if (oldPost.views !== newData.views) {
                const viewsEl = postEl.querySelector('.views-count');
                if (viewsEl) {
                    viewsEl.textContent = `👁 ${Formatters.formatViews(newData.views)}`;
                    changed = true;
                }
            }
            if (fullMessage?.edit_date && !oldPost.edit_date) {
                const dateEl = postEl.querySelector('.post-date');
                if (dateEl && !dateEl.querySelector('.edited-mark')) {
                    dateEl.innerHTML += ' <span class="edited-mark">(edited)</span>';
                    changed = true;
                }
            }
            if (newData.media_url && oldPost.media_url !== newData.media_url) {
                const container = postEl.querySelector('.media-loading, .media-container, .media-unavailable');
                if (container) {
                    container.outerHTML = this.renderMedia(newData.media_url, newData.media_type);
                    postEl.dataset.mediaUrl = newData.media_url;
                    setTimeout(() => this.attachMediaHandlers(postEl), 0);
                    changed = true;
                }
            }
            
            State.posts.set(messageId, {...oldPost, ...newData});
            if (changed) {
                postEl.classList.add('updated');
                safeSetTimeout(() => postEl.classList.remove('updated'), 2000);
            }
        },
        setLoaderVisible(visible) {
            const trigger = document.getElementById('infiniteScrollTrigger');
            if (trigger) trigger.textContent = visible ? 'Loading...' : '↓ Load more';
        },
        showScrollTopButton(visible) {
            const btn = document.getElementById('scrollTopBtn');
            if (btn) btn.style.display = visible ? 'flex' : 'none';
        }
    };

    const Lightbox = {
        open(url, type) {
            if (!url) return;
            VideoManager.stopAllVideos();
            const lightbox = document.getElementById('lightbox');
            const content = document.getElementById('lightboxContent');
            const fullUrl = url.startsWith('http') ? url : `${CONFIG.API_BASE}${url}`;
            const isVideo = type === 'video' || url.match(/\.(mp4|webm|mov)$/i);
            content.innerHTML = isVideo ? `<video src="${fullUrl}" controls autoplay playsinline></video>` : `<img src="${fullUrl}" alt="Media">`;
            lightbox.classList.add('active');
            document.body.style.overflow = 'hidden';
        },
        close() {
            document.getElementById('lightbox').classList.remove('active');
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
                State.mediaRequested.clear();
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
                if (data.messages?.length) {
                    State.hasMore = data.hasMore;
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
                    if (newMessages.length) UI.renderPosts(newMessages);
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
        while (State.pendingEvents.length) {
            const event = State.pendingEvents.shift();
            WebSocketManager.processFullMessage(event.data, event.type);
        }
        UI.initIntersectionObserver();
    }

    const WebSocketManager = {
        giveUp: false,
        giveUpTimer: null,
        connect(wsUrl = CONFIG.WS_BASE) {
            if (!this.giveUpTimer) {
                this.giveUpTimer = safeSetTimeout(() => { this.giveUp = true; }, CONFIG.RECONNECT_GIVE_UP_DELAY);
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
                        State.ws.send(JSON.stringify({ type: 'subscribe', channel_id: parseInt(CONFIG.CHANNEL_ID) }));
                    }
                    if (CONFIG.SYNC_AFTER_RECONNECT && State.postOrder.length) {
                        this.syncAfterReconnect();
                    }
                    State.wsPingInterval = safeSetInterval(() => {
                        if (State.ws?.readyState === WebSocket.OPEN) {
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
                    if (!this.giveUp) this.reconnect();
                };
                State.ws.onerror = (err) => console.error('WebSocket error:', err);
            } catch (err) {
                console.error('WebSocket connection error:', err);
                if (!this.giveUp) this.reconnect();
            }
        },
        async syncAfterReconnect() {
            const lastPostId = State.postOrder[0];
            if (!lastPostId) return;
            try {
                const data = await API.fetchMessagesSince(lastPostId, 50);
                if (data.posts?.length) {
                    data.posts.reverse().forEach(post => this.processFullMessage(post, 'new'));
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
            if (data.event_id && data.event_id > State.lastEventId) State.lastEventId = data.event_id;
            if (data.type === 'event_batch') {
                data.events.forEach(event => {
                    if (event.channel_id === parseInt(CONFIG.CHANNEL_ID)) {
                        if (event.type === 'new') this.handleNewMessage(event);
                        else if (event.type === 'edit') this.handleEditMessage(event);
                        else if (event.type === 'delete') this.handleDeleteMessage(event);
                        else if (event.type === 'media_ready') MediaManager.forceLoadMedia(event.message_id);
                    }
                });
                return;
            }
            if (data.channel_id !== parseInt(CONFIG.CHANNEL_ID)) return;
            if (!State.initialLoadComplete) {
                State.pendingEvents.push({ data: data.data || data, type: data.type });
                return;
            }
            if (data.type === 'new') this.handleNewMessage(data);
            else if (data.type === 'edit') this.handleEditMessage(data);
            else if (data.type === 'delete') this.handleDeleteMessage(data);
            else if (data.type === 'media_ready') MediaManager.forceLoadMedia(data.message_id);
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
            const fullMessage = data.data || await MessageAPI.fetchFullMessage(data.message_id);
            if (fullMessage) this.processFullMessage(fullMessage, 'new');
        },
        async handleEditMessage(data) {
            MessageAPI.invalidateMessage(data.message_id);
            const fullMessage = data.data || await MessageAPI.fetchFullMessage(data.message_id);
            if (fullMessage) this.processFullMessage(fullMessage, 'edit');
        },
        handleDeleteMessage(data) {
            State.posts.delete(data.message_id);
            const index = State.postOrder.indexOf(data.message_id);
            if (index !== -1) State.postOrder.splice(index, 1);
            const postEl = document.querySelector(`.post[data-message-id="${data.message_id}"]`);
            if (postEl) {
                postEl.classList.add('deleted');
                safeSetTimeout(() => postEl.remove(), 300);
            }
        },
        processFullMessage(fullMessage, type = 'new') {
            const post = this.normalizePostData(fullMessage);
            const existingEl = document.querySelector(`.post[data-message-id="${post.message_id}"]`);
            
            if (existingEl && type === 'edit') {
                UI.updatePost(post.message_id, post, fullMessage);
            } else if (!existingEl) {
                if (window.scrollY < 400) {
                    UI.addPostToTop(post);
                } else {
                    State.newPosts.push(post);
                    UI.updateNewPostsBadge();
                }
            }
        },
        flushNewPosts() {
            if (!State.newPosts.length) return;
            const postsToFlush = [...State.newPosts].sort((a, b) => b.message_id - a.message_id);
            State.newPosts = [];
            UI.updateNewPostsBadge();
            postsToFlush.forEach(post => UI.addPostToTop(post));
        },
        reconnect() {
            if (this.giveUp || State.wsReconnectAttempts >= CONFIG.MAX_RECONNECT_ATTEMPTS) return;
            State.wsReconnectAttempts++;
            const delay = Math.min(1000 * Math.pow(1.5, State.wsReconnectAttempts), 30000);
            safeSetTimeout(() => {
                if (!State.wsConnected && !this.giveUp) this.connect(CONFIG.WS_BASE);
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
            if (scrollY < 200 && State.newPosts.length) {
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
            if (!State.isLoading && State.hasMore) MessageLoader.loadMessages();
        }, 300)
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
                if (post?.dataset.mediaUrl) {
                    Lightbox.open(post.dataset.mediaUrl, post.dataset.mediaType);
                    e.preventDefault();
                }
            }
        });

        document.getElementById('channelAvatar').addEventListener('click', () => ThemeManager.toggle());
        document.getElementById('newPostsBadge').addEventListener('click', () => {
            WebSocketManager.flushNewPosts();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
        document.getElementById('scrollTopBtn').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
        document.getElementById('lightboxClose').addEventListener('click', Lightbox.close);
        document.getElementById('lightbox').addEventListener('click', (e) => {
            if (e.target === document.getElementById('lightbox')) Lightbox.close();
        });
        
        window.addEventListener('online', () => MediaManager.loadVisibleMedia());
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && State.newPosts.length) WebSocketManager.flushNewPosts();
        });
        window.addEventListener('beforeunload', cleanupResources);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();