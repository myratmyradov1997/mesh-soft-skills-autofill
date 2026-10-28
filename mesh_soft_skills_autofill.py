#!/usr/bin/env python3
"""
МЭШ — автозаполнение Soft Skills (консольная версия)
====================================================
Сам находит учителя, учебный год, текущий период soft skills и все группы
учителя по расписанию (уроки-замены не учитываются). Средний балл ученика
считается по оценкам за текущий период по всем группам учителя.

Запуск:
  python3 mesh_soft_skills_autofill.py              # только показать, что будет выставлено
  python3 mesh_soft_skills_autofill.py --apply      # выставить тем, у кого ещё не заполнено
  python3 mesh_soft_skills_autofill.py --apply --overwrite   # перезаписать всем

Токен берётся из --token, переменной MESH_TOKEN или файла ~/.mesh_token,
иначе спрашивается. Его можно скопировать из cookie aupd_token на school.mos.ru.

Зависимости: pip install requests
"""

import argparse, datetime as dt, json, os, sys, time
from collections import defaultdict

import requests

BASE = "https://school.mos.ru"

# Пороги среднего балла для «Почти всегда», «Часто»; ниже — «Редко»
THRESHOLDS = {
    "Самоорганизация": (4.6, 3.7),
    "Самообразование": (4.8, 4.0),
    "Саморегуляция": (4.6, 3.7),
    "Коммуникация": (4.6, 3.7),
}
DEFAULT_THRESHOLDS = (4.6, 3.7)
# Сдвиг по вопросам: выступления и интерес вне программы — ниже, ДЗ и вежливость — выше
QUESTION_OFFSETS = {1: 0.25, 2: 0.15, 3: -0.35, 4: -0.20, 5: 0.05, 6: 0.10, 7: 0.20, 11: 0.30, 13: 0.25, 14: -0.30}
# Слабых учеников (в т.ч. только с двойками) оцениваем как троечников: «Почти никогда» не ставится
MIN_AVG = 3.3
ALWAYS, OFTEN, RARELY, UNSURE = 4, 3, 2, 5
ANSWER_SHORT = {4: "В", 3: "Ч", 2: "Р", 1: "Н", 5: "?"}


class Mesh:
    def __init__(self, token):
        self.s = requests.Session()
        self.s.headers.update({
            "Authorization": f"Bearer {token}", "Accept": "application/json",
            "X-Mes-Subsystem": "teacherweb", "User-Agent": "Mozilla/5.0",
        })
        self.token = token

    def req(self, method, path, **kw):
        for attempt in range(4):
            try:
                r = self.s.request(method, BASE + path, timeout=90, **kw)
            except requests.exceptions.RequestException:
                time.sleep(2 + attempt * 2); continue
            if r.status_code in (502, 503, 504):
                time.sleep(2 + attempt * 2); continue
            if r.status_code == 401:
                sys.exit("❌ Токен недействителен или истёк. Войдите в МЭШ заново и возьмите свежий aupd_token.")
            r.raise_for_status()
            return r.json() if r.content else None
        raise RuntimeError(f"МЭШ не отвечает: {method} {path}")

    def get(self, path, **params):
        return self.req("GET", path, params=params)


def answer_for(avg, qid, category, person_id):
    if avg is None:
        return UNSURE
    always, often = THRESHOLDS.get(category, DEFAULT_THRESHOLDS)
    adj = max(avg, MIN_AVG) + QUESTION_OFFSETS.get(qid, 0) + noise(person_id, qid)
    if adj >= always: return ALWAYS
    if adj >= often: return OFTEN
    return RARELY


def noise(person_id, qid):
    """Постоянная для ученика и вопроса поправка от -0.25 до +0.25 (FNV-1a, как в JS-версии)."""
    h = 0x811C9DC5
    for b in f"{person_id}:{qid}".encode():
        h = ((h ^ b) * 0x01000193) & 0xFFFFFFFF
    return (h % 500 - 250) / 1000


def parse_date(v):
    if isinstance(v, list): return dt.date(*v[:3])
    if "." in v: d, m, y = v.split(".")[:3]; return dt.date(int(y), int(m), int(d[:2]))
    return dt.date.fromisoformat(v[:10])


def find_teacher(m):
    sess = m.req("POST", "/api/ej/acl/v1/sessions", json={"auth_token": m.token})
    prof = next((p for p in sess.get("profiles", []) if p.get("type") == "teacher"), None)
    if not prof:
        sys.exit("❌ У этого аккаунта нет профиля учителя.")
    m.s.headers["Profile-Id"] = str(prof["id"])
    name = " ".join(filter(None, [sess.get("last_name"), sess.get("first_name"), sess.get("middle_name")]))
    return prof["id"], name


def current_year(m):
    years = m.get("/api/ej/core/teacher/v1/academic_years")
    return next(y for y in years if y.get("current_year"))


def my_groups(m, teacher_id, year):
    """Группы, где учитель ведёт свои уроки (без замен)."""
    frm = year["begin_date"][:10]
    to = min(parse_date(year["end_date"]), dt.date.today() + dt.timedelta(days=60)).isoformat()
    groups, page = {}, 1
    while True:
        items = m.get("/api/ej/plan/teacher/v1/schedule_items", academic_year_id=year["id"], teacher_id=teacher_id,
                      **{"from": frm, "to": to}, with_group_class_subject_info="true", page=page, per_page=300)
        for it in items:
            if it.get("replaced") or it.get("replaced_teacher_id") or not it.get("group_id"):
                continue
            groups.setdefault(it["group_id"], {"id": it["group_id"], "name": (it.get("group_name") or "").strip(),
                                               "subject": it.get("subject_name") or ""})
        if len(items) < 300:
            break
        page += 1
    return sorted(groups.values(), key=lambda g: g["name"])


def collect(m, year, groups, log=print):
    """Ученики по всем группам (один человек — одна анкета) + средний балл за текущий период."""
    students = {}  # person_id -> info
    by_profile = {}
    for g in groups:
        profiles = m.get("/api/ej/core/teacher/v1/student_profiles", academic_year_id=year["id"],
                         group_ids=g["id"], per_page=300, page=1)
        g["count"] = 0
        for s in profiles:
            pid = s.get("person_id")
            if not pid:
                continue
            g["count"] += 1
            st = students.setdefault(pid, {
                "person_id": pid, "name": (s.get("user_name") or s.get("short_name") or f"ID {s['id']}").strip(),
                "class": (s.get("class_unit") or {}).get("name", ""),
                "parallel": (s.get("class_unit") or {}).get("class_level_id"),
                "groups": [], "marks": [],
            })
            st["groups"].append(g["name"])
            by_profile[s["id"]] = st
        log(f"  {g['name']}: {g['count']} уч.")

    # Текущий период и «уже заполнено» — отдельно для каждого ученика
    periods = {}
    for st in students.values():
        cur = m.get("/api/soft_skills/v1/periods/checkCurrentPeriodTeacher", student_person_id=st["person_id"])
        st["period_id"] = cur.get("period_id")
        st["filled"] = bool(cur.get("answers_exists"))
        if st["period_id"] and st["period_id"] not in periods:
            lst = m.get("/api/soft_skills/v1/periods", student_person_id=st["person_id"])
            for p in lst.get("periods", []):
                periods[p["period_id"]] = p
    for st in students.values():
        st["period"] = periods.get(st["period_id"])

    # Оценки за период каждого ученика
    for g in groups:
        marks = m.get("/api/ej/core/teacher/v1/marks", group_ids=g["id"],
                      created_at_from=parse_date(year["begin_date"]).strftime("%d.%m.%Y"),
                      created_at_to=dt.date.today().strftime("%d.%m.%Y"),
                      with_non_numeric_entries="false", per_page=5000, page=1)
        for mk in marks:
            st = by_profile.get(mk.get("student_profile_id"))
            if not st or not st["period"]:
                continue
            try:
                five = mk["values"][0]["grade"]["five"]
                day = parse_date(mk.get("date") or mk["created_at"])
            except (KeyError, IndexError, TypeError, ValueError):
                continue
            p = st["period"]
            if five and parse_date(p["begin_date"]) <= day <= parse_date(p["end_date"]):
                st["marks"].append((float(five), mk.get("weight") or 1))
    for st in students.values():
        w = sum(x[1] for x in st["marks"])
        st["avg"] = sum(v * k for v, k in st["marks"]) / w if w else None
    return students


def build_answers(m, students):
    questions = {}
    for st in students.values():
        par = st["parallel"]
        if par not in questions:
            qa = m.get("/api/soft_skills/v1/survey/questionsAnswers", **({"parallel": par} if par else {}))
            questions[par] = [(q["question_id"], grp["question_group_name"])
                              for grp in qa["question_groups"] for q in grp["questions"]]
        st["answers"] = {qid: answer_for(st["avg"], qid, cat, st["person_id"]) for qid, cat in questions[par]}


def main():
    ap = argparse.ArgumentParser(description="Автозаполнение soft skills в МЭШ")
    ap.add_argument("--apply", action="store_true", help="выставить (без флага — только показать)")
    ap.add_argument("--overwrite", action="store_true", help="перезаписать уже заполненные анкеты")
    ap.add_argument("--token", help="aupd_token из cookies school.mos.ru")
    ap.add_argument("--report", default="soft_skills_report.json", help="куда сохранить отчёт")
    a = ap.parse_args()

    token = a.token or os.environ.get("MESH_TOKEN")
    path = os.path.expanduser("~/.mesh_token")
    if not token and os.path.exists(path):
        token = open(path).read().strip()
    if not token:
        token = input("Токен (cookie aupd_token с school.mos.ru): ").strip()
    m = Mesh(token)

    teacher_id, teacher_name = find_teacher(m)
    year = current_year(m)
    print(f"👤 {teacher_name} (профиль {teacher_id}), учебный год {year['name']}")

    groups = my_groups(m, teacher_id, year)
    if not groups:
        sys.exit("❌ В расписании нет ваших уроков в этом учебном году.")
    print(f"📚 Ваши группы ({len(groups)}):")
    students = collect(m, year, groups)
    build_answers(m, students)

    pnames = {(s["period"] or {}).get("period_name") for s in students.values()}
    print(f"\n👥 Учеников: {len(students)} (одна анкета на ученика по всем вашим предметам); период: {', '.join(sorted(filter(None, pnames)))}")
    by_class = defaultdict(list)
    for st in students.values():
        by_class[st["class"]].append(st)
    for cls in sorted(by_class, key=lambda c: (len(c), c)):
        lst = sorted(by_class[cls], key=lambda s: s["name"])
        print(f"\n— {cls} ({len(lst)})")
        for st in lst:
            avg = f"{st['avg']:.2f}" if st["avg"] is not None else " —  "
            ans = "".join(ANSWER_SHORT[v] for _, v in sorted(st["answers"].items()))
            flag = "  [уже заполнено]" if st["filled"] else ""
            print(f"   {avg}  {ans}  {st['name']}{flag}")

    todo = [s for s in students.values() if s["period_id"] and (a.overwrite or not s["filled"])]
    no_period = sum(1 for s in students.values() if not s["period_id"])
    print(f"\nК выставлению: {len(todo)}; уже заполнено: {sum(s['filled'] for s in students.values())}; без периода: {no_period}")
    print("Ответы: В — почти всегда, Ч — часто, Р — редко, ? — нет оценок за период (затрудняюсь ответить)")

    ok = fail = 0
    if a.apply:
        for i, st in enumerate(todo, 1):
            body = {"student_person_id": st["person_id"], "period_id": st["period_id"],
                    "answers": [{"question_id": q, "answer_id": v} for q, v in st["answers"].items()]}
            try:
                m.req("POST", "/api/soft_skills/v1/survey", json=body)
                ok += 1; st["result"] = "ok"
            except Exception as e:
                fail += 1; st["result"] = f"error: {e}"
                print(f"   ❌ {st['name']}: {e}")
            if i % 20 == 0 or i == len(todo):
                print(f"   … {i}/{len(todo)}")
            time.sleep(0.15)
        print(f"\n✅ Выставлено: {ok}, ошибок: {fail}")
    else:
        print("\n(Ничего не отправлено. Запустите с --apply, чтобы выставить.)")

    with open(a.report, "w", encoding="utf-8") as f:
        json.dump({"teacher": teacher_name, "year": year["name"], "groups": groups,
                   "students": [{k: v for k, v in s.items() if k != "marks"} | {"marks": len(s["marks"])}
                                for s in students.values()]}, f, ensure_ascii=False, indent=1, default=str)
    print(f"📁 Отчёт: {a.report}")


if __name__ == "__main__":
    main()
