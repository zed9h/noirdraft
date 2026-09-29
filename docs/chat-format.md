# NoirDraft CHAT convention

CHAT remains ordinary Markdown. The chat pane projects complete KoboldCpp-style turns as a history and keeps the composer separate from the stored context.

The default convention is:

````markdown
{{[INPUT]}}
This reaction explains too much.
{{[OUTPUT]}}
The second sentence states the emotion explicitly.

{{[INPUT]}}
Rewrite it without naming the emotion.
{{[OUTPUT]}}
The second sentence states the emotion explicitly.
````

In the complete project file these lines sit below `# CHAT`. The context marker can pin the oldest turn to replay; otherwise the configured recent-turn count is used and its ghost marker shows the range. Authors can edit the stored source in any text editor. Notes outside complete turn pairs are preserved but are not sent to the model.

A turn's peak context-size figure and any context-budget warnings (see PLAN.md §20.1) are session diagnostics only, shown live on the turn while the app is open — like the raw request/response inspection, they are never written into this stored format.
