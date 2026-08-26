# Active renderer entry

Production and packaged builds use only `index.html` → `src/legacy-main.tsx` →
`src/legacy-style.css` plus `src/legacy/*`.

The retired `src/main.tsx` and `src/style.css` migration reference was removed so
it cannot reintroduce a second sticky task-notification surface. Visual-contract
tests inspect the active legacy entry only.
