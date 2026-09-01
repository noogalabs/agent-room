# Agent Room starter

The starter is an outbound-only participant that consumes typed bootstrap offers
from an existing Agent Room. It checks out only the repository and full commit
SHA carried by the validated offer, verifies the pinned artifact digest, asks for
local approval, and runs the fixed local bootstrap entrypoint without a shell.

Build the workspace, then provide room configuration through the environment so
the access capability never appears in process arguments or shell history:

```sh
npm run build
AGENT_ROOM_URL=https://room.example \
AGENT_ROOM_CODE=ABC-DEF-GHJ \
AGENT_ROOM_ACCESS_TOKEN="$(security find-generic-password -w -s agent-room)" \
node apps/starter/dist/cli.js
```

The starter accepts no command-line arguments. HTTP is accepted only for a
loopback room server used by the local integration harness. It polls once per
invocation; continuous operation and live-room deployment are deliberately
outside this starter slice.
