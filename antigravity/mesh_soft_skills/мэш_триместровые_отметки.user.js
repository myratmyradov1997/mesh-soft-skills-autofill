// ==UserScript==
// @name         МЭШ — Триместровые и годовые отметки
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Автоматический расчёт и выставление триместровых, годовых отметок и промежуточной аттестации на основе среднего балла
// @author       You
// @match        https://school.mos.ru/*
// @grant        GM_addStyle
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';
    console.log('[Итоговые отметки] ЗАПУСК скрипта...');

    function getStorageItem(key) {
        try { return localStorage.getItem(key); } catch (e) { return null; }
    }

    function setStorageItem(key, val) {
        try { localStorage.setItem(key, val); } catch (e) {}
    }

    function removeStorageItem(key) {
        try { localStorage.removeItem(key); } catch (e) {}
    }

    let authState = {
        token: getStorageItem('mss_fm_captured_token') || null,
        profileId: getStorageItem('mss_fm_captured_profile_id') || null
    };

    (function interceptNetwork() {
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
                            setStorageItem('mss_fm_captured_token', t);
                        }
                    }
                    if (prof) {
                        const p = String(prof);
                        if (p !== authState.profileId) {
                            authState.profileId = p;
                            setStorageItem('mss_fm_captured_profile_id', p);
                        }
                    }
                }
            } catch (e) {}
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
                            setStorageItem('mss_fm_captured_token', t);
                        }
                    }
                    if (header.toLowerCase() === 'profile-id') {
                        const p = String(value);
                        if (p !== authState.profileId) {
                            authState.profileId = p;
                            setStorageItem('mss_fm_captured_profile_id', p);
                        }
                    }
                }
            } catch (e) {}
            return originalSetRequestHeader.apply(this, arguments);
        };
    })();

    const CONFIG = {
        apiBase: 'https://school.mos.ru',
        academicYearId: 13,
        gradeThresholds: [
            { min: 4.5, grade: 5, label: 'Отлично' },
            { min: 3.5, grade: 4, label: 'Хорошо' },
            { min: 2.5, grade: 3, label: 'Удовлетворительно' },
            { min: 0, grade: 2, label: 'Неудовлетворительно' },
        ],
        minMarks: {
            2: 5,
            1: 3,
            default: 3,
        },
        finalMarksEndpoint: '/api/ej/core/teacher/v1/final_marks',
        finalMarksHeaders: {
            'x-mes-hostid': '9',
            'aid': '13',
            'x-mes-subsystem': 'journalw',
            'X-Mes-RoleId': '9',
        },
        // Какие классы НЕ имеют итоговой оценки (по номеру в названии группы)
        noFinalGrades: ['7'],

        attestationPeriodIds: {
            '1': '85767',
            '2': '85768',
            '3': '85764',
        },
        // Старый неверный период (для очистки)
        legacyPeriodIds: ['85766', '85767', '85768'],
        // Mark types for different submission modes
        markTypes: {
            trimester: { is_year_mark: false, mark_type: null },
            annual: { is_year_mark: true, mark_type: null },
            attestation: { is_year_mark: false, mark_type: 'intermediate_attestation' },
            final: { is_year_mark: false, mark_type: 'attestation' },
        },
    };

    const TRIMESTER_DATES = {
        '1': { start: '01.09.2025', end: '30.11.2025', label: '1 триместр' },
        '2': { start: '01.12.2025', end: '28.02.2026', label: '2 триместр' },
        '3': { start: '01.03.2026', end: '31.05.2026', label: '3 триместр' },
        'year': { start: '01.09.2025', end: '31.08.2026', label: 'Весь год' },
    };

    function autoDetectTrimester() {
        const date = new Date();
        const month = date.getMonth() + 1;
        if (month >= 9 && month <= 11) return '1';
        if (month === 12 || month === 1 || month === 2) return '2';
        if (month >= 3 && month <= 5) return '3';
        return '3';
    }

    let state = {
        groups: [],
        scheduleItems: [],
        selectedGroupId: null,
        students: [],
        trimester: autoDetectTrimester(),
        submitting: false,
        logs: [],
        activeTab: 'main',
    };

    function scanStorageForCredentials() {
        try {
            if (authState.token && authState.profileId) return;
            for (let i = 0; i < localStorage.length; i++) {
                const val = localStorage.getItem(localStorage.key(i));
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
                const val = sessionStorage.getItem(sessionStorage.key(i));
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
        } catch (e) {}
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
            setStorageItem('mss_fm_captured_profile_id', m[1]);
            return m[1];
        }
        return null;
    }

    async function apiFetch(path, opts = {}) {
        scanStorageForCredentials();
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
            throw new Error('Сессия истекла (401). Обновите страницу.');
        }
        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            throw new Error(`HTTP ${resp.status} для ${path}: ${body.slice(0, 200)}`);
        }
        return resp.json();
    }

    function extractGroupsFromSchedule(sched, profileId) {
        const items = Array.isArray(sched) ? sched : (sched && sched.items ? sched.items : []);
        const groups = {};

        // Check if schedule items have replacement metadata
        const hasReplacementData = items.some(item =>
            item.replaced !== undefined || item.replaced_teacher_id !== undefined
        );

        for (const item of items) {
            // Filter out replacement lessons (user was a substitute for another teacher)
            if (hasReplacementData) {
                if (item.replaced === true && item.replaced_teacher_id) {
                    // replaced_teacher_id = whom the user substituted for (the original teacher).
                    // If replaced_teacher_id !== profileId, user was subbing → skip.
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
                    subject_name: item.subject_name || '',
                    class_unit_id: item.class_unit_id,
                    periods_schedule_id: item.periods_schedule_id,
                };
            }
        }
        return Object.values(groups);
    }

    function getWeekKey(date) {
        const d = new Date(date);
        const yearStart = new Date(d.getFullYear(), 0, 1);
        const weekNum = Math.ceil((((d - yearStart) / 86400000) + yearStart.getDay() + 1) / 7);
        return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
    }

    function computeHoursPerWeek(scheduleItems, groupId) {
        const items = scheduleItems.filter(item => String(item.group_id) === String(groupId));
        if (items.length === 0) return 1;

        // Determine actual field names from first item
        const first = items[0];
        const dayField = ['day_of_week', 'week_day', 'day', 'weekday', 'class_day', 'weekDay'].find(f => first[f] !== undefined);
        const periodField = ['period_number', 'period', 'slot_number', 'slot', 'lesson_number', 'order', 'number'].find(f => first[f] !== undefined);

        // Method 1: day_of_week + period_number (recurring slots)
        if (dayField) {
            const slots = new Set();
            for (const item of items) {
                const day = item[dayField];
                const period = periodField ? item[periodField] : 0;
                if (day != null) slots.add(`${day}-${period}`);
            }
            if (slots.size > 0) return slots.size;
        }

        // Method 2: by actual date fields
        const dateField = ['date', 'lesson_date', 'start_date', 'event_date'].find(f => first[f] !== undefined);
        if (dateField) {
            // Count unique (weekday, period) combos
            const slots = new Set();
            for (const item of items) {
                if (item[dateField]) {
                    const d = new Date(item[dateField]);
                    if (!isNaN(d)) {
                        const period = periodField ? (item[periodField] || 0) : 0;
                        slots.add(`${d.getDay()}-${period}`);
                    }
                }
            }
            if (slots.size > 0) return slots.size;

            // Per-week average count
            const weeks = {};
            for (const item of items) {
                if (item[dateField]) {
                    const d = new Date(item[dateField]);
                    if (!isNaN(d)) {
                        const wk = getWeekKey(d);
                        weeks[wk] = (weeks[wk] || 0) + 1;
                    }
                }
            }
            const counts = Object.values(weeks);
            if (counts.length > 0) {
                return Math.max(Math.round(counts.reduce((a, b) => a + b, 0) / counts.length), 1);
            }
        }

        // Method 3: item count as proxy
        const count = items.length;
        if (count <= 6) return Math.max(count, 1);
        return 2;
    }

    function getMinRequiredMarks(hoursPerWeek) {
        return CONFIG.minMarks[hoursPerWeek] || CONFIG.minMarks.default;
    }

    function groupHasFinalGrade(group) {
        if (!group || !group.group_name) return true;
        const name = group.group_name;
        for (const g of CONFIG.noFinalGrades) {
            if (new RegExp(`[^\\d]${g}[А-ЯA-Z]`).test(name) || new RegExp(`^${g}[А-ЯA-Z]`).test(name)) {
                return false;
            }
        }
        return true;
    }

    function getGradeFromAverage(avg) {
        if (avg == null || isNaN(avg)) return null;
        for (const t of CONFIG.gradeThresholds) {
            if (avg >= t.min) return t.grade;
        }
        return 2;
    }

    function getGradeLabel(grade) {
        const map = { 5: 'Отлично', 4: 'Хорошо', 3: 'Удовлетворительно', 2: 'Неудовлетворительно' };
        return map[grade] || grade;
    }

    function autoSelectGroupFromUrl() {
        const m = window.location.pathname.match(/\/grade\/(\d+)/);
        return m ? m[1] : null;
    }

    function getStudentName(profile) {
        const lastFields = ['last_name', 'lastName', 'surname', 'family_name', 'second_name'];
        const firstFields = ['first_name', 'firstName', 'name', 'given_name'];
        const middleFields = ['middle_name', 'middleName', 'patronymic', 'patronymic_name', 'father_name'];

        const last = lastFields.find(f => profile[f] !== undefined && profile[f] !== null);
        const first = firstFields.find(f => profile[f] !== undefined && profile[f] !== null);
        const middle = middleFields.find(f => profile[f] !== undefined && profile[f] !== null);

        const parts = [
            last ? profile[last] : '',
            first ? profile[first] : '',
            middle ? profile[middle] : '',
        ].filter(Boolean);

        if (parts.length > 0) return parts.join(' ');
        if (profile.short_name) return profile.short_name;
        if (profile.user_name) return profile.user_name;
        return `ID ${profile.id}`;
    }

    async function fetchMyGroups() {
        const pid = await getProfileId();
        if (pid) {
            try {
                const sched = await apiFetch(`/api/ej/plan/teacher/v1/schedule_items?academic_year_id=${CONFIG.academicYearId}&teacher_id=${pid}&from=2025-09-01&to=2026-05-31&with_group_class_subject_info=true&page=1&per_page=2000`);
                state.scheduleItems = Array.isArray(sched) ? sched : (sched && sched.items ? sched.items : []);

                // Debug: log first schedule item fields
                if (state.scheduleItems.length > 0) {
                    console.log('[Итоговые отметки] Поля schedule items:', Object.keys(state.scheduleItems[0]));
                }

                const groups = extractGroupsFromSchedule(sched, pid);
                if (groups.length > 0) {
                    state.groups = groups;
                    // Auto-select group from URL
                    const urlGroupId = autoSelectGroupFromUrl();
                    if (urlGroupId && groups.some(g => String(g.id) === urlGroupId)) {
                        state.selectedGroupId = urlGroupId;
                    }
                    return groups;
                }
            } catch (e) {
                console.warn('Schedule fetch failed:', e);
            }
        }
        try {
            const data = await apiFetch(`/api/ej/plan/teacher/v1/groups?academic_year_id=${CONFIG.academicYearId}`);
            const groups = Array.isArray(data) ? data : (data.items || data.groups || []);
            state.groups = groups;
            return groups;
        } catch (e) {
            throw e;
        }
    }

    async function loadStudents(groupId) {
        const data = await apiFetch(`/api/ej/core/teacher/v1/student_profiles?academic_year_id=${CONFIG.academicYearId}&group_ids=${groupId}&with_final_marks=true&per_page=150&page=1`);
        return Array.isArray(data) ? data : (data.items || []);
    }

    async function loadMarks(groupId, dateStart, dateEnd, subjectId) {
        let url = `/api/ej/core/teacher/v1/marks?group_ids=${groupId}&created_at_from=${dateStart}&created_at_to=${dateEnd}&with_non_numeric_entries=true&per_page=3000&page=1`;
        if (subjectId) url += `&subject_id=${subjectId}`;
        const data = await apiFetch(url);
        return Array.isArray(data) ? data : (data.marks || data.items || []);
    }

    function extractGradeFromEntry(entry) {
        if (!entry || !entry.grade) return null;
        const g = entry.grade;
        if (g.five != null && !isNaN(g.five)) return Number(g.five);
        if (g.value != null && !isNaN(g.value)) return Number(g.value);
        if (g.name != null) {
            const n = parseFloat(g.name);
            if (!isNaN(n)) return n;
        }
        return null;
    }

    function getMarkType(mark) {
        // Some marks might be non-grade entries (attendance, etc.)
        // Check for type indicators
        if (!mark) return 'unknown';
        if (mark.type === 'attendance' || mark.type === 'behaviour') return 'non-grade';
        // Check if any values have valid grades
        const vals = mark.values || [];
        if (vals.length === 0) {
            const n = parseFloat(mark.name || mark.value);
            if (isNaN(n) || n < 2 || n > 5) return 'non-grade';
            return 'grade';
        }
        for (const v of vals) {
            const g = extractGradeFromEntry(v);
            if (g !== null && g >= 2 && g <= 5) return 'grade';
        }
        if (vals.some(v => v && v.grade && v.grade.type === 'attendance')) return 'non-grade';
        return 'unknown';
    }

    function isMarkDeleted(mark) {
        return mark.deleted_at || mark.is_deleted === true || mark.deleted === true;
    }

    function buildCorrectionMap(marksData) {
        const replacedIds = new Set();
        for (const m of marksData) {
            const replaces = m.replaces_mark_id || m.corrects_mark_id;
            if (replaces) replacedIds.add(String(replaces));
        }
        return replacedIds;
    }

    function isMarkReplaced(mark, correctionMap) {
        return correctionMap.has(String(mark.id));
    }

    function countStudentMarks(marksData, studentId, correctionMap) {
        let count = 0;
        for (const m of marksData) {
            if (String(m.student_profile_id || m.student_id) !== String(studentId)) continue;
            if (isMarkDeleted(m)) continue;
            if (isMarkReplaced(m, correctionMap)) continue;
            const vals = m.values || [];
            let counted = false;
            for (const entry of vals) {
                let v = null;
                if (entry && entry.grade && entry.grade.five != null) v = entry.grade.five;
                if (v != null && v >= 2 && v <= 5) { count++; counted = true; }
            }
            if (!counted) {
                let v = parseFloat(m.name || m.value);
                if (v != null && v >= 2 && v <= 5) count++;
            }
        }
        return count;
    }

    // Log full mark structure for the first few marks of a student
    function logMarkStructure(marksData, debugSid, debugName) {
        if (!debugSid || !debugName) return;
        const studentMarks = marksData.filter(m =>
            String(m.student_profile_id || m.student_id) === String(debugSid)
        );
        if (studentMarks.length === 0) return;
        console.log(`[Итоговые отметки] Структура отметок для ${debugName}:`);
        studentMarks.slice(0, 3).forEach(m => {
            const keys = Object.keys(m).filter(k => !k.startsWith('_'));
            console.log(`  id=${m.id} ключи:`, keys);
            console.log(`  id=${m.id} values:`, JSON.stringify(m.values).slice(0, 200));
            if (m.replaces_mark_id) console.log(`  id=${m.id} ЗАМЕНЯЕТ отметку: ${m.replaces_mark_id}`);
            if (m.corrects_mark_id) console.log(`  id=${m.id} ИСПРАВЛЯЕТ отметку: ${m.corrects_mark_id}`);
            if (m.replaced_by_mark_id) console.log(`  id=${m.id} ЗАМЕНЕНА отметкой: ${m.replaced_by_mark_id}`);
            if (m.corrected_by_mark_id) console.log(`  id=${m.id} ИСПРАВЛЕНА отметкой: ${m.corrected_by_mark_id}`);
        });
    }

    function computeAverages(marksData, studentIds, debugStudentId, debugStudentName) {
        const correctionMap = buildCorrectionMap(marksData);
        logMarkStructure(marksData, debugStudentId, debugStudentName);

        const weightedScores = {};
        const countScores = {};
        let debugLines = [];

        for (const mark of marksData) {
            const sid = mark.student_profile_id || mark.student_id;
            if (!studentIds.includes(String(sid))) continue;

            if (isMarkDeleted(mark)) {
                if (sid === debugStudentId && debugStudentName) {
                    debugLines.push(`  🗑️ deleted: id=${mark.id}`);
                }
                continue;
            }

            if (isMarkReplaced(mark, correctionMap)) {
                if (sid === debugStudentId && debugStudentName) {
                    debugLines.push(`  🔄 replaced: id=${mark.id} (есть исправление)`);
                }
                continue;
            }

            const weight = mark.weight || mark.coefficient || 1;
            const vals = mark.values || [];
            let anyValueUsed = false;

            for (const entry of vals) {
                const g = extractGradeFromEntry(entry);
                if (g !== null && g >= 2 && g <= 5) {
                    if (!weightedScores[sid]) weightedScores[sid] = 0;
                    if (!countScores[sid]) countScores[sid] = 0;
                    weightedScores[sid] += g * weight;
                    countScores[sid] += weight;
                    anyValueUsed = true;
                    if (sid === debugStudentId && debugStudentName) {
                        const replaces = mark.replaces_mark_id || mark.corrects_mark_id || '';
                        const note = replaces ? ` (исправление #${replaces})` : '';
                        debugLines.push(`  📝 id=${mark.id} val=${g} weight=${weight} → ${g * weight}${note}`);
                    }
                } else if (entry && g !== null) {
                    if (sid === debugStudentId && debugStudentName) {
                        debugLines.push(`  ⏭️ id=${mark.id} val=${g} (вне диапазона 2-5)`);
                    }
                }
            }

            if (!anyValueUsed) {
                const hasEmptyValues = vals.length === 0 || vals.every(v => v == null || Object.keys(v).length === 0);
                if (hasEmptyValues) {
                    const g = parseFloat(mark.name ?? mark.value);
                    if (!isNaN(g) && g >= 2 && g <= 5) {
                        if (!weightedScores[sid]) weightedScores[sid] = 0;
                        if (!countScores[sid]) countScores[sid] = 0;
                        weightedScores[sid] += g * weight;
                        countScores[sid] += weight;
                        anyValueUsed = true;
                        if (sid === debugStudentId && debugStudentName) {
                            debugLines.push(`  📝 id=${mark.id} name="${mark.name || mark.value}" val=${g} weight=${weight} → ${g * weight}`);
                        }
                    } else if (mark.name) {
                        if (sid === debugStudentId && debugStudentName) {
                            debugLines.push(`  ⏭️ id=${mark.id} name="${mark.name}" (не число или вне 2-5)`);
                        }
                    }
                }
            }

            if (!anyValueUsed && sid === debugStudentId && debugStudentName) {
                debugLines.push(`  ⏭️ id=${mark.id} — нет grade-значений`);
            }
        }

        if (debugStudentId && debugStudentName && debugLines.length > 0) {
            console.log(`[Итоговые отметки] Разбор отметок для ${debugStudentName}:`);
            debugLines.forEach(l => console.log(l));
            const total = weightedScores[debugStudentId];
            const cnt = countScores[debugStudentId];
            if (total != null && cnt > 0) {
                console.log(`  Итого: ${total} / ${cnt} = ${(total / cnt).toFixed(2)}`);
            } else {
                console.log(`  Итого: нет оценок`);
            }
        }

        const averages = {};
        for (const sid of studentIds) {
            if (weightedScores[sid] != null && countScores[sid] > 0) {
                averages[sid] = weightedScores[sid] / countScores[sid];
            } else {
                averages[sid] = null;
            }
        }
        return averages;
    }

    function getExistingFinalMarks(profiles, subjectId, periodId) {
        const result = {};
        for (const p of profiles) {
            if (p.final_marks && Array.isArray(p.final_marks)) {
                const fm = p.final_marks.find(m =>
                    String(m.subject_id) === String(subjectId) &&
                    String(m.period_id) === String(periodId)
                );
                if (fm) result[p.id] = fm.mark;
            }
        }
        return result;
    }

    // Get all trimester final marks for annual grade calculation
    function isTrimesterMark(m) {
        return (
            !m.is_year_mark &&
            !m.year_mark &&
            (m.mark_type == null || m.mark_type === '')
        );
    }

    function logTrimesterDebug(profiles, subjectId) {
        for (const p of profiles) {
            if (!p.final_marks) continue;
            const all = p.final_marks.filter(m => String(m.subject_id) === String(subjectId) && m.mark != null);
            const tri = all.filter(isTrimesterMark).map(m => m.mark);
            if (all.length > 0) {
                console.log(`[Итоговые отметки] ${p.last_name || p.short_name}: всего final_marks=${all.length}, триместровые=${JSON.stringify(tri)}, все:`, all.map(m => ({ mark: m.mark, is_year: m.is_year_mark, year: m.year_mark, type: m.mark_type, period: m.attestation_period_id })));
            }
        }
    }

    function getExistingTrimesterMarks(profiles, subjectId) {
        const result = {};
        for (const p of profiles) {
            if (p.final_marks && Array.isArray(p.final_marks)) {
                const trimesterMarks = p.final_marks.filter(m =>
                    String(m.subject_id) === String(subjectId) &&
                    m.mark != null && m.mark >= 2 && m.mark <= 5 &&
                    isTrimesterMark(m)
                );
                result[p.id] = trimesterMarks.map(m => m.mark);
            } else {
                result[p.id] = [];
            }
        }
        return result;
    }

    function buildFinalMarkPayload(studentId, subjectId, value, attestationPeriodId, opts = {}) {
        const isYearMark = !!opts.is_year_mark;
        const isAttestation = opts.mark_type === 'intermediate_attestation';
        return {
            comment: '',
            subject_id: subjectId,
            student_profile_id: studentId,
            academic_year_id: CONFIG.academicYearId,
            is_year_mark: isYearMark,
            year_mark: isYearMark,
            attested: true,
            eliminated: false,
            is_good_reason: false,
            module_id: null,
            attestation_period_id: isAttestation ? null : (attestationPeriodId || null),
            academic_debt: false,
            no_mark: false,
            period_id: null,
            value: isAttestation ? 1 : String(value),
            mark_type: opts.mark_type || null,
            grade_system_type: isAttestation ? 'approve' : 'five',
        };
    }

    async function submitSingleFinalMark(payload, endpoint) {
        const ep = endpoint || CONFIG.finalMarksEndpoint;
        const url = ep.startsWith('http') ? ep : CONFIG.apiBase + ep;
        try {
            const headers = {
                'Authorization': authState.token ? `Bearer ${authState.token}` : '',
                'Profile-Id': String(authState.profileId || ''),
                'Accept': '*/*',
                'Content-Type': 'application/json',
                ...CONFIG.finalMarksHeaders,
            };
            const resp = await fetch(url, {
                method: 'POST',
                credentials: 'include',
                headers,
                body: JSON.stringify(payload),
            });
            if (resp.status === 400) {
                const body = await resp.text().catch(() => '{}');
                let msg = 'ошибка запроса';
                try { const j = JSON.parse(body); msg = j.message || j.error || msg; } catch (e) {}
                // 400 часто означает «уже существует», считаем успехом
                const isExists = msg.toLowerCase().includes('существует') || msg.toLowerCase().includes('already');
                return { success: true, alreadyExists: true, message: msg };
            }
            if (resp.status === 401) {
                return { success: false, error: '401 — сессия истекла, обновите страницу' };
            }
            if (!resp.ok) {
                const body = await resp.text().catch(() => '');
                return { success: false, error: `HTTP ${resp.status}: ${body.slice(0, 200)}` };
            }
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    async function probeFinalMarksApi(studentId, subjectId, value, attestationPeriodId) {
        const payload = buildFinalMarkPayload(studentId, subjectId, value, attestationPeriodId);
        const primary = CONFIG.finalMarksEndpoint;
        const primaryResult = await submitSingleFinalMark(payload, primary);
        if (primaryResult.success) {
            return { endpoint: primary, payload, success: true };
        }
        return { endpoint: primary, payload, success: false, lastError: primaryResult.error };
    }

    function injectStyles() {
        if (document.getElementById('mss_fm_styles')) return;
        const css = `
            #mss-fm-root {
                all: initial;
                font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                font-size: 14px;
                color: #2c3e50;
            }
            #mss-fm-floating-btn {
                position: fixed;
                bottom: 90px;
                right: 24px;
                z-index: 999999;
                width: 56px;
                height: 56px;
                border-radius: 50%;
                background: linear-gradient(135deg, #e67e22 0%, #d35400 100%);
                color: white;
                box-shadow: 0 4px 18px rgba(230, 126, 34, 0.4);
                border: none;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
            }
            #mss-fm-floating-btn:hover {
                transform: scale(1.08) translateY(-2px);
                box-shadow: 0 6px 24px rgba(230, 126, 34, 0.5);
            }
            #mss-fm-floating-btn svg {
                width: 24px;
                height: 24px;
                fill: white;
            }
            #mss-fm-modal {
                position: fixed;
                bottom: 156px;
                right: 24px;
                z-index: 999998;
                width: 520px;
                height: 600px;
                background: rgba(255, 255, 255, 0.92);
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
            #mss-fm-modal.visible {
                transform: scale(1);
                opacity: 1;
            }
            #mss-fm-header {
                padding: 14px 20px;
                background: linear-gradient(135deg, rgba(230, 126, 22, 0.1) 0%, rgba(211, 84, 0, 0.05) 100%);
                border-bottom: 1px solid rgba(0,0,0,0.06);
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            #mss-fm-header h3 {
                margin: 0;
                font-weight: 700;
                font-size: 15px;
                color: #d35400;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            #mss-fm-close-btn {
                background: none;
                border: none;
                font-size: 18px;
                color: #7f8c8d;
                cursor: pointer;
                padding: 4px;
                border-radius: 50%;
                width: 28px;
                height: 28px;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            #mss-fm-close-btn:hover {
                background: rgba(0,0,0,0.05);
                color: #2c3e50;
            }
            #mss-fm-tabs {
                display: flex;
                background: rgba(0,0,0,0.02);
                border-bottom: 1px solid rgba(0,0,0,0.06);
                padding: 0 10px;
            }
            .mss-fm-tab-btn {
                flex: 1;
                padding: 10px 8px;
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
            .mss-fm-tab-btn.active {
                color: #d35400;
                border-bottom-color: #d35400;
            }
            .mss-fm-tab-btn:hover:not(.active) {
                color: #2c3e50;
                background: rgba(0,0,0,0.015);
            }
            #mss-fm-content {
                flex: 1;
                overflow-y: auto;
                padding: 16px;
                display: flex;
                flex-direction: column;
                gap: 12px;
            }
            .mss-fm-section-title {
                font-size: 11px;
                text-transform: uppercase;
                letter-spacing: 0.8px;
                color: #7f8c8d;
                font-weight: 700;
                margin-bottom: 4px;
            }
            .mss-fm-form-group {
                display: flex;
                flex-direction: column;
                gap: 6px;
            }
            .mss-fm-select, .mss-fm-input {
                padding: 10px 12px;
                border-radius: 10px;
                border: 1px solid rgba(0,0,0,0.12);
                background: white;
                font-size: 13.5px;
                outline: none;
                transition: all 0.2s;
            }
            .mss-fm-select:focus, .mss-fm-input:focus {
                border-color: #d35400;
                box-shadow: 0 0 0 3px rgba(211, 84, 0, 0.15);
            }
            .mss-fm-radio-group {
                display: grid;
                grid-template-columns: repeat(5, 1fr);
                gap: 6px;
            }
            .mss-fm-radio-btn {
                position: relative;
            }
            .mss-fm-radio-btn input {
                position: absolute;
                opacity: 0;
                width: 0;
                height: 0;
            }
            .mss-fm-radio-label {
                display: block;
                padding: 8px 4px;
                text-align: center;
                border: 1px solid rgba(0,0,0,0.1);
                border-radius: 8px;
                cursor: pointer;
                font-size: 11px;
                font-weight: 500;
                background: white;
                transition: all 0.2s;
            }
            .mss-fm-radio-btn input:checked + .mss-fm-radio-label {
                background: #d35400;
                color: white;
                border-color: #d35400;
                box-shadow: 0 2px 8px rgba(211, 84, 0, 0.25);
            }
            .mss-fm-radio-btn:hover:not(:checked) .mss-fm-radio-label {
                background: rgba(0,0,0,0.02);
            }
            .mss-fm-btn-primary {
                background: linear-gradient(135deg, #e67e22 0%, #d35400 100%);
                color: white;
                border: none;
                padding: 12px;
                border-radius: 10px;
                font-weight: 600;
                font-size: 14px;
                cursor: pointer;
                transition: all 0.2s;
                box-shadow: 0 4px 12px rgba(211, 84, 0, 0.2);
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 8px;
            }
            .mss-fm-btn-primary:hover {
                transform: translateY(-1px);
                box-shadow: 0 6px 16px rgba(211, 84, 0, 0.3);
            }
            .mss-fm-btn-primary:disabled {
                opacity: 0.6;
                cursor: not-allowed;
                transform: none;
            }
            .mss-fm-btn-secondary {
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
            .mss-fm-btn-secondary:hover {
                background: rgba(0,0,0,0.02);
            }
            .mss-fm-preview-container {
                overflow-x: auto;
                border: 1px solid rgba(0,0,0,0.08);
                border-radius: 10px;
                background: white;
                max-height: 340px;
            }
            .mss-fm-table {
                width: 100%;
                border-collapse: collapse;
                font-size: 11.5px;
                text-align: left;
            }
            .mss-fm-table th {
                background: rgba(0,0,0,0.03);
                padding: 7px 8px;
                font-weight: 600;
                border-bottom: 1px solid rgba(0,0,0,0.08);
                white-space: nowrap;
            }
            .mss-fm-table td {
                padding: 7px 8px;
                border-bottom: 1px solid rgba(0,0,0,0.04);
            }
            .mss-fm-badge {
                font-weight: bold;
                padding: 2px 6px;
                border-radius: 4px;
                font-size: 11px;
            }
            .mss-fm-badge-5 { background: rgba(76, 175, 80, 0.15); color: #2e7d32; }
            .mss-fm-badge-4 { background: rgba(33, 150, 243, 0.15); color: #1565c0; }
            .mss-fm-badge-3 { background: rgba(255, 152, 0, 0.15); color: #ef6c00; }
            .mss-fm-badge-2 { background: rgba(244, 67, 54, 0.15); color: #c62828; }
            .mss-fm-warning {
                color: #d35400;
                font-weight: 600;
                font-size: 11px;
            }
            .mss-fm-success {
                color: #2e7d32;
                font-weight: 600;
                font-size: 11px;
            }
            .mss-fm-existent {
                color: #7f8c8d;
                font-style: italic;
                font-size: 11px;
            }
            #mss-fm-logs {
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
                gap: 3px;
            }
            .mss-fm-log-entry { line-height: 1.4; }
            .mss-fm-log-info { color: #d4d4d4; }
            .mss-fm-log-success { color: #4caf50; }
            .mss-fm-log-warning { color: #ffeb3b; }
            .mss-fm-log-error { color: #f44336; }
            #mss-fm-progress-bar-container {
                background: rgba(0,0,0,0.06);
                height: 8px;
                border-radius: 4px;
                overflow: hidden;
            }
            #mss-fm-progress-bar {
                background: linear-gradient(90deg, #e67e22 0%, #f39c12 100%);
                height: 100%;
                width: 0%;
                transition: width 0.2s;
            }
            .mss-fm-summary-card {
                background: white;
                border: 1px solid rgba(0,0,0,0.08);
                border-radius: 10px;
                padding: 12px;
            }
            .mss-fm-info-badge {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                padding: 3px 8px;
                border-radius: 6px;
                font-size: 11px;
                font-weight: 600;
            }
            .mss-fm-info-badge.orange { background: rgba(230, 126, 34, 0.12); color: #d35400; }
            .mss-fm-info-badge.green { background: rgba(76, 175, 80, 0.12); color: #2e7d32; }
            .mss-fm-info-badge.red { background: rgba(244, 67, 54, 0.12); color: #c62828; }
            .mss-fm-info-badge.blue { background: rgba(33, 150, 243, 0.12); color: #1565c0; }
        `;
        GM_addStyle(css);
    }

    function hideModal() {
        const el = document.getElementById('mss-fm-modal');
        if (el) el.classList.remove('visible');
    }

    function switchTab(tab) {
        state.activeTab = tab;
        document.querySelectorAll('.mss-fm-tab-btn').forEach(b => {
            b.classList.toggle('active', b.getAttribute('data-tab') === tab);
        });
        renderContent();
    }

    function ensureUI() {
        if (!document.body) return;
        injectStyles();
        let root = document.getElementById('mss-fm-root');
        if (!root) {
            root = document.createElement('div');
            root.id = 'mss-fm-root';
            root.innerHTML = `
                <button id="mss-fm-floating-btn" title="Триместровые отметки">
                    <svg viewBox="0 0 24 24">
                        <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 14l-5-5 1.41-1.41L12 14.17l4.59-4.58L18 11l-6 6z"/>
                    </svg>
                </button>
                <div id="mss-fm-modal">
                    <div id="mss-fm-header">
                        <h3>📊 Итоговые отметки</h3>
                        <button id="mss-fm-close-btn">✕</button>
                    </div>
                    <div id="mss-fm-tabs">
                        <button class="mss-fm-tab-btn active" data-tab="main">Запуск</button>
                        <button class="mss-fm-tab-btn" data-tab="preview">Превью</button>
                        <button class="mss-fm-tab-btn" data-tab="logs">Консоль</button>
                    </div>
                    <div id="mss-fm-content"></div>
                </div>
            `;
            document.body.appendChild(root);
            console.log('[Итоговые отметки] Кнопка добавлена на страницу');

            document.getElementById('mss-fm-floating-btn').addEventListener('click', () => {
                document.getElementById('mss-fm-modal').classList.toggle('visible');
            });
            document.getElementById('mss-fm-close-btn').addEventListener('click', hideModal);

            document.querySelectorAll('.mss-fm-tab-btn').forEach(btn => {
                btn.addEventListener('click', () => switchTab(btn.getAttribute('data-tab')));
            });

            switchTab('main');
            loadGroups();
        }
    }

    function addLog(text, type = 'info') {
        const now = new Date();
        const timeStr = now.toTimeString().split(' ')[0];
        state.logs.push({ time: timeStr, text, type });
        console.log(`[Итоговые отметки] [${type}] ${text}`);
        if (state.activeTab === 'logs') {
            const container = document.getElementById('mss-fm-logs');
            if (container) {
                const entry = document.createElement('div');
                entry.className = `mss-fm-log-entry mss-fm-log-${type}`;
                entry.textContent = `[${timeStr}] ${text}`;
                container.appendChild(entry);
                container.scrollTop = container.scrollHeight;
            }
        }
    }

    function renderContent() {
        const content = document.getElementById('mss-fm-content');
        if (!content) return;

        if (state.activeTab === 'main') {
            const selectedGroup = state.groups.find(g => String(g.id) === String(state.selectedGroupId));
            const hw = selectedGroup ? computeHoursPerWeek(state.scheduleItems, selectedGroup.id) : '—';
            const minMarks = selectedGroup ? getMinRequiredMarks(hw) : '—';

            content.innerHTML = `
                <div class="mss-fm-form-group">
                    <div class="mss-fm-section-title">1. Выберите класс (группу)</div>
                    <select id="mss-fm-group-select" class="mss-fm-select">
                        <option value="">Загрузка групп...</option>
                    </select>
                    ${selectedGroup ? `
                        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px;">
                            <span class="mss-fm-info-badge orange">📚 ${selectedGroup.subject_name}</span>
                            <span class="mss-fm-info-badge blue">⏱ ${hw} ч/нед</span>
                            <span class="mss-fm-info-badge green">📝 мин. ${minMarks} оценок</span>
                        </div>
                    ` : ''}
                </div>
                <div class="mss-fm-form-group">
                    <div class="mss-fm-section-title">2. Выберите период</div>
                    <div class="mss-fm-radio-group">
                        ${['1', '2', '3', 'year'].map(t => `
                            <div class="mss-fm-radio-btn">
                                <input type="radio" id="fm-per-${t}" name="fm-period" value="${t}"
                                    ${state.trimester === t ? 'checked' : ''}>
                                <label class="mss-fm-radio-label" for="fm-per-${t}">${TRIMESTER_DATES[t].label}</label>
                            </div>
                        `).join('')}
                    </div>
                </div>
                <div class="mss-fm-form-group" style="background:rgba(230,126,22,0.06);border-radius:10px;padding:8px 10px;">
                    <div style="font-size:11px;color:#d35400;font-weight:600;margin-bottom:4px;">
                        🔧 Этапы выставления (все сразу)
                    </div>
                    <div style="font-size:11px;color:#666;line-height:1.4;">
                        Нажми «Выставить всем» — скрипт сделает всё по порядку:<br>
                        1️⃣ Триместровая — по среднему баллу<br>
                        2️⃣ Промежуточная аттестация — «зачёт»<br>
                        3️⃣ Годовая — по триместрам<br>
                        4️⃣ Итоговая — по триместрам<br>
                        <span style="color:#d35400;font-weight:600;">🔇 Итоговая не выставляется классам, где она не предусмотрена (7-е)</span>
                    </div>
                </div>
                    <div style="font-size:11px;color:#666;line-height:1.4;">
                        • Триместровая — по среднему баллу за выбранный триместр<br>
                        • Годовая — по триместрам (среднее триместровых отметок)<br>
                        • Итоговая — по триместрам (только для 8+ классов)
                    </div>
                </div>
                <div style="font-size:10px;color:#95a5a6;">
                    API: <code style="font-size:10px;">${CONFIG.finalMarksEndpoint}</code>
                </div>
                <div style="display:flex;gap:8px;margin-top:8px;">
                    <button id="mss-fm-analyze-btn" class="mss-fm-btn-primary" style="flex:1;">
                        📊 Анализировать выбранный класс
                    </button>
                </div>
                <div style="display:flex;gap:8px;">
                    <button id="mss-fm-all-groups-btn" class="mss-fm-btn-primary" style="flex:1;padding:10px;font-size:13px;
                        background:linear-gradient(135deg,#27ae60 0%,#1e8449 100%);box-shadow:0 4px 12px rgba(39,174,96,0.2);">
                        🌐 Выставить всем группам
                    </button>
                </div>
            `;

            document.querySelectorAll('input[name="fm-period"]').forEach(r => {
                r.addEventListener('change', e => { state.trimester = e.target.value; });
            });

            const sel = document.getElementById('mss-fm-group-select');
            sel.innerHTML = state.groups.length === 0
                ? '<option value="">Нет групп</option>'
                : state.groups.map(g => {
                    const hw = computeHoursPerWeek(state.scheduleItems, g.id);
                    const selected = String(g.id) === String(state.selectedGroupId) ? 'selected' : '';
                    return `<option value="${g.id}" ${selected}>${g.group_name} (${g.subject_name}, ${hw}ч/н)</option>`;
                }).join('');

            sel.addEventListener('change', e => {
                state.selectedGroupId = e.target.value;
                renderContent();
            });

            document.getElementById('mss-fm-analyze-btn').addEventListener('click', analyzeGroup);
            document.getElementById('mss-fm-all-groups-btn').addEventListener('click', submitAllGroups);

        } else if (state.activeTab === 'preview') {
            if (state.students.length === 0) {
                content.innerHTML = `
                    <div style="text-align:center;color:#7f8c8d;padding-top:50px;">
                        <div style="font-size:48px;margin-bottom:10px;">📋</div>
                        <div>Класс не проанализирован.<br>Перейдите во вкладку <b>Запуск</b>.</div>
                    </div>
                `;
                return;
            }

            const selectedGroup = state.groups.find(g => String(g.id) === String(state.selectedGroupId));
            const hw = selectedGroup ? computeHoursPerWeek(state.scheduleItems, selectedGroup.id) : '—';
            const minMarks = selectedGroup ? getMinRequiredMarks(hw) : 3;
            const deficient = state.students.filter(s => s.markCount < minMarks);
            const ready = state.students.filter(s => s.markCount >= minMarks);

            let rowsHtml = '';
            state.students.forEach((s, idx) => {
                const grade = s.grade;
                const badgeClass = grade === 5 ? 'mss-fm-badge-5' : grade === 4 ? 'mss-fm-badge-4' : grade === 3 ? 'mss-fm-badge-3' : 'mss-fm-badge-2';
                const gradeLabel = grade ? getGradeLabel(grade) : '—';
                const gradeMarker = s.gradeSource === 'trimester' ? '📊 ' : '';
                const hasEnough = s.markCount >= minMarks;
                const statusBadge = s.status === 'ok'
                    ? '<span class="mss-fm-success">✅</span>'
                    : s.status === 'error'
                        ? '<span class="mss-fm-log-error">❌</span>'
                        : s.finalMark !== null
                            ? '<span class="mss-fm-existent">🔒 есть</span>'
                            : hasEnough ? '' : '<span class="mss-fm-warning">⚠️</span>';

                rowsHtml += `
                    <tr>
                        <td><input type="checkbox" class="mss-fm-student-check" data-idx="${idx}"
                            ${s.selected ? 'checked' : ''}></td>
                        <td style="font-weight:500;">${s.name}</td>
                        <td>${s.avg !== null ? s.avg.toFixed(2) : '—'}</td>
                        <td>${s.markCount}</td>
                        <td><span class="mss-fm-badge ${badgeClass}">${gradeMarker}${gradeLabel}</span></td>
                        <td>${statusBadge}</td>
                    </tr>
                `;
            });

            const groupInfo = selectedGroup
                ? `<span class="mss-fm-info-badge orange">${selectedGroup.group_name}</span>
                   <span class="mss-fm-info-badge blue">${hw} ч/нед, мин ${minMarks} оценок</span>
                   <span class="mss-fm-info-badge green">готово: ${ready.length}</span>
                   ${deficient.length > 0 ? `<span class="mss-fm-info-badge red">не хватает: ${deficient.length}</span>` : ''}`
                : '';

            content.innerHTML = `
                <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
                    ${groupInfo}
                </div>
                ${deficient.length > 0 ? `
                    <div style="background:rgba(230,126,34,0.08);border:1px solid rgba(230,126,34,0.2);border-radius:8px;padding:10px;">
                        <div style="font-weight:600;color:#d35400;font-size:12px;margin-bottom:4px;">
                            ⚠️ Ученикам не хватает оценок для выставления отметки
                        </div>
                        <div style="font-size:11px;color:#666;">
                            ${deficient.map(d =>
                                `<div>• ${d.name} — ${d.markCount} оценок (нужно ${minMarks})</div>`
                            ).join('')}
                        </div>
                    </div>
                ` : ''}
                <div style="font-size:12px;font-weight:600;display:flex;justify-content:space-between;align-items:center;">
                    <div>Ученики (${state.students.length})</div>
                    <div style="display:flex;gap:8px;">
                        <span style="cursor:pointer;color:#d35400;" id="mss-fm-sel-all">Выбрать всех</span> ·
                        <span style="cursor:pointer;color:#d35400;" id="mss-fm-sel-ready">Готовых</span> ·
                        <span style="cursor:pointer;color:#d35400;" id="mss-fm-sel-none">Никого</span>
                    </div>
                </div>
                <div class="mss-fm-preview-container">
                    <table class="mss-fm-table">
                        <thead>
                            <tr>
                                <th style="width:24px;"></th>
                                <th>Ученик</th>
                                <th>Ср. балл</th>
                                <th>Оценок</th>
                                <th>Отметка</th>
                                <th style="width:30px;">Ст.</th>
                            </tr>
                        </thead>
                        <tbody>${rowsHtml}</tbody>
                    </table>
                </div>
                <div style="display:flex;gap:8px;margin-top:4px;">
                    <button id="mss-fm-submit-btn" class="mss-fm-btn-primary" style="flex:1;"
                        ${state.submitting ? 'disabled' : ''}>
                        ${state.submitting ? '⏳ Отправка...' : '🚀 Выставить всем'}
                    </button>
                    <button id="mss-fm-test-btn" class="mss-fm-btn-secondary" style="flex:0 0 auto;padding:12px 14px;font-size:12px;"
                        ${state.submitting ? 'disabled' : ''}>
                        🔬 Тест (1 ученик)
                    </button>
                    <button id="mss-fm-delete-btn" class="mss-fm-btn-secondary" style="flex:0 0 auto;padding:12px 14px;font-size:12px;color:#c62828;border-color:rgba(198,40,40,0.3);"
                        ${state.submitting ? 'disabled' : ''}>
                        🗑️ Удалить выбранным
                    </button>
                </div>
                <div style="font-size:10px;color:#95a5a6;text-align:center;margin-top:2px;">
                    Endpoint: <code style="font-size:10px;">${CONFIG.finalMarksEndpoint}</code>
                </div>
            `;

            document.getElementById('mss-fm-sel-all').addEventListener('click', () => {
                state.students.forEach(s => s.selected = true);
                switchTab('preview');
            });
            document.getElementById('mss-fm-sel-ready').addEventListener('click', () => {
                state.students.forEach(s => s.selected = s.markCount >= minMarks);
                switchTab('preview');
            });
            document.getElementById('mss-fm-sel-none').addEventListener('click', () => {
                state.students.forEach(s => s.selected = false);
                switchTab('preview');
            });
            document.getElementById('mss-fm-submit-btn').addEventListener('click', submitAllMarks);
            document.getElementById('mss-fm-test-btn').addEventListener('click', testSubmitSingle);
            document.getElementById('mss-fm-delete-btn').addEventListener('click', deleteSelectedMarks);

            content.querySelectorAll('.mss-fm-student-check').forEach(ch => {
                ch.addEventListener('change', e => {
                    const idx = parseInt(e.target.getAttribute('data-idx'));
                    state.students[idx].selected = e.target.checked;
                });
            });

        } else if (state.activeTab === 'logs') {
            const total = state.students.filter(s => s.selected).length;
            const done = state.students.filter(s => s.status === 'ok' || s.status === 'error').length;
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;

            content.innerHTML = `
                <div style="font-size:12px;font-weight:600;display:flex;justify-content:space-between;">
                    <div>Консоль</div>
                    <div id="mss-fm-clear-logs" style="cursor:pointer;color:#7f8c8d;font-size:11px;">Очистить</div>
                </div>
                <div id="mss-fm-logs">
                    ${state.logs.map(l => `<div class="mss-fm-log-entry mss-fm-log-${l.type}">[${l.time}] ${l.text}</div>`).join('')}
                </div>
                ${state.students.length > 0 ? `
                    <div style="display:flex;flex-direction:column;gap:4px;margin-top:5px;">
                        <div style="display:flex;justify-content:space-between;font-size:11px;font-weight:600;">
                            <div>Прогресс: ${done}/${total}</div>
                            <div>${pct}%</div>
                        </div>
                        <div id="mss-fm-progress-bar-container">
                            <div id="mss-fm-progress-bar" style="width:${pct}%;"></div>
                        </div>
                    </div>
                ` : ''}
            `;

            const logsEl = document.getElementById('mss-fm-logs');
            if (logsEl) logsEl.scrollTop = logsEl.scrollHeight;

            document.getElementById('mss-fm-clear-logs').addEventListener('click', () => {
                state.logs = [];
                switchTab('logs');
            });
        }
    }

    async function loadGroups() {
        try {
            if (!authState.token && !authState.profileId) {
                addLog('Ожидание авторизации...', 'warning');
            }
            state.groups = await fetchMyGroups();
            addLog(`Загружено групп: ${state.groups.length}`, 'success');
            renderContent();
        } catch (e) {
            addLog(`Ошибка загрузки групп: ${e.message}`, 'error');
        }
    }

    async function analyzeGroup() {
        const gid = state.selectedGroupId;
        if (!gid) { alert('Выберите группу!'); return; }

        const group = state.groups.find(g => String(g.id) === String(gid));
        if (!group) { alert('Группа не найдена'); return; }

        const hw = computeHoursPerWeek(state.scheduleItems, gid);
        const minRequired = getMinRequiredMarks(hw);
        const dates = TRIMESTER_DATES[state.trimester];

        state.students = [];
        switchTab('logs');
        addLog(`=== АНАЛИЗ: ${group.group_name} (${group.subject_name}) ===`);
        addLog(`Часов в неделю: ${hw}, минимально оценок: ${minRequired}`);
        addLog(`Период: ${dates.label} (${dates.start} — ${dates.end})`);

        addLog(`Endpoint: ${CONFIG.finalMarksEndpoint}`);

        try {
            addLog('Загружаю учеников...');
            const rawStudents = await loadStudents(gid);
            const profiles = Array.isArray(rawStudents) ? rawStudents : (rawStudents.items || []);
            const validStudents = profiles.filter(s => s.person_id);
            addLog(`Учеников: ${validStudents.length}`);

            addLog('Загружаю оценки за период...');
            const marksData = await loadMarks(gid, dates.start, dates.end, group.subject_id);

            const studentIds = validStudents.map(s => String(s.id));

            // Debug: show detailed breakdown for first student
            let debugSid = null;
            let debugName = null;
            if (validStudents.length > 0) {
                debugSid = validStudents[0].id;
                debugName = getStudentName(validStudents[0]);
            }

            const avgMap = computeAverages(marksData, studentIds, debugSid, debugName);
            const avgCount = Object.keys(avgMap).filter(k => avgMap[k] !== null).length;
            addLog(`Средний балл рассчитан для ${avgCount} учеников`);
            addLog(`ℹ️ В консоли (F12) — разбор отметок для ${debugName}`);

            const existingMarksMap = getExistingFinalMarks(profiles, group.subject_id, CONFIG.academicYearId);
            const trimesterMarksMap = getExistingTrimesterMarks(profiles, group.subject_id);

            // Log first student's fields for debugging
            if (validStudents.length > 0) {
                const firstKeys = Object.keys(validStudents[0]).filter(k => !k.startsWith('_'));
                console.log('[Итоговые отметки] Поля первого ученика:', firstKeys);
            }

            const isYearPeriod = state.trimester === 'year';
            const correctionMap = buildCorrectionMap(marksData);
            const studentsList = [];

            for (const s of validStudents) {
                const name = getStudentName(s);
                const avg = avgMap[s.id];
                const markCount = countStudentMarks(marksData, s.id, correctionMap);

                // For annual period: calculate grade from trimester marks if available
                let grade = null;
                let gradeSource = 'marks';
                if (isYearPeriod) {
                    const tMarks = trimesterMarksMap[s.id] || [];
                    if (tMarks.length >= 2) {
                        const triAvg = tMarks.reduce((a, b) => a + b, 0) / tMarks.length;
                        grade = getGradeFromAverage(triAvg);
                        gradeSource = 'trimester';
                    }
                }
                if (grade === null) {
                    grade = getGradeFromAverage(avg);
                }

                const existingFinal = existingMarksMap[s.id] || null;

                studentsList.push({
                    id: s.id,
                    person_id: s.person_id,
                    name,
                    avg,
                    markCount,
                    grade,
                    gradeSource,
                    hasFinalMark: existingFinal !== null,
                    finalMark: existingFinal,
                    selected: markCount >= minRequired,
                    status: null,
                    subject_id: group.subject_id,
                });
            }

            if (isYearPeriod) {
                const fromTri = studentsList.filter(s => s.gradeSource === 'trimester').length;
                const fromMarks = studentsList.filter(s => s.gradeSource === 'marks').length;
                addLog(`Годовая: для ${fromTri} учеников по триместрам, для ${fromMarks} — по среднему баллу`, 'info');
            }

            state.students = studentsList.sort((a, b) => a.name.localeCompare(b.name));
            addLog('Анализ завершён', 'success');

            const deficient = state.students.filter(s => s.markCount < minRequired);
            if (deficient.length > 0) {
                addLog(`⚠️ У ${deficient.length} учеников недостаточно оценок:`, 'warning');
                deficient.forEach(d => addLog(`   ${d.name} — ${d.markCount} оценок (нужно ${minRequired})`, 'warning'));
            }

            const ready = state.students.filter(s => s.markCount >= minRequired);
            addLog(`Готовы к выставлению: ${ready.length} учеников`, 'success');

            switchTab('preview');
        } catch (e) {
            addLog(`Ошибка: ${e.message}`, 'error');
        }
    }

    function buildGradePayload(studentId, subjectId, grade, attestationPeriodId, opts = {}) {
        return buildFinalMarkPayload(studentId, subjectId, grade, attestationPeriodId, opts);
    }

    async function deleteFinalMarkById(markId) {
        const url = `${CONFIG.apiBase}/api/ej/core/teacher/v1/final_marks/${markId}`;
        try {
            const headers = {
                'Authorization': authState.token ? `Bearer ${authState.token}` : '',
                'Profile-Id': String(authState.profileId || ''),
                'Accept': '*/*',
                'x-mes-hostid': '9',
                'aid': '13',
                'x-mes-subsystem': 'journalw',
                'X-Mes-RoleId': '9',
            };
            const resp = await fetch(url, { method: 'DELETE', credentials: 'include', headers });
            if (resp.status === 404) return { success: true, notFound: true };
            if (!resp.ok) return { success: false, error: `HTTP ${resp.status}` };
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    function getFinalMarkIdsToDelete(profiles, studentId, subjectId, periodIds, markTypes) {
        const ids = [];
        const profile = profiles.find(p => String(p.id) === String(studentId));
        if (!profile || !profile.final_marks) return ids;

        for (const fm of profile.final_marks) {
            if (String(fm.subject_id) !== String(subjectId)) continue;

            // Skip trimester marks (не годовая, не аттестация, не итоговая)
            if (isTrimesterMark(fm)) continue;

            // Check if this final mark matches any of our target criteria
            for (const pid of periodIds) {
                if (String(fm.attestation_period_id) === String(pid)) {
                    if (fm.id) ids.push({ id: fm.id, desc: `period=${pid}` });
                }
            }
            if ((fm.is_year_mark || fm.year_mark) && fm.mark_type === null) {
                if (fm.id) ids.push({ id: fm.id, desc: 'годовая' });
            }
            if (fm.mark_type === 'intermediate_attestation') {
                if (fm.id) ids.push({ id: fm.id, desc: 'промежуточная' });
            }
            if (fm.mark_type === 'attestation') {
                if (fm.id) ids.push({ id: fm.id, desc: 'итоговая' });
            }
        }
        return ids;
    }

    async function sendGrade(student, group, opts = {}) {
        const attestationPeriodId = opts.attestation_period_id || CONFIG.attestationPeriodIds[state.trimester] || null;
        const payload = buildGradePayload(
            student.id,
            student.subject_id || group.subject_id,
            student.grade,
            attestationPeriodId,
            { is_year_mark: !!opts.is_year_mark, mark_type: opts.mark_type || null }
        );
        return submitSingleFinalMark(payload);
    }

    async function clearFinalMark(studentId, subjectId, attestationPeriodId, opts = {}) {
        const payload = buildClearPayload(studentId, subjectId, attestationPeriodId, opts);
        return submitSingleFinalMark(payload);
    }

    const SUBMISSION_STEPS = [
        { name: 'Триместровая', key: 'trimester', is_year_mark: false, mark_type: null },
        { name: 'Промежуточная аттестация', key: 'attestation', is_year_mark: false, mark_type: 'intermediate_attestation' },
        { name: 'Годовая', key: 'annual', is_year_mark: true, mark_type: null },
        { name: 'Итоговая', key: 'final', is_year_mark: false, mark_type: 'attestation' },
    ];

    async function submitStudentGrade(student, group, step, gradeOverride) {
        const attestationPeriodId = step.key === 'trimester'
            ? (CONFIG.attestationPeriodIds[state.trimester] || null)
            : null;
        const gradeVal = gradeOverride != null ? gradeOverride : student.grade;
        return sendGrade({ ...student, grade: gradeVal }, group, {
            is_year_mark: step.is_year_mark,
            mark_type: step.mark_type,
            attestation_period_id: attestationPeriodId,
        });
    }

    async function submitAllMarks() {
        const toSubmit = state.students.filter(s => s.selected && s.grade !== null);
        if (toSubmit.length === 0) {
            alert('Нет учеников для выставления отметок!');
            return;
        }

        const group = state.groups.find(g => String(g.id) === String(state.selectedGroupId));
        if (!group) { alert('Группа не выбрана'); return; }

        const dates = TRIMESTER_DATES[state.trimester];
        if (!confirm(`Выставить все отметки ${toSubmit.length} ученикам группы "${group.group_name}"?\n\n`
            + `Период: ${dates.label}\n`
            + `Будут выполнены 4 этапа: триместр → промежуточная → годовая → итоговая`)) return;

        state.submitting = true;
        switchTab('logs');
        addLog(`=== ВЫСТАВЛЕНИЕ ВСЕХ ОТМЕТОК ===`);
        addLog(`Группа: ${group.group_name}, учеников: ${toSubmit.length}`);

        // Load trimester marks for annual/final calculations
        let trimesterMarksMap = {};
        let loadProfilesData = [];
        try {
            const rawProfiles = await loadStudents(group.id);
            loadProfilesData = Array.isArray(rawProfiles) ? rawProfiles : (rawProfiles.items || []);
            trimesterMarksMap = getExistingTrimesterMarks(loadProfilesData, group.subject_id);
        } catch (e) {
            addLog(`⚠️ Не удалось загрузить триместровые отметки: ${e.message}`, 'warning');
        }
        logTrimesterDebug(loadProfilesData, group.subject_id);

        let totalSuccess = 0;
        let totalErrors = 0;

        for (let si = 0; si < SUBMISSION_STEPS.length; si++) {
            const step = SUBMISSION_STEPS[si];

            if (step.key === 'final' && !groupHasFinalGrade(group)) {
                addLog(`  ⏭️ ${step.name} — не предусмотрена для ${group.group_name}`, 'info');
                continue;
            }

            addLog(`\n--- Этап ${si + 1}: ${step.name} ---`);

            let stepOk = 0;
            let stepErr = 0;

            for (let i = 0; i < state.students.length; i++) {
                const s = state.students[i];
                if (!s.selected || s.grade === null) continue;

                // For annual/final: use trimester-based grade
                let gradeToUse = s.grade;
                if (step.key === 'annual' || step.key === 'final') {
                    const tMarks = trimesterMarksMap[s.id] || [];
                    console.log(`[Итоговые отметки] ${s.name} триместровые отметки:`, tMarks);
                    if (tMarks.length >= 2) {
                        const triAvg = tMarks.reduce((a, b) => a + b, 0) / tMarks.length;
                        const triGrade = getGradeFromAverage(triAvg);
                        if (triGrade !== null) gradeToUse = triGrade;
                        addLog(`📊 ${s.name}: триместры [${tMarks.join(', ')}] = ${triAvg.toFixed(2)} → ${gradeToUse}`, 'info');
                    } else {
                        addLog(`⚠️ ${s.name}: недостаточно триместров (${tMarks.length}), использую сырой балл ${s.avg?.toFixed(2)} → ${gradeToUse}`, 'warning');
                    }
                }

                try {
                    const result = await submitStudentGrade(s, group, step, gradeToUse);
                    if (result.success) {
                        stepOk++;
                        if (result.alreadyExists) {
                            addLog(`  🔒 ${s.name} — уже есть`, 'info');
                        } else {
                            addLog(`  ✅ ${s.name} — ${gradeToUse}`, 'success');
                        }
                    } else {
                        stepErr++;
                        addLog(`  ❌ ${s.name}: ${result.error}`, 'error');
                    }
                } catch (e) {
                    stepErr++;
                    addLog(`  ❌ ${s.name}: ${e.message}`, 'error');
                }

                updateProgress(i + 1, state.students.length);
                await new Promise(r => setTimeout(r, 200));
            }

            totalSuccess += stepOk;
            totalErrors += stepErr;
            addLog(`  → ${step.name}: ✅ ${stepOk}, ❌ ${stepErr}`, stepErr > 0 ? 'warning' : 'success');
        }

        state.submitting = false;
        addLog(`\n=== ВСЕ ЭТАПЫ ЗАВЕРШЕНЫ ===`, 'success');
        addLog(`✅ Успешно: ${totalSuccess}, ❌ Ошибок: ${totalErrors}`, 'info');

        if (totalErrors > 0) {
            addLog(`💡 Ошибки 400 = уже существует (нормально)`, 'info');
        }

        alert(`Готово!\n\n✅ Успешно: ${totalSuccess}\n❌ Ошибок: ${totalErrors}`);
        switchTab('preview');
    }

    async function deleteSelectedMarks() {
        const toDelete = state.students.filter(s => s.selected);
        if (toDelete.length === 0) { alert('Нет выбранных учеников'); return; }

        const group = state.groups.find(g => String(g.id) === String(state.selectedGroupId));
        if (!group) { alert('Группа не выбрана'); return; }

        if (!confirm(`Удалить отметки у ${toDelete.length} учеников группы "${group.group_name}"?\n\n`
            + `Будут найдены и удалены:\n`
            + `• триместровые (все периоды)\n`
            + `• промежуточная аттестация\n`
            + `• годовая\n`
            + `• итоговая`)) return;

        state.submitting = true;
        switchTab('logs');
        addLog(`=== УДАЛЕНИЕ ОТМЕТОК ===`);
        addLog(`Группа: ${group.group_name}`);

        // Загружаем свежие профили учеников с final_marks
        let profiles = [];
        try {
            const raw = await loadStudents(group.id);
            profiles = Array.isArray(raw) ? raw : (raw.items || []);
        } catch (e) {
            addLog(`❌ Ошибка загрузки профилей: ${e.message}`, 'error');
            state.submitting = false;
            return;
        }

        const periodsToClean = [CONFIG.attestationPeriodIds[state.trimester]]
            .concat(CONFIG.legacyPeriodIds || [])
            .filter(Boolean);

        let ok = 0;
        let err = 0;

        for (const s of toDelete) {
            const subjId = s.subject_id || group.subject_id;
            const marksToDelete = getFinalMarkIdsToDelete(profiles, s.id, subjId, periodsToClean);

            if (marksToDelete.length === 0) {
                addLog(`  ⏭️ ${s.name} — нет итоговых отметок для удаления`, 'info');
                continue;
            }

            for (const fm of marksToDelete) {
                const result = await deleteFinalMarkById(fm.id);
                if (result.success) {
                    ok++;
                    addLog(`  🗑️ ${s.name} — ${fm.desc} (id=${fm.id}) удалено`, 'success');
                } else if (!result.notFound) {
                    err++;
                    addLog(`  ❌ ${s.name} — ${fm.desc}: ${result.error}`, 'error');
                }
                await new Promise(r => setTimeout(r, 100));
            }
        }

        state.submitting = false;
        addLog(`\n=== ГОТОВО ===`, 'success');
        addLog(`✅ Удалено: ${ok}, ❌ Ошибок: ${err}`, err > 0 ? 'warning' : 'success');
        alert(`Удаление завершено!\n✅ Удалено: ${ok}\n❌ Ошибок: ${err}`);
        switchTab('preview');
    }

    async function testSubmitSingle() {
        const group = state.groups.find(g => String(g.id) === String(state.selectedGroupId));
        if (!group || state.students.length === 0) {
            alert('Сначала выполните анализ класса');
            return;
        }
        const firstReady = state.students.find(s => s.grade !== null);
        if (!firstReady) { alert('Нет учеников с рассчитанной отметкой'); return; }

        addLog(`🔬 Тестовая отправка для: ${firstReady.name}`, 'info');
        addLog(`Endpoint: ${CONFIG.finalMarksEndpoint}`, 'info');
        const attestPeriodId = CONFIG.attestationPeriodIds[state.trimester] || null;
        const payload = buildFinalMarkPayload(
            firstReady.id,
            firstReady.subject_id || group.subject_id,
            firstReady.grade,
            attestPeriodId,
            { is_year_mark: state.trimester === 'year' }
        );
        addLog(`Payload: ${JSON.stringify(payload, null, 2)}`, 'info');

        const result = await sendGrade(firstReady, group);
        if (result.success) {
            if (result.alreadyExists) {
                addLog(`🔒 Отметка уже была выставлена ранее (ответ: ${result.message})`, 'info');
            } else {
                addLog(`✅ Тест пройден! Отметка выставлена.`, 'success');
            }
            firstReady.status = 'ok';
        } else {
            addLog(`❌ Ошибка: ${result.error}`, 'error');
        }
        switchTab('logs');
    }

    async function submitAllGroups() {
        const groups = state.groups;

        if (groups.length === 0) {
            alert('Нет групп для выставления.');
            return;
        }

        if (!confirm(`Выставить отметки ученикам в ${groups.length} группах?\n\n`
            + `Период: ${TRIMESTER_DATES[state.trimester].label}\n`
            + `4 этапа: триместр → промежуточная → годовая → итоговая\n`
            + `📌 Итоговая выставляется только классам, где она предусмотрена`)) return;

        state.submitting = true;
        switchTab('logs');
        addLog(`=== ВЫСТАВЛЕНИЕ ВСЕМ ГРУППАМ ===`);
        addLog(`Период: ${TRIMESTER_DATES[state.trimester].label}`);
        addLog(`Всего групп: ${groups.length}`);

        const dates = TRIMESTER_DATES[state.trimester];

        let totalSuccess = 0;
        let totalErrors = 0;
        let totalGroupsOk = 0;

        for (let gi = 0; gi < groups.length; gi++) {
            const group = groups[gi];
            const hw = computeHoursPerWeek(state.scheduleItems, group.id);
            const minRequired = getMinRequiredMarks(hw);

            addLog(`\n[${gi + 1}/${state.groups.length}] ${group.group_name} (${group.subject_name}, ${hw}ч/н)`);

            try {
                const rawStudents = await loadStudents(group.id);
                const profiles = Array.isArray(rawStudents) ? rawStudents : (rawStudents.items || []);
                const validStudents = profiles.filter(s => s.person_id);

                if (validStudents.length === 0) {
                    addLog(`  ⏭️ Нет учеников`, 'warning');
                    continue;
                }

                const marksData = await loadMarks(group.id, dates.start, dates.end, group.subject_id);
                const studentIds = validStudents.map(s => String(s.id));
                const avgMap = computeAverages(marksData, studentIds);
                const correctionMap = buildCorrectionMap(marksData);

                // Pre-calculate grades for each student
                const trimesterMarksMap = getExistingTrimesterMarks(profiles, group.subject_id);
                logTrimesterDebug(profiles, group.subject_id);
                const studentGrades = [];
                for (const s of validStudents) {
                    const avg = avgMap[s.id];
                    const grade = getGradeFromAverage(avg);

                    // Annual/final grade from trimester marks
                    const tMarks = trimesterMarksMap[s.id] || [];
                    let trimesterGrade = null;
                    if (tMarks.length >= 2) {
                        const triAvg = tMarks.reduce((a, b) => a + b, 0) / tMarks.length;
                        trimesterGrade = getGradeFromAverage(triAvg);
                    }
                    if (trimesterGrade === null) trimesterGrade = grade;

                    const actualMarkCount = countStudentMarks(marksData, s.id, correctionMap);
                    studentGrades.push({
                        id: s.id,
                        grade,
                        trimesterGrade,
                        markCount: actualMarkCount,
                        subject_id: group.subject_id,
                        name: getStudentName(s),
                    });
                }

                const readyStudents = studentGrades.filter(s => s.grade !== null && s.markCount >= minRequired);
                if (readyStudents.length === 0) {
                    addLog(`  ⏭️ Нет учеников, готовых к выставлению`, 'warning');
                    totalGroupsOk++;
                    continue;
                }

                let groupOk = 0;
                let groupErr = 0;

                for (const step of SUBMISSION_STEPS) {
                    if (step.key === 'final' && !groupHasFinalGrade(group)) {
                        addLog(`  --- ${step.name} (не предусмотрена) ---`);
                        continue;
                    }
                    addLog(`  --- ${step.name} ---`);

                    for (const s of readyStudents) {
                        try {
                            const gradeToUse = (step.key === 'annual' || step.key === 'final')
                                ? s.trimesterGrade : s.grade;
                            const attestationPeriodId = step.key === 'trimester'
                                ? (CONFIG.attestationPeriodIds[state.trimester] || null) : null;
                            const result = await sendGrade(
                                { id: s.id, grade: gradeToUse, subject_id: s.subject_id },
                                group,
                                { is_year_mark: step.is_year_mark, mark_type: step.mark_type, attestation_period_id: attestationPeriodId }
                            );
                            if (result.success) groupOk++;
                            else groupErr++;
                        } catch (e) {
                            groupErr++;
                        }
                        await new Promise(r => setTimeout(r, 100));
                    }
                }

                totalSuccess += groupOk;
                totalErrors += groupErr;
                totalGroupsOk++;
                addLog(`  ✅ Группа: ${groupOk} отметок, ${groupErr} ошибок`, groupErr > 0 ? 'warning' : 'success');

            } catch (e) {
                addLog(`  ❌ Ошибка группы: ${e.message}`, 'error');
            }

            updateProgressAll(gi + 1, state.groups.length);
        }

        state.submitting = false;
        const totalOps = totalSuccess + totalErrors;
        addLog(`\n=== ВСЕ ГРУППЫ ОБРАБОТАНЫ ===`, 'success');
        addLog(`✅ Групп: ${totalGroupsOk}`);
        addLog(`✅ Отметок выставлено: ${totalSuccess}`);
        addLog(`❌ Ошибок: ${totalErrors}`, totalErrors > 0 ? 'warning' : 'info');

        alert(`Готово!\nГрупп: ${totalGroupsOk}\n✅ Отметок: ${totalSuccess}\n❌ Ошибок: ${totalErrors}`);
        switchTab('logs');
    }

    function updateProgressAll(current, total) {
        const bar = document.getElementById('mss-fm-progress-bar');
        if (bar) bar.style.width = `${Math.round((current / total) * 100)}%`;
    }

    function updateProgress(current, total) {
        const bar = document.getElementById('mss-fm-progress-bar');
        if (bar) bar.style.width = `${Math.round((current / total) * 100)}%`;
    }

    function startUIObserver() {
        ensureUI();
        if (typeof MutationObserver !== 'undefined') {
            const observer = new MutationObserver(() => {
                if (!document.getElementById('mss-fm-root') && document.body) {
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
        setInterval(() => {
            if (!document.getElementById('mss-fm-root') && document.body) {
                ensureUI();
            }
        }, 2000);
    }

    function init() {
        console.log('[Итоговые отметки] init() вызван, body:', !!document.body);
        startUIObserver();
    }

    console.log('[Итоговые отметки] Скрипт загружен, readyState:', document.readyState);

    // Всегда запускаем, даже если DOMContentLoaded уже прошёл
    if (document.readyState !== 'loading') {
        init();
    } else {
        document.addEventListener('DOMContentLoaded', init);
    }
})();
