// ==UserScript==
// @name         DeepSeek Anti-recall (Ultimate & Polished UI)
// @name:zh-CN   DeepSeek 防撤回（底层拦截 & 精装修 UI 终极版）
// @version      2026-10-25.70
// @description  通过底层 XHR 拦截实现真防撤回，网页上绝不消失，且实时同步至本地精装修存档库。
// @author       Atom-kkk
// @namespace    https://github.com/Atom-kkk/DeepSeek-Anti-recall
// @match        https://chat.deepseek.com/*
// @icon         https://www.deepseek.com/favicon.ico
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
    'use strict';
    console.log("========== [Anti-recall] 终极防撤回 & 精装修版启动 ==========");

    /* =========================================================
       第一部分：底层网络拦截引擎 (XHR Hook)
       ========================================================= */

    const config = {
        WRITE_THROTTLE_MS: 800,
        DB_NAME: 'ds-anti-recall',
        DB_VERSION: 1,
        STORE: 'messages',
    };

    const TEMPLATE_RESPONSE = "TEMPLATE_RESPONSE";
    const CONTENT_FILTER = "CONTENT_FILTER";
    const RECALL_TIP_CH = "⚠️ 此回复已被拦截，仅在本浏览器存档";
    const RECALL_NOT_FOUND_CH = "⛔️ 此回复已被拦截，且无法在本地缓存中找到";

    // ---- IndexedDB 封装 ----
    let _dbPromise = null;
    function getDB() {
        if (_dbPromise) return _dbPromise;
        _dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(config.DB_NAME, config.DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(config.STORE)) {
                    const store = db.createObjectStore(config.STORE, { keyPath: 'key' });
                    store.createIndex('sessId', 'sessId', { unique: false });
                    store.createIndex('updatedAt', 'updatedAt', { unique: false });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return _dbPromise;
    }

    function idbPut(record) {
        return getDB().then(db => new Promise((resolve, reject) => {
            const tx = db.transaction(config.STORE, 'readwrite');
            tx.objectStore(config.STORE).put(record);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        }));
    }

    function idbGet(key) {
        return getDB().then(db => new Promise((resolve, reject) => {
            const tx = db.transaction(config.STORE, 'readonly');
            const req = tx.objectStore(config.STORE).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        }));
    }

    // ---- 存储 Key / 迁移 ----
    function _getKey(sessId, msgId) { return "deleted-chat-sess-" + sessId + "-msg-" + msgId; }
    function _getPersistKey(sessId, msgId) { return "persist:" + sessId + ":" + msgId; }

    // ---- 实时保存快照 ----
    function persistMessageSnapshot(sessId, response, recalled, locale) {
        if (!sessId || !response || !response.message_id) return;
        const key = _getPersistKey(sessId, response.message_id);
        const record = {
            key, sessId, msgId: response.message_id, updatedAt: Date.now(),
            recalled: !!recalled, locale: locale || 'zh_CN',
            status: response.status || 'UNKNOWN',
            fragments: response.fragments || [],
            isUser: response.role === 'USER'
        };
        schedulePut(record);
    }

    const _pendingRecords = new Map();
    const _flushTimers = new Map();

    function schedulePut(record) {
        _pendingRecords.set(record.key, record);
        if (_flushTimers.has(record.key)) return;
        const t = setTimeout(() => {
            _flushTimers.delete(record.key);
            const rec = _pendingRecords.get(record.key);
            _pendingRecords.delete(record.key);
            if (rec) idbPut(rec).catch(e => console.warn('[Anti-recall] idbPut failed', e));
        }, config.WRITE_THROTTLE_MS);
        _flushTimers.set(record.key, t);
    }

    window.addEventListener('beforeunload', () => {
        for (const [key, timer] of _flushTimers) {
            clearTimeout(timer);
            const rec = _pendingRecords.get(key);
            if (rec) idbPut(rec).catch(() => {});
            _pendingRecords.delete(key);
        }
        _flushTimers.clear();
    });

    // ---- 路径工具 ----
    function _parseKey(key, container) {
        if (Array.isArray(container) && key.match(/^[-+]?\d+$/)) {
            let int = parseInt(key);
            if (int < 0) int = container.length + int;
            return int;
        }
        return key;
    }

    function _setValueByPath(obj, path, value, isAppend) {
        const keys = path.split("/");
        let current = obj;
        for (let i = 0; i < keys.length - 1; i++) {
            let key = _parseKey(keys[i], current);
            if (!(key in current)) {
                const nextKey = _parseKey(keys[i + 1], current);
                current[key] = typeof nextKey === 'number' ? [] : {};
            }
            current = current[key];
        }
        const lastKey = _parseKey(keys[keys.length - 1], current);
        let lastVal = current[lastKey];
        if (isAppend) {
            if (Array.isArray(current[lastKey])) {
                for (let k = 0; k < value.length; k++) current[lastKey].push(value[k]);
            } else {
                current[lastKey] = lastVal + value;
            }
        } else {
            current[lastKey] = value;
        }
        return obj;
    }

    // ---- 状态机处理 (针对 AI 回复) ----
    function DSState() {
        this.fields = {};
        this.sessId = "";
        this.locale = "zh_CN";
        this.recalled = false;
        this._updatePath = "";
        this._updateMode = "SET";
        this._lastPersistLen = 0;
    }

    DSState.prototype.update = function (data) {
        let precheck = this.preCheck(data);
        if (data.p) this._updatePath = data.p;
        if (data.o) this._updateMode = data.o;
        let value = data.v;

        if (typeof value == 'object' && this._updatePath == "") {
            for (var key in value) this.fields[key] = value[key];
            this._tryPersist();
            return precheck;
        }
        this.setField(this._updatePath, value, this._updateMode);
        this._tryPersist();
        return precheck;
    };

    DSState.prototype._tryPersist = function () {
        const resp = this.fields && this.fields.response;
        if (!resp || !resp.message_id || !this.sessId) return;
        const frags = resp.fragments || [];
        const len = frags.length;
        const status = resp.status || '';
        if (len === this._lastPersistLen && status === this._lastPersistStatus && !this.recalled) {
            const lastFrag = frags[len - 1];
            const lastLen = lastFrag && lastFrag.content ? lastFrag.content.length : 0;
            if (lastLen === this._lastPersistLastLen) return;
            this._lastPersistLastLen = lastLen;
        }
        this._lastPersistLen = len;
        this._lastPersistStatus = status;
        persistMessageSnapshot(this.sessId, resp, this.recalled, this.locale);
    };

    DSState.prototype.preCheck = function (data) {
        let path = data.p ? data.p : this._updatePath;
        let mode = data.o ? data.o : this._updateMode;
        let modified = false;

        if (mode == "BATCH" && path == "response") {
            for (let i = 0; i < data.v.length; i++) {
                let v = data.v[i];
                if (v.p == "fragments" && v.v[0].type == TEMPLATE_RESPONSE) {
                    modified = true;
                    data.v[i] = {
                        "v": [{"id": this.fields.response.fragments.length + 1, "type": "TIP", style: "WARNING", "content": RECALL_TIP_CH}],
                        "p": "fragments", "o": "APPEND"
                    };
                }
                if (v.p == "status" && v.v == CONTENT_FILTER) {
                    modified = true;
                    data.v[i] = {"p": "status", "v": "FINISHED"};
                }
            }
        }

        if (modified) {
            this.recalled = true;
            persistMessageSnapshot(this.sessId, this.fields.response, true, this.locale);
            try {
                localStorage.setItem(_getKey(this.sessId, this.fields.response.message_id), JSON.stringify(this.fields.response.fragments));
            } catch (_) {}
            return JSON.stringify(data);
        }
        return "";
    };

    DSState.prototype.setField = function (path, value, mode) {
        if (mode == "BATCH") {
            let subMode = "SET";
            for (let i = 0; i < value.length; i++) {
                let v = value[i];
                if (v.o) subMode = v.o;
                this.setField(path + "/" + v.p, v.v, subMode);
            }
        } else if (mode == "SET") {
            _setValueByPath(this.fields, path, value, false);
        } else if (mode == "APPEND") {
            _setValueByPath(this.fields, path, value, true);
        }
    };

    async function getRecalledMessage(req, sessId, msgId) {
        let record = null;
        try { record = await idbGet(_getPersistKey(sessId, msgId)); } catch (_) {}
        let frags = record ? record.fragments : null;
        if (!frags) {
            try {
                let raw = localStorage.getItem(_getKey(sessId, msgId));
                if (raw) frags = JSON.parse(raw);
            } catch(_) {}
        }

        if (!frags) {
            return [{ content: RECALL_NOT_FOUND_CH, id: 2, type: TEMPLATE_RESPONSE }];
        }

        const out = frags.map(f => ({...f}));
        out.push({"id": out.length + 1, "type": "TIP", style: "WARNING", "content": RECALL_TIP_CH});
        return out;
    }

    function handleEventItem(req, msg) {
        if (!msg.v) return "";
        return req.__dsState.update(msg);
    }

    function onEventStreamResp(req, res) {
        if (req.__messagesCount === undefined) {
            req.__messagesCount = 0;
            req.__dsState = new DSState();
            req.__dsState.sessId = req.__sessId;
        }
        let lastMessageCount = req.__messagesCount;
        let messages = res.split("\n");

        for (let i = lastMessageCount; i < messages.length - 1; i++) {
            let msg = messages[i];
            req.__messagesCount++;
            if (!msg.startsWith("data: ")) continue;
            try {
                let data = JSON.parse(msg.replace("data:", ""));
                let handleRes = handleEventItem(req, data);
                if (handleRes != "") messages[i] = "data: " + handleRes;
            } catch (e) {}
        }

        if (req.__dsState.recalled) {
            let res2 = "";
            for (let l = 0; l < messages.length; l++) res2 += messages[l] + "\n";
            return res2;
        }
        return res;
    }

    // ★ 核心新增：拦截并保存用户发出的提问内容
    function saveUserPrompt(sessId, bodyString, locale) {
        if (!sessId || !bodyString) return;
        try {
            let bodyJson = JSON.parse(bodyString);
            let promptText = bodyJson.prompt || (bodyJson.chat_messages && bodyJson.chat_messages.length > 0 ? bodyJson.chat_messages[bodyJson.chat_messages.length-1].content : null);

            if (promptText) {
                let fakeMsgId = "user_" + Date.now();
                let fakeResponse = {
                    message_id: fakeMsgId,
                    role: "USER",
                    status: "FINISHED",
                    fragments: [{ id: 1, type: "TEXT", content: promptText }]
                };
                persistMessageSnapshot(sessId, fakeResponse, false, locale);

                // 尝试给会话取个初始名字
                getDB().then(db => {
                    const tx = db.transaction(config.STORE, 'readwrite');
                    const store = tx.objectStore(config.STORE);
                    const getReq = store.get(`sess_meta_${sessId}`);
                    getReq.onsuccess = () => {
                        let existing = getReq.result;
                        if (existing && existing.isCustom) return;
                        store.put({
                            key: `sess_meta_${sessId}`,
                            sessId: sessId,
                            isSessionMeta: true,
                            title: promptText.slice(0, 12) + (promptText.length > 12 ? '...' : ''),
                            updatedAt: Date.now()
                        });
                    };
                });
            }
        } catch(e) {}
    }

    // 劫持 XHR 核心逻辑
    function installXhrHook() {
        let originXhrResponse = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, "response");
        let originXhrResponseText = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, "responseText");
        let originXhrOpen = XMLHttpRequest.prototype.open;
        let originXhrSend = XMLHttpRequest.prototype.send;
        let originXhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

        function preloadHistory(req) {
            const orig = originXhrResponseText.get.call(req);
            let json;
            try { json = JSON.parse(orig); } catch (_) { return; }
            if (!json.data || !json.data.biz_data) return;
            const data = json.data.biz_data;
            const sessId = data.chat_session && data.chat_session.id;
            if (!sessId) return;

            let modified = false;
            const tasks = [];
            for (let i = 0; i < data.chat_messages.length; i++) {
                const m = data.chat_messages[i];
                if (m.status == CONTENT_FILTER) {
                    tasks.push(
                        getRecalledMessage(req, sessId, m.message_id).then(frags => {
                            m.fragments = frags;
                            m.status = "FINISHED";
                            modified = true;
                        })
                    );
                } else {
                    tasks.push(
                        idbGet(_getPersistKey(sessId, m.message_id)).then(rec => {
                            if (rec && rec.fragments && rec.fragments.length > (m.fragments ? m.fragments.length : 0)) {
                                m.fragments = rec.fragments;
                                modified = true;
                            }
                        }).catch(() => {})
                    );
                }
            }
            Promise.all(tasks).then(() => {
                if (modified) {
                    json.data.biz_data = data;
                    req.__historyModifiedText = JSON.stringify(json);
                }
                req.__historyPreloaded = true;
            });
        }

        Object.defineProperty(XMLHttpRequest.prototype, "response", {
            get: function () {
                if (!this.__reqType) return originXhrResponse.get.call(this);
                if (this.__reqType === "history") {
                    if (this.__historyPreloaded && this.__historyModifiedText) return this.__historyModifiedText;
                    if (!this.__historyPreloading) { this.__historyPreloading = true; preloadHistory(this); }
                    return originXhrResponse.get.call(this);
                }
                return onEventStreamResp(this, originXhrResponse.get.call(this));
            },
            set: function (body) { return originXhrResponse.set.call(this, body); }
        });

        Object.defineProperty(XMLHttpRequest.prototype, "responseText", {
            get: function () {
                if (!this.__reqType) return originXhrResponseText.get.call(this);
                if (this.__reqType === "history") {
                    if (this.__historyPreloaded && this.__historyModifiedText) return this.__historyModifiedText;
                    if (!this.__historyPreloading) { this.__historyPreloading = true; preloadHistory(this); }
                    return originXhrResponseText.get.call(this);
                }
                return onEventStreamResp(this, originXhrResponseText.get.call(this));
            },
            set: function (body) { return originXhrResponseText.set.call(this, body); }
        });

        XMLHttpRequest.prototype.open = function (method, url) {
            let [urlPath] = url.split("?");
            if (urlPath == '/api/v0/chat/history_messages') this.__reqType = "history";
            else if (['/api/v0/chat/completion', '/api/v0/chat/edit_message', '/api/v0/chat/regenerate', '/api/v0/chat/continue', '/api/v0/chat/resume_stream'].includes(urlPath)) this.__reqType = "generate";
            return originXhrOpen.apply(this, arguments);
        };

        XMLHttpRequest.prototype.send = function (body) {
            if (!this.__reqType) return originXhrSend.apply(this, arguments);

            if (this.__reqType == "generate" && body) {
                try {
                    let bodyJson = JSON.parse(body);
                    this.__sessId = bodyJson.chat_session_id;
                    saveUserPrompt(this.__sessId, body, this.__locale || "zh_CN");
                } catch (_) {}
            }
            return originXhrSend.apply(this, arguments);
        };

        XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
            if (this.__reqType && header == "x-client-locale") this.__locale = value;
            return originXhrSetRequestHeader.apply(this, arguments);
        };
    }

    installXhrHook();


    /* =========================================================
       第二部分：存档库 UI 渲染引擎
       ========================================================= */

    function getCurrentSessionId() {
        const match = location.pathname.match(/\/s\/([a-zA-Z0-9-]+)/);
        return match ? match[1] : 'unknown';
    }

    async function openArchiveViewer() {
        try {
            let existing = document.getElementById('ds-archive-viewer');
            if (existing) { existing.remove(); return; }

            const db = await getDB();
            const tx = db.transaction(config.STORE, 'readonly');
            const store = tx.objectStore(config.STORE);
            const req = store.getAll();

            req.onsuccess = () => {
                try {
                    let allRecords = req.result || [];
                    let sessionsData = new Map();
                    let messages = [];

                    allRecords.forEach(r => {
                        if (r.isSessionMeta) {
                            sessionsData.set(String(r.sessId), { sessId: String(r.sessId), title: r.title, updatedAt: r.updatedAt });
                        } else {
                            messages.push(r);
                        }
                    });

                    messages.forEach(m => {
                        let sId = String(m.sessId || "unknown");
                        if (!sessionsData.has(sId)) {
                            sessionsData.set(sId, { sessId: sId, title: `本地记录 (${sId.slice(0,6)})`, updatedAt: m.updatedAt || Date.now() });
                        }
                    });

                    let sessions = Array.from(sessionsData.values());
                    sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

                    if (sessions.length === 0) {
                        alert("暂无存档数据。请先和 AI 聊天或刷新页面。");
                        return;
                    }
                    renderViewer(sessions, messages);
                } catch (e) {
                    alert("解析数据库失败: " + e.message);
                }
            };
        } catch (err) {}
    }

    function renderViewer(sessions, allMsgs) {
        const currentSessId = getCurrentSessionId();

        let sessionHtml = "";
        sessions.forEach((s, idx) => {
            let safeTitle = (s.title || "未命名").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            let isCur = s.sessId === currentSessId ? '<span style="color:#1a73e8; font-size:12px; margin-left:4px;">(当前)</span>' : '';
            let activeStyle = idx === 0 ? 'background:#e8f0fe; color:#1a73e8; border-left:3px solid #1a73e8;' : 'border-left:3px solid transparent; color:#333;';

            sessionHtml += `
                <div class="ds-sess-item" data-id="${s.sessId}" style="position:relative; padding:14px 50px 14px 16px; border-bottom:1px solid #f0f0f0; cursor:pointer; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; ${activeStyle} transition: background 0.2s; user-select:none;"
                     onmouseover="this.querySelector('.del-btn').style.display='inline-block'"
                     onmouseout="this.querySelector('.del-btn').style.display='none'">
                    <span class="title-text">${safeTitle}</span> ${isCur}
                    <span class="del-btn" style="display:none; position:absolute; right:12px; top:12px; color:#d32f2f; font-size:12px; background:#ffebee; padding:2px 6px; border-radius:4px; cursor:pointer;" title="删除整个对话">[删除]</span>
                </div>
            `;
        });

        let html = `
            <div style="position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.5); z-index:2147483647; display:flex; justify-content:center; align-items:center; backdrop-filter: blur(2px);" id="ds-archive-viewer">
                <div style="background:#fff; width:1200px; max-width:98%; height:88vh; border-radius:12px; display:flex; flex-direction:column; box-shadow:0 10px 30px rgba(0,0,0,0.2); overflow:hidden;">
                    <div style="padding:16px 20px; border-bottom:1px solid #eee; display:flex; justify-content:space-between; align-items:center; background:#fff; flex-shrink:0;">
                        <h2 style="margin:0; font-size:18px; color:#333;">📚 本地对话归档库 <span style="font-size:12px;color:#888;font-weight:normal;margin-left:10px;">(双击左侧可改名，悬停气泡可单条删除)</span></h2>
                        <button id="ds-close-viewer" style="background:#f5f5f5; border:none; padding:6px 12px; border-radius:6px; cursor:pointer; font-size:14px;">关闭</button>
                    </div>
                    <div style="display:flex; flex:1; overflow:hidden; height:100%;">
                        <div style="width:240px; background:#f9f9f9; border-right:1px solid #eee; overflow-y:auto; height:100%; box-sizing:border-box;" id="ds-session-list">
                            ${sessionHtml}
                        </div>
                        <div style="flex:1; padding:20px 40px; overflow-y:auto; background:#fff; position:relative; height:100%; box-sizing:border-box;" id="ds-message-list"></div>
                        <div style="width:260px; background:#fafafa; border-left:1px solid #eee; overflow-y:auto; padding:12px; height:100%; box-sizing:border-box;" id="ds-toc-list"></div>
                    </div>
                </div>
            </div>
        `;

        const div = document.createElement('div');
        div.innerHTML = html;
        document.body.appendChild(div);

        document.getElementById('ds-close-viewer').onclick = () => {
            document.getElementById('ds-archive-viewer').remove();
        };

        function scrollToMessage(tocItem) {
            const targetId = tocItem.getAttribute('data-target');
            const targetEl = document.getElementById(targetId);
            const container = document.getElementById('ds-message-list');
            if (targetEl && container) {
                const containerRect = container.getBoundingClientRect();
                const targetRect = targetEl.getBoundingClientRect();
                const targetScrollTop = container.scrollTop + (targetRect.top - containerRect.top) - 20;
                container.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
                targetEl.style.transition = 'background-color 0.3s, box-shadow 0.3s';
                targetEl.style.backgroundColor = '#fff3cd';
                targetEl.style.boxShadow = '0 0 0 4px rgba(255, 193, 7, 0.4)';
                setTimeout(() => {
                    targetEl.style.backgroundColor = targetEl.getAttribute('data-original-bg') || 'transparent';
                    targetEl.style.boxShadow = 'none';
                }, 1500);
            }
        }

        let tocClickTimer = null;
        document.getElementById('ds-toc-list').addEventListener('click', function(e) {
            const tocItem = e.target.closest('.ds-toc-item');
            if (!tocItem) return;
            if (tocClickTimer) clearTimeout(tocClickTimer);
            tocClickTimer = setTimeout(() => { tocClickTimer = null; scrollToMessage(tocItem); }, 200);
        });

        document.getElementById('ds-message-list').addEventListener('click', function(e) {
            if (e.target.classList.contains('del-single-btn')) {
                const msgKey = e.target.getAttribute('data-key');
                if (msgKey && confirm("确定要删除这条记录吗？")) {
                    getDB().then(db => {
                        const tx = db.transaction(config.STORE, 'readwrite');
                        tx.objectStore(config.STORE).delete(msgKey);
                        tx.oncomplete = () => {
                            const wrapper = e.target.closest('.msg-wrapper');
                            if (wrapper) wrapper.remove();
                            const tocItem = document.querySelector(`.ds-toc-item[data-key="${msgKey}"]`);
                            if (tocItem) tocItem.remove();
                        };
                    });
                }
            }
        });

        function cleanText(rawText) {
            if (!rawText) return "";
            let text = rawText;
            text = text.replace(/[\r\n\u2028\u2029]+/g, '\n');
            text = text.replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\uFEFF]/g, ' ');
            let lines = text.split('\n');
            lines = lines.map(line => line.trim());
            text = lines.join('\n');
            text = text.replace(/^\n+|\n+$/g, '');
            text = text.replace(/\n{3,}/g, '\n\n');
            return text.trim();
        }

        function loadMessages(sessId) {
            let msgs = allMsgs.filter(m => String(m.sessId) === String(sessId));
            msgs.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));

            let msgHtml = '';
            let tocHtml = '';
            let visualIndex = 0;

            if (msgs.length === 0) {
                msgHtml = `<p style="text-align:center; color:#999; margin-top:50px;">此对话无详细记录</p>`;
            } else {
                msgs.forEach((item) => {
                    let rawText = item.fragments.map(f => f.content || "").join("");
                    let text = cleanText(rawText);
                    if (!text) return;

                    let isUser = item.isUser;
                    let isBlocked = item.recalled;
                    let safeText = text.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, '<br>');

                    if (!isUser) {
                        let rawTitle = text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
                        let preview = rawTitle.slice(0, 20) + (rawTitle.length > 20 ? '...' : '');
                        let icon = isBlocked ? '🚫' : '🤖';
                        let defaultTitle = `${icon} ${preview}`;

                        let textColor = isBlocked ? '#d32f2f' : '#555';
                        let borderColor = isBlocked ? '#ef5350' : '#bbb';
                        let bgColor = isBlocked ? '#fff4f4' : '#fff';
                        let hoverBg = isBlocked ? '#ffe5e5' : '#e8f0fe';
                        let hoverColor = isBlocked ? '#b71c1c' : '#1a73e8';

                        tocHtml += `
                            <div class="ds-toc-item" data-target="ds-msg-${visualIndex}" data-key="${item.key}" style="padding:8px; margin-bottom:4px; font-size:13px; color:${textColor}; cursor:pointer; border-radius:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; border-left: 2px solid ${borderColor}; background: ${bgColor}; transition: background 0.2s, color 0.2s;" onmouseover="this.style.background='${hoverBg}';this.style.color='${hoverColor}'" onmouseout="this.style.background='${bgColor}';this.style.color='${textColor}'" title="${rawTitle.replace(/"/g, '&quot;')}">
                                ${defaultTitle}
                            </div>
                        `;
                    }

                    let delBtnHtml = `<span class="del-single-btn" data-key="${item.key}" style="display:none; position:absolute; top:50%; transform:translateY(-50%); ${isUser ? 'left:-35px;' : 'right:-35px;'} width:24px; height:24px; background:#ffebee; color:#d32f2f; border-radius:50%; text-align:center; line-height:24px; cursor:pointer; font-size:12px;" onmouseover="this.style.background='#ffcdd2'" onmouseout="this.style.background='#ffebee'" title="删除此条">✕</span>`;

                    if (isUser) {
                        msgHtml += `
                            <div class="msg-wrapper" style="position:relative; margin-bottom: 20px; text-align: right; padding: 0 10px;" onmouseover="this.querySelector('.del-single-btn').style.display='block'" onmouseout="this.querySelector('.del-single-btn').style.display='none'">
                                <div id="ds-msg-${visualIndex}" data-original-bg="#d9e7fb" style="display: inline-block; text-align: left !important; background: #d9e7fb; color: #000; padding: 10px 16px !important; border-radius: 12px 12px 2px 12px; max-width: 75%; white-space: normal !important; word-break: break-word; font-size: 14px; line-height: 1.6; position:relative; box-shadow:0 1px 2px rgba(0,0,0,0.05);">
                                    ${delBtnHtml}
                                    ${safeText}
                                </div>
                            </div>
                        `;
                    } else {
                        let badge = isBlocked ? `<span style="background:#ffebee; color:#c62828; padding:2px 6px; border-radius:4px; font-size:12px; margin-left:8px;">已被官方撤回/拦截 (本地留存)</span>` : '';
                        msgHtml += `
                            <div class="msg-wrapper" style="position:relative; margin-bottom: 20px; text-align: left; padding: 0 10px;" onmouseover="this.querySelector('.del-single-btn').style.display='block'" onmouseout="this.querySelector('.del-single-btn').style.display='none'">
                                <div id="ds-msg-${visualIndex}" data-original-bg="#f7f7f8" style="display: inline-block; text-align: left !important; background: #f7f7f8; border: 1px solid ${isBlocked ? '#ffcdd2' : '#e0e0e0'}; color: #333; padding: 10px 16px !important; border-radius: 12px 12px 12px 2px; max-width: 75%; white-space: normal !important; word-break: break-word; font-size: 14px; line-height: 1.6; position:relative; box-shadow:0 1px 2px rgba(0,0,0,0.05);">
                                    ${delBtnHtml}
                                    <div style="margin-bottom: 6px; font-size: 12px; color: #888;">AI 回复 ${badge}</div>
                                    ${safeText}
                                </div>
                            </div>
                        `;
                    }
                    visualIndex++;
                });
            }

            if (tocHtml.trim() === '') {
                document.getElementById('ds-toc-list').style.display = 'none';
                document.getElementById('ds-message-list').style.width = '100%';
            } else {
                document.getElementById('ds-toc-list').style.display = 'block';
                document.getElementById('ds-toc-list').innerHTML = tocHtml;
            }

            document.getElementById('ds-message-list').innerHTML = msgHtml;
            document.getElementById('ds-message-list').scrollTop = 0;
        }

        const items = document.querySelectorAll('.ds-sess-item');
        items.forEach(item => {
            item.onclick = function(e) {
                if (e.target.classList.contains('del-btn')) return;
                items.forEach(i => {
                    i.style.background = 'transparent';
                    i.style.color = '#333';
                    i.style.borderLeftColor = 'transparent';
                });
                this.style.background = '#e8f0fe';
                this.style.color = '#1a73e8';
                this.style.borderLeftColor = '#1a73e8';
                loadMessages(this.getAttribute('data-id'));
            };

            // 双击改名功能
            item.ondblclick = function(e) {
                if (e.target.classList.contains('del-btn')) return;
                e.stopPropagation();
                const sessId = this.getAttribute('data-id');
                const titleSpan = this.querySelector('.title-text');
                const currentTitle = titleSpan.innerText.trim();
                const newTitle = prompt("请输入新的对话标题：", currentTitle);
                if (newTitle && newTitle.trim() !== "" && newTitle !== currentTitle) {
                    const finalTitle = newTitle.trim();
                    titleSpan.innerText = finalTitle;
                    getDB().then(db => {
                        const tx = db.transaction(config.STORE, 'readwrite');
                        const store = tx.objectStore(config.STORE);
                        const getReq = store.get(`sess_meta_${sessId}`);
                        getReq.onsuccess = () => {
                            let meta = getReq.result || {};
                            meta.key = `sess_meta_${sessId}`;
                            meta.sessId = sessId;
                            meta.isSessionMeta = true;
                            meta.title = finalTitle;
                            meta.isCustom = true; // 标记为自定义，防止被后台自动改名覆盖
                            meta.updatedAt = Date.now();
                            store.put(meta);
                        };
                    });
                }
            };

            const delBtn = item.querySelector('.del-btn');
            if (delBtn) {
                delBtn.onclick = function(e) {
                    e.stopPropagation();
                    const sessId = item.getAttribute('data-id');
                    if (confirm(`确定要彻底删除对话记录吗？`)) {
                        getDB().then(db => {
                            const tx = db.transaction(config.STORE, 'readwrite');
                            const store = tx.objectStore(config.STORE);
                            const index = store.index('sessId');
                            index.openCursor(IDBKeyRange.only(sessId)).onsuccess = (ev) => {
                                const cursor = ev.target.result;
                                if (cursor) { cursor.delete(); cursor.continue(); }
                            };
                            store.delete(`sess_meta_${sessId}`);
                            tx.oncomplete = () => {
                                item.remove();
                                for (let i = allMsgs.length - 1; i >= 0; i--) {
                                    if (String(allMsgs[i].sessId) === String(sessId)) allMsgs.splice(i, 1);
                                }
                                document.getElementById('ds-message-list').innerHTML = `<p style="text-align:center; color:#999; margin-top:50px;">暂无对话记录</p>`;
                                document.getElementById('ds-toc-list').style.display = 'none';
                            };
                        });
                    }
                };
            }
        });

        let initialSessId = (sessions.find(s => String(s.sessId) === currentSessId) || sessions[0]).sessId;
        setTimeout(() => {
            const initialItem = document.querySelector(`.ds-sess-item[data-id="${initialSessId}"]`);
            if (initialItem) initialItem.click();
        }, 50);
    }

    /* =========================================================
       第三部分：数据导入/导出
       ========================================================= */

    async function exportData() {
        const db = await getDB();
        const tx = db.transaction(config.STORE, 'readonly');
        const store = tx.objectStore(config.STORE);
        const req = store.getAll();
        req.onsuccess = () => {
            const data = req.result || [];
            if (data.length === 0) {
                alert("当前没有任何记录，无需导出。");
                return;
            }
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `deepseek_anticall_backup_${new Date().toISOString().slice(0,10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
        };
    }

    function importData() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    const imported = JSON.parse(event.target.result);
                    if (!Array.isArray(imported)) throw new Error("数据格式错误，必须是数组。");

                    let count = 0;
                    getDB().then(db => {
                        const tx = db.transaction(config.STORE, 'readwrite');
                        const store = tx.objectStore(config.STORE);

                        imported.forEach(rec => {
                            if (rec.key && rec.sessId) {
                                // 简单的冲突处理：如果已有，除非导入的更新，否则覆盖
                                store.put(rec);
                                count++;
                            }
                        });

                        tx.oncomplete = () => {
                            alert(`✅ 成功导入 ${count} 条记录！请刷新页面或重新打开存档库查看。`);
                            location.reload();
                        };
                        tx.onerror = (err) => {
                            alert("导入失败：" + err.message);
                        };
                    });
                } catch (err) {
                    alert("解析 JSON 失败：" + err.message);
                }
            };
            reader.readAsText(file);
        };
        input.click();
    }


    /* =========================================================
       第四部分：菜单与入口挂载
       ========================================================= */

    if (typeof GM_registerMenuCommand !== 'undefined') {
        GM_registerMenuCommand("🗑️ 清空所有本地记录", () => {
            if (confirm("确定要清空本地保存的所有对话记录吗？(不可恢复)")) {
                getDB().then(db => {
                    const tx = db.transaction(config.STORE, 'readwrite');
                    tx.objectStore(config.STORE).clear();
                    tx.oncomplete = () => { alert("✅ 已清空！请刷新页面。"); location.reload(); };
                });
            }
        });
        GM_registerMenuCommand("📖 打开分类对话归档器", openArchiveViewer);
        GM_registerMenuCommand("📤 导出记录 (JSON)", exportData);
        GM_registerMenuCommand("📥 导入记录 (JSON)", importData);
    }

    function addFloatingButton() {
        if (document.getElementById('ds-archive-btn')) return;
        let btn = document.createElement('div');
        btn.id = 'ds-archive-btn';
        btn.innerHTML = '📚 存档库';
        btn.style = "position:fixed; bottom:20px; right:20px; background:#1a73e8; color:#fff; padding:10px 16px; border-radius:20px; cursor:pointer; z-index:2147483647; font-size:14px; box-shadow:0 4px 12px rgba(0,0,0,0.15); font-weight:bold; user-select:none;";
        btn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            openArchiveViewer();
        };
        document.body.appendChild(btn);
    }

    setTimeout(addFloatingButton, 1500);
    console.log('[Anti-recall] ========== 终极防撤回 & 精装修版已启动 ==========');
})();
