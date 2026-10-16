---
"@mcpjam/inspector": patch
---

A plugin's local stdio server now always starts from its verified bundle: one the backend marks as a plugin component is prepared even when its config names no `${PLUGIN_ROOT}`, so it gets `PLUGIN_ROOT`, a `PLUGIN_DATA` directory and, unless it declares a `cwd`, the plugin root as its working directory, locally and in a hosted box. `PLUGIN_ROOT` and `PLUGIN_DATA` are set after the component's own variables, so nothing can override them.
