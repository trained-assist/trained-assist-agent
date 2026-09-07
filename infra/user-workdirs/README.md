# User Workdir Templates

CLAUDE.md templates for agent user workdirs (`$USERS_DIR/{username}/`).

When Claude runs a task, it uses the user's workdir as `cwd`. If a `CLAUDE.md` exists there,
Claude reads it as project-level context. These templates provide the canonical content.

## Deploying

```bash
cp infra/user-workdirs/misha/CLAUDE.md /home/vova/users/misha/CLAUDE.md
```

The server will also auto-generate `skills/profile-layout.md` on each task startup —
that file is ephemeral and not versioned here.
