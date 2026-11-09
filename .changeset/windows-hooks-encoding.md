---
"dsh-lifecycle-hooks": patch
---

Windows support: hooks files are decoded by their byte-order mark (UTF-8 BOM, UTF-16 LE and BE), so a `.dsh/hooks.json` written by Notepad or PowerShell 5 no longer drops the whole layer; a broken rewrite still keeps the last valid layer and warns. Module hook extensions (`.mjs` / `.js`) are compared case-insensitively. The README documents that `run.command` runs in the host shell (pwsh on Windows) and that `match.tool` must name the tool the host actually mounts.

POSIX 上原本能加载的 hooks 文件照常工作；新增的是大小写不敏感的 module 扩展名与 BOM 解码，二者不改变既有文件的语义。