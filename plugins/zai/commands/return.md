---
description: Return a zai job to GLM with specific feedback
argument-hint: "<job-id> <feedback>"
allowed-tools: Bash(node:*)
---

Return zai job with feedback: $ARGUMENTS

The worker resumes its own session with this feedback and then goes through verification again. Make the feedback
specific and actionable before sending it:

- One numbered item per problem: `file:line`, what is wrong, what correct looks like.
- Name the failing gate or the brief's done-criterion each item violates.
- Say what to keep, so correct work is not redone; say what to revert if the change went out of scope.
- No praise, no restating the whole brief, no open questions.

If the user's text is vague ("fix it"), rewrite it into that form from the review packet, show the user the final
feedback, and send it. Pass the feedback as one single-quoted argument (write each `'` inside it as `'\''`) with
the Bash tool:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/zai.js" return <id> '<feedback>'
```

Report in one line that the job is running again and that `/zai:review <id>` applies once it is back in
`awaiting_review`.
