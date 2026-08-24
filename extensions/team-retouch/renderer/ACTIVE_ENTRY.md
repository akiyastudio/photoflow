# Active renderer entry

Production and packaged builds use only `index.html` → `src/legacy-main.tsx` →
`src/legacy-style.css` plus `src/legacy/*`.

`src/main.tsx` and `src/style.css` are retained as a non-production migration
reference. They are not imported by the HTML entry, are not a visual source of
truth, and visual-contract tests must inspect the active legacy entry instead.
