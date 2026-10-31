# Project experiences

## Four-view viewport

- Replaced the single perspective viewport with synchronized Front, Top, Left, and Right orthographic views rendered through one WebGL renderer.
- Playwright exposed a toolbar overlap when a pane was maximized: the global Focus button intercepted the restore button. Moving the toolbar below the pane title fixed the interaction.
- Browser coverage checks view labels, maximize/restore, joint picking, and gizmo dragging in all four views.
- Four concurrent browser workers caused WebGL timeouts; limiting Playwright to two workers made the full suite reliable.
- The complete unit and Playwright suites passed after these fixes.
