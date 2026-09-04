# Active renderer entry

Production and packaged builds use `index.html` → `src/legacy-main.tsx` → `src/legacy-style.css` plus `src/legacy/*`. The filenames are retained temporarily to limit UI churn; they do not indicate support for an older plugin, Host API, or stored-data contract.

The entry reads the current workspace, registers only the user's explicit selection, preserves missing-file diagnostics, and starts current task-chain reconciliation. It does not poll storage/project migrations or infer old paths.
