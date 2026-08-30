# PhotoFlow component UI contract

Use `application.settingsForm` for ordinary component preferences. PhotoFlow validates the declaration, renders native settings rows, applies defaults, and persists values through `component.settings` without loading component HTML.

When ordinary preferences also need account authorization, environment installation, or diagnostics, add `customPage` to the same `application.settingsForm`. PhotoFlow keeps one navigation item and renders the native form together with the isolated advanced region. Standalone `application.settingsPage` remains available for pages with no declarative fields. Custom pages should import `component-sdk/ui.css` and call `mountUiTheme()` from `component-sdk/index.js`.

UI contract version 1 provides design tokens and framework-free primitives for settings groups, rows, buttons, inputs, selects, switches, status badges, spinners, callouts, dialogs, and path-picker presentation. Custom pages can call `host.notify(...)` and `host.dialog(...)`; dialog file and directory results remain scoped tokens rather than raw persistent paths. Other behavior continues through versioned RPC and lifecycle APIs. CSS classes never grant capabilities.

Declarative field types in schema version 1 are `toggle`, `select`, `text`, `number`, and `range`. Values are stored under the field id in the component-owned settings object. Persistent filesystem paths are intentionally excluded because component input access uses scoped tokens instead of raw path disclosure.
