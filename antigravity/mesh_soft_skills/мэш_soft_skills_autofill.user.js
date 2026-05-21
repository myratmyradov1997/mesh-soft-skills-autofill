// ==UserScript==
// @name         МЭШ Автозаполнение Soft Skills
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Автоматически заполняет оценку soft skills на основе среднего балла ученика
// @author       You
// @match        https://school.mos.ru/teacher/study-process/journal/grade/*
// @match        https://school.mos.ru/teacher/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = {
        thresholds: {
            self_org: { always: 4.6, often: 3.7, rarely: 3.0 },
            self_edu: { always: 4.8, often: 4.0, rarely: 3.3 },
            self_reg: { always: 4.6, often: 3.7, rarely: 3.0 },
            comm:     { always: 4.6, often: 3.7, rarely: 3.0 },
        },
        apiBase: 'https://school.mos.ru',
    };

    const QUESTION_CATEGORY = {
        1: 'self_org', 2: 'self_org',
        3: 'self_edu', 4: 'self_edu',
        5: 'self_reg', 6: 'self_reg', 7: 'self_reg',
        11: 'comm', 13: 'comm', 14: 'comm',
    };

    const QUESTION_NAMES = {
        1: 'Самоорганизация: выполняет ДЗ',
        2: 'Самоорганизация: выполняет в срок',
        3: 'Самообразование: интерес вне программы',
        4: 'Самообразование: любознательность',
        5: 'Саморегуляция: внимательность',
        6: 'Саморегуляция: самооценка',
        7: 'Саморегуляция: дисциплина',
        11: 'Коммуникация: умение слушать',
        13: 'Коммуникация: вежливость',
        14: 'Коммуникация: выступления',
    };

    function getAnswerByScore(score, category) {
        if (score == null || score === undefined) return 5;
        const t = CONFIG.thresholds[category];
        if (score >= t.always) return 4;
        if (score >= t.often) return 3;
        if (score >= t.rarely) return 2;
        return 1;
    }

    async function apiFetch(path, opts = {}) {
        const url = path.startsWith('http') ? path : CONFIG.apiBase + path;
        const resp = await fetch(url, {
            credentials: 'include',
            headers: {
                'Accept': 'application/json',
                'X-Mes-Subsystem': 'teacherweb',
                'Content-Type': 'application/json',
                ...opts.headers,
            },
            ...opts,
        });
        if (resp.status === 401) throw new Error('Сессия истекла. Обнови страницу и войди заново.');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${path}`);
        return resp.json();
    }

    function getGroupId() {
        const m = window.location.pathname.match(/\/grade\/(\d+)/);
        return m ? m[1] : null;
    }

    async function runAutofill() {
        const groupId = getGroupId();
        if (!groupId) {
            setStatus('ID группы не найден в URL. Открой журнал класса.', true);
            return;
        }

        // === 1. Получаем учеников ===
        setStatus(`Загружаю учеников (группа ${groupId})...`);
        let students;
        try {
            students = await apiFetch(`/api/ej/core/teacher/v1/student_profiles?academic_year_id=13&group_ids=${groupId}&with_groups=true&with_final_marks=true&with_home_based_periods=true&per_page=150&page=1`);
        } catch (e) {
            setStatus(`Ошибка загрузки учеников: ${e.message}`, true);
            return;
        }

        const profiles = students.items || [];
        if (profiles.length === 0) {
            setStatus('Нет учеников в этой группе', true);
            return;
        }

        // Маппинг: profile_id -> person_id + name
        const studentMap = {};
        for (const s of profiles) {
            if (s.person_id) {
                studentMap[s.id] = {
                    person_id: s.person_id,
                    name: [s.last_name, s.first_name, s.middle_name].filter(Boolean).join(' ') || `ID ${s.id}`,
                };
            }
        }
        const studentIds = Object.keys(studentMap);
        setStatus(`Загружено ${studentIds.length} учеников. Получаю оценки...`);

        // === 2. Получаем оценки ===
        let avgMap = {};
        try {
            const idsChunks = [];
            for (let i = 0; i < studentIds.length; i += 50) {
                idsChunks.push(studentIds.slice(i, i + 50));
            }
            for (const chunk of idsChunks) {
                const avgData = await apiFetch(`/api/ej/core/teacher/v1/average_marks_year?group_ids=${groupId}&student_profile_ids=${chunk.join(',')}`);
                if (Array.isArray(avgData)) {
                    for (const item of avgData) {
                        const sid = item.student_profile_id || item.student_id;
                        const val = item.avg_mark || item.average_mark || item.value;
                        if (sid && val != null) {
                            avgMap[sid] = parseFloat(val);
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('average_marks_year не сработал, пробую marks:', e);
        }

        // Fallback: считаем среднее из всех оценок
        if (Object.keys(avgMap).length === 0) {
            try {
                const marksData = await apiFetch(`/api/ej/core/teacher/v1/marks?group_ids=${groupId}&created_at_from=01.09.2025&created_at_to=31.08.2026&with_non_numeric_entries=true&per_page=1000&page=1`);
                const allMarks = marksData.marks || [];
                for (const sid of studentIds) {
                    const sm = allMarks.filter(m => String(m.student_id) === String(sid));
                    const nums = sm.map(m => parseInt(m.value)).filter(v => !isNaN(v) && v >= 2 && v <= 5);
                    if (nums.length > 0) {
                        avgMap[sid] = nums.reduce((a, b) => a + b, 0) / nums.length;
                    }
                }
            } catch (e) {
                console.warn('Не удалось получить оценки:', e);
            }
        }

        // === 3. Получаем period_id ===
        setStatus('Определяю period...');
        const firstPersonId = studentMap[studentIds[0]].person_id;
        let periodId = null;
        try {
            const periods = await apiFetch(`/api/soft_skills/v1/periods?student_person_id=${firstPersonId}`);
            if (Array.isArray(periods) && periods.length > 0) {
                periodId = periods[0].id;
            }
        } catch (e) {
            console.warn('periods не сработал:', e);
        }

        if (!periodId) {
            try {
                const check = await apiFetch(`/api/soft_skills/v1/periods/checkCurrentPeriodTeacher?student_person_id=${firstPersonId}`);
                if (check && check.period_id) periodId = check.period_id;
            } catch (e) {
                setStatus(`Не удалось определить period: ${e.message}`, true);
                return;
            }
        }

        setStatus(`Готово. period_id=${periodId}. Начинаю заполнение...`);

        // === 4. Заполняем для каждого ученика ===
        let success = 0, failed = 0, skipped = 0;

        for (let i = 0; i < studentIds.length; i++) {
            const sid = studentIds[i];
            const info = studentMap[sid];
            const avg = avgMap[sid];
            updateProgress(i + 1, studentIds.length, info.name, avg, success, skipped);

            // Проверка: уже заполнено?
            try {
                const existing = await apiFetch(`/api/soft_skills/v1/survey/teacherSurvey?student_person_id=${info.person_id}&period_id=${periodId}`);
                if (existing && existing.answers && existing.answers.length > 0) {
                    skipped++;
                    continue;
                }
            } catch (e) {
                // Если 404 — значит нет ответов, продолжаем
            }

            const answers = Object.entries(QUESTION_CATEGORY).map(([qId, cat]) => ({
                question_id: qId,
                answer_id: getAnswerByScore(avg, cat),
            }));

            try {
                const resp = await fetch(`${CONFIG.apiBase}/api/soft_skills/v1/survey`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                        'Accept': '*/*',
                        'X-Mes-Subsystem': 'teacherweb',
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        student_person_id: info.person_id,
                        period_id: periodId,
                        answers: answers,
                    }),
                });
                if (resp.ok) success++;
                else failed++;
            } catch (e) {
                console.error('Submit error:', e);
                failed++;
            }

            await new Promise(r => setTimeout(r, 250));
        }

        setStatus(`✅ Готово! Заполнено: ${success}, пропущено: ${skipped}, ошибок: ${failed}`);
        updateProgress(studentIds.length, studentIds.length, '', null, success, skipped);
    }

    // === UI ===
    let progressEl;

    function setStatus(msg, isError = false) {
        const el = document.getElementById('mss-status');
        if (el) {
            el.textContent = msg;
            el.style.color = isError ? '#ffcdd2' : 'rgba(255,255,255,0.9)';
        }
    }

    function updateProgress(current, total, name, avg, success, skipped) {
        const el = document.getElementById('mss-progress');
        if (el) {
            const pct = total > 0 ? Math.round((current / total) * 100) : 0;
            el.innerHTML = `
                <div style="margin:8px 0;">
                    <div style="height:6px;background:rgba(255,255,255,0.2);border-radius:3px;overflow:hidden;">
                        <div style="height:100%;width:${pct}%;background:#4caf50;border-radius:3px;transition:width 0.3s;"></div>
                    </div>
                </div>
                <div style="font-size:12px;">${current}/${total} · ${name ? name + ' · ' : ''}балл: ${avg != null ? avg.toFixed(2) : 'N/A'}</div>
                <div style="font-size:12px;">✅ ${success} · ⏭️ ${skipped}</div>
            `;
        }
    }

    function createUI() {
        const panel = document.createElement('div');
        panel.id = 'mss-panel';
        panel.innerHTML = `
            <div style="position:fixed;bottom:24px;right:24px;z-index:99999;background:#1a73e8;color:white;padding:18px 22px;border-radius:14px;box-shadow:0 6px 24px rgba(0,0,0,0.35);font-family:'Google Sans',Segoe UI,Arial,sans-serif;width:360px;transition:all 0.2s;">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
                    <div style="font-size:16px;font-weight:600;">⚡ Soft Skills</div>
                    <button id="mss-hide" style="background:none;border:none;color:rgba(255,255,255,0.7);cursor:pointer;font-size:18px;line-height:1;">✕</button>
                </div>
                <div id="mss-status" style="font-size:13px;margin-bottom:6px;opacity:0.9;">Нажми кнопку, чтобы начать</div>
                <div id="mss-progress"></div>
                <button id="mss-run-btn" style="background:white;color:#1a73e8;border:none;padding:10px 18px;border-radius:8px;font-weight:600;cursor:pointer;font-size:14px;width:100%;margin-top:8px;">🚀 Заполнить всех учеников</button>
                <div style="margin-top:8px;font-size:11px;opacity:0.6;">Ответы на основе среднего балла. Уже заполненные пропускаются.</div>
            </div>
        `;
        document.body.appendChild(panel);

        document.getElementById('mss-run-btn').addEventListener('click', runAutofill);
        document.getElementById('mss-hide').addEventListener('click', () => {
            document.getElementById('mss-panel').style.display = 'none';
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createUI);
    } else {
        createUI();
    }

})();
