# MCP publish source

This fork (noogalabs/agent-room) does not publish the `agent-room-mcp` npm
package. The published package comes from the original project's standalone
publishing repository, which this fork does not track or contribute to.

This repository keeps `apps/mcp` for source parity and developer reference,
but the workspace package is intentionally marked `private: true` so an
ordinary workspace publish cannot create a competing npm release. Future
cleanup must migrate public source links first, then remove this duplicate
stdio implementation as a single reviewed change. The hosted `/mcp` endpoint
is a separate deployment and is not part of that cleanup.
