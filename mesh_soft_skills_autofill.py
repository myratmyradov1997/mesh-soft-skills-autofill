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
  7. Вставь токен — выбери свой предмет и свои группы

Зависимости: pip install requests

Если на Windows не работает SSL, попробуй:
  pip install pip-system-certs
"""

import requests
import json
import sys
import time
import hashlib
import warnings
from collections import defaultdict

warnings.filterwarnings("ignore")
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

BASE_URL = "https://school.mos.ru"

# ============================================================
# НАСТРОЙКИ
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


def get_answer(avg_score, question_id, person_id):
    if avg_score is None:
        return 5
    cat = QUESTION_CATEGORY[question_id]
    t = THRESHOLDS[cat]
    offset = QUESTION_OFFSETS.get(question_id, 0)
    seed = int(hashlib.md5(str(person_id).encode()).hexdigest()[:8], 16)
    pv = ((seed + question_id * 100) % 500 - 250) / 1000
    adj = avg_score + offset + pv
    if adj >= t[0]: return 4
    if adj >= t[1]: return 3
    if adj >= t[2]: return 2
    return 1


# ============================================================
# API
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
        print("\n  ❌ Токен истёк. Обнови страницу и скопируй новый.")
        sys.exit(1)
    resp.raise_for_status()
    return resp.json()


def api_post(token, path, data):
    resp = requests.post(
        f"{BASE_URL}{path}",
        headers=make_headers(token), json=data, timeout=30, verify=False,
    )
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
    if isinstance(marks_data, list):
        for m in marks_data:
            sid = m.get("student_profile_id")
            if sid not in student_ids:
                continue
            try:
                val = m.get("values", [{}])[0].get("grade", {}).get("five")
                if val is None:
                    val = float(m.get("name", 0))
                if 2 <= val <= 5:
                    scores[sid].append(val)
            except (ValueError, TypeError, IndexError):
                pass
    return {sid: sum(vals) / len(vals) for sid, vals in scores.items() if vals}


def get_period_id(token, person_id):
    try:
        p = api_get(token, "/api/soft_skills/v1/periods", {"student_person_id": person_id})
        if isinstance(p, list) and p:
            return p[0].get("id")
    except: pass
    try:
        c = api_get(token, "/api/soft_skills/v1/periods/checkCurrentPeriodTeacher",
                     {"student_person_id": person_id})
        if isinstance(c, dict):
            return c.get("period_id")
    except: pass
    return None


def check_already_filled(token, person_id, period_id):
    try:
        r = requests.get(
            f"{BASE_URL}/api/soft_skills/v1/survey/teacherSurvey",
            headers=make_headers(token), verify=False,
            params={"student_person_id": person_id, "period_id": period_id}, timeout=10,
        )
        if r.status_code == 200:
            d = r.json()
            if isinstance(d, dict) and d.get("answers") and len(d["answers"]) > 0:
                return True
    except: pass
    return False


# ============================================================
# ОСНОВНАЯ ПРОГРАММА
# ============================================================

def main():
    print("=" * 70)
    print("  МЭШ — АВТОЗАПОЛНЕНИЕ SOFT SKILLS")
    print("  Заполняет оценку soft skills для учеников")
    print("  на основе их среднего балла.")
    print("=" * 70)

    token = input("\n🔑 Введите Bearer токен:\n  ").strip()
    if not token:
        print("Токен не может быть пустым.")
        sys.exit(1)

    print("\n⏳ Загружаю список групп...")

    all_groups = api_get(token, "/api/ej/plan/teacher/v1/groups",
                         {"academic_year_id": 13, "page": 1, "per_page": 2000})
    if not isinstance(all_groups, list):
        all_groups = all_groups.get("items", all_groups.get("groups", []))

    if not all_groups:
        print("❌ Группы не найдены.")
        sys.exit(1)

    # Группируем по предмету (первое слово в названии группы)
    subjects = defaultdict(list)
    for g in all_groups:
        name = g.get("group_name", g.get("name", ""))
        subj = name.split()[0] if name else "?"
        subj_clean = subj.strip().rstrip(".,")
        if subj_clean:
            subjects[subj_clean].append((g["id"], name))

    subj_list = sorted(subjects.keys(), key=lambda x: x.lower())

    print(f"\n📚 ПРЕДМЕТЫ В ШКОЛЕ:")
    print("-" * 60)
    for i, subj in enumerate(subj_list, 1):
        print(f"  {i:2d}. {subj} ({len(subjects[subj])} групп)")

    print("\nВыберите свой ПРЕДМЕТ (введите номер или часть названия):")
    print("  Например: «1» или «труд» или «Технология»")
    choice = input("> ").strip().lower()

    selected_subj = None
    groups_in_subject = []

    # По номеру
    try:
        idx = int(choice) - 1
        if 0 <= idx < len(subj_list):
            selected_subj = subj_list[idx]
            groups_in_subject = subjects[selected_subj]
    except ValueError:
        pass

    if not selected_subj:
        # По части названия
        for subj in subj_list:
            if choice in subj.lower():
                selected_subj = subj
                groups_in_subject = subjects[subj]
                break

    if not selected_subj:
        print("❌ Предмет не найден.")
        sys.exit(1)

    print(f"\n✅ Предмет: {selected_subj} ({len(groups_in_subject)} групп)")

    # Выбор групп
    print(f"\n📋 ГРУППЫ ПО ПРЕДМЕТУ «{selected_subj}»:")
    print("-" * 60)
    for i, (gid, gname) in enumerate(groups_in_subject, 1):
        print(f"  {i:2d}. [{gid}] {gname}")

    print("\nВыберите ВАШИ группы:")
    print("  1 — все группы")
    print("  2 — выбрать по номерам (например: 1,3,5-8)")
    print("  3 — ввести ID групп вручную")
    sel = input("> ").strip()

    selected_groups = []
    if sel == "1":
        selected_groups = groups_in_subject
    elif sel == "2":
        parts = input("Номера групп: ").strip().split()
        for part in parts:
            if "-" in part:
                a, b = part.split("-")
                for n in range(int(a), int(b) + 1):
                    if 1 <= n <= len(groups_in_subject):
                        selected_groups.append(groups_in_subject[n - 1])
            else:
                try:
                    n = int(part)
                    if 1 <= n <= len(groups_in_subject):
                        selected_groups.append(groups_in_subject[n - 1])
                except: pass
    elif sel == "3":
        ids = input("ID групп через запятую: ").strip()
        for gid_str in ids.split(","):
            gid_str = gid_str.strip()
            if gid_str.isdigit():
                for gid, gname in groups_in_subject:
                    if str(gid) == gid_str:
                        selected_groups.append((gid, gname))
                        break

    if not selected_groups:
        print("❌ Не выбрано ни одной группы.")
        sys.exit(1)

    print(f"\n✅ Выбрано групп: {len(selected_groups)}")

    # ============================================================
    # ЗАПОЛНЕНИЕ
    # ============================================================

    all_results = []
    total_students = 0
    total_success = 0
    total_skipped = 0
    total_failed = 0

    for gid, gname in selected_groups:
        print(f"\n📁 [{gid}] {gname}")

        try:
            students = api_get(token, "/api/ej/core/teacher/v1/student_profiles", {
                "academic_year_id": 13, "group_ids": gid,
                "with_final_marks": "true", "per_page": 150, "page": 1,
            })
        except Exception as e:
            print(f"  ❌ Ошибка загрузки учеников: {e}")
            continue

        profiles = students if isinstance(students, list) else students.get("items", [])
        valid = [s for s in profiles if s.get("person_id")]

        if not valid:
            print(f"  ⏭️ Нет учеников")
            continue

        sids_set = {s["id"] for s in valid}
        print(f"  👥 {len(valid)} уч.")

        # Оценки
        averages = {}
        try:
            marks = api_get(token, "/api/ej/core/teacher/v1/marks", {
                "group_ids": gid, "created_at_from": "01.09.2025",
                "created_at_to": "31.08.2026",
                "with_non_numeric_entries": "true", "per_page": 3000, "page": 1,
            })
            if isinstance(marks, list) and marks:
                averages = compute_averages(marks, sids_set)
        except: pass

        # Если оценок нет — попробуем final_marks из профилей
        if not averages:
            for s in valid:
                fm = s.get("final_marks", s.get("marks", []))
                nums = []
                for m in fm:
                    try:
                        v = int(m.get("value", m.get("mark", 0)))
                        if 2 <= v <= 5: nums.append(v)
                    except: pass
                if nums:
                    averages[s["id"]] = sum(nums) / len(nums)

        print(f"  📊 Оценок: {len(averages)}/{len(valid)} уч.")

        # Period
        period_id = get_period_id(token, valid[0]["person_id"])
        if not period_id:
            print(f"  ⚠️ Не удалось определить period_id")
            continue

        # Заполнение
        group_success = 0
        group_skipped = 0

        for s in valid:
            name = get_student_name(s)
            avg = averages.get(s["id"])
            answers = {str(q): get_answer(avg, q, s["person_id"]) for q in QUESTION_CATEGORY}

            if check_already_filled(token, s["person_id"], period_id):
                group_skipped += 1
                continue

            ans_list = [{"question_id": q, "answer_id": answers[q]}
                       for q in ["1","2","3","4","5","6","7","11","13","14"]]

            ok = False
            try:
                r = api_post(token, "/api/soft_skills/v1/survey", {
                    "student_person_id": s["person_id"],
                    "period_id": period_id,
                    "answers": ans_list,
                })
                ok = r.ok
            except: pass

            if ok:
                group_success += 1
            else:
                total_failed += 1

            all_results.append({
                "group": gname, "name": name, "period_id": period_id,
                "avg": round(avg, 2) if avg else None, "answers": answers,
            })

            time.sleep(0.15)

        total_success += group_success
        total_skipped += group_skipped
        total_students += len(valid)
        print(f"  ✅ {group_success} заполнено, ⏭️ {group_skipped} пропущено")

    # ИТОГИ
    print("\n" + "=" * 70)
    print("📊 ИТОГИ")
    print("=" * 70)
    print(f"  ✅ Заполнено:           {total_success}")
    print(f"  ⏭️ Уже было заполнено:  {total_skipped}")
    print(f"  ❌ Ошибок:              {total_failed}")
    print(f"  📝 Всего учеников:      {total_students}")
    print(f"  📚 Групп:               {len(selected_groups)}")

    # Отчёт
    report = {
        "thresholds": {c: f">={t[0]} Всегда, >={t[1]} Часто, >={t[2]} Редко, <{t[2]} Никогда"
                      for c, t in THRESHOLDS.items()},
        "question_offsets": QUESTION_OFFSETS,
        "answer_map": ANSWER_TEXT,
        "questions": QUESTION_TEXT,
        "students": all_results,
    }
    with open("soft_skills_answers.json", "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print(f"\n📁 Отчёт: soft_skills_answers.json")
    print("=" * 70)


if __name__ == "__main__":
    main()
