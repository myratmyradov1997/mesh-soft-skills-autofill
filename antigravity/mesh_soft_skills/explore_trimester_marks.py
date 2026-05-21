#!/usr/bin/env python3
"""
Исследование API МЭШ для триместровых отметок.
Использование: python3 explore_trimester_marks.py <token> <profile_id>
"""

import requests
import json
import sys
from collections import defaultdict

BASE_URL = "https://school.mos.ru"

def make_headers(token, profile_id):
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "X-Mes-Subsystem": "teacherweb",
        "Content-Type": "application/json",
        "Profile-Id": str(profile_id),
        "User-Agent": "Mozilla/5.0",
    }

def api_get(token, profile_id, path, params=None):
    url = f"{BASE_URL}{path}"
    resp = requests.get(url, headers=make_headers(token, profile_id), params=params, timeout=30)
    if resp.status_code == 401:
        print(f"❌ Токен истёк ({path})")
        return None
    if resp.status_code != 200:
        print(f"⚠️  HTTP {resp.status_code}: {url}")
        return None
    try:
        return resp.json()
    except:
        print(f"⚠️  Не JSON ответ: {resp.text[:200]}")
        return None

def main():
    if len(sys.argv) < 3:
        print("Использование: python3 explore_trimester_marks.py <token> <profile_id>")
        sys.exit(1)

    token = sys.argv[1]
    profile_id = sys.argv[2]

    print("=" * 70)
    print("  ИССЛЕДОВАНИЕ API МЭШ — Триместровые отметки")
    print("=" * 70)

    # 1. Получаем группы
    print("\n1️⃣  Группы учителя...")
    groups = api_get(token, profile_id, "/api/ej/plan/teacher/v1/groups",
                     {"academic_year_id": 13})
    if groups is None:
        print("   Не удалось получить группы")
        return

    all_groups = groups if isinstance(groups, list) else groups.get("items", groups.get("groups", []))
    print(f"   Всего групп: {len(all_groups)}")

    # Выводим первые 20 названий групп
    print(f"   Примеры групп (первые 20):")
    for g in all_groups[:20]:
        print(f"     [{g.get('id')}] {g.get('group_name')} (subject={g.get('subject_id')}, cu={g.get('class_unit_id')})")

    # Фильтруем 9-е классы
    grade9_groups = []
    for g in all_groups:
        name = g.get("group_name", "")
        if name.startswith("9") and (" " in name or "гр" in name):
            grade9_groups.append(g)

    if not grade9_groups:
        # Попробуем другой фильтр
        for g in all_groups:
            name = g.get("group_name", "")
            if "9" in name:
                grade9_groups.append(g)

    print(f"\n   Найдено 9-х классов: {len(grade9_groups)}")
    for g in grade9_groups:
        print(f"     [{g.get('id')}] {g.get('group_name')} (subject={g.get('subject_id')}, cu={g.get('class_unit_id')}, ps={g.get('periods_schedule_id') or g.get('periods_schedule')})")

    # 2. Для первого 9-го класса изучаем структуру
    if not grade9_groups:
        print("   9-е классы не найдены")
        # Возьмём любую группу для исследования
        if all_groups:
            grade9_groups = [all_groups[0]]
            print(f"   Берём первую группу: {grade9_groups[0].get('group_name')}")

    first_group = grade9_groups[0]
    gid = first_group["id"]
    cu_id = first_group.get("class_unit_id")
    subj_id = first_group.get("subject_id")

    print(f"\n2️⃣  Изучаем: [{gid}] {first_group.get('group_name')}")
    print(f"   class_unit_id={cu_id}, subject_id={subj_id}")

    # 3. Получаем расписание периодов
    print(f"\n3️⃣  periods_schedules...")
    ps_id = first_group.get("periods_schedule_id") or first_group.get("periods_schedule")
    print(f"   periods_schedule_id={ps_id}")
    if ps_id:
        periods = api_get(token, profile_id, f"/api/ej/core/teacher/v1/periods_schedules/{ps_id}")
        if periods:
            print(f"   Ответ (первые 1500 символов):")
            print(json.dumps(periods, ensure_ascii=False, indent=2)[:1500])

    # 4. attestation_fixation
    print(f"\n4️⃣  attestation_fixation...")
    if cu_id:
        fix = api_get(token, profile_id, "/api/ej/core/teacher/v1/class_units/attestation_fixation",
                      {"class_unit_id": cu_id})
        if fix:
            print(f"   Ответ (первые 2000 символов):")
            print(json.dumps(fix, ensure_ascii=False, indent=2)[:2000])

    # 5. student_profiles
    print(f"\n5️⃣  student_profiles с with_final_marks=true...")
    students = api_get(token, profile_id, "/api/ej/core/teacher/v1/student_profiles", {
        "academic_year_id": 13,
        "group_ids": gid,
        "with_final_marks": "true",
        "per_page": 150,
        "page": 1,
    })
    profiles = []
    if students:
        profiles = students if isinstance(students, list) else students.get("items", [])
        print(f"   {len(profiles)} учеников")
        if profiles:
            s = profiles[0]
            print(f"   Ключи профиля: {[k for k in s.keys() if not k.startswith('_')]}")
            # Ищем final_marks
            for key in s:
                if any(x in key.lower() for x in ["final", "mark", "attest", "period"]):
                    print(f"   -> {key}: {json.dumps(s[key], ensure_ascii=False)[:300]}")

    # 6. average_marks_year
    print(f"\n6️⃣  average_marks_year...")
    if profiles and subj_id:
        student_ids = [s["id"] for s in profiles[:5]]
        ids_str = ",".join(str(sid) for sid in student_ids)
        print(f"   student_ids: {ids_str}")

        # Без периода
        avg_year = api_get(token, profile_id, "/api/ej/core/teacher/v1/average_marks_year", {
            "subject_id": subj_id,
            "group_ids": gid,
            "student_profile_ids": ids_str,
        })
        if avg_year:
            print(f"   Годовой: {json.dumps(avg_year, ensure_ascii=False)[:800]}")

    # 7. Получаем ID attestation периодов из attestation_fixation
    print(f"\n7️⃣  Извлекаем attestation_periods...")
    # Пробуем разные варианты получения периодов
    # Вариант: из groups -> education_level -> ...
    # Вариант: из class_units
    if cu_id:
        cu = api_get(token, profile_id, f"/api/ej/core/teacher/v1/class_units/{cu_id}")
        if cu:
            print(f"   class_unit keys: {list(cu.keys())}")
            for key in cu:
                if any(x in key.lower() for x in ["period", "attest", "level", "class"]):
                    print(f"   {key}: {cu[key]}")

    # 8. Пробуем разные endpoint'ы для attestation
    print(f"\n8️⃣  Поиск attestation_periods...")
    # Пробуем получить periods для группы
    # Из HAR: class_level_id=9, subject_id=37187584
    if subj_id:
        cf = api_get(token, profile_id, "/api/ej/core/teacher/v1/control_forms", {
            "academic_year_id": 13,
            "subject_id": subj_id,
            "with_grade_system": "true",
            "with_deleted": "false",
            "education_level_id": 2,
            "per_page": 1000,
            "page": 1,
        })
        if cf:
            print(f"   control_forms (первые 1500):")
            print(json.dumps(cf, ensure_ascii=False, indent=2)[:1500])

    # 9. average_marks с theme_frame_integration_ids
    print(f"\n9️⃣  Поиск возможных attestation_periods...")
    # Пробуем получить attestation_periods_schedules
    # Из HAR: attestation_periods_schedules/38368
    # Похоже, что 38368 = это какой-то ID, связанный с class_unit или education_level
    if cu_id:
        aps = api_get(token, profile_id, f"/api/ej/core/teacher/v1/attestation_periods_schedules/{cu_id}")
        if aps:
            print(f"   attestation_periods_schedules/{cu_id}: {json.dumps(aps, ensure_ascii=False, indent=2)[:1500]}")

    # 10. Ищем другие endpoint'ы
    print(f"\n🔟  Пробуем /api/ej/core/teacher/v1/attestation...")
    att = api_get(token, profile_id, "/api/ej/core/teacher/v1/attestation", {
        "class_unit_ids": cu_id,
        "academic_year_id": 13,
    }) if cu_id else None
    if att:
        print(f"   attestation: {json.dumps(att, ensure_ascii=False, indent=2)[:1500]}")

    print("\n" + "=" * 70)
    print("  Исследование завершено")
    print("=" * 70)

if __name__ == "__main__":
    main()
