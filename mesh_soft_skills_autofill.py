#!/usr/bin/env python3
"""
МЭШ — Автозаполнение Soft Skills
==================================
Автоматически заполняет оценку «soft skills» для всех учеников
на основе их среднего балла по предмету.

Как использовать:
  1. Открой school.mos.ru в Chrome, войди в аккаунт
  2. Нажми F12 (DevTools) → вкладка Network (Сеть)
  3. Обнови страницу или кликни на любой раздел
  4. Найди любой запрос к school.mos.ru/api/...
  5. Скопируй значение заголовка Authorization: Bearer eyJ...
     (весь длинный текст после "Bearer ")
  6. Запусти скрипт: python3 mesh_soft_skills_autofill.py
  7. Вставь токен — скрипт сам найдёт твои группы

Зависимости: pip install requests
"""

import requests
import json
import sys
import time
import hashlib
import warnings
from collections import defaultdict

warnings.filterwarnings("ignore", message="Unverified HTTPS request")
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

BASE_URL = "https://school.mos.ru"

# ============================================================
# НАСТРОЙКИ (можно менять под своё усмотрение)
# ============================================================

# Смещения для каждого вопроса (вариативность ответов)
# Положительное = более вероятен высокий ответ, отрицательное = ниже
QUESTION_OFFSETS = {
    1: +0.25,   # Самоорганизация: домашние задания
    2: +0.15,   # Самоорганизация: соблюдение сроков
    3: -0.35,   # Самообразование: интерес вне программы
    4: -0.20,   # Самообразование: любознательность
    5: +0.05,   # Саморегуляция: внимательность
    6: +0.10,   # Саморегуляция: объективность самооценки
    7: +0.20,   # Саморегуляция: дисциплина
    11: +0.30,  # Коммуникация: умение слушать
    13: +0.25,  # Коммуникация: вежливость
    14: -0.30,  # Коммуникация: выступления перед аудиторией
}

# Пороги для категорий: [Всегда, Часто, Редко]
# Если средний балл >= threshold[0] → "Всегда"
# Если >= threshold[1] → "Часто"
# Если >= threshold[2] → "Редко"
# Иначе → "Никогда"
# Если оценок нет → "Затрудняюсь ответить"
THRESHOLDS = {
    "self_org": [4.6, 3.7, 3.0],
    "self_edu": [4.8, 4.0, 3.3],
    "self_reg": [4.6, 3.7, 3.0],
    "comm":     [4.6, 3.7, 3.0],
}

# Категории вопросов
QUESTION_CATEGORY = {
    1: "self_org", 2: "self_org",
    3: "self_edu", 4: "self_edu",
    5: "self_reg", 6: "self_reg", 7: "self_reg",
    11: "comm", 13: "comm", 14: "comm",
}

# Тексты вопросов (для отчёта)
QUESTION_TEXT = {
    1: "Самоорганизация: выполняет ДЗ, готов к урокам",
    2: "Самоорганизация: выполняет в срок, распределяет время",
    3: "Самообразование: интересуется вне программы",
    4: "Самообразование: любознательность, сложные задачи",
    5: "Саморегуляция: внимательность, переключение задач",
    6: "Саморегуляция: объективная самооценка",
    7: "Саморегуляция: дисциплина, поведение",
    11: "Коммуникация: умение слушать",
    13: "Коммуникация: вежливость, нормы поведения",
    14: "Коммуникация: выступления перед аудиторией",
}

ANSWER_TEXT = {1: "Никогда", 2: "Редко", 3: "Часто", 4: "Всегда", 5: "Затрудняюсь"}

# ============================================================
# ЛОГИКА ОЦЕНКИ
# ============================================================

def get_answer(avg_score, question_id, person_id):
    """Определяет ответ с вариативностью для каждого вопроса."""
    if avg_score is None:
        return 5

    category = QUESTION_CATEGORY[question_id]
    thresholds = THRESHOLDS[category]
    offset = QUESTION_OFFSETS.get(question_id, 0)

    # Персональная вариация (детерминированая — одинаковая при каждом запуске)
    seed = int(hashlib.md5(str(person_id).encode()).hexdigest()[:8], 16)
    person_var = ((seed + question_id * 100) % 500 - 250) / 1000

    adjusted = avg_score + offset + person_var

    if adjusted >= thresholds[0]:
        return 4
    elif adjusted >= thresholds[1]:
        return 3
    elif adjusted >= thresholds[2]:
        return 2
    return 1


# ============================================================
# ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
# ============================================================

def make_headers(token):
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "X-Mes-Subsystem": "teacherweb",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    }


def api_get(token, path, params=None):
    url = f"{BASE_URL}{path}"
    resp = requests.get(url, headers=make_headers(token), params=params, timeout=30, verify=False)
    if resp.status_code == 401:
        print("\n  ❌ Токен истёк или недействителен. Обнови страницу и скопируй новый.")
        sys.exit(1)
    resp.raise_for_status()
    return resp.json()


def api_post(token, path, data):
    url = f"{BASE_URL}{path}"
    resp = requests.post(url, headers=make_headers(token), json=data, timeout=30, verify=False)
    return resp


def get_student_name(student):
    """Извлекает имя ученика из профиля."""
    name = (student.get("short_name") or "").strip()
    if not name or name == "None None":
        name = (student.get("user_name") or "").strip()
    if not name:
        name = f"{student.get('last_name', '')} {student.get('first_name', '')}".strip()
    return name or "Unknown"


def compute_averages(marks_data, student_ids):
    """Вычисляет средний балл для каждого ученика из списка отметок."""
    scores = defaultdict(list)
    if isinstance(marks_data, list):
        for mark in marks_data:
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


def get_period_id(token, person_id):
    """Получает period_id для ученика."""
    try:
        periods = api_get(token, "/api/soft_skills/v1/periods",
                          {"student_person_id": person_id})
        if isinstance(periods, list) and periods:
            return periods[0].get("id")
    except Exception:
        pass
    try:
        check = api_get(token, "/api/soft_skills/v1/periods/checkCurrentPeriodTeacher",
                        {"student_person_id": person_id})
        if isinstance(check, dict):
            return check.get("period_id")
    except Exception:
        pass
    return None


def check_already_filled(token, person_id, period_id):
    """Проверяет, заполнена ли уже анкета для ученика."""
    try:
        resp = requests.get(
            f"{BASE_URL}/api/soft_skills/v1/survey/teacherSurvey",
            headers=make_headers(token),
            params={"student_person_id": person_id, "period_id": period_id},
            timeout=10,
            verify=False,
        )
        if resp.status_code == 200:
            data = resp.json()
            if isinstance(data, dict) and data.get("answers") and len(data["answers"]) > 0:
                return True
    except Exception:
        pass
    return False


def get_my_groups(token):
    """
    Определяет группы учителя через отметки.
    Возвращает список (group_id, group_name, subject_name).
    """
    # 1. Берём любую группу, чтобы узнать teacher_id и subject_id
    all_groups = api_get(token, "/api/ej/plan/teacher/v1/groups",
                         {"academic_year_id": 13, "page": 1, "per_page": 2000})

    if not isinstance(all_groups, list):
        all_groups = all_groups.get("items", all_groups.get("groups", []))

    if not all_groups:
        print("❌ Не найдено ни одной группы в школе.")
        sys.exit(1)

    # 2. Пробуем найти teacher_id и subject_id через первую группу с оценками
    teacher_id = None
    subject_id = None

    for group in all_groups[:50]:  # проверяем первые 50 групп
        gid = group.get("id")
        try:
            r = requests.get(
                f"{BASE_URL}/api/ej/core/teacher/v1/marks",
                headers=make_headers(token),
                params={
                    "group_ids": gid,
                    "created_at_from": "01.09.2025",
                    "created_at_to": "31.08.2026",
                    "per_page": 1,
                    "page": 1,
                },
                timeout=10,
                verify=False,
            )
            if r.status_code == 200:
                marks = r.json()
                if isinstance(marks, list) and len(marks) > 0:
                    teacher_id = marks[0].get("teacher_id")
                    subject_id = marks[0].get("subject_id")
                    if teacher_id and subject_id:
                        break
        except Exception:
            continue

    if not teacher_id or not subject_id:
        print("❌ Не удалось определить teacher_id/subject_id.")
        print("Убедитесь, что у вас есть оценки в журнале.")
        sys.exit(1)

    # 3. Получаем ВСЕ отметки этого учителя по этому предмету
    all_marks = api_get(token, "/api/ej/core/teacher/v1/marks", {
        "teacher_id": teacher_id,
        "subject_id": subject_id,
        "created_at_from": "01.09.2025",
        "created_at_to": "31.08.2026",
        "with_non_numeric_entries": "true",
        "per_page": 10000,
        "page": 1,
    })

    if not isinstance(all_marks, list):
        print("❌ Не удалось загрузить отметки.")
        sys.exit(1)

    # 4. Извлекаем уникальные group_id
    group_ids = set()
    for mark in all_marks:
        gid = mark.get("group_id")
        if gid:
            group_ids.add(gid)

    if not group_ids:
        print("❌ Не найдено групп с оценками. Возможно, у вас нет отметок в журнале.")
        sys.exit(1)

    # 5. Получаем названия групп
    ids_str = ",".join(str(g) for g in sorted(group_ids))
    groups_info = api_get(token, "/api/ej/plan/teacher/v1/groups",
                          {"group_ids": ids_str, "academic_year_id": 13})

    if not isinstance(groups_info, list):
        groups_info = groups_info.get("items", groups_info.get("groups", []))

    result = []
    for g in groups_info:
        gid = g.get("id")
        name = g.get("group_name", g.get("name", "?"))
        subj = g.get("subject_name", g.get("subject", ""))
        result.append((gid, name, subj))

    return sorted(result, key=lambda x: x[1])


# ============================================================
# ОСНОВНАЯ ПРОГРАММА
# ============================================================

def main():
    print("=" * 70)
    print("  МЭШ — АВТОЗАПОЛНЕНИЕ SOFT SKILLS")
    print("  Заполняет оценку soft skills для всех учеников")
    print("  на основе их среднего балла по предмету.")
    print("=" * 70)

    # 1. Получаем токен
    token = input("\n🔑 Введите Bearer токен (из DevTools → Network):\n  ").strip()
    if not token:
        print("Токен не может быть пустым.")
        sys.exit(1)

    # Проверка токена и получение групп
    print("\n⏳ Определяю ваши группы через отметки...")
    my_groups = get_my_groups(token)

    print(f"\n✅ Найдено групп: {len(my_groups)}")
    print("\n📚 ВАШИ ГРУППЫ:")
    print("-" * 60)
    for i, (gid, gname, subj) in enumerate(my_groups, 1):
        print(f"  {i:2d}. [{gid}] {gname}")

    # 2. Выбираем группы для заполнения
    print("\nВыберите группы для заполнения:")
    print("  1 — все группы")
    print("  2 — выбрать по номерам")
    print("  3 — ввести ID групп вручную")
    choice = input("Ваш выбор (1/2/3): ").strip()

    selected_groups = []
    if choice == "1":
        selected_groups = my_groups
    elif choice == "2":
        nums = input("Введите номера через пробел (например: 1 3 5): ").strip().split()
        for n in nums:
            try:
                idx = int(n) - 1
                if 0 <= idx < len(my_groups):
                    selected_groups.append(my_groups[idx])
            except ValueError:
                pass
    elif choice == "3":
        ids_input = input("Введите ID групп через запятую: ").strip()
        for part in ids_input.split(","):
            gid = part.strip()
            if gid.isdigit():
                found = False
                for sgid, sname, subj in my_groups:
                    if str(sgid) == gid:
                        selected_groups.append((sgid, sname, subj))
                        found = True
                        break
                if not found:
                    print(f"  ⚠️ Группа {gid} не найдена")
    else:
        print("Неверный выбор.")
        sys.exit(1)

    if not selected_groups:
        print("Не выбрано ни одной группы.")
        sys.exit(1)

    print(f"\n✅ Выбрано групп: {len(selected_groups)}")

    # 3. Собираем данные и заполняем
    all_results = []
    total_students = 0
    success = 0
    skipped = 0
    failed = 0

    for gid, gname, subj in selected_groups:
        print(f"\n📁 [{gid}] {gname}")

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
            failed += 1
            continue

        profiles = students if isinstance(students, list) else students.get("items", [])
        valid = [s for s in profiles if s.get("person_id")]
        if not valid:
            print(f"  ⏭️ Нет учеников")
            continue

        print(f"  👥 {len(valid)} учеников")

        # Получаем оценки
        student_ids_set = {s["id"] for s in valid}
        try:
            marks = api_get(token, "/api/ej/core/teacher/v1/marks", {
                "group_ids": gid,
                "created_at_from": "01.09.2025",
                "created_at_to": "31.08.2026",
                "with_non_numeric_entries": "true",
                "per_page": 3000,
                "page": 1,
            })
            averages = compute_averages(marks, student_ids_set)
        except Exception as e:
            print(f"  ⚠️ Ошибка загрузки оценок: {e}")
            averages = {}

        # Получаем period_id
        period_id = get_period_id(token, valid[0]["person_id"])
        if not period_id:
            print(f"  ⚠️ Не удалось определить period_id для этой группы")
            for s in valid:
                all_results.append({
                    "group": gname, "name": get_student_name(s),
                    "person_id": s["person_id"], "period_id": None,
                    "avg": None, "answers": {},
                })
            continue

        # Заполняем для каждого ученика
        for s in valid:
            sid = s["id"]
            name = get_student_name(s)
            avg = averages.get(sid)
            answers = {
                str(q): get_answer(avg, q, s["person_id"])
                for q in QUESTION_CATEGORY
            }

            # Пропускаем, если уже заполнено
            if check_already_filled(token, s["person_id"], period_id):
                skipped += 1
                continue

            # Отправляем
            ans_list = [{"question_id": q, "answer_id": answers[q]} for q in ["1","2","3","4","5","6","7","11","13","14"]]
            resp_ok = False
            try:
                resp = api_post(token, "/api/soft_skills/v1/survey", {
                    "student_person_id": s["person_id"],
                    "period_id": period_id,
                    "answers": ans_list,
                })
                resp_ok = resp.ok
                if resp.ok:
                    success += 1
                else:
                    failed += 1
                    print(f"  ❌ {name} — HTTP {resp.status_code}")
            except Exception as e:
                failed += 1
                print(f"  ❌ {name} — {str(e)[:50]}")

            all_results.append({
                "group": gname,
                "name": name,
                "period_id": period_id,
                "avg": round(avg, 2) if avg else None,
                "answers": answers,
            })

            print(f"  {'✅' if resp_ok else '❌'} {name} (балл: {avg:.2f if avg else 'N/A'})")
            time.sleep(0.2)

        total_students += len(valid)

    # 4. Итоги
    print("\n" + "=" * 70)
    print("📊 ИТОГИ ЗАПОЛНЕНИЯ")
    print("=" * 70)
    print(f"  ✅ Заполнено:           {success}")
    print(f"  ⏭️ Уже было заполнено:  {skipped}")
    print(f"  ❌ Ошибок:              {failed}")
    print(f"  📝 Всего учеников:      {total_students}")
    print(f"  📚 Всего групп:         {len(selected_groups)}")

    # Сохраняем отчёт
    report = {
        "thresholds": {
            cat: f">={t[0]} Всегда, >={t[1]} Часто, >={t[2]} Редко, <{t[2]} Никогда"
            for cat, t in THRESHOLDS.items()
        },
        "question_offsets": QUESTION_OFFSETS,
        "answer_map": ANSWER_TEXT,
        "questions": QUESTION_TEXT,
        "students": all_results,
    }
    with open("soft_skills_answers.json", "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print(f"\n📁 Отчёт сохранён: soft_skills_answers.json")
    print("=" * 70)


if __name__ == "__main__":
    main()
