# macOS GUI QA checklist

This checklist complements automated tests; it is not evidence of hands-on macOS validation.

- Start Claudia from `start-claudia.command`; confirm macOS asks for any expected Terminal or notification permissions.
- Verify footer shortcuts use `⌘`, then try `⌘+Enter`, `⌘+K`, `⌘+U`, and `⌘+1` from both the board and a focused prompt field.
- Click **Browse**. Confirm the native folder chooser appears, supports `⌘`-click multi-selection, returns every selected POSIX path, and cancel restores **Browse** without an error.
- With a recent working directory available, open the picker and confirm it starts in that directory. Try a path containing spaces and a quote if your filesystem permits it.
- Create a finish chain containing **Notify me**, **Sleep displays**, **Run wrap-up script**, and **Shut down host**. Check the preview names `osascript`, `pmset displaysleepnow`, the user-local `bin/wrapup.sh`, and `shutdown -h now`; do not execute shutdown on a production machine.
- Exercise a non-destructive chain in a disposable project and confirm a failed wrap-up script stops later actions and reports its failure.
