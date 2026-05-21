// ==UserScript==
// @name         МЭШ Автозаполнение Soft Skills PRO FIXED
// @namespace    http://tampermonkey.net/
// @version      2.4-fixed
// @description  Удобное автозаполнение оценок soft skills в МЭШ с графическим интерфейсом
// @author       You
// @match        https://school.mos.ru/*
// @grant        GM_addStyle
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // === БЕЗОПАСНЫЙ ДОСТУП К LOCALSTORAGE ===
    function getStorageItem(key) {
        try {
            return localStorage.getItem(key);
        } catch (e) {
            return null;
        }
    }

    function setStorageItem(key, val) {
        try {
            localStorage.setItem(key, val);
        } catch (e) {}
    }

    function removeStorageItem(key) {
        try {
            localStorage.removeItem(key);
        } catch (e) {}
    }

    // === СОСТОЯНИЕ АВТОРИЗАЦИИ И СЕТЕВОЙ ПЕРЕХВАТ ===
    let authState = {
        token: getStorageItem('mss_captured_token') || null,
        profileId: getStorageItem('mss_captured_profile_id') || null
    };

    // Перехват сетевых запросов страницы для автоматического захвата токенов
    (function interceptNetwork() {
        // 1. Безопасный перехват fetch (синхронная обертка для сохранения порядка микрозадач)
        const originalFetch = window.fetch;
        window.fetch = function (resource, options) {
            try {
                let headersObj = null;
                if (resource && resource instanceof Request) {
                    headersObj = resource.headers;
                } else if (options && options.headers) {
                    headersObj = options.headers;
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
                            console.log('[SoftSkills PRO] Перехвачен Bearer токен через fetch');
                        }
                    }
                    if (prof) {
                        const p = String(prof);
                        if (p !== authState.profileId) {
                            authState.profileId = p;
                            setStorageItem('mss_captured_profile_id', p);
                            console.log('[SoftSkills PRO] Перехвачен Profile-Id через fetch:', p);
                        }
                    }
                }
            } catch (e) {
                console.error('[SoftSkills PRO] Ошибка в перехватчике fetch:', e);
            }
            return originalFetch.apply(this, arguments);
        };

        // 2. Безопасный перехват XMLHttpRequest (XHR)
        const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
        XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
            try {
                if (header && typeof header === 'string' && value && typeof value === 'string') {
                    if (header.toLowerCase() === 'authorization' && value.startsWith('Bearer ')) {
                        const t = value.substring(7);
                        if (t !== authState.token) {
                            authState.token = t;
                            setStorageItem('mss_captured_token', t);
                            console.log('[SoftSkills PRO] Перехвачен Bearer токен через XHR');
                        }
                    }
                    if (header.toLowerCase() === 'profile-id') {
                        const p = String(value);
                        if (p !== authState.profileId) {
                            authState.profileId = p;
                            setStorageItem('mss_captured_profile_id', p);
                            console.log('[SoftSkills PRO] Перехвачен Profile-Id через XHR:', p);
                        }
                    }
                }
            } catch (e) {
                console.error('[SoftSkills PRO] Ошибка в перехватчике XHR:', e);
            }
            return originalSetRequestHeader.apply(this, arguments);
        };
    })();

    // === КОНФИГУРАЦИЯ ПО УМОЛЧАНИЮ ===
    const DEFAULT_CONFIG = {
        thresholds: {
            self_org: { always: 4.6, often: 3.7, rarely: 3.0 },
            self_edu: { always: 4.8, often: 4.0, rarely: 3.3 },
            self_reg: { always: 4.6, often: 3.7, rarely: 3.0 },
            comm:     { always: 4.6, often: 3.7, rarely: 3.0 }
        },
        offsets: {
            1: 0.25,   // Самоорганизация: ДЗ
            2: 0.15,   // Самоорганизация: сроки
            3: -0.35,  // Самообразование: интерес вне программы
            4: -0.20,  // Самообразование: любознательность
            5: 0.05,   // Саморегуляция: внимание
            6: 0.10,   // Саморегуляция: самооценка
            7: 0.20,   // Саморегуляция: дисциплина
            11: 0.30,  // Коммуникация: умение слушать
            13: 0.25,  // Коммуникация: вежливость
            14: -0.30  // Коммуникация: выступления
        },
        apiBase: 'https://school.mos.ru'
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
                        apiBase: DEFAULT_CONFIG.apiBase
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
            offsets: CONFIG.offsets
        }));
    }

    const QUESTION_CATEGORY = {
        1: 'self_org', 2: 'self_org',
        3: 'self_edu', 4: 'self_edu',
        5: 'self_reg', 6: 'self_reg', 7: 'self_reg',
        11: 'comm', 13: 'comm', 14: 'comm'
    };

    // === ВНУТРЕННИЙ ПОИСК В ХРАНИЛИЩАХ (ЗАПАСНОЙ ВАРИАНТ) ===
    function scanStorageForCredentials() {
        try {
            if (authState.token && authState.profileId) return;

            // Поиск JWT (начинается с eyJ) в localStorage
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
            
            // Поиск в sessionStorage
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

            // Поиск profileId напрямую
            if (!authState.profileId) {
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (key && key.toLowerCase().includes('profile')) {
                        const val = localStorage.getItem(key);
                        if (val && !isNaN(val)) authState.profileId = val;
                    }
                }
            }
        } catch (e) {
            console.error('[SoftSkills PRO] Ошибка при сканировании хранилища:', e);
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

    // === СЕТЕВЫЕ ЗАПРОСЫ К МЭШ ===
    async function apiFetch(path, opts = {}) {
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

        const resp = await fetch(url, {
            credentials: 'include',
            headers,
            ...opts,
        });

        if (resp.status === 401) {
            throw new Error('Сессия истекла (401). Пожалуйста, обновите страницу.');
        }
        if (!resp.ok) {
            throw new Error(`Ошибка HTTP ${resp.status} для запроса: ${path}`);
        }
        return resp.json();
    }

    function extractGroupsFromSchedule(sched, profileId) {
        const items = Array.isArray(sched) ? sched : (sched && sched.items ? sched.items : []);
        const groups = {};
        const hasReplacementData = items.some(item =>
            item.replaced !== undefined || item.replaced_teacher_id !== undefined
        );
        for (const item of items) {
            if (hasReplacementData) {
                if (item.replaced === true && item.replaced_teacher_id) {
                    if (String(item.replaced_teacher_id) !== String(profileId)) {
                        continue;
                    }
                }
            }
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

    // Получить список классов учителя
    async function fetchMyGroups() {
        const pid = await getProfileId();
        if (pid) {
            try {
                const sched = await apiFetch(`/api/ej/plan/teacher/v1/schedule_items?academic_year_id=13&teacher_id=${pid}&from=2025-09-01&to=2026-05-31&with_group_class_subject_info=true&page=1&per_page=2000`);
                const groups = extractGroupsFromSchedule(sched, pid);
                if (groups.length > 0) return groups;
            } catch (e2) {
                console.warn('Не удалось получить группы через расписание:', e2);
            }
        }

        // Запасной вариант — все группы учителя
        try {
            const data = await apiFetch('/api/ej/plan/teacher/v1/groups?academic_year_id=13');
            return Array.isArray(data) ? data : (data.items || data.groups || []);
        } catch (e) {
            throw e;
        }
    }

    // === ЛОГИКА ОЦЕНКИ ===
    function getAnswerByScore(score, questionId, personId) {
        if (score == null || isNaN(score)) return 5; // Затрудняюсь
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
        if (document.getElementById('mss-styles') || document.getElementById('gm_mss_styles')) return;

        const css = `
            #mss-panel-root {
                all: initial;
                font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                font-size: 14px;
                color: #2c3e50;
            }
            #mss-floating-btn {
                position: fixed;
                bottom: 24px;
                right: 24px;
                z-index: 999999;
                width: 56px;
                height: 56px;
                border-radius: 50%;
                background: linear-gradient(135deg, #1a73e8 0%, #1557b0 100%);
                color: white;
                box-shadow: 0 4px 18px rgba(26, 115, 232, 0.4);
                border: none;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
            }
            #mss-floating-btn:hover {
                transform: scale(1.08) translateY(-2px);
                box-shadow: 0 6px 24px rgba(26, 115, 232, 0.5);
            }
            #mss-floating-btn svg {
                width: 24px;
                height: 24px;
                fill: white;
            }
            #mss-modal-container {
                position: fixed;
                bottom: 90px;
                right: 24px;
                z-index: 999998;
                width: 440px;
                height: 550px;
                background: rgba(255, 255, 255, 0.85);
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
            #mss-modal-container.visible {
                transform: scale(1);
                opacity: 1;
            }
            #mss-header {
                padding: 16px 20px;
                background: linear-gradient(135deg, rgba(26, 115, 232, 0.08) 0%, rgba(21, 87, 176, 0.04) 100%);
                border-bottom: 1px solid rgba(0,0,0,0.06);
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            #mss-header h3 {
                margin: 0;
                font-weight: 700;
                font-size: 16px;
                color: #1a73e8;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            #mss-close-btn {
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
            #mss-close-btn:hover {
                background: rgba(0,0,0,0.05);
                color: #2c3e50;
            }
            #mss-tabs {
                display: flex;
                background: rgba(0,0,0,0.02);
                border-bottom: 1px solid rgba(0,0,0,0.06);
                padding: 0 10px;
            }
            .mss-tab-btn {
                flex: 1;
                padding: 12px 8px;
                background: none;
                border: none;
                font-size: 12px;
                font-weight: 600;
                color: #7f8c8d;
                cursor: pointer;
                transition: all 0.2s;
                border-bottom: 2px solid transparent;
                text-align: center;
            }
            .mss-tab-btn.active {
                color: #1a73e8;
                border-bottom-color: #1a73e8;
            }
            .mss-tab-btn:hover:not(.active) {
                color: #2c3e50;
                background: rgba(0,0,0,0.015);
            }
            #mss-content {
                flex: 1;
                overflow-y: auto;
                padding: 20px;
                display: flex;
                flex-direction: column;
                gap: 15px;
            }
            .mss-section-title {
                font-size: 11px;
                text-transform: uppercase;
                letter-spacing: 0.8px;
                color: #7f8c8d;
                font-weight: 700;
                margin-bottom: 6px;
                margin-top: 4px;
            }
            .mss-form-group {
                display: flex;
                flex-direction: column;
                gap: 6px;
            }
            .mss-select, .mss-input {
                padding: 10px 12px;
                border-radius: 10px;
                border: 1px solid rgba(0,0,0,0.12);
                background: white;
                font-size: 13.5px;
                outline: none;
                transition: all 0.2s;
            }
            .mss-select:focus, .mss-input:focus {
                border-color: #1a73e8;
                box-shadow: 0 0 0 3px rgba(26, 115, 232, 0.15);
            }
            .mss-radio-group {
                display: grid;
                grid-template-columns: repeat(4, 1fr);
                gap: 8px;
            }
            .mss-radio-btn {
                position: relative;
            }
            .mss-radio-btn input {
                position: absolute;
                opacity: 0;
                width: 0;
                height: 0;
            }
            .mss-radio-label {
                display: block;
                padding: 8px 4px;
                text-align: center;
                border: 1px solid rgba(0,0,0,0.1);
                border-radius: 8px;
                cursor: pointer;
                font-size: 12px;
                font-weight: 500;
                background: white;
                transition: all 0.2s;
            }
            .mss-radio-btn input:checked + .mss-radio-label {
                background: #1a73e8;
                color: white;
                border-color: #1a73e8;
                box-shadow: 0 2px 8px rgba(26, 115, 232, 0.25);
            }
            .mss-radio-btn:hover:not(:checked) .mss-radio-label {
                background: rgba(0,0,0,0.02);
            }
            .mss-toggle-group {
                display: flex;
                gap: 12px;
            }
            .mss-toggle-btn {
                flex: 1;
                padding: 10px;
                border: 1px solid rgba(0,0,0,0.1);
                border-radius: 8px;
                cursor: pointer;
                font-size: 12.5px;
                font-weight: 500;
                background: white;
                text-align: center;
                transition: all 0.2s;
            }
            .mss-toggle-btn.active {
                background: #1a73e8;
                color: white;
                border-color: #1a73e8;
            }
            .mss-btn-primary {
                background: linear-gradient(135deg, #1a73e8 0%, #1557b0 100%);
                color: white;
                border: none;
                padding: 12px;
                border-radius: 10px;
                font-weight: 600;
                font-size: 14px;
                cursor: pointer;
                transition: all 0.2s;
                box-shadow: 0 4px 12px rgba(26, 115, 232, 0.2);
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 8px;
            }
            .mss-btn-primary:hover {
                transform: translateY(-1px);
                box-shadow: 0 6px 16px rgba(26, 115, 232, 0.3);
            }
            .mss-btn-secondary {
                background: white;
                color: #2c3e50;
                border: 1px solid rgba(0,0,0,0.15);
                padding: 10px;
                border-radius: 8px;
                font-weight: 500;
                font-size: 13px;
                cursor: pointer;
                transition: all 0.2s;
                text-align: center;
            }
            .mss-btn-secondary:hover {
                background: rgba(0,0,0,0.02);
            }
            .mss-preview-container {
                overflow-x: auto;
                border: 1px solid rgba(0,0,0,0.08);
                border-radius: 10px;
                background: white;
                max-height: 380px;
            }
            .mss-table {
                width: 100%;
                border-collapse: collapse;
                font-size: 12px;
                text-align: left;
            }
            .mss-table th {
                background: rgba(0,0,0,0.03);
                padding: 8px 10px;
                font-weight: 600;
                border-bottom: 1px solid rgba(0,0,0,0.08);
            }
            .mss-table td {
                padding: 8px 10px;
                border-bottom: 1px solid rgba(0,0,0,0.04);
            }
            .mss-mark-badge {
                font-weight: bold;
                padding: 2px 6px;
                border-radius: 4px;
            }
            .mss-mark-5 { background: rgba(76, 175, 80, 0.15); color: #2e7d32; }
            .mss-mark-4 { background: rgba(33, 150, 243, 0.15); color: #1565c0; }
            .mss-mark-3 { background: rgba(255, 152, 0, 0.15); color: #ef6c00; }
            .mss-mark-2 { background: rgba(244, 67, 54, 0.15); color: #c62828; }
            .mss-survey-select {
                padding: 3px 5px;
                border-radius: 4px;
                border: 1px solid rgba(0,0,0,0.12);
                font-size: 11px;
                outline: none;
            }
            #mss-logs-container {
                flex: 1;
                background: #1e1e1e;
                color: #d4d4d4;
                font-family: monospace;
                font-size: 11px;
                padding: 10px;
                border-radius: 10px;
                overflow-y: auto;
                display: flex;
                flex-direction: column;
                gap: 4px;
            }
            .mss-log-entry {
                line-height: 1.4;
            }
            .mss-log-info { color: #d4d4d4; }
            .mss-log-success { color: #4caf50; }
            .mss-log-warning { color: #ffeb3b; }
            .mss-log-error { color: #f44336; }
            .mss-settings-row {
                display: grid;
                grid-template-columns: 140px 1fr;
                align-items: center;
                gap: 12px;
                font-size: 13px;
            }
            .mss-slider-group {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .mss-slider {
                flex: 1;
            }
            .mss-slider-val {
                width: 32px;
                font-weight: 600;
                text-align: right;
            }
            #mss-progress-bar-container {
                background: rgba(0,0,0,0.06);
                height: 8px;
                border-radius: 4px;
                overflow: hidden;
            }
            #mss-progress-bar {
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

        let root = document.getElementById('mss-panel-root');
        if (!root) {
            root = document.createElement('div');
            root.id = 'mss-panel-root';
            root.innerHTML = `
                <button id="mss-floating-btn" title="Soft Skills Автозаполнение">
                    <svg viewBox="0 0 24 24">
                        <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                    </svg>
                </button>
                <div id="mss-modal-container">
                    <div id="mss-header">
                        <h3>⚡ Soft Skills PRO</h3>
                        <button id="mss-close-btn" title="Закрыть">✕</button>
                    </div>
                    <div id="mss-tabs">
                        <button class="mss-tab-btn active" data-tab="main">Запуск</button>
                        <button class="mss-tab-btn" data-tab="preview">Превью</button>
                        <button class="mss-tab-btn" data-tab="settings">Настройки</button>
                        <button class="mss-tab-btn" data-tab="logs">Консоль</button>
                    </div>
                    <div id="mss-content">
                        <!-- Заполняется js -->
                    </div>
                </div>
            `;
            document.body.appendChild(root);

            // Регистрация слушателей кликов
            document.getElementById('mss-floating-btn').addEventListener('click', toggleModal);
            document.getElementById('mss-close-btn').addEventListener('click', hideModal);

            const tabButtons = root.querySelectorAll('.mss-tab-btn');
            tabButtons.forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const tab = e.target.getAttribute('data-tab');
                    switchTab(tab);
                });
            });

            autoDetectTrimester();
            switchTab(state.activeTab || 'main');
            loadGroupsDropdown();
        }
    }

    function toggleModal() {
        const container = document.getElementById('mss-modal-container');
        if (container) {
            container.classList.toggle('visible');
        }
    }

    function hideModal() {
        const container = document.getElementById('mss-modal-container');
        if (container) {
            container.classList.remove('visible');
        }
    }

    function switchTab(tabName) {
        state.activeTab = tabName;
        const tabButtons = document.querySelectorAll('.mss-tab-btn');
        tabButtons.forEach(btn => {
            if (btn.getAttribute('data-tab') === tabName) btn.classList.add('active');
            else btn.classList.remove('active');
        });

        renderContent();
    }

    function renderContent() {
        const content = document.getElementById('mss-content');
        if (!content) return;

        if (state.activeTab === 'main') {
            content.innerHTML = `
                <div class="mss-form-group">
                    <div class="mss-section-title">1. Выберите класс (группу)</div>
                    <select id="mss-group-select" class="mss-select">
                        <option value="">Загрузка групп...</option>
                    </select>
                </div>
                
                <div class="mss-form-group">
                    <div class="mss-section-title">2. Выберите период оценки</div>
                    <div class="mss-radio-group">
                        <div class="mss-radio-btn">
                            <input type="radio" id="tri-1" name="trimester" value="1" ${state.trimester === '1' ? 'checked' : ''}>
                            <label class="mss-radio-label" for="tri-1">1 трим.</label>
                        </div>
                        <div class="mss-radio-btn">
                            <input type="radio" id="tri-2" name="trimester" value="2" ${state.trimester === '2' ? 'checked' : ''}>
                            <label class="mss-radio-label" for="tri-2">2 трим.</label>
                        </div>
                        <div class="mss-radio-btn">
                            <input type="radio" id="tri-3" name="trimester" value="3" ${state.trimester === '3' ? 'checked' : ''}>
                            <label class="mss-radio-label" for="tri-3">3 трим.</label>
                        </div>
                        <div class="mss-radio-btn">
                            <input type="radio" id="tri-year" name="trimester" value="year" ${state.trimester === 'year' ? 'checked' : ''}>
                            <label class="mss-radio-label" for="tri-year">Весь год</label>
                        </div>
                    </div>
                </div>
                
                <div class="mss-form-group">
                    <div class="mss-section-title">3. Режим перезаписи оценок</div>
                    <div class="mss-toggle-group">
                        <div id="mode-new" class="mss-toggle-btn ${state.mode === 'new' ? 'active' : ''}">Только новые</div>
                        <div id="mode-overwrite" class="mss-toggle-btn ${state.mode === 'overwrite' ? 'active' : ''}">Исправить/Перезаписать</div>
                    </div>
                </div>
                
                <div style="flex: 1; display:flex; align-items:flex-end; margin-top: 15px;">
                    <button id="mss-analyze-btn" class="mss-btn-primary" style="width: 100%;">
                        🔍 Анализировать класс и оценки
                    </button>
                </div>
            `;

            const radios = content.querySelectorAll('input[name="trimester"]');
            radios.forEach(r => {
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

            const select = document.getElementById('mss-group-select');
            populateGroupSelect(select);

            document.getElementById('mss-analyze-btn').addEventListener('click', analyzeClass);

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
                const markClass = student.avg >= 4.5 ? 'mss-mark-5' : (student.avg >= 3.8 ? 'mss-mark-4' : (student.avg >= 3.0 ? 'mss-mark-3' : 'mss-mark-2'));
                const avgText = student.avg ? student.avg.toFixed(2) : '—';
                const checkedAttr = student.selected ? 'checked' : '';

                const categories = ['self_org', 'self_edu', 'self_reg', 'comm'];

                let cellsHtml = '';
                categories.forEach(cat => {
                    const ansId = student.answers[cat];
                    cellsHtml += `
                        <td>
                            <select class="mss-survey-select" data-student-idx="${index}" data-cat="${cat}">
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
                        <td style="width: 25px;"><input type="checkbox" class="mss-student-check" data-idx="${index}" ${checkedAttr}></td>
                        <td style="font-weight: 500; font-size:11px;" title="${student.name}">${truncateString(student.name, 16)}</td>
                        <td><span class="mss-mark-badge ${markClass}">${avgText}</span></td>
                        ${cellsHtml}
                    </tr>
                `;
            });

            content.innerHTML = `
                <div style="font-size:12px; font-weight:600; display:flex; justify-content:space-between; align-items:center;">
                    <div>Список учеников (${state.students.length} чел.)</div>
                    <div style="display:flex; gap: 8px;">
                        <span style="cursor:pointer; color:#1a73e8;" id="mss-sel-all">Все</span> · 
                        <span style="cursor:pointer; color:#1a73e8;" id="mss-sel-none">Никто</span>
                    </div>
                </div>
                <div class="mss-preview-container">
                    <table class="mss-table">
                        <thead>
                            <tr>
                                <th></th>
                                <th>Имя</th>
                                <th>Ср.б.</th>
                                <th title="Самоорганизация">Орг</th>
                                <th title="Самообразование">Обр</th>
                                <th title="Саморегуляция">Рег</th>
                                <th title="Коммуникация">Ком</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rowsHtml}
                        </tbody>
                    </table>
                </div>
                <div style="font-size:11px; color:#7f8c8d; line-height:1.3;">
                    * Ответы рассчитаны автоматически. Вы можете изменить оценки ученика вручную перед отправкой.
                </div>
                <button id="mss-run-submit-btn" class="mss-btn-primary" style="margin-top:5px;">
                    🚀 Отправить данные в МЭШ
                </button>
            `;

            content.querySelectorAll('.mss-student-check').forEach(ch => {
                ch.addEventListener('change', (e) => {
                    const idx = parseInt(e.target.getAttribute('data-idx'));
                    state.students[idx].selected = e.target.checked;
                });
            });

            content.querySelectorAll('.mss-survey-select').forEach(sel => {
                sel.addEventListener('change', (e) => {
                    const idx = parseInt(e.target.getAttribute('data-student-idx'));
                    const cat = e.target.getAttribute('data-cat');
                    const val = parseInt(e.target.value);
                    state.students[idx].answers[cat] = val;
                });
            });

            document.getElementById('mss-sel-all').addEventListener('click', () => toggleAllStudents(true));
            document.getElementById('mss-sel-none').addEventListener('click', () => toggleAllStudents(false));
            document.getElementById('mss-run-submit-btn').addEventListener('click', runSurveysSubmit);

        } else if (state.activeTab === 'settings') {
            content.innerHTML = `
                <div class="mss-section-title" style="margin-bottom:8px;">Параметры авторизации</div>
                <div style="border: 1px solid rgba(0,0,0,0.08); border-radius:10px; padding: 12px; background:rgba(0,0,0,0.015); display:flex; flex-direction:column; gap:8px; margin-bottom:12px;">
                    <div class="mss-form-group">
                        <label style="font-weight:600; font-size:11px; color:#555;">Bearer Токен (Authorization):</label>
                        <input type="text" id="mss-token-input" class="mss-input" style="font-family:monospace; font-size:11px; padding:6px 10px;" value="${authState.token || ''}" placeholder="Захватывается автоматически. Можно вставить вручную.">
                    </div>
                    <div class="mss-form-group">
                        <label style="font-weight:600; font-size:11px; color:#555;">Profile ID:</label>
                        <input type="text" id="mss-profile-id-input" class="mss-input" style="font-family:monospace; font-size:11px; padding:6px 10px;" value="${authState.profileId || ''}" placeholder="Захватывается автоматически. Можно вставить вручную.">
                    </div>
                </div>

                <div class="mss-section-title" style="margin-bottom:8px;">Пороги оценок</div>
                
                <div class="mss-form-group" style="gap:10px; max-height:180px; overflow-y:auto; padding-right:4px;">
                    ${renderThresholdSliders()}
                </div>
                
                <div style="border-top:1px solid rgba(0,0,0,0.06); padding-top:10px; margin-top:8px; display:flex; gap:10px;">
                    <button id="mss-save-settings-btn" class="mss-btn-primary" style="flex:1; padding:8px 12px; font-size:12px;">Сохранить всё</button>
                    <button id="mss-reset-settings-btn" class="mss-btn-secondary" style="flex:1; padding:8px 12px; font-size:12px;">Сбросить</button>
                </div>
            `;

            const sliders = content.querySelectorAll('.mss-slider');
            sliders.forEach(slider => {
                slider.addEventListener('input', (e) => {
                    const valEl = e.target.nextElementSibling;
                    valEl.textContent = parseFloat(e.target.value).toFixed(1);
                });
            });

            document.getElementById('mss-save-settings-btn').addEventListener('click', saveConfigFromUI);
            document.getElementById('mss-reset-settings-btn').addEventListener('click', resetConfigToDefault);

        } else if (state.activeTab === 'logs') {
            const hasProgress = state.isRunning || state.logs.length > 0;
            let percent = 0;
            let current = 0;
            let total = 0;
            
            if (state.students.length > 0) {
                total = state.students.filter(s => s.selected).length;
                current = state.students.filter(s => s.status === 'ok' || s.status === 'error' || s.status === 'skipped').length;
                percent = total > 0 ? Math.round((current / total) * 100) : 0;
            }

            content.innerHTML = `
                <div style="font-size:12px; font-weight:600; display:flex; justify-content:space-between; align-items:center;">
                    <div>Вывод консоли</div>
                    <div id="mss-clear-logs" style="cursor:pointer; color:#7f8c8d; font-size:11px;">Очистить</div>
                </div>
                <div id="mss-logs-container">
                    ${state.logs.map(l => `<div class="mss-log-entry mss-log-${l.type}">[${l.time}] ${l.text}</div>`).join('')}
                </div>
                ${hasProgress ? `
                    <div class="mss-form-group" style="gap:4px; margin-top: 5px;">
                        <div style="display:flex; justify-content:space-between; font-size:11px; font-weight:600;">
                            <div>Прогресс: ${current}/${total}</div>
                            <div>${percent}%</div>
                        </div>
                        <div id="mss-progress-bar-container">
                            <div id="mss-progress-bar" style="width: ${percent}%;"></div>
                        </div>
                    </div>
                ` : ''}
            `;

            const container = document.getElementById('mss-logs-container');
            if (container) container.scrollTop = container.scrollHeight;

            document.getElementById('mss-clear-logs').addEventListener('click', () => {
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
        const cats = {
            self_org: 'Самоорганизация',
            self_edu: 'Самообразование',
            self_reg: 'Саморегуляция',
            comm: 'Коммуникация'
        };

        return Object.entries(cats).map(([cat, label]) => {
            const t = CONFIG.thresholds[cat];
            return `
                <div style="border: 1px solid rgba(0,0,0,0.05); border-radius:10px; padding: 10px; background:rgba(0,0,0,0.01)">
                    <div style="font-weight:600; font-size:12px; margin-bottom:8px; color:#1a73e8;">${label}</div>
                    
                    <div class="mss-settings-row" style="margin-bottom:6px;">
                        <div>Всегда (≥):</div>
                        <div class="mss-slider-group">
                            <input type="range" class="mss-slider" data-cat="${cat}" data-level="always" min="3.5" max="5.0" step="0.1" value="${t.always}">
                            <div class="mss-slider-val">${t.always.toFixed(1)}</div>
                        </div>
                    </div>
                    
                    <div class="mss-settings-row" style="margin-bottom:6px;">
                        <div>Часто (≥):</div>
                        <div class="mss-slider-group">
                            <input type="range" class="mss-slider" data-cat="${cat}" data-level="often" min="3.0" max="4.5" step="0.1" value="${t.often}">
                            <div class="mss-slider-val">${t.often.toFixed(1)}</div>
                        </div>
                    </div>
                    
                    <div class="mss-settings-row">
                        <div>Редко (≥):</div>
                        <div class="mss-slider-group">
                            <input type="range" class="mss-slider" data-cat="${cat}" data-level="rarely" min="2.0" max="4.0" step="0.1" value="${t.rarely}">
                            <div class="mss-slider-val">${t.rarely.toFixed(1)}</div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    function saveConfigFromUI() {
        const content = document.getElementById('mss-content');
        
        // Сохраняем токен и profileId из полей ввода
        const tokenInput = document.getElementById('mss-token-input');
        const profileIdInput = document.getElementById('mss-profile-id-input');
        
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

        const sliders = content.querySelectorAll('.mss-slider');
        sliders.forEach(slider => {
            const cat = slider.getAttribute('data-cat');
            const level = slider.getAttribute('data-level');
            const val = parseFloat(slider.value);
            CONFIG.thresholds[cat][level] = val;
        });

        saveSettings();
        addLog('Настройки и параметры авторизации успешно сохранены!', 'success');
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
        console.log(`[SoftSkills PRO] [${type}] ${text}`);
        
        if (state.activeTab === 'logs') {
            const container = document.getElementById('mss-logs-container');
            if (container) {
                const entry = document.createElement('div');
                entry.className = `mss-log-entry mss-log-${type}`;
                entry.textContent = `[${timeStr}] ${text}`;
                container.appendChild(entry);
                container.scrollTop = container.scrollHeight;
            }
        }
    }

    async function loadGroupsDropdown() {
        const select = document.getElementById('mss-group-select');
        if (state.groups && state.groups.length > 0) {
            if (select) populateGroupSelect(select);
            return;
        }

        try {
            scanStorageForCredentials();
            if (!authState.token) {
                addLog('⚠️ Токен авторизации не обнаружен. Пожалуйста, совершите любое действие в журнале (например, перейдите в другой класс) или обновите страницу, чтобы скрипт перехватил сессию.', 'warning');
            }
            
            addLog('Загружаю список групп учителя...');
            state.groups = await fetchMyGroups();
            
            if (select) populateGroupSelect(select);
            addLog(`Загружено ${state.groups.length} групп.`, 'success');
        } catch (e) {
            addLog(`Ошибка при загрузке групп: ${e.message}`, 'error');
            if (select) {
                select.innerHTML = `<option value="">Ошибка загрузки (проверьте авторизацию)</option>`;
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
        const groupSelect = document.getElementById('mss-group-select');
        const groupId = groupSelect ? groupSelect.value : null;

        if (!groupId) {
            alert('Сначала выберите группу!');
            return;
        }

        state.currentClassId = groupId;
        state.students = [];
        switchTab('logs');
        addLog(`=== НАЧАЛО АНАЛИЗА КЛАССА [${groupId}] ===`);

        try {
            // 1. Загрузка учеников класса
            addLog('Загружаю список учеников...');
            const studentsData = await apiFetch(`/api/ej/core/teacher/v1/student_profiles?academic_year_id=13&group_ids=${groupId}&with_final_marks=true&per_page=150&page=1`);
            const profiles = studentsData.items || studentsData || [];
            const validStudents = profiles.filter(s => s.person_id);

            if (validStudents.length === 0) {
                addLog('В группе не найдено учеников.', 'error');
                return;
            }
            addLog(`Загружено учеников: ${validStudents.length}`);

            // 2. Загрузка оценок за выбранный период
            const dates = getTrimesterDates(state.trimester);
            addLog(`Загружаю оценки за период: ${dates.start} — ${dates.end}...`);
            const marksData = await apiFetch(`/api/ej/core/teacher/v1/marks?group_ids=${groupId}&created_at_from=${dates.start}&created_at_to=${dates.end}&with_non_numeric_entries=true&per_page=3000&page=1`);
            
            const studentIds = validStudents.map(s => String(s.id));
            const avgMap = computeAverages(marksData, studentIds);
            addLog(`Вычислен средний балл за период для ${Object.keys(avgMap).filter(k => avgMap[k] !== null).length} учеников`);

            // 3. Выбор period_id
            addLog('Определяю текущий период для soft skills...');
            const firstPersonId = validStudents[0].person_id;
            const periodId = await getPeriodId(firstPersonId);
            
            if (!periodId) {
                addLog('Не удалось определить period_id. МЭШ не настроен на проведение анкетирования.', 'error');
                return;
            }
            state.periodId = periodId;
            addLog(`Используется period_id: ${periodId}`, 'success');

            // 4. Построение массива учеников для превью
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
                    
                    answers[cat] = getAnswerByScore(avg, qId, s.person_id);
                });

                studentsList.push({
                    id: s.id,
                    person_id: s.person_id,
                    name: name,
                    avg: avg,
                    answers: answers,
                    selected: true,
                    status: null
                });
            }

            state.students = studentsList.sort((a,b) => a.name.localeCompare(b.name));
            addLog('Анализ завершён. Перейдите во вкладку «Превью» для проверки.', 'success');
            switchTab('preview');

        } catch (e) {
            addLog(`Ошибка при анализе: ${e.message}`, 'error');
        }
    }

    function computeAverages(marksData, studentIds) {
        const scores = {};
        const items = Array.isArray(marksData) ? marksData : (marksData.marks || marksData.items || []);
        
        for (const mark of items) {
            const sid = mark.student_profile_id || mark.student_id;
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
        } catch (e) {
            console.warn('Failed checkCurrentPeriodTeacher:', e);
        }
        try {
            const periods = await apiFetch(`/api/soft_skills/v1/periods?student_person_id=${firstPersonId}`);
            if (Array.isArray(periods) && periods.length > 0) {
                const current = periods.find(p => p.is_current || p.current);
                if (current) return current.id;
                return periods[periods.length - 1].id;
            }
        } catch (e) {
            console.warn('Failed to fetch periods list:', e);
        }
        return null;
    }

    async function checkSurveyFilled(personId, periodId) {
        try {
            const data = await apiFetch(`/api/soft_skills/v1/survey/teacherSurvey?student_person_id=${personId}&period_id=${periodId}`);
            if (data && data.answers && data.answers.length > 0) {
                return true;
            }
        } catch (e) {}
        return false;
    }

    // === ОТПРАВКА ОЦЕНОК В МЭШ ===
    async function runSurveysSubmit() {
        const toSubmit = state.students.filter(s => s.selected);
        if (toSubmit.length === 0) {
            alert('Не выбрано ни одного ученика для отправки!');
            return;
        }

        const confirmText = state.mode === 'overwrite' 
            ? `Вы уверены, что хотите перезаписать оценки для ${toSubmit.length} учеников? Прежние оценки за этот период будут предварительно удалены.`
            : `Запустить отправку оценок для ${toSubmit.length} учеников?`;

        if (!confirm(confirmText)) return;

        state.isRunning = true;
        switchTab('logs');
        addLog(`=== НАЧАЛО ОТПРАВКИ ОЦЕНОК в period_id=${state.periodId} ===`);
        addLog(`Режим работы: ${state.mode === 'overwrite' ? 'УДАЛИТЬ СТАРЫЕ и ЗАПИСАТЬ' : 'ЗАПОЛНИТЬ ТОЛЬКО НОВЫЕ'}`);

        let success = 0;
        let skipped = 0;
        let errors = 0;

        for (let i = 0; i < state.students.length; i++) {
            const s = state.students[i];
            if (!s.selected) continue;

            addLog(`Обработка ученика: ${s.name} (балл: ${s.avg ? s.avg.toFixed(2) : '—'})...`);

            try {
                if (state.mode === 'new') {
                    const isFilled = await checkSurveyFilled(s.person_id, state.periodId);
                    if (isFilled) {
                        s.status = 'skipped';
                        skipped++;
                        addLog(`⏭️ Пропущено: Оценка для ${s.name} уже была выставлена.`, 'warning');
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
                    } catch (err) {
                        console.warn(`Не удалось удалить предыдущую анкету для ${s.name}: ${err.message}`);
                    }
                }

                const answersList = [];
                Object.entries(QUESTION_CATEGORY).forEach(([qIdStr, cat]) => {
                    const qId = parseInt(qIdStr);
                    const baseAns = s.answers[cat];
                    
                    let finalAnswerId = baseAns;
                    if (baseAns !== 5) {
                        finalAnswerId = getAnswerByScore(s.avg, qId, s.person_id);
                    }

                    answersList.push({
                        question_id: qId,
                        answer_id: finalAnswerId
                    });
                });

                await submitSurvey(s.person_id, state.periodId, answersList);
                s.status = 'ok';
                success++;
                addLog(`✅ Успешно отправлено: ${s.name}`, 'success');

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
        const headers = {
            'Accept': 'application/json',
            'X-Mes-Subsystem': 'teacherweb',
            'Content-Type': 'application/json',
        };
        if (authState.token) {
            headers['Authorization'] = `Bearer ${authState.token}`;
        }
        if (authState.profileId) {
            headers['Profile-Id'] = String(authState.profileId);
        }
        const resp = await fetch(CONFIG.apiBase + url, {
            method: 'DELETE',
            credentials: 'include',
            headers: headers
        });
        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}`);
        }
        return resp;
    }

    async function submitSurvey(personId, periodId, answers) {
        const url = `/api/soft_skills/v1/survey`;
        const headers = {
            'Accept': 'application/json',
            'X-Mes-Subsystem': 'teacherweb',
            'Content-Type': 'application/json',
        };
        if (authState.token) {
            headers['Authorization'] = `Bearer ${authState.token}`;
        }
        if (authState.profileId) {
            headers['Profile-Id'] = String(authState.profileId);
        }
        const resp = await fetch(CONFIG.apiBase + url, {
            method: 'POST',
            credentials: 'include',
            headers: headers,
            body: JSON.stringify({
                student_person_id: personId,
                period_id: periodId,
                answers: answers
            })
        });
        if (!resp.ok) {
            let errText = `HTTP ${resp.status}`;
            try {
                const errJson = await resp.json();
                errText = errJson.message || errJson.error || errText;
            } catch (e) {}
            throw new Error(errText);
        }
        return resp.json();
    }

    function updateSubmitProgressBar(current, total) {
        const bar = document.getElementById('mss-progress-bar');
        if (bar) {
            const pct = Math.round((current / total) * 100);
            bar.style.width = `${pct}%`;
        }
    }

    // === ДИНАМИЧЕСКИЙ ОБСЕРВЕР ИНТЕРФЕЙСА ===
    function startUIObserver() {
        ensureUI();

        // Отслеживаем изменения DOM (например, монтирование/перерисовку SPA МЭШ)
        if (typeof MutationObserver !== 'undefined') {
            const observer = new MutationObserver(() => {
                const root = document.getElementById('mss-panel-root');
                if (!root && document.body) {
                    ensureUI();
                }
            });

            if (document.body) {
                observer.observe(document.body, { childList: true });
            } else {
                setTimeout(() => {
                    if (document.body) {
                        observer.observe(document.body, { childList: true });
                        ensureUI();
                    }
                }, 500);
            }
        }

        // Резервный интервал проверки на случай сбоя MutationObserver
        setInterval(() => {
            const root = document.getElementById('mss-panel-root');
            if (!root && document.body) {
                ensureUI();
            }
        }, 2000);
    }

    // === ЗАПУСК И ИНИЦИАЛИЗАЦИЯ ===
    function init() {
        startUIObserver();
    }

    console.log('[SoftSkills PRO] Скрипт загружен, readyState:', document.readyState);

    // Запускаем UI-рендеринг при полной готовности DOM
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        init();
    } else {
        document.addEventListener('DOMContentLoaded', init);
    }
})();
