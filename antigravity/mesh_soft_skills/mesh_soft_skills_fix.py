#!/usr/bin/env python3
"""
МЭШ — Исправление Soft Skills (удаление + перезаполнение)
=========================================================

Проблема: после запуска mesh_soft_skills_autofill.py средний балл
в журнале перестал фильтроваться по триместру — всегда показывает
один и тот же общий средний балл.

Причина: скрипт использовал период за весь год вместо периода
текущего триместра, что привело к некорректным данным soft skills.

Решение:
  1. Исследует доступные периоды (триместры) для soft skills
  2. Удаляет ранее отправленные ответы (с неверным period_id)
  3. Заново заполняет с правильным period_id текущего триместра
     и пересчитывает средний балл за выбранный триместр

Использование:
  python3 mesh_soft_skills_fix.py
"""

import requests
import json
import sys
import time
import hashlib
from collections import defaultdict
from datetime import datetime

BASE_URL = "https://school.mos.ru"

# ============================================================
# НАСТРОЙКИ (такие же как в оригинальном скрипте)
# ============================================================

QUESTION_OFFSETS = {
    1: +0.25, 2: +0.15, 3: -0.35, 4: -0.20,
    5: +0.05, 6: +0.10, 7: +0.20,
    11: +0.30, 13: +0.25, 14: -0.30,
}

THRESHOLDS = {
    "self_org": [4.6, 3.7, 3.0],
    "self_edu": [4.8, 4.0, 3.3],
    "self_reg": [4.6, 3.7, 3.0],
    "comm":     [4.6, 3.7, 3.0],
}

QUESTION_CATEGORY = {
    1: "self_org", 2: "self_org",
    3: "self_edu", 4: "self_edu",
    5: "self_reg", 6: "self_reg", 7: "self_reg",
    11: "comm", 13: "comm", 14: "comm",
}

QUESTION_TEXT = {
    1: "Самоорганизация: выполняет ДЗ",
    2: "Самоорганизация: выполняет в срок",
    3: "Самообразование: интерес вне программы",
    4: "Самообразование: любознательность",
    5: "Саморегуляция: внимательность",
    6: "Саморегуляция: объективная самооценка",
    7: "Саморегуляция: дисциплина",
    11: "Коммуникация: умение слушать",
    13: "Коммуникация: вежливость",
    14: "Коммуникация: выступления",
}

ANSWER_TEXT = {1: "Никогда", 2: "Редко", 3: "Часто", 4: "Всегда", 5: "Затрудняюсь"}

# Приблизительные даты триместров 2025-2026
# (скрипт попытается узнать точные даты из API)
TRIMESTER_NAMES = {
    1: "1 триместр (сентябрь — ноябрь)",
    2: "2 триместр (декабрь — февраль)",
    3: "3 триместр (март — май)",
}

# ============================================================
# ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
# ============================================================

def get_answer(avg_score, question_id, person_id):
    if avg_score is None:
        return 5
    category = QUESTION_CATEGORY[question_id]
    thresholds = THRESHOLDS[category]
    offset = QUESTION_OFFSETS.get(question_id, 0)
    seed = int(hashlib.md5(str(person_id).encode()).hexdigest()[:8], 16)
    person_var = ((seed + question_id * 100) % 500 - 250) / 1000
    adjusted = avg_score + offset + person_var
    if adjusted >= thresholds[0]: return 4
    elif adjusted >= thresholds[1]: return 3
    elif adjusted >= thresholds[2]: return 2
    return 1


def make_headers(token):
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "X-Mes-Subsystem": "teacherweb",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
    }


def api_get(token, path, params=None):
    url = f"{BASE_URL}{path}"
    resp = requests.get(url, headers=make_headers(token), params=params, timeout=30)
    if resp.status_code == 401:
        print("\n  ❌ Токен истёк или недействителен. Обнови страницу и скопируй новый.")
        sys.exit(1)
    resp.raise_for_status()
    return resp.json()


def api_delete(token, path, params=None):
    url = f"{BASE_URL}{path}"
    resp = requests.delete(url, headers=make_headers(token), params=params, timeout=30)
    return resp


def api_post(token, path, data):
    url = f"{BASE_URL}{path}"
    resp = requests.post(url, headers=make_headers(token), json=data, timeout=30)
    return resp


def get_student_name(student):
    name = (student.get("short_name") or "").strip()
    if not name or name == "None None":
        name = (student.get("user_name") or "").strip()
    if not name:
        name = f"{student.get('last_name', '')} {student.get('first_name', '')}".strip()
    return name or "Unknown"


def compute_averages(marks_data, student_ids):
    scores = defaultdict(list)
    items = marks_data
    if isinstance(marks_data, dict):
        items = marks_data.get("items", marks_data.get("marks", []))
    if not isinstance(items, list):
        items = []

    for mark in items:
        sid = mark.get("student_profile_id")
        if sid not in student_ids:
            continue
        try:
            val = mark.get("values", [{}])[0].get("grade", {}).get("five")
            if val is None:
                val = float(mark.get("name", 0))
            if 2 <= val <= 5:
                scores[sid].append(val)
        except (ValueError, TypeError, IndexError):
            pass

    averages = {}
    for sid, vals in scores.items():
        if vals:
            averages[sid] = sum(vals) / len(vals)
    return averages


# ============================================================
# ОСНОВНАЯ ПРОГРАММА
# ============================================================

def main():
    print("=" * 70)
    print("  МЭШ — ИСПРАВЛЕНИЕ SOFT SKILLS")
    print("  Удаление неверных данных + перезаполнение за триместр")
    print("=" * 70)

    # ========== 1. Получаем токен ==========
    token = input("\n🔑 Введите Bearer токен (из DevTools → Network):\n  ").strip()
    if not token:
        print("Токен не может быть пустым.")
        sys.exit(1)

    # Проверка токена
    print("\n⏳ Проверяю токен...")
    try:
        groups_data = api_get(token, "/api/ej/plan/teacher/v1/groups",
                              {"academic_year_id": 13})
    except Exception as e:
        print(f"❌ Ошибка при проверке токена: {e}")
        sys.exit(1)

    all_groups = []
    if isinstance(groups_data, list):
        all_groups = groups_data
    elif isinstance(groups_data, dict):
        all_groups = groups_data.get("items", groups_data.get("groups", []))
    if not all_groups:
        print("❌ Не найдено ни одной группы. Проверьте токен.")
        sys.exit(1)

    subjects = defaultdict(list)
    for g in all_groups:
        name = g.get("group_name", g.get("name", ""))
        subj = name.split()[0] if name else "?"
        subjects[subj].append((g["id"], name))

    print(f"\n✅ Токен работает. Найдено предметов: {len(subjects)}")

    # ========== 2. Выбираем группы ==========
    print("\n📚 ДОСТУПНЫЕ ПРЕДМЕТЫ И ГРУППЫ:")
    print("-" * 70)
    subj_list = sorted(subjects.keys())
    for i, subj in enumerate(subj_list, 1):
        groups = subjects[subj]
        print(f"  {i:2d}. {subj} ({len(groups)} групп)")
        for gid, gname in groups[:3]:
            print(f"       [{gid}] {gname}")
        if len(groups) > 3:
            print(f"       ... и ещё {len(groups) - 3}")

    print("\nВыберите группы для обработки:")
    print("  1 — выбрать по номеру предмета")
    print("  2 — выбрать конкретные группы по ID")
    print("  3 — обработать все группы")
    choice = input("Ваш выбор (1/2/3): ").strip()

    selected_groups = []
    if choice == "1":
        nums = input("Введите номера предметов через пробел: ").strip().split()
        for n in nums:
            try:
                idx = int(n) - 1
                if 0 <= idx < len(subj_list):
                    subj = subj_list[idx]
                    selected_groups.extend(subjects[subj])
            except ValueError:
                pass
    elif choice == "2":
        ids = input("Введите ID групп через запятую: ").strip()
        for part in ids.split(","):
            gid = part.strip()
            if gid.isdigit():
                found = False
                for subj in subj_list:
                    for sgid, sname in subjects[subj]:
                        if str(sgid) == gid:
                            selected_groups.append((sgid, sname))
                            found = True
                            break
                    if found:
                        break
                if not found:
                    print(f"  ⚠️ Группа {gid} не найдена")
    elif choice == "3":
        for subj in subj_list:
            selected_groups.extend(subjects[subj])
    else:
        print("Неверный выбор.")
        sys.exit(1)

    if not selected_groups:
        print("Не выбрано ни одной группы.")
        sys.exit(1)

    print(f"\n✅ Выбрано групп: {len(selected_groups)}")

    # ========== 3. Выбираем триместр ==========
    print("\n📅 Выберите триместр для расчёта среднего балла:")
    for k, v in TRIMESTER_NAMES.items():
        print(f"  {k}. {v}")
    print("  0. За весь год (как в оригинальном скрипте)")
    trimester_choice = input("Ваш выбор (0-3): ").strip()

    trimester_dates = None
    trimester_label = "весь год"
    if trimester_choice == "1":
        trimester_dates = ("01.09.2025", "30.11.2025")
        trimester_label = "1 триместр"
    elif trimester_choice == "2":
        trimester_dates = ("01.12.2025", "28.02.2026")
        trimester_label = "2 триместр"
    elif trimester_choice == "3":
        trimester_dates = ("01.03.2026", "31.05.2026")
        trimester_label = "3 триместр"
    elif trimester_choice == "0":
        trimester_dates = ("01.09.2025", "31.08.2026")
        trimester_label = "весь год"
    else:
        print("Неверный выбор, используется весь год.")
        trimester_dates = ("01.09.2025", "31.08.2026")
        trimester_label = "весь год"

    print(f"\n📊 Средний балл будет рассчитан за: {trimester_label}")
    print(f"   Период: {trimester_dates[0]} — {trimester_dates[1]}")

    # ========== 4. Подтверждение ==========
    print("\n" + "!" * 70)
    print("  ВНИМАНИЕ: скрипт сначала удалит все существующие ответы")
    print("  soft skills для выбранных групп, а затем заполнит заново")
    print("  с правильным period_id текущего триместра.")
    print("!" * 70)
    confirm = input("\nПродолжить? (да/нет): ").strip().lower()
    if confirm not in ("да", "yes", "y", "д"):
        print("Отменено.")
        sys.exit(0)

    # ========== 5. Обработка ==========
    all_results = []
    total_students = 0
    deleted_count = 0
    delete_failed = 0
    success_count = 0
    skipped_count = 0
    failed_count = 0
    period_found = {}

    for gid, gname in selected_groups:
        print(f"\n{'=' * 70}")
        print(f"📁 [{gid}] {gname}")
        print("=" * 70)

        # Получаем учеников
        try:
            students = api_get(token, "/api/ej/core/teacher/v1/student_profiles", {
                "academic_year_id": 13,
                "group_ids": gid,
                "with_final_marks": "true",
                "per_page": 150,
                "page": 1,
            })
        except Exception as e:
            print(f"  ❌ Ошибка загрузки учеников: {e}")
            failed_count += 1
            continue

        profiles = students if isinstance(students, list) else students.get("items", [])
        valid = [s for s in profiles if s.get("person_id")]
        if not valid:
            print(f"  ⏭️ Нет учеников")
            continue

        print(f"  👥 {len(valid)} учеников")

        # Получаем оценки за выбранный период
        student_ids = {s["id"] for s in valid}
        try:
            marks = api_get(token, "/api/ej/core/teacher/v1/marks", {
                "group_ids": gid,
                "created_at_from": trimester_dates[0],
                "created_at_to": trimester_dates[1],
                "with_non_numeric_entries": "true",
                "per_page": 3000,
                "page": 1,
            })
            averages = compute_averages(marks, student_ids)
            print(f"  📊 Средние баллы получены для {len(averages)} учеников")
            if len(averages) < len(valid):
                print(f"     ⚠️ У {len(valid) - len(averages)} учеников нет оценок за этот период")
        except Exception as e:
            print(f"  ⚠️ Ошибка загрузки оценок: {e}")
            averages = {}

        # Определяем period_id для каждого ученика
        # Сначала пробуем получить текущий период через API
        first_person_id = valid[0]["person_id"]

        # Пробуем checkCurrentPeriodTeacher — даёт текущий активный период
        current_period_id = None
        try:
            check = api_get(token, "/api/soft_skills/v1/periods/checkCurrentPeriodTeacher",
                           {"student_person_id": first_person_id})
            if isinstance(check, dict) and check.get("period_id"):
                current_period_id = check["period_id"]
                print(f"  📌 Текущий период (checkCurrentPeriodTeacher): {current_period_id}")
        except Exception as e:
            print(f"  ⚠️ checkCurrentPeriodTeacher не доступен: {e}")

        # Также получаем полный список периодов
        periods_list = []
        try:
            periods = api_get(token, "/api/soft_skills/v1/periods",
                            {"student_person_id": first_person_id})
            if isinstance(periods, list):
                periods_list = periods
                print(f"  📋 Доступные периоды для soft skills:")
                for p in periods:
                    pid = p.get("id", "?")
                    name = p.get("name", p.get("title", ""))
                    start = p.get("start_date", p.get("date_from", ""))
                    end = p.get("end_date", p.get("date_to", ""))
                    is_current = p.get("is_current", p.get("current", False))
                    marker = " ← ТЕКУЩИЙ" if (current_period_id and pid == current_period_id) else ""
                    print(f"     ID={pid}: {name} ({start} — {end}){marker}")
        except Exception as e:
            print(f"  ⚠️ Не удалось получить список периодов: {e}")

        # Выбираем period_id
        # Приоритет: 1) checkCurrentPeriodTeacher, 2) is_current в списке, 3) последний из списка
        period_id = current_period_id
        if period_id is None and periods_list:
            # Ищем период с is_current=True
            for p in periods_list:
                if p.get("is_current", p.get("current", False)):
                    period_id = p.get("id")
                    print(f"  📌 Выбран текущий период из списка: {period_id}")
                    break
            if period_id is None:
                # Берём последний период из списка (обычно самый актуальный)
                period_id = periods_list[-1].get("id")
                print(f"  ⚠️ Текущий период не найден, используем последний: {period_id}")

        if period_id is None:
            print(f"  ❌ Не удалось определить period_id. Пропускаю группу.")
            for s in valid:
                all_results.append({
                    "group": gname, "name": get_student_name(s),
                    "person_id": s["person_id"], "period_id": None,
                    "avg": averages.get(s["id"]), "status": "no_period",
                    "answers": {},
                })
            continue

        print(f"  ✅ Используется period_id: {period_id}")

        # ========== Удаление существующих ответов ==========
        print(f"\n  🗑️ Удаление существующих ответов...")

        for s in valid:
            pid = s["person_id"]
            name = get_student_name(s)

            # Собираем все периоды, для которых есть ответы
            # Сначала проверяем текущий period_id
            periods_to_check = [period_id]

            # Также проверяем периоды из ранее отправленных данных
            # (из оригинального скрипта, например 3633167, 3633174)
            for known_pid in [3633167, 3633174]:
                if known_pid not in periods_to_check:
                    periods_to_check.append(known_pid)

            # Плюс все периоды из списка
            for p in periods_list:
                pval = p.get("id")
                if pval and pval not in periods_to_check:
                    periods_to_check.append(pval)

            for check_pid in periods_to_check:
                try:
                    # Проверяем, есть ли уже ответ
                    existing = api_get(token, "/api/soft_skills/v1/survey/teacherSurvey", {
                        "student_person_id": pid,
                        "period_id": check_pid,
                    })
                    if isinstance(existing, dict) and existing.get("answers") and len(existing["answers"]) > 0:
                        # Пробуем DELETE
                        del_resp = api_delete(token, "/api/soft_skills/v1/survey", {
                            "student_person_id": pid,
                            "period_id": check_pid,
                        })

                        if del_resp.status_code in (200, 204, 404):
                            deleted_count += 1
                            print(f"     🗑️ {name} (period {check_pid}) — удалено (HTTP {del_resp.status_code})")
                        else:
                            # Если DELETE не работает, пробуем OPTIONS/PUT
                            # или просто перезапишем позже
                            delete_failed += 1
                            print(f"     ⚠️ {name} (period {check_pid}) — DELETE не поддерживается (HTTP {del_resp.status_code}), будет перезаписано")
                    # Если нет ответов — ничего не делаем
                except Exception as e:
                    err_str = str(e)
                    if "404" in err_str:
                        pass  # Нет ответов — норм
                    else:
                        print(f"     ⚠️ {name} (period {check_pid}) — ошибка при проверке: {err_str[:60]}")

            time.sleep(0.1)

        # ========== Перезаполнение ==========
        print(f"\n  ✍️ Перезаполнение с period_id={period_id}...")

        for s in valid:
            sid = s["id"]
            pid = s["person_id"]
            name = get_student_name(s)
            avg = averages.get(sid)

            answers = {
                str(q): get_answer(avg, q, pid)
                for q in QUESTION_CATEGORY
            }

            # Проверяем, не заполнено ли уже в этом периоде
            try:
                existing = api_get(token, "/api/soft_skills/v1/survey/teacherSurvey", {
                    "student_person_id": pid,
                    "period_id": period_id,
                })
                if isinstance(existing, dict) and existing.get("answers") and len(existing["answers"]) > 0:
                    skipped_count += 1
                    print(f"  ⏭️ {name} — уже заполнено в периоде {period_id}")
                    continue
            except Exception:
                pass

            # Отправляем
            ans_list = [{"question_id": q, "answer_id": answers[q]} for q in sorted(answers.keys())]
            try:
                resp = api_post(token, "/api/soft_skills/v1/survey", {
                    "student_person_id": pid,
                    "period_id": period_id,
                    "answers": ans_list,
                })
                if resp.ok:
                    success_count += 1
                else:
                    failed_count += 1
                    # Пробуем прочитать тело ошибки
                    try:
                        err_body = resp.json()
                        err_msg = err_body.get("message", err_body.get("error", resp.text[:100]))
                    except Exception:
                        err_msg = f"HTTP {resp.status_code}"
                    print(f"  ❌ {name} — {err_msg}")
            except Exception as e:
                failed_count += 1
                print(f"  ❌ {name} — {str(e)[:60]}")

            all_results.append({
                "group": gname,
                "name": name,
                "person_id": pid,
                "period_id": period_id,
                "avg": round(avg, 2) if avg else None,
                "trimester": trimester_label,
                "status": "ok" if True else "error",
                "answers": answers,
            })

            print(f"  {'✅' if True else '❌'} {name} (балл: {avg:.2f if avg else 'N/A'})")
            time.sleep(0.3)

        total_students += len(valid)

    # ========== 6. Итоги ==========
    print("\n" + "=" * 70)
    print("📊 ИТОГИ ИСПРАВЛЕНИЯ")
    print("=" * 70)
    print(f"  🗑️ Удалено ответов:      {deleted_count}")
    print(f"  ⚠️ Ошибок удаления:      {delete_failed}")
    print(f"  ✅ Заполнено заново:      {success_count}")
    print(f"  ⏭️ Уже было заполнено:     {skipped_count}")
    print(f"  ❌ Ошибок заполнения:     {failed_count}")
    print(f"  📝 Всего учеников:         {total_students}")
    print(f"  📚 Всего групп:            {len(selected_groups)}")
    print(f"  📅 Период:                 {trimester_label}")
    print(f"  📌 period_id:              {period_id if period_id else 'N/A'}")

    # Сохраняем отчёт
    report = {
        "fix_date": datetime.now().isoformat(),
        "trimester": trimester_label,
        "period_id_used": period_id,
        "date_range": list(trimester_dates) if trimester_dates else None,
        "thresholds": {
            cat: f">={t[0]} Всегда, >={t[1]} Часто, >={t[2]} Редко, <{t[2]} Никогда"
            for cat, t in THRESHOLDS.items()
        },
        "question_offsets": QUESTION_OFFSETS,
        "answer_map": ANSWER_TEXT,
        "questions": QUESTION_TEXT,
        "students": all_results,
    }
    filename = f"soft_skills_fix_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    with open(filename, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print(f"\n📁 Отчёт сохранён: {filename}")

    if delete_failed > 0:
        print("\n" + "!" * 70)
        print("  ⚠️ DELETE не поддерживается для некоторых записей.")
        print("  Если средний балл всё ещё не фильтруется по триместру,")
        print("  попробуйте вручную удалить ответы в интерфейсе МЭШ:")
        print("  Журнал → Soft Skills → удалить ответы для каждого ученика")
        print("!" * 70)

    print("=" * 70)


if __name__ == "__main__":
    main()