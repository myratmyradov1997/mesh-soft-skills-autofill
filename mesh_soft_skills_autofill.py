#!/usr/bin/env python3
"""
МЭШ — Автозаполнение Soft Skills
==================================
Автоматически заполняет оценку «soft skills» для всех учеников
на основе их среднего балла по предмету.

Как использовать:
  1. Открой school.mos.ru → F12 → Network → обнови страницу
  2. Скопируй Authorization: Bearer eyJ...  (из любого запроса)
  3. Скопируй Profile-Id: 17905177  (из заголовков запроса)
  4. Запусти: python3 mesh_soft_skills_autofill.py
  5. Вставь токен и profile-id — скрипт сам найдёт твои группы

Зависимости: pip install requests
"""

import requests, json, sys, time, hashlib, warnings
from collections import defaultdict
warnings.filterwarnings("ignore")
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

BASE_URL = "https://school.mos.ru"

QUESTION_OFFSETS = {1:0.25,2:0.15,3:-0.35,4:-0.20,5:0.05,6:0.10,7:0.20,11:0.30,13:0.25,14:-0.30}
THRESHOLDS = {"self_org":[4.6,3.7,3.0],"self_edu":[4.8,4.0,3.3],"self_reg":[4.6,3.7,3.0],"comm":[4.6,3.7,3.0]}
QUESTION_CATEGORY = {1:"self_org",2:"self_org",3:"self_edu",4:"self_edu",5:"self_reg",6:"self_reg",7:"self_reg",11:"comm",13:"comm",14:"comm"}
QUESTION_TEXT = {1:"Самоорганизация: ДЗ",2:"Самоорганизация: сроки",3:"Самообразование: интерес",4:"Самообразование: любознательность",5:"Саморегуляция: внимание",6:"Саморегуляция: самооценка",7:"Саморегуляция: дисциплина",11:"Коммуникация: слушает",13:"Коммуникация: вежливость",14:"Коммуникация: выступления"}
ANSWER_TEXT = {1:"Никогда",2:"Редко",3:"Часто",4:"Всегда",5:"Затрудняюсь"}

def make_headers(token):
    return {"Authorization":f"Bearer {token}","Accept":"application/json","X-Mes-Subsystem":"teacherweb","Content-Type":"application/json","User-Agent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}

def api_get(token, path, params=None):
    resp = requests.get(f"{BASE_URL}{path}", headers=make_headers(token), params=params, timeout=30, verify=False)
    if resp.status_code == 401: print("\n  ❌ Токен истёк."); sys.exit(1)
    resp.raise_for_status(); return resp.json()

def api_post(token, path, data):
    return requests.post(f"{BASE_URL}{path}", headers=make_headers(token), json=data, timeout=30, verify=False)

def get_student_name(s):
    name = (s.get("short_name") or "").strip()
    if not name or name == "None None": name = (s.get("user_name") or "").strip()
    if not name: name = f"{s.get('last_name','')} {s.get('first_name','')}".strip()
    return name or "Unknown"

def compute_averages(marks_data, student_ids):
    scores = defaultdict(list)
    if isinstance(marks_data, list):
        for m in marks_data:
            sid = m.get("student_profile_id")
            if sid not in student_ids: continue
            try:
                val = m.get("values",[{}])[0].get("grade",{}).get("five")
                if val is None: val = float(m.get("name",0))
                if 2<=val<=5: scores[sid].append(val)
            except: pass
    return {sid: sum(vals)/len(vals) for sid,vals in scores.items() if vals}

def get_period_id(token, person_id):
    try:
        p = api_get(token, "/api/soft_skills/v1/periods", {"student_person_id": person_id})
        if isinstance(p,list) and p: return p[0].get("id")
    except: pass
    try:
        c = api_get(token, "/api/soft_skills/v1/periods/checkCurrentPeriodTeacher", {"student_person_id": person_id})
        if isinstance(c,dict): return c.get("period_id")
    except: pass
    return None

def check_filled(token, person_id, period_id):
    try:
        r = requests.get(f"{BASE_URL}/api/soft_skills/v1/survey/teacherSurvey", headers=make_headers(token), verify=False, params={"student_person_id":person_id,"period_id":period_id}, timeout=10)
        if r.status_code==200:
            d = r.json()
            if isinstance(d,dict) and d.get("answers") and len(d["answers"])>0: return True
    except: pass
    return False

def get_answer(avg, qid, pid):
    if avg is None: return 5
    cat = QUESTION_CATEGORY[qid]; t = THRESHOLDS[cat]
    seed = int(hashlib.md5(str(pid).encode()).hexdigest()[:8],16)
    pv = ((seed+qid*100)%500-250)/1000
    adj = avg+QUESTION_OFFSETS.get(qid,0)+pv
    if adj>=t[0]: return 4
    if adj>=t[1]: return 3
    if adj>=t[2]: return 2
    return 1

def get_my_groups_from_schedule(token, teacher_id):
    """Получает группы учителя из расписания."""
    print("  ⏳ Загружаю расписание...")
    r = requests.get(f"{BASE_URL}/api/ej/plan/teacher/v1/schedule_items", headers=make_headers(token), verify=False, params={
        "academic_year_id":13,
        "teacher_id":teacher_id,
        "from":"2025-09-01",
        "to":"2026-05-31",
        "with_group_class_subject_info":"true",
        "page":1,
        "per_page":2000,
    }, timeout=30)
    if r.status_code!=200:
        print(f"  ❌ Ошибка расписания: HTTP {r.status_code}")
        return []
    data = r.json()
    if not isinstance(data, list):
        print(f"  ❌ Неверный формат ответа")
        return []
    
    # Фильтруем уроки-замены (учитель временно замещает, а не ведёт постоянно)
    regular_lessons = [
        item for item in data
        if not item.get("replaced") and not item.get("replaced_teacher_id")
    ]
    if len(regular_lessons) < len(data):
        print(f"  ⏳ Отфильтровано замен: {len(data) - len(regular_lessons)}")

    groups = {}
    for item in regular_lessons:
        gid = item.get("group_id")
        gname = item.get("group_name","")
        subj = item.get("subject_name","")
        if gid and gid not in groups:
            groups[gid] = {"name": gname, "subject": subj}
    
    if not groups:
        print("  ❌ В расписании нет уроков. Проверьте Profile-Id.")
        return []
    
    result = [(gid, info["name"], info["subject"]) for gid, info in groups.items()]
    return sorted(result, key=lambda x: x[1])

def main():
    print("="*65)
    print("  МЭШ — АВТОЗАПОЛНЕНИЕ SOFT SKILLS")
    print("="*65)
    
    token = input("\n🔑 Bearer токен (из F12 → Network):\n  ").strip()
    if not token: print("Токен пустой"); sys.exit(1)
    
    pid_input = input("👤 Profile-Id (из заголовков запроса):\n  ").strip()
    if not pid_input or not pid_input.isdigit():
        print("Profile-Id должен быть числом. Ищи в Request Headers → Profile-Id")
        sys.exit(1)
    teacher_id = int(pid_input)
    
    print("\n⏳ Получаю ваши группы из расписания...")
    my_groups = get_my_groups_from_schedule(token, teacher_id)
    
    if not my_groups:
        print("❌ Не найдено групп. Проверьте Profile-Id.")
        sys.exit(1)
    
    # Группируем по предметам
    subjects = defaultdict(list)
    for gid, gname, subj in my_groups:
        subj_name = subj or (gname.split()[0] if gname else "?")
        subjects[subj_name].append((gid, gname))
    
    print(f"\n✅ Найдено {len(my_groups)} групп, {len(subjects)} предметов")
    
    # Выбор предмета
    subj_list = sorted(subjects.keys(), key=lambda x: x.lower())
    print(f"\n📚 ВАШИ ПРЕДМЕТЫ:")
    print("-"*50)
    for i, subj in enumerate(subj_list, 1):
        print(f"  {i}. {subj} ({len(subjects[subj])} групп)")
    
    print(f"\n  {'='*50}")
    print(f"  🎯 Если у вас один предмет — выбран автоматически")
    if len(subj_list) == 1:
        selected_subj = subj_list[0]
        selected_groups = subjects[selected_subj]
        print(f"     Предмет: {selected_subj}")
    else:
        choice = input(f"\nВыберите предмет (1-{len(subj_list)}): ").strip()
        try:
            idx = int(choice)-1
            if 0<=idx<len(subj_list):
                selected_subj = subj_list[idx]
                selected_groups = subjects[selected_subj]
            else: print("Неверный выбор"); sys.exit(1)
        except: print("Неверный ввод"); sys.exit(1)
    
    print(f"\n📋 ГРУППЫ ПО ПРЕДМЕТУ «{selected_subj}»:")
    for i, (gid, gname) in enumerate(selected_groups, 1):
        print(f"  {i:2d}. [{gid}] {gname}")
    
    if len(selected_groups) <= 5:
        confirm = input(f"\nЗаполнить все {len(selected_groups)} групп? (Enter/да, n/нет): ").strip().lower()
        if confirm != "n":
            chosen = selected_groups
        else:
            sys.exit(0)
    else:
        print(f"\nВыберите группы для заполнения:")
        print(f"  1 — все {len(selected_groups)} групп")
        print(f"  2 — выбрать по номерам (1,3,5-8)")
        sel = input("> ").strip()
        chosen = []
        if sel == "1":
            chosen = selected_groups
        elif sel == "2":
            parts = input("Номера групп: ").strip().split()
            for part in parts:
                if "-" in part:
                    a,b = part.split("-")
                    for n in range(int(a),int(b)+1):
                        if 1<=n<=len(selected_groups): chosen.append(selected_groups[n-1])
                else:
                    try:
                        n = int(part)
                        if 1<=n<=len(selected_groups): chosen.append(selected_groups[n-1])
                    except: pass
        if not chosen: print("❌ Нет выбранных групп"); sys.exit(1)
    
    print(f"\n✅ Выбрано групп: {len(chosen)}")
    input("Нажмите Enter для начала заполнения...")
    
    # ===== ЗАПОЛНЕНИЕ =====
    all_results = []
    total_students = total_ok = total_skip = total_fail = 0
    
    for gid, gname in chosen:
        print(f"\n📁 [{gid}] {gname}")
        try:
            students = api_get(token, "/api/ej/core/teacher/v1/student_profiles", {"academic_year_id":13,"group_ids":gid,"with_final_marks":"true","per_page":150,"page":1})
        except Exception as e:
            print(f"  ❌ {e}"); continue
        
        profiles = students if isinstance(students,list) else students.get("items",[])
        valid = [s for s in profiles if s.get("person_id")]
        if not valid: print(f"  ⏭️ нет учеников"); continue
        
        sids_set = {s["id"] for s in valid}
        print(f"  👥 {len(valid)} уч.")
        
        averages = {}
        try:
            marks = api_get(token, "/api/ej/core/teacher/v1/marks", {"group_ids":gid,"created_at_from":"01.09.2025","created_at_to":"31.08.2026","with_non_numeric_entries":"true","per_page":3000,"page":1})
            if isinstance(marks,list) and marks: averages = compute_averages(marks, sids_set)
        except: pass
        if not averages:
            for s in valid:
                nums = []
                for m in (s.get("final_marks",s.get("marks",[]))):
                    try:
                        v = int(m.get("value",m.get("mark",0)))
                        if 2<=v<=5: nums.append(v)
                    except: pass
                if nums: averages[s["id"]] = sum(nums)/len(nums)
        
        print(f"  📊 оценок: {len(averages)}/{len(valid)}")
        
        period_id = get_period_id(token, valid[0]["person_id"])
        if not period_id: print(f"  ⚠️ нет period_id"); continue
        
        g_ok=g_skip=0
        for s in valid:
            name = get_student_name(s)
            avg = averages.get(s["id"])
            answers = {str(q): get_answer(avg,q,s["person_id"]) for q in QUESTION_CATEGORY}
            if check_filled(token, s["person_id"], period_id): g_skip+=1; continue
            ans_list = [{"question_id":q,"answer_id":answers[q]} for q in ["1","2","3","4","5","6","7","11","13","14"]]
            try:
                r = api_post(token, "/api/soft_skills/v1/survey", {"student_person_id":s["person_id"],"period_id":period_id,"answers":ans_list})
                if r.ok: g_ok+=1
                else: total_fail+=1
            except: total_fail+=1
            all_results.append({"group":gname,"name":name,"period_id":period_id,"avg":round(avg,2) if avg else None,"answers":answers})
            time.sleep(0.15)
        
        total_ok+=g_ok; total_skip+=g_skip; total_students+=len(valid)
        print(f"  ✅ {g_ok} заполнено, ⏭️ {g_skip} пропущено")
    
    print(f"\n{'='*50}")
    print("📊 ИТОГИ")
    print(f"  ✅ Заполнено:           {total_ok}")
    print(f"  ⏭️ Уже было:            {total_skip}")
    print(f"  ❌ Ошибок:              {total_fail}")
    print(f"  📝 Всего учеников:      {total_students}")
    print(f"  📚 Групп:               {len(chosen)}")
    
    report = {"thresholds":{c:f">={t[0]} Всегда, >={t[1]} Часто, >={t[2]} Редко, <{t[2]} Никогда" for c,t in THRESHOLDS.items()},"question_offsets":QUESTION_OFFSETS,"answer_map":ANSWER_TEXT,"questions":QUESTION_TEXT,"students":all_results}
    with open("soft_skills_answers.json","w",encoding="utf-8") as f: json.dump(report,f,ensure_ascii=False,indent=2)
    print(f"📁 Отчёт: soft_skills_answers.json")

if __name__ == "__main__":
    main()
