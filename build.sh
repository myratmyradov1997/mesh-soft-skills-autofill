#!/bin/sh
# Собирает скрипт Tampermonkey и архив расширения из extension/softskills.js
set -e
cd "$(dirname "$0")"
{
  cat <<'HDR'
// ==UserScript==
// @name         МЭШ Автозаполнение Soft Skills
// @namespace    https://github.com/myratmyradov1997/mesh-soft-skills-autofill
// @version      3.0
// @description  Выставляет soft skills всем ученикам учителя в МЭШ по среднему баллу
// @match        https://school.mos.ru/*
// @grant        none
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/myratmyradov1997/mesh-soft-skills-autofill/main/mesh_soft_skills_autofill_pro.user.js
// @updateURL    https://raw.githubusercontent.com/myratmyradov1997/mesh-soft-skills-autofill/main/mesh_soft_skills_autofill_pro.user.js
// ==/UserScript==

HDR
  cat extension/softskills.js
} > mesh_soft_skills_autofill_pro.user.js
rm -f mesh-soft-skills-extension.zip
(cd extension && zip -q -r ../mesh-soft-skills-extension.zip . -x '.*')
echo "OK: mesh_soft_skills_autofill_pro.user.js, mesh-soft-skills-extension.zip"
