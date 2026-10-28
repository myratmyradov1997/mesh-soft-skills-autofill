// МЭШ — автозаполнение Soft Skills v3.0
// Работает как расширение Chrome/Яндекс.Браузера/Edge и как скрипт Tampermonkey.
// Учитель, учебный год, период и группы определяются автоматически; уроки-замены не учитываются.
(function () {
    'use strict';
    if (window.__meshSoftSkills) return;
    window.__meshSoftSkills = true;

    const BASE = 'https://school.mos.ru';
    // Пороги среднего балла для «Почти всегда», «Часто»; ниже — «Редко»
    const THRESHOLDS = {
        'Самоорганизация': [4.6, 3.7],
        'Самообразование': [4.8, 4.0],
        'Саморегуляция': [4.6, 3.7],
        'Коммуникация': [4.6, 3.7],
    };
    const DEFAULT_THRESHOLDS = [4.6, 3.7];
    // Выступления и интерес вне программы — ниже, ДЗ и вежливость — выше
    const QUESTION_OFFSETS = { 1: 0.25, 2: 0.15, 3: -0.35, 4: -0.20, 5: 0.05, 6: 0.10, 7: 0.20, 11: 0.30, 13: 0.25, 14: -0.30 };
    // Слабых учеников (в т.ч. только с двойками) оцениваем как троечников: «Почти никогда» не ставится
    const MIN_AVG = 3.3;
    const ALWAYS = 4, OFTEN = 3, RARELY = 2, UNSURE = 5;
    const ANSWER_LABEL = { 4: 'Почти всегда', 3: 'Часто', 2: 'Редко', 1: 'Почти никогда', 5: 'Затрудняюсь' };
    const ANSWER_SHORT = { 4: 'В', 3: 'Ч', 2: 'Р', 1: 'Н', 5: '?' };

    // === Логика ответов (та же, что в mesh_soft_skills_autofill.py) ===
    function noise(personId, qid) {
        let h = 0x811c9dc5;
        for (const b of new TextEncoder().encode(`${personId}:${qid}`)) {
            h = Math.imul(h ^ b, 0x01000193) >>> 0;
        }
        return (h % 500 - 250) / 1000;
    }

    function answerFor(avg, qid, category, personId) {
        if (avg == null) return UNSURE;
        const [always, often] = THRESHOLDS[category] || DEFAULT_THRESHOLDS;
        const adj = Math.max(avg, MIN_AVG) + (QUESTION_OFFSETS[qid] || 0) + noise(personId, qid);
        if (adj >= always) return ALWAYS;
        if (adj >= often) return OFTEN;
        return RARELY;
    }

    // === Доступ к API МЭШ ===
    const auth = { token: null, profileId: null };

    function readCookie(name) {
        const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
        return m ? decodeURIComponent(m[1]) : null;
    }

    function findToken() {
        const fromCookie = readCookie('aupd_token');
        if (fromCookie) return fromCookie;
        for (const store of [localStorage, sessionStorage]) {
            try {
                for (let i = 0; i < store.length; i++) {
                    const m = String(store.getItem(store.key(i)) || '').match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/);
                    if (m) return m[0];
                }
            } catch (e) { /* хранилище недоступно */ }
        }
        return null;
    }

    async function api(method, path, { query, body } = {}) {
        const url = new URL(BASE + path);
        for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
        const headers = {
            'Accept': 'application/json',
            'X-Mes-Subsystem': 'teacherweb',
            'Authorization': `Bearer ${auth.token}`,
        };
        if (auth.profileId) headers['Profile-Id'] = String(auth.profileId);
        if (body) headers['Content-Type'] = 'application/json';
        for (let attempt = 0; ; attempt++) {
            let resp;
            try {
                resp = await fetch(url, { method, headers, credentials: 'include', body: body ? JSON.stringify(body) : undefined });
            } catch (e) {
                if (attempt < 3) { await sleep(2000 * (attempt + 1)); continue; }
                throw new Error('Нет связи с МЭШ');
            }
            if ([502, 503, 504].includes(resp.status) && attempt < 3) { await sleep(2000 * (attempt + 1)); continue; }
            if (resp.status === 401) throw new Error('Сессия МЭШ истекла — обновите страницу и войдите заново');
            if (!resp.ok) {
                let msg = `HTTP ${resp.status}`;
                try { const j = await resp.json(); msg = j.message || j.description || msg; } catch (e) { /* не JSON */ }
                throw new Error(msg);
            }
            const text = await resp.text();
            return text ? JSON.parse(text) : null;
        }
    }

    const get = (path, query) => api('GET', path, { query });
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    async function pool(items, limit, fn) {
        let next = 0;
        const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (next < items.length) {
                const i = next++;
                await fn(items[i], i);
            }
        });
        await Promise.all(workers);
    }

    function parseDate(v) {
        if (Array.isArray(v)) return new Date(v[0], v[1] - 1, v[2]);
        if (v.includes('.')) { const [d, m, y] = v.split(/[.\s]/); return new Date(+y, +m - 1, +d); }
        const [y, m, d] = v.slice(0, 10).split('-'); return new Date(+y, +m - 1, +d);
    }
    const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const ru = d => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;

    // === Сбор данных ===
    async function analyze(progress) {
        auth.token = findToken();
        if (!auth.token) throw new Error('Не найден токен МЭШ — войдите в МЭШ как учитель и обновите страницу');

        progress('Определяю учителя…');
        const sess = await api('POST', '/api/ej/acl/v1/sessions', { body: { auth_token: auth.token } });
        const prof = (sess.profiles || []).find(p => p.type === 'teacher');
        if (!prof) throw new Error('У этого аккаунта нет профиля учителя');
        auth.profileId = prof.id;
        const teacherName = [sess.last_name, sess.first_name, sess.middle_name].filter(Boolean).join(' ');

        const years = await get('/api/ej/core/teacher/v1/academic_years');
        const year = years.find(y => y.current_year);

        progress('Ищу ваши классы в расписании…');
        const today = new Date();
        const horizon = new Date(today.getTime() + 60 * 864e5);
        const to = parseDate(year.end_date) < horizon ? parseDate(year.end_date) : horizon;
        const groupMap = new Map();
        for (let page = 1; ; page++) {
            const items = await get('/api/ej/plan/teacher/v1/schedule_items', {
                academic_year_id: year.id, teacher_id: prof.id, from: year.begin_date.slice(0, 10), to: iso(to),
                with_group_class_subject_info: 'true', page, per_page: 300,
            });
            for (const it of items) {
                if (it.replaced || it.replaced_teacher_id || !it.group_id) continue;
                if (!groupMap.has(it.group_id)) {
                    groupMap.set(it.group_id, { id: it.group_id, name: (it.group_name || '').trim(), subject: it.subject_name || '' });
                }
            }
            if (items.length < 300) break;
        }
        const groups = [...groupMap.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
        if (!groups.length) throw new Error('В расписании нет ваших уроков в этом учебном году');

        progress(`Загружаю учеников (${groups.length} групп)…`);
        const students = new Map();
        const byProfile = new Map();
        await pool(groups, 4, async g => {
            const profiles = await get('/api/ej/core/teacher/v1/student_profiles', {
                academic_year_id: year.id, group_ids: g.id, per_page: 300, page: 1,
            });
            g.count = 0;
            for (const s of profiles) {
                if (!s.person_id) continue;
                g.count++;
                if (!students.has(s.person_id)) {
                    students.set(s.person_id, {
                        personId: s.person_id,
                        name: (s.user_name || s.short_name || `ID ${s.id}`).trim(),
                        cls: (s.class_unit || {}).name || '',
                        parallel: (s.class_unit || {}).class_level_id,
                        groups: [], marks: [],
                    });
                }
                const st = students.get(s.person_id);
                st.groups.push(g.name);
                byProfile.set(s.id, st);
            }
        });

        progress(`Проверяю период и заполненные анкеты (${students.size} учеников)…`);
        const periods = new Map();
        let done = 0;
        await pool([...students.values()], 6, async st => {
            const cur = await get('/api/soft_skills/v1/periods/checkCurrentPeriodTeacher', { student_person_id: st.personId });
            st.periodId = cur.period_id;
            st.filled = !!cur.answers_exists;
            if (st.periodId && !periods.has(st.periodId)) {
                periods.set(st.periodId, null);
                const lst = await get('/api/soft_skills/v1/periods', { student_person_id: st.personId });
                for (const p of lst.periods || []) periods.set(p.period_id, p);
            }
            if (++done % 25 === 0) progress(`Проверяю период и заполненные анкеты: ${done}/${students.size}…`);
        });
        for (const st of students.values()) st.period = periods.get(st.periodId) || null;

        progress('Загружаю оценки…');
        await pool(groups, 4, async g => {
            const marks = await get('/api/ej/core/teacher/v1/marks', {
                group_ids: g.id, created_at_from: ru(parseDate(year.begin_date)), created_at_to: ru(today),
                with_non_numeric_entries: 'false', per_page: 5000, page: 1,
            });
            for (const mk of marks) {
                const st = byProfile.get(mk.student_profile_id);
                if (!st || !st.period) continue;
                const five = mk.values && mk.values[0] && mk.values[0].grade && mk.values[0].grade.five;
                const day = parseDate(mk.date || mk.created_at);
                if (five && day >= parseDate(st.period.begin_date) && day <= parseDate(st.period.end_date)) {
                    st.marks.push([Number(five), mk.weight || 1]);
                }
            }
        });
        for (const st of students.values()) {
            const w = st.marks.reduce((a, m) => a + m[1], 0);
            st.avg = w ? st.marks.reduce((a, m) => a + m[0] * m[1], 0) / w : null;
        }

        progress('Рассчитываю ответы…');
        const questions = new Map();
        for (const st of students.values()) {
            if (!questions.has(st.parallel)) {
                const qa = await get('/api/soft_skills/v1/survey/questionsAnswers', st.parallel ? { parallel: st.parallel } : {});
                questions.set(st.parallel, qa.question_groups.flatMap(gr => gr.questions.map(q => [q.question_id, gr.question_group_name])));
            }
            st.answers = questions.get(st.parallel).map(([qid, cat]) => [qid, answerFor(st.avg, qid, cat, st.personId)]);
        }

        const periodNames = [...new Set([...students.values()].map(s => s.period && s.period.period_name).filter(Boolean))];
        return { teacherName, year, groups, students: [...students.values()], periodNames };
    }

    async function submit(st) {
        await api('POST', '/api/soft_skills/v1/survey', {
            body: {
                student_person_id: st.personId,
                period_id: st.periodId,
                answers: st.answers.map(([qid, a]) => ({ question_id: qid, answer_id: a })),
            },
        });
    }

    // === Интерфейс ===
    const CSS = `
        :host { all: initial; }
        * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
        .fab { position: fixed; left: 20px; bottom: 20px; z-index: 2147483646; height: 48px; padding: 0 18px;
               border: 0; border-radius: 24px; background: #1d4ed8; color: #fff; font-size: 15px; font-weight: 600;
               box-shadow: 0 4px 14px rgba(0,0,0,.25); cursor: pointer; }
        .fab:hover { background: #1e40af; }
        .panel { position: fixed; left: 20px; bottom: 80px; z-index: 2147483647; width: min(560px, calc(100vw - 40px));
                 max-height: calc(100vh - 110px); display: flex; flex-direction: column; background: #fff; color: #111827;
                 border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,.3); font-size: 14px; overflow: hidden; }
        .head { padding: 14px 16px; background: #1d4ed8; color: #fff; display: flex; align-items: start; gap: 8px; }
        .head h2 { margin: 0; font-size: 16px; }
        .head .sub { font-size: 12px; opacity: .85; margin-top: 3px; }
        .head button { margin-left: auto; background: none; border: 0; color: #fff; font-size: 20px; cursor: pointer; line-height: 1; }
        .body { padding: 12px 16px; overflow: auto; flex: 1; }
        .foot { padding: 12px 16px; border-top: 1px solid #e5e7eb; display: flex; flex-direction: column; gap: 8px; }
        .status { color: #374151; padding: 20px 0; text-align: center; }
        .error { color: #b91c1c; background: #fef2f2; padding: 10px 12px; border-radius: 8px; }
        .ok { color: #166534; background: #f0fdf4; padding: 10px 12px; border-radius: 8px; }
        details { border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 6px; }
        summary { padding: 8px 10px; cursor: pointer; display: flex; align-items: center; gap: 8px; list-style: none; }
        summary::-webkit-details-marker { display: none; }
        summary .cnt { margin-left: auto; color: #6b7280; font-size: 12px; white-space: nowrap; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        td { padding: 3px 10px; border-top: 1px solid #f3f4f6; }
        td.avg { width: 40px; color: #6b7280; }
        td.ans { font-family: ui-monospace, Menlo, monospace; letter-spacing: 1px; width: 110px; }
        .muted { color: #6b7280; font-size: 12px; }
        .row { display: flex; align-items: center; gap: 8px; }
        .go { height: 40px; border: 0; border-radius: 8px; background: #16a34a; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; }
        .go:disabled { background: #9ca3af; cursor: default; }
        .bar { height: 6px; background: #e5e7eb; border-radius: 3px; overflow: hidden; }
        .bar div { height: 100%; background: #16a34a; width: 0; transition: width .2s; }
        .tag { font-size: 11px; color: #92400e; background: #fef3c7; border-radius: 4px; padding: 0 4px; }
    `;

    let root, panel, data = null, busy = false;

    function el(tag, attrs = {}, ...children) {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
            else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
        }
        for (const c of children.flat(Infinity)) if (c != null) e.append(c);
        return e;
    }

    function mount() {
        if (root || !document.body) return;
        const host = el('div', { id: 'mesh-soft-skills' });
        document.body.append(host);
        root = host.attachShadow({ mode: 'open' });
        root.append(el('style', {}, CSS), el('button', { class: 'fab', onclick: toggle, title: 'Soft Skills: выставить всем ученикам' }, '★ Soft Skills'));
    }

    function toggle() {
        if (panel) { if (!busy) { panel.remove(); panel = null; } return; }
        panel = el('div', { class: 'panel' });
        root.append(panel);
        if (data) renderReady(); else load();
    }

    function frame(sub, body, foot) {
        panel.replaceChildren(
            el('div', { class: 'head' },
                el('div', {}, el('h2', {}, 'Soft Skills — автозаполнение'), el('div', { class: 'sub' }, sub)),
                el('button', { title: 'Закрыть', onclick: toggle }, '×')),
            el('div', { class: 'body' }, body),
            ...(foot ? [el('div', { class: 'foot' }, foot)] : []));
    }

    async function load() {
        const status = el('div', { class: 'status' }, 'Загрузка…');
        frame('Подготовка', status);
        busy = true;
        try {
            data = await analyze(t => { status.textContent = t; });
            busy = false;
            renderReady();
        } catch (e) {
            busy = false;
            frame('Ошибка', [el('div', { class: 'error' }, e.message)],
                el('button', { class: 'go', onclick: () => { data = null; load(); } }, 'Повторить'));
        }
    }

    function renderReady() {
        const { teacherName, year, groups, students, periodNames } = data;
        const byClass = new Map();
        for (const st of students) {
            if (!byClass.has(st.cls)) byClass.set(st.cls, []);
            byClass.get(st.cls).push(st);
        }
        const classes = [...byClass.keys()].sort((a, b) => a.length - b.length || a.localeCompare(b, 'ru'));
        const selected = new Set(classes);
        const overwrite = el('input', { type: 'checkbox' });
        const goBtn = el('button', { class: 'go' });

        const todo = () => students.filter(s => selected.has(s.cls) && s.periodId && (overwrite.checked || !s.filled));
        const refresh = () => {
            const n = todo().length;
            goBtn.textContent = n ? `Выставить soft skills (${n} уч.)` : 'Всё уже заполнено';
            goBtn.disabled = !n;
        };
        overwrite.addEventListener('change', refresh);

        const list = classes.map(cls => {
            const lst = byClass.get(cls).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
            const filled = lst.filter(s => s.filled).length;
            const cb = el('input', { type: 'checkbox', checked: true, onclick: e => e.stopPropagation(),
                onchange: e => { e.target.checked ? selected.add(cls) : selected.delete(cls); refresh(); } });
            const grpNames = [...new Set(lst.flatMap(s => s.groups))].join(', ');
            return el('details', {},
                el('summary', {}, cb, el('b', {}, cls || 'Без класса'),
                    el('span', { class: 'cnt' }, `${lst.length} уч.` + (filled ? ` · заполнено ${filled}` : ''))),
                el('div', { class: 'muted', style: 'padding:0 10px 6px' }, grpNames),
                el('table', {}, lst.map(st => el('tr', {},
                    el('td', { class: 'avg' }, st.avg == null ? '—' : st.avg.toFixed(2)),
                    el('td', { class: 'ans', title: st.answers.map(([, a]) => ANSWER_LABEL[a]).join(', ') },
                        st.answers.map(([, a]) => ANSWER_SHORT[a]).join('')),
                    el('td', {}, st.name, st.filled ? [' ', el('span', { class: 'tag' }, 'заполнено')] : null)))));
        });

        frame(`${teacherName} · ${year.name} · период: ${periodNames.join(', ') || '—'}`,
            [el('div', { class: 'muted', style: 'margin-bottom:8px' },
                `Ваши группы: ${groups.length}, учеников: ${students.length}. Анкета одна на ученика по всем вашим предметам. ` +
                'Ответы: В — почти всегда, Ч — часто, Р — редко, ? — нет оценок за период. Слабых учеников оцениваем как троечников.'),
             list],
            [el('label', { class: 'row muted' }, overwrite, 'Перезаписать уже заполненные анкеты'), goBtn]);
        refresh();
        goBtn.addEventListener('click', () => run(todo()));
    }

    async function run(list) {
        if (!list.length || !confirm(`Выставить soft skills ${list.length} ученикам?`)) return;
        busy = true;
        const bar = el('div', {});
        const status = el('div', { class: 'status' }, 'Отправка…');
        const errors = el('div', {});
        frame('Выставление', [el('div', { class: 'bar' }, bar), status, errors]);
        let ok = 0, fail = 0, done = 0;
        await pool(list, 3, async st => {
            try {
                await submit(st);
                st.filled = true; ok++;
            } catch (e) {
                fail++;
                errors.append(el('div', { class: 'error', style: 'margin-top:6px' }, `${st.name}: ${e.message}`));
            }
            done++;
            bar.style.width = `${Math.round(done / list.length * 100)}%`;
            status.textContent = `${done} / ${list.length}`;
        });
        busy = false;
        status.replaceWith(el('div', { class: fail ? 'error' : 'ok', style: 'margin-top:12px' },
            `Готово: выставлено ${ok}` + (fail ? `, ошибок ${fail}` : '')));
        panel.querySelector('.body').after(el('div', { class: 'foot' },
            el('button', { class: 'go', onclick: () => renderReady() }, 'К списку классов')));
    }

    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener(msg => { if (msg === 'toggle') { mount(); toggle(); } });
    }
    if (document.body) mount();
    else document.addEventListener('DOMContentLoaded', mount);
})();
