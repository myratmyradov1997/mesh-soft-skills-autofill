// ==UserScript==
// @name         МЭШ Автозаполнение Soft Skills PRO — DEBUG
// @namespace    http://tampermonkey.net/
// @version      2.4-debug
// @description  DEBUG-версия с максимальным логированием, таймаутами и fallback'ами для диагностики проблем
// @author       You
// @match        https://school.mos.ru/*
// @grant        GM_addStyle
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // === БЕЗОПАСНЫЙ ДОСТУП К LOCALSTORAGE ===
    function getStorageItem(key) {
        try { return localStorage.getItem(key); } catch (e) { return null; }
    }
    function setStorageItem(key, val) {
        try { localStorage.setItem(key, val); } catch (e) {}
    }
    function removeStorageItem(key) {
        try { localStorage.removeItem(key); } catch (e) {}
    }

    // === СОСТОЯНИЕ АВТОРИЗАЦИИ ===
    let authState = {
        token: getStorageItem('mss_captured_token') || null,
        profileId: getStorageItem('mss_captured_profile_id') || null,
        academicYearId: getStorageItem('mss_captured_ayid') || null
    };

    // Перехват сетевых запросов для автоматического захвата токенов, profileId и academic_year_id
    (function interceptNetwork() {
        const originalFetch = window.fetch;
        window.fetch = function (resource, options) {
            try {
                let headersObj = null;
                let urlStr = '';
                if (resource && resource instanceof Request) {
                    headersObj = resource.headers;
                    urlStr = resource.url || '';
                } else {
                    urlStr = String(resource);
                    if (options && options.headers) headersObj = options.headers;
                }

                // Перехват academic_year_id из URL
                if (urlStr) {
                    const ayMatch = urlStr.match(/academic_year_id[=\/]?(\d+)/);
                    if (ayMatch && ayMatch[1]) {
                        const newAy = ayMatch[1];
                        if (newAy !== authState.academicYearId) {
                            authState.academicYearId = newAy;
                            setStorageItem('mss_captured_ayid', newAy);
                            console.log('[DEBUG] Перехвачен academic_year_id:', newAy, 'из URL:', urlStr.substring(0, 120));
                        }
                    }
                }

                if (headersObj) {
                    let auth = null;
                    let prof = null;
                    if (typeof Headers !== 'undefined' && headersObj instanceof Headers) {
                        auth = headersObj.get('Authorization');
                        prof = headersObj.get('Profile-Id');
                    } else if (typeof headersObj === 'object') {
                        for (const key in headersObj) {
                            if (key.toLowerCase() === 'authorization') auth = headersObj[key];
                            if (key.toLowerCase() === 'profile-id') prof = headersObj[key];
                        }
                    }

                    if (auth && typeof auth === 'string' && auth.startsWith('Bearer ')) {
                        const t = auth.substring(7);
                        if (t !== authState.token) {
                            authState.token = t;
                            setStorageItem('mss_captured_token', t);
                            console.log('[DEBUG] Перехвачен Bearer токен через fetch');
                        }
                    }
                    if (prof) {
                        const p = String(prof);
                        if (p !== authState.profileId) {
                            authState.profileId = p;
                            setStorageItem('mss_captured_profile_id', p);
                            console.log('[DEBUG] Перехвачен Profile-Id через fetch:', p);
                        }
                    }
                }
            } catch (e) {
                console.error('[DEBUG] Ошибка в перехватчике fetch:', e);
            }
            return originalFetch.apply(this, arguments);
        };

        const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
        XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
            try {
                if (header && typeof header === 'string' && value && typeof value === 'string') {
                    if (header.toLowerCase() === 'authorization' && value.startsWith('Bearer ')) {
                        const t = value.substring(7);
                        if (t !== authState.token) {
                            authState.token = t;
                            setStorageItem('mss_captured_token', t);
                            console.log('[DEBUG] Перехвачен Bearer токен через XHR');
                        }
                    }
                    if (header.toLowerCase() === 'profile-id') {
                        const p = String(value);
                        if (p !== authState.profileId) {
                            authState.profileId = p;
                            setStorageItem('mss_captured_profile_id', p);
                            console.log('[DEBUG] Перехвачен Profile-Id через XHR:', p);
                        }
                    }
                }
            } catch (e) {
                console.error('[DEBUG] Ошибка в перехватчике XHR:', e);
            }
            return originalSetRequestHeader.apply(this, arguments);
        };

        // Перехват open() XHR для academic_year_id в URL
        const originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url, async, user, password) {
            try {
                if (url) {
                    const ayMatch = String(url).match(/academic_year_id[=\/]?(\d+)/);
                    if (ayMatch && ayMatch[1]) {
                        const newAy = ayMatch[1];
                        if (newAy !== authState.academicYearId) {
                            authState.academicYearId = newAy;
                            setStorageItem('mss_captured_ayid', newAy);
                            console.log('[DEBUG] Перехвачен academic_year_id из XHR URL:', newAy);
                        }
                    }
                }
            } catch (e) {}
            return originalOpen.apply(this, arguments);
        };
    })();

    // === КОНФИГУРАЦИЯ ===
    const DEFAULT_CONFIG = {
        thresholds: {
            self_org: { always: 4.6, often: 3.7, rarely: 3.0 },
            self_edu: { always: 4.8, often: 4.0, rarely: 3.3 },
            self_reg: { always: 4.6, often: 3.7, rarely: 3.0 },
            comm:     { always: 4.6, often: 3.7, rarely: 3.0 }
        },
        offsets: {
            1: 0.25, 2: 0.15, 3: -0.35, 4: -0.20,
            5: 0.05, 6: 0.10, 7: 0.20,
            11: 0.30, 13: 0.25, 14: -0.30
        },
        apiBase: 'https://school.mos.ru',
        academicYearId: null
    };

    let CONFIG = loadSettings();

    function loadSettings() {
        try {
            const saved = getStorageItem('mss_pro_config');
            if (saved) {
                const parsed = JSON.parse(saved);
                if (parsed && typeof parsed === 'object') {
                    return {
                        thresholds: { ...DEFAULT_CONFIG.thresholds, ...(parsed.thresholds || {}) },
                        offsets: { ...DEFAULT_CONFIG.offsets, ...(parsed.offsets || {}) },
                        apiBase: DEFAULT_CONFIG.apiBase,
                        academicYearId: parsed.academicYearId || null
                    };
                }
            }
        } catch (e) {
            console.error('Ошибка загрузки настроек:', e);
        }
        return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }

    function saveSettings() {
        setStorageItem('mss_pro_config', JSON.stringify({
            thresholds: CONFIG.thresholds,
            offsets: CONFIG.offsets,
            academicYearId: CONFIG.academicYearId
        }));
    }

    const QUESTION_CATEGORY = {
        1: 'self_org', 2: 'self_org',
        3: 'self_edu', 4: 'self_edu',
        5: 'self_reg', 6: 'self_reg', 7: 'self_reg',
        11: 'comm', 13: 'comm', 14: 'comm'
    };

    function getAcademicYearId() {
        if (CONFIG.academicYearId) return CONFIG.academicYearId;
        if (authState.academicYearId) return authState.academicYearId;
        return '13';
    }

    // === СКАНИРОВАНИЕ ХРАНИЛИЩ ===
    function scanStorageForCredentials() {
        try {
            if (authState.token && authState.profileId) return;
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                const val = localStorage.getItem(key);
                if (val) {
                    if (val.startsWith('eyJ') || val.startsWith('Bearer eyJ')) {
                        authState.token = val.replace('Bearer ', '');
                    }
                    try {
                        const obj = JSON.parse(val);
                        const t = findJwtInObject(obj);
                        if (t) authState.token = t;
                        const p = findProfileIdInObject(obj);
                        if (p) authState.profileId = String(p);
                    } catch (e) {}
                }
            }
            for (let i = 0; i < sessionStorage.length; i++) {
                const key = sessionStorage.key(i);
                const val = sessionStorage.getItem(key);
                if (val) {
                    if (val.startsWith('eyJ') || val.startsWith('Bearer eyJ')) {
                        authState.token = val.replace('Bearer ', '');
                    }
                    try {
                        const obj = JSON.parse(val);
                        const t = findJwtInObject(obj);
                        if (t) authState.token = t;
                        const p = findProfileIdInObject(obj);
                        if (p) authState.profileId = String(p);
                    } catch (e) {}
                }
            }
            if (!authState.profileId) {
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (key && key.toLowerCase().includes('profile')) {
                        const val = localStorage.getItem(key);
                        if (val && !isNaN(val)) authState.profileId = val;
                    }
                }
            }
            // Ищем academic_year_id
            if (!authState.academicYearId) {
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (key && key.toLowerCase().includes('academic_year')) {
                        const val = localStorage.getItem(key);
                        if (val && !isNaN(val)) {
                            authState.academicYearId = val;
                            setStorageItem('mss_captured_ayid', val);
                        }
                    }
                }
            }
        } catch (e) {
            console.error('[DEBUG] Ошибка при сканировании хранилища:', e);
        }
    }

    function findJwtInObject(obj) {
        if (!obj || typeof obj !== 'object') return null;
        for (const key in obj) {
            const val = obj[key];
            if (typeof val === 'string' && (val.startsWith('eyJ') || val.startsWith('Bearer eyJ'))) {
                return val.replace('Bearer ', '');
            }
            if (typeof val === 'object') {
                const res = findJwtInObject(val);
                if (res) return res;
            }
        }
        return null;
    }

    function findProfileIdInObject(obj) {
        if (!obj || typeof obj !== 'object') return null;
        for (const key in obj) {
            if (key.toLowerCase() === 'profileid' || key.toLowerCase() === 'profile_id') {
                if (obj[key] && !isNaN(obj[key])) return obj[key];
            }
            const val = obj[key];
            if (typeof val === 'object') {
                const res = findProfileIdInObject(val);
                if (res) return res;
            }
        }
        return null;
    }

    async function getProfileId() {
        if (authState.profileId) return authState.profileId;
        scanStorageForCredentials();
        if (authState.profileId) return authState.profileId;
        const m = window.location.pathname.match(/\/teacher\/(\d+)/);
        if (m) {
            authState.profileId = m[1];
            setStorageItem('mss_captured_profile_id', m[1]);
            return m[1];
        }
        return null;
    }

    // === MD5 ===
    function md5(string) {
        function RotateLeft(lValue, iShiftBits) { return (lValue<<iShiftBits) | (lValue>>>(32-iShiftBits)); }
        function AddUnsigned(lX,lY) {
            var lX8,lY8,lX4,lY4,lResult;
            lX8 = (lX & 0x80000000); lY8 = (lY & 0x80000000); lX4 = (lX & 0x40000000); lY4 = (lY & 0x40000000);
            lResult = (lX & 0x3FFFFFFF)+(lY & 0x3FFFFFFF);
            if (lX4 & lY4) return (lResult ^ 0x80000000 ^ lX8 ^ lY8);
            if (lX4 | lY4) {
                if (lResult & 0x40000000) return (lResult ^ 0xC0000000 ^ lX8 ^ lY8);
                else return (lResult ^ 0x40000000 ^ lX8 ^ lY8);
            } else return (lResult ^ lX8 ^ lY8);
        }
        function F(x,y,z) { return (x & y) | ((~x) & z); }
        function G(x,y,z) { return (x & z) | (y & (~z)); }
        function H(x,y,z) { return (x ^ y ^ z); }
        function I(x,y,z) { return (y ^ (x | (~z))); }
        function FF(a,b,c,d,x,s,ac) { a = AddUnsigned(a, AddUnsigned(AddUnsigned(F(b,c,d), x), ac)); return AddUnsigned(RotateLeft(a, s), b); }
        function GG(a,b,c,d,x,s,ac) { a = AddUnsigned(a, AddUnsigned(AddUnsigned(G(b,c,d), x), ac)); return AddUnsigned(RotateLeft(a, s), b); }
        function HH(a,b,c,d,x,s,ac) { a = AddUnsigned(a, AddUnsigned(AddUnsigned(H(b,c,d), x), ac)); return AddUnsigned(RotateLeft(a, s), b); }
        function II(a,b,c,d,x,s,ac) { a = AddUnsigned(a, AddUnsigned(AddUnsigned(I(b,c,d), x), ac)); return AddUnsigned(RotateLeft(a, s), b); }
        function ConvertToWordArray(string) {
            var lWordCount, lMessageLength = string.length, lNumberOfWords_temp1 = lMessageLength + 8;
            var lNumberOfWords_temp2 = (lNumberOfWords_temp1 - (lNumberOfWords_temp1 % 64)) / 64;
            var lNumberOfWords = (lNumberOfWords_temp2 + 1) * 16, lWordArray = Array(lNumberOfWords), lBytePosition = 0, lByteCount = 0;
            while ( lByteCount < lMessageLength ) {
                lWordCount = (lByteCount - (lByteCount % 4)) / 4; lBytePosition = (lByteCount % 4) * 8;
                lWordArray[lWordCount] = (lWordArray[lWordCount] | (string.charCodeAt(lByteCount)<<lBytePosition));
                lByteCount++;
            }
            lWordCount = (lByteCount - (lByteCount % 4)) / 4; lBytePosition = (lByteCount % 4) * 8;
            lWordArray[lWordCount] = lWordArray[lWordCount] | (0x80<<lBytePosition);
            lWordArray[lNumberOfWords-2] = lMessageLength << 3; lWordArray[lNumberOfWords-1] = lMessageLength >>> 29;
            return lWordArray;
        }
        function WordToHex(lValue) {
            var WordToHexValue="",WordToHexValue_temp="",lByte,lCount;
            for (lCount = 0;lCount<=3;lCount++) {
                lByte = (lValue>>>(lCount*8)) & 255;
                WordToHexValue_temp = "0" + lByte.toString(16);
                WordToHexValue = WordToHexValue + WordToHexValue_temp.substr(WordToHexValue_temp.length-2,2);
            }
            return WordToHexValue;
        }
        function Utf8Encode(string) {
            string = string.replace(/\r\n/g,"\n");
            var utftext = "";
            for (var n = 0; n < string.length; n++) {
                var c = string.charCodeAt(n);
                if (c < 128) utftext += String.fromCharCode(c);
                else if((c > 127) && (c < 2048)) {
                    utftext += String.fromCharCode((c >> 6) | 192);
                    utftext += String.fromCharCode((c & 63) | 128);
                } else {
                    utftext += String.fromCharCode((c >> 12) | 224);
                    utftext += String.fromCharCode(((c >> 6) & 63) | 128);
                    utftext += String.fromCharCode((c & 63) | 128);
                }
            }
            return utftext;
        }
        var x=Array(), k,AA,BB,CC,DD,a,b,c,d;
        var S11=7, S12=12, S13=17, S14=22;
        var S21=5, S22=9 , S23=14, S24=20;
        var S31=4, S32=11, S33=16, S34=23;
        var S41=6, S42=10, S43=15, S44=21;
        string = Utf8Encode(string); x = ConvertToWordArray(string);
        a = 0x67452301; b = 0xEFCDAB89; c = 0x98BADCFE; d = 0x10325476;
        for (k=0;k<x.length;k+=16) {
            AA=a; BB=b; CC=c; DD=d;
            a=FF(a,b,c,d,x[k+0], S11,0xD76AA478); d=FF(d,a,b,c,x[k+1], S12,0xE8C7B756); c=FF(c,d,a,b,x[k+2], S13,0x242070DB); b=FF(b,c,d,a,x[k+3], S14,0xC1BDCEEE);
            a=FF(a,b,c,d,x[k+4], S11,0xF57C0FAF); d=FF(d,a,b,c,x[k+5], S12,0x4787C62A); c=FF(c,d,a,b,x[k+6], S13,0xA8304613); b=FF(b,c,d,a,x[k+7], S14,0xFD469501);
            a=FF(a,b,c,d,x[k+8], S11,0x698098D8); d=FF(d,a,b,c,x[k+9], S12,0x8B44F7AF); c=FF(c,d,a,b,x[k+10],S13,0xFFFF5BB1); b=FF(b,c,d,a,x[k+11],S14,0x895CD7BE);
            a=FF(a,b,c,d,x[k+12],S11,0x6B901122); d=FF(d,a,b,c,x[k+13],S12,0xFD987193); c=FF(c,d,a,b,x[k+14],S13,0xA679438E); b=FF(b,c,d,a,x[k+15],S14,0x49B40821);
            a=GG(a,b,c,d,x[k+1], S21,0xF61E2562); d=GG(d,a,b,c,x[k+6], S22,0xC040B340); c=GG(c,d,a,b,x[k+11],S23,0x265E5A51); b=GG(b,c,d,a,x[k+0], S24,0xE9B6C7AA);
            a=GG(a,b,c,d,x[k+5], S21,0xD62F105D); d=GG(d,a,b,c,x[k+10],S22,0x2441453); c=GG(c,d,a,b,x[k+15],S23,0xD8A1E681); b=GG(b,c,d,a,x[k+4], S24,0xE7D3FBC8);
            a=GG(a,b,c,d,x[k+9], S21,0x21E1CDE6); d=GG(d,a,b,c,x[k+14],S22,0xC33707D6); c=GG(c,d,a,b,x[k+3], S23,0xF4D50D87); b=GG(b,c,d,a,x[k+8], S24,0x455A14ED);
            a=GG(a,b,c,d,x[k+13],S21,0xA9E3E905); d=GG(d,a,b,c,x[k+2], S22,0xFCEFA3F8); c=GG(c,d,a,b,x[k+7],S23,0x676F02D9); b=GG(b,c,d,a,x[k+12],S24,0x8D2A4C8A);
            a=HH(a,b,c,d,x[k+5], S31,0xFFFA3942); d=HH(d,a,b,c,x[k+8], S32,0x8771F681); c=HH(c,d,a,b,x[k+11],S33,0x6D9D6122); b=HH(b,c,d,a,x[k+14],S34,0xFDE5380C);
            a=HH(a,b,c,d,x[k+1], S31,0xA4BEEA44); d=HH(d,a,b,c,x[k+4], S32,0x4BDECFA9); c=HH(c,d,a,b,x[k+7], S33,0xF6BB4B60); b=HH(b,c,d,a,x[k+10],S34,0xBEBFBC70);
            a=HH(a,b,c,d,x[k+13],S31,0x289B7EC6); d=HH(d,a,b,c,x[k+0], S32,0xEAA127FA); c=HH(c,d,a,b,x[k+3], S33,0xD4EF3085); b=HH(b,c,d,a,x[k+6], S34,0x4881D05);
            a=HH(a,b,c,d,x[k+9], S31,0xD9D4D039); d=HH(d,a,b,c,x[k+12],S32,0xE6DB99E5); c=HH(c,d,a,b,x[k+15],S33,0x1FA27CF8); b=HH(b,c,d,a,x[k+2], S34,0xC4AC5665);
            a=II(a,b,c,d,x[k+0], S41,0xF4292244); d=II(d,a,b,c,x[k+7], S42,0x432AFF97); c=II(c,d,a,b,x[k+14],S43,0xAB9423A7); b=II(b,c,d,a,x[k+5], S44,0xFC93A039);
            a=II(a,b,c,d,x[k+12],S41,0x655B59C3); d=II(d,a,b,c,x[k+3], S42,0x8F0CCC92); c=II(c,d,a,b,x[k+10],S43,0xFFEFF47D); b=II(b,c,d,a,x[k+1], S44,0x85845DD1);
            a=II(a,b,c,d,x[k+8], S41,0x6FA87E4F); d=II(d,a,b,c,x[k+15],S42,0xFE2CE6E0); c=II(c,d,a,b,x[k+6], S43,0xA3014314); b=II(b,c,d,a,x[k+13],S44,0x4E0811A1);
            a=II(a,b,c,d,x[k+4], S41,0xF7537E82); d=II(d,a,b,c,x[k+11],S42,0xBD3AF235); c=II(c,d,a,b,x[k+2], S43,0x2AD7D2BB); b=II(b,c,d,a,x[k+9], S44,0xEB86D391);
            a=AddUnsigned(a,AA); b=AddUnsigned(b,BB); c=AddUnsigned(c,CC); d=AddUnsigned(d,DD);
        }
        var temp = WordToHex(a)+WordToHex(b)+WordToHex(c)+WordToHex(d);
        return temp.toLowerCase();
    }

    // === СЕТЕВЫЕ ЗАПРОСЫ С ТАЙМАУТОМ И ЛОГИРОВАНИЕМ ===
    async function apiFetch(path, opts = {}, timeoutMs = 15000) {
        scanStorageForCredentials();
        await getProfileId();

        const url = path.startsWith('http') ? path : CONFIG.apiBase + path;
        const headers = {
            'Accept': 'application/json',
            'X-Mes-Subsystem': 'teacherweb',
            'Content-Type': 'application/json',
            ...opts.headers,
        };

        if (authState.token) {
            headers['Authorization'] = `Bearer ${authState.token}`;
        }
        if (authState.profileId) {
            headers['Profile-Id'] = String(authState.profileId);
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        addLog(`[API] Запрос → ${path.substring(0, 80)}...`, 'info');
        console.log('[DEBUG API] Запрос:', url, 'headers:', { ...headers, Authorization: headers.Authorization ? 'Bearer ***' : undefined });

        try {
            const resp = await fetch(url, {
                credentials: 'include',
                headers,
                signal: controller.signal,
                ...opts,
            });
            clearTimeout(timer);

            if (resp.status === 401) {
                throw new Error('Сессия истекла (401). Пожалуйста, обновите страницу.');
            }
            if (!resp.ok) {
                throw new Error(`Ошибка HTTP ${resp.status} для запроса: ${path}`);
            }

            const data = await resp.json();
            // Логируем структуру ответа
            const isArray = Array.isArray(data);
            const keys = data && typeof data === 'object' ? Object.keys(data).slice(0, 10) : [];
            addLog(`[API] Ответ ← ${path.substring(0, 50)}… тип=${isArray ? 'array['+(data?.length || 0)+']' : 'obj{keys:'+keys.join(',')+'}'}`, 'info');
            console.log('[DEBUG API] Ответ:', data);
            return data;
        } catch (err) {
            clearTimeout(timer);
            if (err.name === 'AbortError') {
                throw new Error(`Таймаут запроса (${timeoutMs}ms): ${path}`);
            }
            throw err;
        }
    }

    function extractGroupsFromSchedule(sched) {
        const items = Array.isArray(sched) ? sched : (sched && sched.items ? sched.items : []);
        const groups = {};
        for (const item of items) {
            const gid = item.group_id;
            if (gid && !groups[gid]) {
                groups[gid] = {
                    id: gid,
                    group_name: item.group_name || `Группа ${gid}`,
                    subject_id: item.subject_id,
                    subject_name: item.subject_name || ''
                };
            }
        }
        return Object.values(groups);
    }

    async function fetchMyGroups() {
        const ayId = getAcademicYearId();
        const errors = [];

        // Вариант 1: Быстрый endpoint /groups (без расписания)
        try {
            addLog(`[Groups] Пробую быструю загрузку /groups?academic_year_id=${ayId}`, 'info');
            const data = await apiFetch(`/api/ej/plan/teacher/v1/groups?academic_year_id=${ayId}`, {}, 15000);
            const arr = Array.isArray(data) ? data : (data.items || data.groups || data.data || []);
            if (arr.length > 0) {
                addLog(`[Groups] Быстрый endpoint вернул ${arr.length} групп`, 'success');
                console.log('[DEBUG Groups] Первые 3 группы:', arr.slice(0, 3));
                return arr.map(g => ({
                    id: g.id || g.group_id,
                    group_name: g.name || g.group_name || g.class_name || `Группа ${g.id || g.group_id}`,
                    subject_id: g.subject_id,
                    subject_name: g.subject_name || ''
                })).filter(g => g.id);
            }
            errors.push(`/groups вернул пустой результат`);
        } catch (e) {
            errors.push(`/groups ошибка: ${e.message}`);
            addLog(`[Groups] Быстрый endpoint не сработал: ${e.message}`, 'warning');
        }

        // Вариант 2: Расписание с укороченным диапазоном (только текущий месяц)
        if (authState.profileId) {
            try {
                const now = new Date();
                const from = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
                const to = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(new Date(now.getFullYear(), now.getMonth()+1, 0).getDate()).padStart(2,'0')}`;
                addLog(`[Groups] Пробую расписание за ${from}…${to}`, 'info');
                const sched = await apiFetch(`/api/ej/plan/teacher/v1/schedule_items?academic_year_id=${ayId}&teacher_id=${authState.profileId}&from=${from}&to=${to}&with_group_class_subject_info=true&page=1&per_page=500`, {}, 15000);
                const groups = extractGroupsFromSchedule(sched);
                if (groups.length > 0) {
                    addLog(`[Groups] Расписание вернуло ${groups.length} групп`, 'success');
                    return groups;
                }
                errors.push(`Расписание (месяц) вернуло 0 групп`);
            } catch (e2) {
                errors.push(`Расписание (месяц) ошибка: ${e2.message}`);
                addLog(`[Groups] Расписание (месяц) не сработало: ${e2.message}`, 'warning');
            }
        }

        // Вариант 3: Последний fallback — расписание за весь год, но с таймаутом 20с
        if (authState.profileId) {
            try {
                addLog(`[Groups] Последний fallback — расписание за весь год (таймаут 20с)`, 'warning');
                const sched = await apiFetch(`/api/ej/plan/teacher/v1/schedule_items?academic_year_id=${ayId}&teacher_id=${authState.profileId}&from=2025-09-01&to=2026-05-31&with_group_class_subject_info=true&page=1&per_page=1000`, {}, 20000);
                const groups = extractGroupsFromSchedule(sched);
                if (groups.length > 0) {
                    addLog(`[Groups] Fallback-расписание вернуло ${groups.length} групп`, 'success');
                    return groups;
                }
                errors.push(`Расписание (год) вернуло 0 групп`);
            } catch (e3) {
                errors.push(`Расписание (год) ошибка: ${e3.message}`);
                addLog(`[Groups] Fallback-расписание не сработало: ${e3.message}`, 'error');
            }
        }

        throw new Error('Не удалось загрузить группы. Попытки:\n' + errors.join('\n'));
    }

    // === ЛОГИКА ОЦЕНКИ ===
    function getAnswerByScore(score, questionId, personId) {
        if (score == null || isNaN(score)) return 5;
        const category = QUESTION_CATEGORY[questionId];
        const t = CONFIG.thresholds[category];
        const offset = CONFIG.offsets[questionId] || 0;
        const seed = parseInt(md5(String(personId)).substring(0, 8), 16);
        const personVar = ((seed + questionId * 100) % 500 - 250) / 1000;
        const adjusted = score + offset + personVar;
        if (adjusted >= t.always) return 4;
        if (adjusted >= t.often) return 3;
        if (adjusted >= t.rarely) return 2;
        return 1;
    }

    // === ИНТЕРФЕЙС И РЕНДЕРИНГ ===
    let state = {
        groups: [],
        currentClassId: null,
        students: [],
        periodId: null,
        isRunning: false,
        trimester: '3',
        mode: 'new',
        logs: [],
        activeTab: 'main'
    };

    function autoDetectTrimester() {
        const date = new Date();
        const month = date.getMonth() + 1;
        if (month >= 9 && month <= 11) state.trimester = '1';
        else if (month === 12 || month === 1 || month === 2) state.trimester = '2';
        else if (month >= 3 && month <= 5) state.trimester = '3';
        else state.trimester = '3';
    }

    function getTrimesterDates(tri) {
        switch (tri) {
            case '1': return { start: '01.09.2025', end: '30.11.2025' };
            case '2': return { start: '01.12.2025', end: '28.02.2026' };
            case '3': return { start: '01.03.2026', end: '31.05.2026' };
            default: return { start: '01.09.2025', end: '31.08.2026' };
        }
    }

    function injectStyles() {
        if (document.getElementById('mss-styles-debug') || document.getElementById('gm_mss_styles_debug')) return;
        const css = `
            #mss-panel-root-debug {
                all: initial;
                font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                font-size: 14px;
                color: #2c3e50;
            }
            #mss-floating-btn-debug {
                position: fixed;
                bottom: 24px;
                right: 24px;
                z-index: 999999;
                width: 56px;
                height: 56px;
                border-radius: 50%;
                background: linear-gradient(135deg, #e65100 0%, #bf360c 100%);
                color: white;
                box-shadow: 0 4px 18px rgba(230, 81, 0, 0.4);
                border: none;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
            }
            #mss-floating-btn-debug:hover {
                transform: scale(1.08) translateY(-2px);
                box-shadow: 0 6px 24px rgba(230, 81, 0, 0.5);
            }
            #mss-floating-btn-debug svg {
                width: 24px;
                height: 24px;
                fill: white;
            }
            #mss-modal-container-debug {
                position: fixed;
                bottom: 90px;
                right: 24px;
                z-index: 999998;
                width: 500px;
                height: 620px;
                background: rgba(255, 255, 255, 0.9);
                backdrop-filter: blur(20px) saturate(180%);
                -webkit-backdrop-filter: blur(20px) saturate(180%);
                border: 1px solid rgba(255, 255, 255, 0.45);
                box-shadow: 0 12px 40px rgba(0,0,0,0.14);
                border-radius: 20px;
                display: flex;
                flex-direction: column;
                overflow: hidden;
                transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
                transform-origin: bottom right;
                transform: scale(0);
                opacity: 0;
            }
            #mss-modal-container-debug.visible {
                transform: scale(1);
                opacity: 1;
            }
            #mss-header-debug {
                padding: 12px 16px;
                background: linear-gradient(135deg, rgba(230, 81, 0, 0.08) 0%, rgba(191, 54, 12, 0.04) 100%);
                border-bottom: 1px solid rgba(0,0,0,0.06);
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            #mss-header-debug h3 {
                margin: 0;
                font-weight: 700;
                font-size: 15px;
                color: #e65100;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            #mss-close-btn-debug {
                background: none;
                border: none;
                font-size: 18px;
                color: #7f8c8d;
                cursor: pointer;
                padding: 4px;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                width: 28px;
                height: 28px;
                transition: all 0.2s;
            }
            #mss-close-btn-debug:hover {
                background: rgba(0,0,0,0.05);
                color: #2c3e50;
            }
            #mss-tabs-debug {
                display: flex;
                background: rgba(0,0,0,0.02);
                border-bottom: 1px solid rgba(0,0,0,0.06);
                padding: 0 10px;
            }
            .mss-tab-btn-debug {
                flex: 1;
                padding: 10px 6px;
                background: none;
                border: none;
                font-size: 11px;
                font-weight: 600;
                color: #7f8c8d;
                cursor: pointer;
                transition: all 0.2s;
                border-bottom: 2px solid transparent;
                text-align: center;
            }
            .mss-tab-btn-debug.active {
                color: #e65100;
                border-bottom-color: #e65100;
            }
            .mss-tab-btn-debug:hover:not(.active) {
                color: #2c3e50;
                background: rgba(0,0,0,0.015);
            }
            #mss-content-debug {
                flex: 1;
                overflow-y: auto;
                padding: 16px;
                display: flex;
                flex-direction: column;
                gap: 12px;
            }
            .mss-section-title-debug {
                font-size: 10px;
                text-transform: uppercase;
                letter-spacing: 0.8px;
                color: #7f8c8d;
                font-weight: 700;
                margin-bottom: 4px;
                margin-top: 2px;
            }
            .mss-form-group-debug {
                display: flex;
                flex-direction: column;
                gap: 5px;
            }
            .mss-select-debug, .mss-input-debug {
                padding: 8px 10px;
                border-radius: 8px;
                border: 1px solid rgba(0,0,0,0.12);
                background: white;
                font-size: 13px;
                outline: none;
                transition: all 0.2s;
            }
            .mss-select-debug:focus, .mss-input-debug:focus {
                border-color: #e65100;
                box-shadow: 0 0 0 3px rgba(230, 81, 0, 0.12);
            }
            .mss-radio-group-debug {
                display: grid;
                grid-template-columns: repeat(4, 1fr);
                gap: 6px;
            }
            .mss-radio-btn-debug { position: relative; }
            .mss-radio-btn-debug input { position: absolute; opacity: 0; width: 0; height: 0; }
            .mss-radio-label-debug {
                display: block;
                padding: 7px 3px;
                text-align: center;
                border: 1px solid rgba(0,0,0,0.1);
                border-radius: 6px;
                cursor: pointer;
                font-size: 11px;
                font-weight: 500;
                background: white;
                transition: all 0.2s;
            }
            .mss-radio-btn-debug input:checked + .mss-radio-label-debug {
                background: #e65100;
                color: white;
                border-color: #e65100;
                box-shadow: 0 2px 8px rgba(230, 81, 0, 0.25);
            }
            .mss-toggle-group-debug { display: flex; gap: 10px; }
            .mss-toggle-btn-debug {
                flex: 1;
                padding: 8px;
                border: 1px solid rgba(0,0,0,0.1);
                border-radius: 6px;
                cursor: pointer;
                font-size: 12px;
                font-weight: 500;
                background: white;
                text-align: center;
                transition: all 0.2s;
            }
            .mss-toggle-btn-debug.active {
                background: #e65100;
                color: white;
                border-color: #e65100;
            }
            .mss-btn-primary-debug {
                background: linear-gradient(135deg, #e65100 0%, #bf360c 100%);
                color: white;
                border: none;
                padding: 10px;
                border-radius: 8px;
                font-weight: 600;
                font-size: 13px;
                cursor: pointer;
                transition: all 0.2s;
                box-shadow: 0 4px 12px rgba(230, 81, 0, 0.2);
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
            }
            .mss-btn-primary-debug:hover {
                transform: translateY(-1px);
                box-shadow: 0 6px 16px rgba(230, 81, 0, 0.3);
            }
            .mss-btn-secondary-debug {
                background: white;
                color: #2c3e50;
                border: 1px solid rgba(0,0,0,0.15);
                padding: 8px;
                border-radius: 6px;
                font-weight: 500;
                font-size: 12px;
                cursor: pointer;
                transition: all 0.2s;
                text-align: center;
            }
            .mss-btn-secondary-debug:hover { background: rgba(0,0,0,0.02); }
            .mss-preview-container-debug {
                overflow-x: auto;
                border: 1px solid rgba(0,0,0,0.08);
                border-radius: 8px;
                background: white;
                max-height: 340px;
            }
            .mss-table-debug {
                width: 100%;
                border-collapse: collapse;
                font-size: 11px;
                text-align: left;
            }
            .mss-table-debug th {
                background: rgba(0,0,0,0.03);
                padding: 6px 8px;
                font-weight: 600;
                border-bottom: 1px solid rgba(0,0,0,0.08);
            }
            .mss-table-debug td {
                padding: 6px 8px;
                border-bottom: 1px solid rgba(0,0,0,0.04);
            }
            .mss-mark-badge-debug {
                font-weight: bold;
                padding: 2px 5px;
                border-radius: 4px;
                font-size: 11px;
            }
            .mss-mark-5-debug { background: rgba(76, 175, 80, 0.15); color: #2e7d32; }
            .mss-mark-4-debug { background: rgba(33, 150, 243, 0.15); color: #1565c0; }
            .mss-mark-3-debug { background: rgba(255, 152, 0, 0.15); color: #ef6c00; }
            .mss-mark-2-debug { background: rgba(244, 67, 54, 0.15); color: #c62828; }
            .mss-survey-select-debug {
                padding: 2px 4px;
                border-radius: 4px;
                border: 1px solid rgba(0,0,0,0.12);
                font-size: 10px;
                outline: none;
            }
            #mss-logs-container-debug {
                flex: 1;
                background: #1e1e1e;
                color: #d4d4d4;
                font-family: monospace;
                font-size: 10px;
                padding: 8px;
                border-radius: 8px;
                overflow-y: auto;
                display: flex;
                flex-direction: column;
                gap: 3px;
            }
            .mss-log-entry-debug { line-height: 1.35; }
            .mss-log-info-debug { color: #d4d4d4; }
            .mss-log-success-debug { color: #4caf50; }
            .mss-log-warning-debug { color: #ffeb3b; }
            .mss-log-error-debug { color: #f44336; }
            .mss-debug-box-debug {
                background: #fff3e0;
                border: 1px solid #ffcc80;
                border-radius: 8px;
                padding: 8px 10px;
                font-size: 11px;
                color: #e65100;
            }
            .mss-debug-box-debug div { margin-bottom: 2px; }
            .mss-settings-row-debug {
                display: grid;
                grid-template-columns: 130px 1fr;
                align-items: center;
                gap: 10px;
                font-size: 12px;
            }
            .mss-slider-group-debug { display: flex; align-items: center; gap: 6px; }
            .mss-slider-debug { flex: 1; }
            .mss-slider-val-debug { width: 30px; font-weight: 600; text-align: right; font-size: 11px; }
            #mss-progress-bar-container-debug {
                background: rgba(0,0,0,0.06);
                height: 6px;
                border-radius: 3px;
                overflow: hidden;
            }
            #mss-progress-bar-debug {
                background: linear-gradient(90deg, #4caf50 0%, #81c784 100%);
                height: 100%;
                width: 0%;
                transition: width 0.2s;
            }
        `;
        GM_addStyle(css);
    }

    function ensureUI() {
        if (!document.body) return;
        injectStyles();
        let root = document.getElementById('mss-panel-root-debug');
        if (!root) {
            root = document.createElement('div');
            root.id = 'mss-panel-root-debug';
            root.innerHTML = `
                <button id="mss-floating-btn-debug" title="Soft Skills DEBUG">
                    <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
                </button>
                <div id="mss-modal-container-debug">
                    <div id="mss-header-debug">
                        <h3>🐞 Soft Skills DEBUG</h3>
                        <button id="mss-close-btn-debug" title="Закрыть">✕</button>
                    </div>
                    <div id="mss-tabs-debug">
                        <button class="mss-tab-btn-debug active" data-tab="main">Запуск</button>
                        <button class="mss-tab-btn-debug" data-tab="preview">Превью</button>
                        <button class="mss-tab-btn-debug" data-tab="settings">Настройки</button>
                        <button class="mss-tab-btn-debug" data-tab="logs">Консоль</button>
                    </div>
                    <div id="mss-content-debug"></div>
                </div>
            `;
            document.body.appendChild(root);
            document.getElementById('mss-floating-btn-debug').addEventListener('click', toggleModal);
            document.getElementById('mss-close-btn-debug').addEventListener('click', hideModal);
            root.querySelectorAll('.mss-tab-btn-debug').forEach(btn => {
                btn.addEventListener('click', (e) => { switchTab(e.target.getAttribute('data-tab')); });
            });
            autoDetectTrimester();
            switchTab(state.activeTab || 'main');
            loadGroupsDropdown();
        }
    }

    function toggleModal() {
        const container = document.getElementById('mss-modal-container-debug');
        if (container) container.classList.toggle('visible');
    }
    function hideModal() {
        const container = document.getElementById('mss-modal-container-debug');
        if (container) container.classList.remove('visible');
    }
    function switchTab(tabName) {
        state.activeTab = tabName;
        document.querySelectorAll('.mss-tab-btn-debug').forEach(btn => {
            if (btn.getAttribute('data-tab') === tabName) btn.classList.add('active');
            else btn.classList.remove('active');
        });
        renderContent();
    }

    function renderContent() {
        const content = document.getElementById('mss-content-debug');
        if (!content) return;

        if (state.activeTab === 'main') {
            const ayId = getAcademicYearId();
            const tokenShort = authState.token ? authState.token.substring(0, 12) + '…' : 'нет';
            content.innerHTML = `
                <div class="mss-debug-box-debug">
                    <div><b>DEBUG INFO:</b></div>
                    <div>token: ${tokenShort}</div>
                    <div>profileId: ${authState.profileId || '—'}</div>
                    <div>academic_year_id: ${ayId}</div>
                    <div>groups loaded: ${state.groups.length}</div>
                </div>
                <div class="mss-form-group-debug">
                    <div class="mss-section-title-debug">1. Выберите класс (группу)</div>
                    <select id="mss-group-select-debug" class="mss-select-debug">
                        <option value="">Загрузка групп...</option>
                    </select>
                </div>
                <div class="mss-form-group-debug">
                    <div class="mss-section-title-debug">2. Выберите период оценки</div>
                    <div class="mss-radio-group-debug">
                        <div class="mss-radio-btn-debug">
                            <input type="radio" id="tri-1" name="trimester" value="1" ${state.trimester === '1' ? 'checked' : ''}>
                            <label class="mss-radio-label-debug" for="tri-1">1 трим.</label>
                        </div>
                        <div class="mss-radio-btn-debug">
                            <input type="radio" id="tri-2" name="trimester" value="2" ${state.trimester === '2' ? 'checked' : ''}>
                            <label class="mss-radio-label-debug" for="tri-2">2 трим.</label>
                        </div>
                        <div class="mss-radio-btn-debug">
                            <input type="radio" id="tri-3" name="trimester" value="3" ${state.trimester === '3' ? 'checked' : ''}>
                            <label class="mss-radio-label-debug" for="tri-3">3 трим.</label>
                        </div>
                        <div class="mss-radio-btn-debug">
                            <input type="radio" id="tri-year" name="trimester" value="year" ${state.trimester === 'year' ? 'checked' : ''}>
                            <label class="mss-radio-label-debug" for="tri-year">Весь год</label>
                        </div>
                    </div>
                </div>
                <div class="mss-form-group-debug">
                    <div class="mss-section-title-debug">3. Режим перезаписи</div>
                    <div class="mss-toggle-group-debug">
                        <div id="mode-new" class="mss-toggle-btn-debug ${state.mode === 'new' ? 'active' : ''}">Только новые</div>
                        <div id="mode-overwrite" class="mss-toggle-btn-debug ${state.mode === 'overwrite' ? 'active' : ''}">Исправить/Перезаписать</div>
                    </div>
                </div>
                <div style="flex: 1; display:flex; align-items:flex-end; margin-top: 10px;">
                    <button id="mss-analyze-btn-debug" class="mss-btn-primary-debug" style="width: 100%;">
                        🔍 Анализировать класс и оценки
                    </button>
                </div>
            `;
            content.querySelectorAll('input[name="trimester"]').forEach(r => {
                r.addEventListener('change', (e) => { state.trimester = e.target.value; });
            });
            document.getElementById('mode-new').addEventListener('click', () => {
                state.mode = 'new';
                document.getElementById('mode-new').classList.add('active');
                document.getElementById('mode-overwrite').classList.remove('active');
            });
            document.getElementById('mode-overwrite').addEventListener('click', () => {
                state.mode = 'overwrite';
                document.getElementById('mode-overwrite').classList.add('active');
                document.getElementById('mode-new').classList.remove('active');
            });
            const select = document.getElementById('mss-group-select-debug');
            populateGroupSelect(select);
            document.getElementById('mss-analyze-btn-debug').addEventListener('click', analyzeClass);
        } else if (state.activeTab === 'preview') {
            if (state.students.length === 0) {
                content.innerHTML = `
                    <div style="text-align: center; color: #7f8c8d; padding-top: 50px;">
                        <svg viewBox="0 0 24 24" style="width:48px;height:48px;fill:#bdc3c7;margin-bottom:10px;">
                            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-6.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
                        </svg>
                        <div>Класс не проанализирован.<br>Перейдите во вкладку <b>Запуск</b>.</div>
                    </div>
                `;
                return;
            }
            let rowsHtml = '';
            state.students.forEach((student, index) => {
                const markClass = student.avg >= 4.5 ? 'mss-mark-5-debug' : (student.avg >= 3.8 ? 'mss-mark-4-debug' : (student.avg >= 3.0 ? 'mss-mark-3-debug' : 'mss-mark-2-debug'));
                const avgText = student.avg ? student.avg.toFixed(2) : '—';
                const checkedAttr = student.selected ? 'checked' : '';
                const categories = ['self_org', 'self_edu', 'self_reg', 'comm'];
                let cellsHtml = '';
                categories.forEach(cat => {
                    const ansId = student.answers[cat];
                    cellsHtml += `
                        <td>
                            <select class="mss-survey-select-debug" data-student-idx="${index}" data-cat="${cat}">
                                <option value="4" ${ansId === 4 ? 'selected' : ''}>Всегда</option>
                                <option value="3" ${ansId === 3 ? 'selected' : ''}>Часто</option>
                                <option value="2" ${ansId === 2 ? 'selected' : ''}>Редко</option>
                                <option value="1" ${ansId === 1 ? 'selected' : ''}>Никогда</option>
                                <option value="5" ${ansId === 5 ? 'selected' : ''}>Затр.</option>
                            </select>
                        </td>
                    `;
                });
                rowsHtml += `
                    <tr>
                        <td style="width: 22px;"><input type="checkbox" class="mss-student-check-debug" data-idx="${index}" ${checkedAttr}></td>
                        <td style="font-weight: 500; font-size:10px;" title="${student.name}">${truncateString(student.name, 14)}</td>
                        <td><span class="mss-mark-badge-debug ${markClass}">${avgText}</span></td>
                        ${cellsHtml}
                    </tr>
                `;
            });
            content.innerHTML = `
                <div style="font-size:11px; font-weight:600; display:flex; justify-content:space-between; align-items:center;">
                    <div>Список учеников (${state.students.length} чел.)</div>
                    <div style="display:flex; gap: 6px;">
                        <span style="cursor:pointer; color:#e65100;" id="mss-sel-all-debug">Все</span> · 
                        <span style="cursor:pointer; color:#e65100;" id="mss-sel-none-debug">Никто</span>
                    </div>
                </div>
                <div class="mss-preview-container-debug">
                    <table class="mss-table-debug">
                        <thead><tr><th></th><th>Имя</th><th>Ср.б.</th><th title="Самоорганизация">Орг</th><th title="Самообразование">Обр</th><th title="Саморегуляция">Рег</th><th title="Коммуникация">Ком</th></tr></thead>
                        <tbody>${rowsHtml}</tbody>
                    </table>
                </div>
                <div style="font-size:10px; color:#7f8c8d; line-height:1.3;">* Ответы рассчитаны автоматически. Можно изменить вручную.</div>
                <button id="mss-run-submit-btn-debug" class="mss-btn-primary-debug" style="margin-top:4px;">🚀 Отправить данные в МЭШ</button>
            `;
            content.querySelectorAll('.mss-student-check-debug').forEach(ch => {
                ch.addEventListener('change', (e) => {
                    const idx = parseInt(e.target.getAttribute('data-idx'));
                    state.students[idx].selected = e.target.checked;
                });
            });
            content.querySelectorAll('.mss-survey-select-debug').forEach(sel => {
                sel.addEventListener('change', (e) => {
                    const idx = parseInt(e.target.getAttribute('data-student-idx'));
                    const cat = e.target.getAttribute('data-cat');
                    state.students[idx].answers[cat] = parseInt(e.target.value);
                });
            });
            document.getElementById('mss-sel-all-debug').addEventListener('click', () => toggleAllStudents(true));
            document.getElementById('mss-sel-none-debug').addEventListener('click', () => toggleAllStudents(false));
            document.getElementById('mss-run-submit-btn-debug').addEventListener('click', runSurveysSubmit);
        } else if (state.activeTab === 'settings') {
            content.innerHTML = `
                <div class="mss-section-title-debug" style="margin-bottom:6px;">Параметры авторизации</div>
                <div style="border: 1px solid rgba(0,0,0,0.08); border-radius:8px; padding: 10px; background:rgba(0,0,0,0.015); display:flex; flex-direction:column; gap:6px; margin-bottom:10px;">
                    <div class="mss-form-group-debug">
                        <label style="font-weight:600; font-size:10px; color:#555;">Bearer Токен:</label>
                        <input type="text" id="mss-token-input-debug" class="mss-input-debug" style="font-family:monospace; font-size:10px; padding:5px 8px;" value="${authState.token || ''}" placeholder="Захватывается автоматически.">
                    </div>
                    <div class="mss-form-group-debug">
                        <label style="font-weight:600; font-size:10px; color:#555;">Profile ID:</label>
                        <input type="text" id="mss-profile-id-input-debug" class="mss-input-debug" style="font-family:monospace; font-size:10px; padding:5px 8px;" value="${authState.profileId || ''}" placeholder="Захватывается автоматически.">
                    </div>
                    <div class="mss-form-group-debug">
                        <label style="font-weight:600; font-size:10px; color:#555;">Academic Year ID (уч. год):</label>
                        <input type="text" id="mss-ayid-input-debug" class="mss-input-debug" style="font-family:monospace; font-size:10px; padding:5px 8px;" value="${CONFIG.academicYearId || authState.academicYearId || ''}" placeholder="Обычно 13 или 14. Авто-определяется.">
                    </div>
                </div>
                <div class="mss-section-title-debug" style="margin-bottom:6px;">Пороги оценок</div>
                <div class="mss-form-group-debug" style="gap:8px; max-height:170px; overflow-y:auto; padding-right:3px;">
                    ${renderThresholdSliders()}
                </div>
                <div style="border-top:1px solid rgba(0,0,0,0.06); padding-top:8px; margin-top:6px; display:flex; gap:8px;">
                    <button id="mss-save-settings-btn-debug" class="mss-btn-primary-debug" style="flex:1; padding:7px 10px; font-size:11px;">Сохранить всё</button>
                    <button id="mss-reset-settings-btn-debug" class="mss-btn-secondary-debug" style="flex:1; padding:7px 10px; font-size:11px;">Сбросить</button>
                </div>
            `;
            content.querySelectorAll('.mss-slider-debug').forEach(slider => {
                slider.addEventListener('input', (e) => {
                    e.target.nextElementSibling.textContent = parseFloat(e.target.value).toFixed(1);
                });
            });
            document.getElementById('mss-save-settings-btn-debug').addEventListener('click', saveConfigFromUI);
            document.getElementById('mss-reset-settings-btn-debug').addEventListener('click', resetConfigToDefault);
        } else if (state.activeTab === 'logs') {
            const hasProgress = state.isRunning || state.logs.length > 0;
            let percent = 0, current = 0, total = 0;
            if (state.students.length > 0) {
                total = state.students.filter(s => s.selected).length;
                current = state.students.filter(s => s.status === 'ok' || s.status === 'error' || s.status === 'skipped').length;
                percent = total > 0 ? Math.round((current / total) * 100) : 0;
            }
            content.innerHTML = `
                <div style="font-size:11px; font-weight:600; display:flex; justify-content:space-between; align-items:center;">
                    <div>Вывод консоли</div>
                    <div id="mss-clear-logs-debug" style="cursor:pointer; color:#7f8c8d; font-size:10px;">Очистить</div>
                </div>
                <div id="mss-logs-container-debug">
                    ${state.logs.map(l => `<div class="mss-log-entry-debug mss-log-${l.type}-debug">[${l.time}] ${l.text}</div>`).join('')}
                </div>
                ${hasProgress ? `
                    <div class="mss-form-group-debug" style="gap:3px; margin-top: 4px;">
                        <div style="display:flex; justify-content:space-between; font-size:10px; font-weight:600;">
                            <div>Прогресс: ${current}/${total}</div>
                            <div>${percent}%</div>
                        </div>
                        <div id="mss-progress-bar-container-debug"><div id="mss-progress-bar-debug" style="width: ${percent}%;"></div></div>
                    </div>
                ` : ''}
            `;
            const container = document.getElementById('mss-logs-container-debug');
            if (container) container.scrollTop = container.scrollHeight;
            document.getElementById('mss-clear-logs-debug').addEventListener('click', () => {
                state.logs = [];
                renderContent();
            });
        }
    }

    function toggleAllStudents(selectVal) {
        state.students.forEach(s => s.selected = selectVal);
        switchTab('preview');
    }
    function truncateString(str, num) {
        if (str.length <= num) return str;
        return str.slice(0, num) + '...';
    }
    function renderThresholdSliders() {
        const cats = { self_org: 'Самоорганизация', self_edu: 'Самообразование', self_reg: 'Саморегуляция', comm: 'Коммуникация' };
        return Object.entries(cats).map(([cat, label]) => {
            const t = CONFIG.thresholds[cat];
            return `
                <div style="border: 1px solid rgba(0,0,0,0.05); border-radius:8px; padding: 8px; background:rgba(0,0,0,0.01)">
                    <div style="font-weight:600; font-size:11px; margin-bottom:6px; color:#e65100;">${label}</div>
                    <div class="mss-settings-row-debug" style="margin-bottom:5px;"><div>Всегда (≥):</div><div class="mss-slider-group-debug"><input type="range" class="mss-slider-debug" data-cat="${cat}" data-level="always" min="3.5" max="5.0" step="0.1" value="${t.always}"><div class="mss-slider-val-debug">${t.always.toFixed(1)}</div></div></div>
                    <div class="mss-settings-row-debug" style="margin-bottom:5px;"><div>Часто (≥):</div><div class="mss-slider-group-debug"><input type="range" class="mss-slider-debug" data-cat="${cat}" data-level="often" min="3.0" max="4.5" step="0.1" value="${t.often}"><div class="mss-slider-val-debug">${t.often.toFixed(1)}</div></div></div>
                    <div class="mss-settings-row-debug"><div>Редко (≥):</div><div class="mss-slider-group-debug"><input type="range" class="mss-slider-debug" data-cat="${cat}" data-level="rarely" min="2.0" max="4.0" step="0.1" value="${t.rarely}"><div class="mss-slider-val-debug">${t.rarely.toFixed(1)}</div></div></div>
                </div>
            `;
        }).join('');
    }

    function saveConfigFromUI() {
        const content = document.getElementById('mss-content-debug');
        const tokenInput = document.getElementById('mss-token-input-debug');
        const profileIdInput = document.getElementById('mss-profile-id-input-debug');
        const ayIdInput = document.getElementById('mss-ayid-input-debug');
        if (tokenInput) {
            authState.token = tokenInput.value.trim() || null;
            if (authState.token) setStorageItem('mss_captured_token', authState.token);
            else removeStorageItem('mss_captured_token');
        }
        if (profileIdInput) {
            authState.profileId = profileIdInput.value.trim() || null;
            if (authState.profileId) setStorageItem('mss_captured_profile_id', authState.profileId);
            else removeStorageItem('mss_captured_profile_id');
        }
        if (ayIdInput) {
            const val = ayIdInput.value.trim();
            CONFIG.academicYearId = val || null;
            if (val) { authState.academicYearId = val; setStorageItem('mss_captured_ayid', val); }
        }
        content.querySelectorAll('.mss-slider-debug').forEach(slider => {
            const cat = slider.getAttribute('data-cat');
            const level = slider.getAttribute('data-level');
            CONFIG.thresholds[cat][level] = parseFloat(slider.value);
        });
        saveSettings();
        addLog('Настройки и параметры авторизации сохранены!', 'success');
        switchTab('main');
    }

    function resetConfigToDefault() {
        CONFIG = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
        saveSettings();
        addLog('Настройки сброшены по умолчанию!', 'info');
        switchTab('settings');
    }

    function addLog(text, type = 'info') {
        const now = new Date();
        const timeStr = now.toTimeString().split(' ')[0];
        state.logs.push({ time: timeStr, text, type });
        console.log(`[DEBUG] [${type}] ${text}`);
        if (state.activeTab === 'logs') {
            const container = document.getElementById('mss-logs-container-debug');
            if (container) {
                const entry = document.createElement('div');
                entry.className = `mss-log-entry-debug mss-log-${type}-debug`;
                entry.textContent = `[${timeStr}] ${text}`;
                container.appendChild(entry);
                container.scrollTop = container.scrollHeight;
            }
        }
    }

    async function loadGroupsDropdown() {
        const select = document.getElementById('mss-group-select-debug');
        if (state.groups && state.groups.length > 0) {
            if (select) populateGroupSelect(select);
            return;
        }
        try {
            scanStorageForCredentials();
            if (!authState.token) {
                addLog('⚠️ Токен не обнаружен. Совершите действие в журнале или обновите страницу.', 'warning');
            }
            addLog('Загружаю список групп учителя...');
            state.groups = await fetchMyGroups();
            if (select) populateGroupSelect(select);
            addLog(`Загружено ${state.groups.length} групп.`, 'success');
        } catch (e) {
            addLog(`Ошибка при загрузке групп: ${e.message}`, 'error');
            if (select) {
                select.innerHTML = `<option value="">Ошибка: ${e.message.substring(0, 80)}</option>`;
            }
        }
    }

    function populateGroupSelect(select) {
        if (!select) return;
        const m = window.location.pathname.match(/\/grade\/(\d+)/);
        const urlClassId = m ? m[1] : null;
        if (state.groups.length === 0) {
            select.innerHTML = `<option value="">Нет доступных групп</option>`;
            return;
        }
        let options = '';
        state.groups.forEach(g => {
            const isSelected = (urlClassId && String(g.id) === urlClassId) ? 'selected' : '';
            options += `<option value="${g.id}" ${isSelected}>[${g.id}] ${g.group_name || g.name} (${g.subject_name || 'нет предмета'})</option>`;
        });
        select.innerHTML = options;
    }

    // === АНАЛИЗ КЛАССА ===
    async function analyzeClass() {
        const groupSelect = document.getElementById('mss-group-select-debug');
        const groupId = groupSelect ? groupSelect.value : null;
        if (!groupId) { alert('Сначала выберите группу!'); return; }

        state.currentClassId = groupId;
        state.students = [];
        switchTab('logs');
        addLog(`=== НАЧАЛО АНАЛИЗА КЛАССА [${groupId}] ===`);
        const ayId = getAcademicYearId();
        addLog(`Используется academic_year_id=${ayId}`);

        try {
            // 1. Загрузка учеников
            addLog('Загружаю список учеников...');
            const studentsData = await apiFetch(`/api/ej/core/teacher/v1/student_profiles?academic_year_id=${ayId}&group_ids=${groupId}&with_final_marks=true&per_page=150&page=1`);
            console.log('[DEBUG analyzeClass] student_profiles ответ:', studentsData);

            let profiles = [];
            if (Array.isArray(studentsData)) {
                profiles = studentsData;
            } else if (studentsData && studentsData.items && Array.isArray(studentsData.items)) {
                profiles = studentsData.items;
            } else if (studentsData && studentsData.students && Array.isArray(studentsData.students)) {
                profiles = studentsData.students;
            } else if (studentsData && typeof studentsData === 'object') {
                // Попробуем найти массив в любом поле
                for (const key of Object.keys(studentsData)) {
                    if (Array.isArray(studentsData[key])) {
                        profiles = studentsData[key];
                        addLog(`[DEBUG] Найден массив учеников в поле '${key}', length=${profiles.length}`, 'info');
                        break;
                    }
                }
            }

            addLog(`[DEBUG] Всего элементов в ответе: ${profiles.length}`);
            if (profiles.length > 0) {
                addLog(`[DEBUG] Первый элемент keys: ${Object.keys(profiles[0]).join(', ')}`, 'info');
            }

            // Фильтруем только те, у которых есть id
            const validStudents = profiles.filter(s => s && (s.id || s.person_id || s.student_id));
            addLog(`[DEBUG] После фильтрации (id||person_id||student_id): ${validStudents.length}`);

            if (validStudents.length === 0) {
                addLog('В группе не найдено учеников.', 'error');
                return;
            }
            addLog(`Загружено учеников: ${validStudents.length}`);

            // 2. Оценки
            const dates = getTrimesterDates(state.trimester);
            addLog(`Загружаю оценки за период: ${dates.start} — ${dates.end}...`);
            const marksData = await apiFetch(`/api/ej/core/teacher/v1/marks?group_ids=${groupId}&created_at_from=${dates.start}&created_at_to=${dates.end}&with_non_numeric_entries=true&per_page=3000&page=1`);
            console.log('[DEBUG analyzeClass] marks ответ:', marksData);

            const studentIds = validStudents.map(s => String(s.id));
            const avgMap = computeAverages(marksData, studentIds);
            addLog(`Средний балл вычислен для ${Object.keys(avgMap).filter(k => avgMap[k] !== null).length} учеников`);

            // 3. Period ID
            addLog('Определяю текущий период для soft skills...');
            const firstPersonId = validStudents[0].person_id || validStudents[0].id;
            const periodId = await getPeriodId(firstPersonId);
            if (!periodId) {
                addLog('Не удалось определить period_id. МЭШ не настроен на проведение анкетирования.', 'error');
                return;
            }
            state.periodId = periodId;
            addLog(`Используется period_id: ${periodId}`, 'success');

            // 4. Построение массива
            addLog('Рассчитываю автоматические оценки...');
            const studentsList = [];
            for (const s of validStudents) {
                const name = [s.last_name, s.first_name, s.middle_name].filter(Boolean).join(' ') || `ID ${s.id}`;
                const avg = avgMap[s.id];
                const answers = {};
                ['self_org', 'self_edu', 'self_reg', 'comm'].forEach(cat => {
                    let qId = 1;
                    if (cat === 'self_edu') qId = 3;
                    else if (cat === 'self_reg') qId = 5;
                    else if (cat === 'comm') qId = 11;
                    answers[cat] = getAnswerByScore(avg, qId, s.person_id || s.id);
                });
                studentsList.push({
                    id: s.id,
                    person_id: s.person_id || s.id,
                    name: name,
                    avg: avg,
                    answers: answers,
                    selected: true,
                    status: null
                });
            }
            state.students = studentsList.sort((a,b) => a.name.localeCompare(b.name));
            addLog('Анализ завершён. Перейдите во вкладку «Превью».', 'success');
            switchTab('preview');
        } catch (e) {
            addLog(`Ошибка при анализе: ${e.message}`, 'error');
        }
    }

    function computeAverages(marksData, studentIds) {
        const scores = {};
        let items = [];
        if (Array.isArray(marksData)) {
            items = marksData;
        } else if (marksData && marksData.marks && Array.isArray(marksData.marks)) {
            items = marksData.marks;
        } else if (marksData && marksData.items && Array.isArray(marksData.items)) {
            items = marksData.items;
        } else if (marksData && typeof marksData === 'object') {
            for (const key of Object.keys(marksData)) {
                if (Array.isArray(marksData[key])) { items = marksData[key]; break; }
            }
        }

        addLog(`[DEBUG marks] Найдено ${items.length} оценок в ответе`);

        for (const mark of items) {
            const sid = mark.student_profile_id || mark.student_id || mark.profile_id;
            if (!sid) continue;
            if (!studentIds.includes(String(sid))) continue;
            try {
                let val = null;
                if (mark.values && mark.values[0] && mark.values[0].grade) {
                    val = mark.values[0].grade.five;
                }
                if (val == null) {
                    val = parseFloat(mark.name || mark.value);
                }
                if (val != null && val >= 2 && val <= 5) {
                    if (!scores[sid]) scores[sid] = [];
                    scores[sid].push(val);
                }
            } catch (e) {}
        }
        const averages = {};
        for (const sid of studentIds) {
            const vals = scores[sid];
            if (vals && vals.length > 0) {
                averages[sid] = vals.reduce((a, b) => a + b, 0) / vals.length;
            } else {
                averages[sid] = null;
            }
        }
        return averages;
    }

    async function getPeriodId(firstPersonId) {
        try {
            const check = await apiFetch(`/api/soft_skills/v1/periods/checkCurrentPeriodTeacher?student_person_id=${firstPersonId}`);
            if (check && check.period_id) return check.period_id;
        } catch (e) { console.warn('Failed checkCurrentPeriodTeacher:', e); }
        try {
            const periods = await apiFetch(`/api/soft_skills/v1/periods?student_person_id=${firstPersonId}`);
            if (Array.isArray(periods) && periods.length > 0) {
                const current = periods.find(p => p.is_current || p.current);
                if (current) return current.id;
                return periods[periods.length - 1].id;
            }
        } catch (e) { console.warn('Failed to fetch periods list:', e); }
        return null;
    }

    async function checkSurveyFilled(personId, periodId) {
        try {
            const data = await apiFetch(`/api/soft_skills/v1/survey/teacherSurvey?student_person_id=${personId}&period_id=${periodId}`);
            if (data && data.answers && data.answers.length > 0) return true;
        } catch (e) {}
        return false;
    }

    // === ОТПРАВКА ===
    async function runSurveysSubmit() {
        const toSubmit = state.students.filter(s => s.selected);
        if (toSubmit.length === 0) { alert('Не выбрано ни одного ученика!'); return; }
        const confirmText = state.mode === 'overwrite'
            ? `Перезаписать оценки для ${toSubmit.length} учеников?`
            : `Отправить оценки для ${toSubmit.length} учеников?`;
        if (!confirm(confirmText)) return;
        state.isRunning = true;
        switchTab('logs');
        addLog(`=== НАЧАЛО ОТПРАВКИ в period_id=${state.periodId} ===`);
        let success = 0, skipped = 0, errors = 0;
        for (let i = 0; i < state.students.length; i++) {
            const s = state.students[i];
            if (!s.selected) continue;
            addLog(`Обработка: ${s.name} (балл: ${s.avg ? s.avg.toFixed(2) : '—'})...`);
            try {
                if (state.mode === 'new') {
                    const isFilled = await checkSurveyFilled(s.person_id, state.periodId);
                    if (isFilled) {
                        s.status = 'skipped';
                        skipped++;
                        addLog(`⏭️ Пропущено: ${s.name} уже имеет оценку.`, 'warning');
                        updateSubmitProgressBar(i + 1, state.students.length);
                        continue;
                    }
                }
                if (state.mode === 'overwrite') {
                    try {
                        const isFilled = await checkSurveyFilled(s.person_id, state.periodId);
                        if (isFilled) {
                            addLog(`🗑️ Удаление старой анкеты для ${s.name}...`);
                            await deleteSurvey(s.person_id, state.periodId);
                        }
                    } catch (err) { console.warn(`Не удалось удалить анкету ${s.name}: ${err.message}`); }
                }
                const answersList = [];
                Object.entries(QUESTION_CATEGORY).forEach(([qIdStr, cat]) => {
                    const qId = parseInt(qIdStr);
                    const baseAns = s.answers[cat];
                    let finalAnswerId = baseAns;
                    if (baseAns !== 5) {
                        finalAnswerId = getAnswerByScore(s.avg, qId, s.person_id);
                    }
                    answersList.push({ question_id: qId, answer_id: finalAnswerId });
                });
                await submitSurvey(s.person_id, state.periodId, answersList);
                s.status = 'ok';
                success++;
                addLog(`✅ Успешно: ${s.name}`, 'success');
            } catch (err) {
                s.status = 'error';
                errors++;
                addLog(`❌ Ошибка для ${s.name}: ${err.message}`, 'error');
            }
            await new Promise(r => setTimeout(r, 200));
            updateSubmitProgressBar(i + 1, state.students.length);
        }
        state.isRunning = false;
        addLog(`=== ОТПРАВКА ЗАВЕРШЕНА ===`, 'success');
        addLog(`Итоги: Успешно: ${success}, Пропущено: ${skipped}, Ошибок: ${errors}`, 'info');
        alert(`Отправка завершена!\n\nУспешно: ${success}\nПропущено: ${skipped}\nОшибок: ${errors}`);
        switchTab('logs');
    }

    async function deleteSurvey(personId, periodId) {
        const url = `/api/soft_skills/v1/survey?student_person_id=${personId}&period_id=${periodId}`;
        const headers = { 'Accept': 'application/json', 'X-Mes-Subsystem': 'teacherweb', 'Content-Type': 'application/json' };
        if (authState.token) headers['Authorization'] = `Bearer ${authState.token}`;
        if (authState.profileId) headers['Profile-Id'] = String(authState.profileId);
        const resp = await fetch(CONFIG.apiBase + url, { method: 'DELETE', credentials: 'include', headers: headers });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp;
    }

    async function submitSurvey(personId, periodId, answers) {
        const url = `/api/soft_skills/v1/survey`;
        const headers = { 'Accept': 'application/json', 'X-Mes-Subsystem': 'teacherweb', 'Content-Type': 'application/json' };
        if (authState.token) headers['Authorization'] = `Bearer ${authState.token}`;
        if (authState.profileId) headers['Profile-Id'] = String(authState.profileId);
        const resp = await fetch(CONFIG.apiBase + url, {
            method: 'POST',
            credentials: 'include',
            headers: headers,
            body: JSON.stringify({ student_person_id: personId, period_id: periodId, answers: answers })
        });
        if (!resp.ok) {
            let errText = `HTTP ${resp.status}`;
            try { const errJson = await resp.json(); errText = errJson.message || errJson.error || errText; } catch (e) {}
            throw new Error(errText);
        }
        return resp.json();
    }

    function updateSubmitProgressBar(current, total) {
        const bar = document.getElementById('mss-progress-bar-debug');
        if (bar) { bar.style.width = `${Math.round((current / total) * 100)}%`; }
    }

    // === ДИНАМИЧЕСКИЙ ОБСЕРВЕР ===
    function startUIObserver() {
        ensureUI();
        if (typeof MutationObserver !== 'undefined') {
            const observer = new MutationObserver(() => {
                const root = document.getElementById('mss-panel-root-debug');
                if (!root && document.body) ensureUI();
            });
            if (document.body) {
                observer.observe(document.body, { childList: true });
            } else {
                setTimeout(() => {
                    if (document.body) { observer.observe(document.body, { childList: true }); ensureUI(); }
                }, 500);
            }
        }
        setInterval(() => {
            const root = document.getElementById('mss-panel-root-debug');
            if (!root && document.body) ensureUI();
        }, 2000);
    }

    function init() { startUIObserver(); }

    console.log('[SoftSkills DEBUG] Скрипт загружен, readyState:', document.readyState);
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        init();
    } else {
        document.addEventListener('DOMContentLoaded', init);
    }
})();
