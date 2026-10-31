# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Druids is a sophisticated multi-agent system featuring four agent types (Druids, Elementals, Gaia, Worldtree) working together in a federated architecture with FULLY COMPLIANT Model Context Protocol (MCP) integration and a comprehensive web-based management interface.

**Key Architecture:** Production-ready concurrent session support with complete isolation between coordination sessions, enforced through a constitutional architecture defined in the "Concurrent Session Architecture (CONSTITUTIONAL)" sections below.

**Development Philosophy:** This project is Docker-first. All development, testing, and deployment workflows assume services run in Docker containers. This ensures consistent environments, proper service isolation, and eliminates "works on my machine" issues. Local npm commands are available but are NOT the primary workflow.

## Common Development Commands

**IMPORTANT:** This project uses Docker and docker-compose for all development and testing. All services run in containers with proper isolation, networking, and dependency management. Local npm commands are documented for reference but Docker is the primary workflow.

### First-Time Setup (Fresh Clone)

When you first clone the repository, the setup is automatic:

```bash
# 1. Clone the repo
git clone <repo-url>
cd druids

# 2. Copy environment template (if needed)
cp .env.example .env

# 3. Start everything - database initializes automatically
./scripts/dev.sh start

# 4. Verify health
./scripts/health.sh check
```

**What happens automatically:**
- PostgreSQL initializes with current schema from `docker/init.sql`
- Migrations run on app startup (if any are pending)
- Sample data is created (default realm and system coordinator)
- All services start and become healthy

### Database Management

**Reset to Clean State (if needed):**
```bash
# Complete database reset (DELETES ALL DATA)
./scripts/db-reset.sh

# This will:
# 1. Stop all services
# 2. Delete PostgreSQL volume
# 3. Restart with fresh database from docker/init.sql
```

**When to reset:**
- After pulling schema changes from another developer
- When database is in an inconsistent state
- When testing fresh installation flow
- When you want to start completely clean

For detailed database management, see [DATABASE_SETUP.md](docs/DATABASE_SETUP.md).

### Database Migrations

**Automatic Migration System:**
- Database migrations run automatically on app startup
- Migrations are versioned (001, 002, 003, etc.)
- System tracks which migrations have been applied
- Only pending migrations run

**Creating a New Migration:**
```bash
# 1. Create migration file
touch src/database/migrations/002_add_feature.sql

# 2. Write SQL (use transactions!)
cat > src/database/migrations/002_add_feature.sql << 'EOF'
-- Migration 002: Add feature X

BEGIN;

ALTER TABLE druids_core.agents
  ADD COLUMN IF NOT EXISTS new_field TEXT;

COMMIT;
EOF

# 3. Restart app - migration runs automatically
docker-compose restart druids-app

# 4. Check logs to verify
docker logs druids-app | grep Migration
```

**Migration Best Practices:**
- Use transactions (`BEGIN;` / `COMMIT;`)
- Use `IF NOT EXISTS` for idempotency
- Keep migrations small and focused
- Never modify migrations after they're applied
- See `src/database/migrations/README.md` for full guide

### Quick Reference (Most Common Commands)
```bash
# Start everything
./scripts/dev.sh start

# View logs
docker logs druids-app -f
docker logs druids-mcp -f

# Run tests
docker-compose exec druids-app npm test

# Type check
docker-compose exec druids-app npm run type-check

# Rebuild after code changes
docker-compose build druids-app --no-cache && docker-compose --env-file .env up -d druids-app

# Health check
./scripts/health.sh check
```

### Docker Environment Management (PRIMARY WORKFLOW)
```bash
# Start all services (auto-downloads Ollama model on first run)
./scripts/dev.sh start

# Stop all services
./scripts/dev.sh stop

# Restart specific service after code changes
docker-compose restart druids-app
docker-compose restart druids-mcp
docker-compose restart druids-ui

# Rebuild and restart service with code changes (use --no-cache if changes not appearing)
docker-compose build druids-app --no-cache
docker-compose --env-file .env up -d druids-app

docker-compose build druids-mcp --no-cache
docker-compose --env-file .env up -d druids-mcp

docker-compose build druids-ui --no-cache
docker-compose --env-file .env up -d druids-ui

# View service logs
./scripts/dev.sh logs [service-name]
docker logs druids-app -f
docker logs druids-mcp -f
docker logs druids-ui -f

# Check system health
./scripts/health.sh check
./scripts/health.sh detailed

# View running containers
docker-compose ps

# Execute commands inside containers
docker-compose exec druids-app npm run type-check
docker-compose exec druids-app npm run lint
```

**IMPORTANT:** All `docker-compose up` commands MUST include `--env-file .env` to load environment variables properly. The `./scripts/dev.sh` helper script handles this automatically.

### Testing (Docker-based)
```bash
# Run tests in Docker containers (recommended)
docker-compose exec druids-app npm test
docker-compose exec druids-app npm run test:contract
docker-compose exec druids-app npm run test:integration
docker-compose exec druids-app npm run test:unit

# Test coverage
docker-compose exec druids-app npm run test:coverage

# Alternative: Use test script (starts containers if needed)
./scripts/test.sh
```

### Development Inside Containers
```bash
# Type checking
docker-compose exec druids-app npm run type-check

# Linting
docker-compose exec druids-app npm run lint
docker-compose exec druids-app npm run lint:fix

# Build TypeScript
docker-compose exec druids-app npm run build

# Frontend build
docker-compose exec druids-ui npm run build
```

### Local Development (Outside Docker - Advanced Use Cases Only)
These commands are for development outside Docker containers, which is NOT the recommended workflow:

```bash
# Install dependencies locally
npm install

# Run development server locally (requires Redis, Postgres, Ollama locally)
npm run dev

# Type checking locally
npm run type-check

# Linting locally
npm run lint

# Run tests locally (requires all services running)
npm test

# Note: The MCP server is designed to run in Docker (druids-mcp container)
# Standalone mode is not the primary workflow
npm run mcp:server  # Only for special debugging scenarios
```

## High-Level Architecture

### Triple-Server Architecture
The system runs three independent servers:

1. **Main API Server** (port 3000): Internal REST API for system management (CRUD operations on agents, realms, coordination sessions)
2. **MCP Server** (port 3003): External client integration via JSON-RPC 2.0 over HTTP/SSE - FULLY COMPLIANT with MCP specification
3. **Frontend UI** (port 3004): React-based management interface with Tailwind CSS

### Agent Types and Coordination
Four distinct agent types work in federated realms:

- **Druids**: Coordination agents with persona-driven decision making, can travel between realms
- **Elementals**: Domain specialists bound to a single realm with configurable expertise profiles
- **Gaia**: Meta-agents for ecosystem health monitoring and optimization
- **Worldtree**: Collective knowledge repository with namespace-based access control

### Concurrent Session Architecture (CONSTITUTIONAL)
The system enforces mandatory session isolation through three-layer architecture:

1. **SessionAgentManager**: Agent state isolation per coordination session
2. **TaskQueueManager**: Task and concurrency management per session
3. **SessionContentManager**: Content storage isolation per session

**CRITICAL**: Any changes to coordination, agent state, or content management MUST preserve session isolation. See "Critical Development Rules > 1. Concurrent Session Architecture (CONSTITUTIONAL)" below for the full set of immutable architectural principles, including the list of protected files.

### Service Layer Design
Services follow a stateless pattern - NO session-specific state stored in service classes. All session state must exist in session-scoped managers created during coordination.

Pattern:
```typescript
// CORRECT - session creation with isolation
const sessionAgentManager = new SessionAgentManagerImpl(sessionId);
const sessionContentManager = new SessionContentManagerImpl(config);

if (!coordinatorConcurrencyManager.canStartSession(coordinatorId)) {
  throw new Error('Coordinator at maximum concurrent sessions');
}
coordinatorConcurrencyManager.startSession(sessionId, coordinatorId, ...);
```

### LLM Integration
Agents support two LLM providers:
- **Ollama** (default): Local LLM with qwen2.5:1.5b model (~1.5GB)
- **OpenAI**: Cloud-based integration via API

LLM configuration includes:
- Agentic loop support (iterative tool calling with max iterations)
- Token optimization strategies (summarization, sliding window, result truncation)
- Named model configurations via ModelRegistryService

### Knowledge Namespace Security
Hierarchical access control:
```
agent://{agentId}/private/     # Agent-only access
agent://{agentId}/public/      # Read-only for others
worldtree://public/           # Shared knowledge base
worldtree://private/{agentId}/ # Private agent storage in shared system
```

### MCP Protocol Compliance

**CRITICAL MCP ENDPOINT RULE:**
- ALL MCP requests MUST use `/mcp` endpoint: `http://localhost:3003/mcp`
- NEVER use root endpoint `/` - returns HTML error pages
- Session IDs returned in `Mcp-Session-Id` response header, NOT in JSON body

**MCP Response Format Standards:**
- `tools/call` must return `{ content: [{ type: "text", text: "..." }] }`
- Tool handlers return plain data, not wrapper objects with metadata
- Errors thrown in tool handlers, not returned as error objects

**Testing MCP Changes:**
- Always test with curl commands before external client integration
- Use test scripts: `test_mcp_session.sh` and `test_enhanced_coordination.sh`
- Monitor logs: `docker logs druids-mcp -f`

### Frontend Architecture
React 18 + TypeScript + Vite + Tailwind CSS with:

**API Integration (REST):**
- REST API for all operations — CRUD (agents, realms, models) and coordination execution (`/api/coordinators/.../coordinate`)
- The MCP server (JSON-RPC 2.0) is a surface for *external* MCP clients (e.g. Goose), not the web UI

**Component Pattern:**
- Page components handle state and API calls
- UI components focus on presentation
- Shared API client in `frontend/src/services/api.ts`

**Data Mapping:**
Frontend uses flat structures, backend expects nested:
```typescript
// Frontend form data
{ name, description, domain, systemPrompt }

// Backend expects
{
  name,
  description,
  specialization: { domain },  // Nested
  llmConfig: { systemPrompt }   // Nested
}
```

### Docker Services
Core services in Docker Compose:
- **druids-app** (port 3000): Main API server
- **druids-mcp** (port 3003): MCP server for external clients
- **druids-ui** (port 3004): Frontend React app
- **druids-redis** (port 6379): Cache and session storage
- **druids-postgres** (port 5432): Persistent data storage
- **druids-ollama** (port 11434): Local LLM (qwen2.5:1.5b)
- **druids-prometheus** (port 9090): Metrics collection
- **druids-grafana** (port 3002): Monitoring dashboards

### Testing Strategy
Three test categories with different timeout configurations:

1. **Contract Tests** (`tests/contract/`): MCP protocol compliance, 5s timeout
2. **Integration Tests** (`tests/integration/`): Multi-agent scenarios, 15s timeout
3. **Unit Tests** (`tests/unit/`): Component isolation, 10s timeout

All tests use `tests/setup.ts` for environment configuration and mocked console methods.

## Critical Development Rules

### 1. Concurrent Session Architecture (CONSTITUTIONAL)
**NEVER VIOLATE THESE PRINCIPLES:**

- Session isolation is MANDATORY - no shared mutable state between sessions
- All coordination MUST use session-scoped managers (SessionAgentManager, TaskQueueManager, SessionContentManager)
- Services MUST be stateless - no session data in service instance variables
- Session creation MUST go through CoordinatorConcurrencyManager
- Every session MUST have proper cleanup in success/failure paths

Protected core files (REGRESSION FORBIDDEN):
- `src/models/SessionAgentState.ts`
- `src/models/TaskQueueState.ts`
- `src/models/SessionContentState.ts`
- `src/models/CoordinatorSessionState.ts`
- `src/services/SessionAgentManager.ts`
- `src/services/TaskQueueManager.ts`
- `src/services/SessionContentManager.ts`
- `src/services/CoordinatorConcurrencyManager.ts`

### 2. MCP Server Development
When modifying MCP server code:

1. **Always use `/mcp` endpoint** - this is a recurring issue
2. Code changes require no-cache Docker rebuild: `docker-compose build druids-mcp --no-cache`
3. Test with curl before external client integration
4. Monitor logs during testing: `docker logs druids-mcp -f`
5. Validate JSON-RPC 2.0 format in all responses
6. Session IDs come from response headers, not JSON body

### 3. Agent Service Integration
ALL LLM interactions MUST use `AgentService.executeAgentPrompt()`:
```typescript
const result = await agentService.executeAgentPrompt(agentId, {
  prompt: message,
  conversationContext?: string,
  sessionId?: string  // For session-scoped operations
});
```

### 4. TypeScript Strictness
Project uses strict TypeScript configuration:
- `noImplicitAny: true`
- `noUnusedLocals: true`
- `noUnusedParameters: true`
- `exactOptionalPropertyTypes: true`
- `noUncheckedIndexedAccess: true`

All code MUST pass type checking:
```bash
# In Docker (recommended)
docker-compose exec druids-app npm run type-check

# Or locally if developing outside Docker
npm run type-check
```

### 5. Async Result Management
Long-running agent tasks use async result system:
- Auto-detection based on complexity, length, or `force_async` flag
- Results stored in WorldTree namespace: `worldtree://public/async_results`
- Pattern: `{agentId}/{requestId}/status.json`

### 6. Realm Travel Pattern
Only Druids can travel between realms:
```typescript
// Elementals are bound to single realm
realmAccess: { boundRealmId: 'realm-123' }

// Druids can travel with permissions
realmAccess: {
  accessibleRealms: [...],
  allowRealmTravel: true,
  currentRealmId: 'current-realm'
}
```

### 7. Docker Development Requirements and Gotchas
**CRITICAL:** This project REQUIRES Docker for development. Do not attempt to run services directly with npm commands on your host machine - you will encounter missing dependencies (Redis, Postgres, Ollama).

Common Docker issues:
- **Code changes not appearing:** Rebuild with `--no-cache` flag: `docker-compose build druids-app --no-cache`
- **Service name errors:** Verify service names with `docker-compose ps` before restart commands
- **First startup slow:** Downloads 1.5GB Ollama model (5-15 minutes on first run)
- **Performance degradation:** Check container resource usage with `docker stats`
- **Port conflicts:** Ensure ports 3000-3004, 5432, 6379, 9090, 11434 are available
- **Stale containers:** Use `docker-compose down -v` to remove volumes and start fresh

**Best Practice:** When in doubt, full restart with rebuild:
```bash
./scripts/dev.sh stop
docker-compose build --no-cache
./scripts/dev.sh start  # Handles --env-file .env automatically
```

**Environment Variables:** The `.env` file contains critical configuration (database URLs, API keys, etc.). Always use `--env-file .env` with `docker-compose up` commands, or use the `./scripts/dev.sh` script which handles this automatically.

### 8. Built-In Resource Access Tools (File & URL)

All agents have access to five foundational tools with explicit opt-in permissions:

**Built-In Tools:**
1. `read_file` - Read content from `file:///` URLs
2. `write_file` - Write content to `file:///` URLs
3. `list_files` - List files and directories at a `file:///` URL (returns name, type, size, modified date)
4. `process_files_batch` - Process multiple files automatically with built-in iteration (eliminates manual looping)
5. `fetch_url` - Fetch content from `http://` and `https://` URLs

**Configuration:** Agents must explicitly configure `resourceAccess` with allowed locations:
```json
{
  "resourceAccess": {
    "allowedLocations": [
      "file:///app/data/**/*",              // All files in directory tree
      "file:///tmp/*.txt",                  // Wildcard: only .txt files
      "https://api.example.com/**",         // All API endpoints
      "https://specific.com/endpoint"       // Specific URL only
    ]
  }
}
```

**Wildcards:** `*` (single segment), `**` (multiple segments), `?` (single character)

**Host File Access:** Since agents run in Docker containers, `file:///` paths access the container filesystem by default. To grant access to host machine files:
1. Add volume mounts to `docker-compose.yml` (see commented examples in file)
2. Map host directories to `/app/host/*` in container
3. Grant agent permission to container paths (e.g., `file:///app/host/documents/**/*`)

**Documentation:**
- `docs/RESOURCE_ACCESS_TOOLS.md` - Complete usage guide with examples
- `docs/HOST_FILE_ACCESS.md` - Host file access setup and troubleshooting
- `docker-compose.host-access-example.yml` - Example configuration

### 9. Frontend-Backend Communication
- Frontend makes REST calls for all operations, including coordination execution
- The MCP JSON-RPC 2.0 surface is for external MCP clients (e.g. Goose), not the frontend
- Always map frontend flat structures to backend nested structures
- CORS configured for localhost ports 3000-3005

## Working with Claude on this codebase

Druids is public, and contributors will often use Claude Code (or another Claude-driven client) to prepare PRs. Several default Claude behaviors make those PRs hard to review: creating summary markdown files, refactoring adjacent code "while we're here," packaging multiple unrelated changes into one diff. The rules below exist to keep contributions surgical and reviewable.

**These rules are mandatory when working on this codebase and override default Claude behavior.**

### Scope rules

1. **One PR = one task.** If you find yourself fixing a second thing, file a follow-up issue. Don't bundle.
2. **No new markdown files** outside `docs/`, `specs/`, `.github/`, `.claude/`, or the project root whitelist (`README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CLAUDE.md`, `CHANGELOG.md`, `LICENSE`, `CODE_OF_CONDUCT.md`). Do not create `IMPLEMENTATION_SUMMARY.md`, `PLAN.md`, `NOTES.md`, or similar narrative artifacts. Reasoning belongs in the PR description, not in tracked files.
3. **No refactoring of unrelated code.** Renaming a variable, moving a helper, reformatting a file — these belong in their own PR. If you spot rot, file an issue; do not fold it into the current change.
4. **Default to editing existing files.** Creating a new file should require a specific reason that fits the task.

### What does not belong in public artifacts

Certain context about this project is operationally useful when assisting the maintainer in private conversations but **must not appear in repository files, commit messages, PR descriptions, issue threads, or any other public artifact**. This includes:

- **Funding context.** Grant program name, amounts, installment structure, assessment criteria, reviewer identities, internal grant narratives or status. Refer to the project's motivation in technical terms ("research direction," "architectural goal"), not in funding terms.
- **Commercial / venture-studio activity.** Specific business names, customer targets, revenue plans, go-to-market strategy. If a business built on top of Druids drives a feature requirement, describe the requirement generically ("vertical applications in domain X need Y").
- **Unannounced strategic positioning.** Pivots, foundation applications in flight, partnership discussions — until they are public, they are not in public docs.

When writing project documentation or commit/PR text, generalize. Examples:

| Don't write | Write instead |
|---|---|
| "The original grant pitch was X" | "The project's research direction is X" |
| "Driven by [our marketing business]'s needs" | "Driven by vertical applications such as marketing tooling" |
| "The grant team will assess..." | (omit — assessment context is not part of the technical doc) |
| "Load-bearing grant demo" | "Most consumer-facing artifact" / describe the technical role |

Generic *domain* examples (marketing, legal, learning, engineering) are fine as illustrative categories — they're universal. What stays confidential is the specific business, funding, or strategic context attached to those domains.

When in doubt, write the generic version. Internal-only context lives in places outside the repository (typically the maintainer's local notes); public artifacts under `docs/`, `README.md`, `CONTRIBUTING.md`, and PR/issue threads stay generic.

### Before declaring a task complete

1. Run `/pr-scope` to get a scope report on the working tree.
2. Run `docker compose exec druids-app npm run type-check`.
3. Run the relevant tests: `npm run test:unit` minimally, plus integration / contract / `test:session-protection` if your area requires them (see [CONTRIBUTING.md](CONTRIBUTING.md)).
4. **Run `/seam-audit` if the change touches a shared representation** — a migration, a type under `src/models/`, or an added/removed export. It enumerates every producer and consumer of what changed and reports the ones the diff fails to handle.
5. If anything is out of scope, revert it before opening the PR.

Step 4 is enforced rather than advisory: a `PreToolUse` hook blocks `git push` when the branch changes a representation and no audit covers the commit being pushed. It exists because the step *was* advisory and was skipped in three consecutive PRs, each time producing the same defect — a representation changed and a consumer of it went untraced. The hook stops the step being forgotten; it cannot judge whether the audit was thorough.

### Tooling provided

- `/pr-scope` — slash command that runs `git status` + `git diff --stat` and flags new files, `.md` additions, and out-of-scope edits.
- `pr-scope-auditor` — subagent that audits the current diff against a stated task description and returns PASS/FAIL.
- `/seam-audit` — runs the `seam-auditor` subagent over the branch diff and records the audit against the current commit, satisfying the pre-push gate. Amending a commit invalidates the record.
- `.claude/hooks/require-seam-audit.sh` — the gate itself. Narrow by design: silent on body-only edits, tests and docs, because a gate that fires on every PR gets switched off, which is worse than no gate.
- `.claude/settings.example.json` — opt-in hook bundle that *enforces* the markdown-creation rule via `PreToolUse`. Copy to `.claude/settings.local.json` to enable. See [CONTRIBUTING.md](CONTRIBUTING.md) for the one-line opt-in.

## Project Structure Reference

```
src/
├── app.ts                      # Main Express app with dual-server setup
├── index.ts                    # Entry point with graceful shutdown
├── models/                     # Data models and interfaces
│   ├── Agent.ts                # Agent types and configurations
│   ├── Realm.ts                # Realm federation model
│   ├── SessionAgentState.ts    # 🛡️ PROTECTED: Agent session isolation
│   ├── TaskQueueState.ts       # 🛡️ PROTECTED: Task queue management
│   ├── SessionContentState.ts  # 🛡️ PROTECTED: Content isolation
│   └── CoordinatorSessionState.ts # 🛡️ PROTECTED: Coordinator concurrency
├── services/                   # Business logic and integrations
│   ├── AgentService.ts         # Agent lifecycle, LLM integration, policy
│   ├── CoordinationService.ts  # Multi-agent workflow coordination
│   ├── SessionAgentManager.ts  # 🛡️ PROTECTED: Agent state isolation impl
│   ├── TaskQueueManager.ts     # 🛡️ PROTECTED: Task queue impl
│   ├── SessionContentManager.ts # 🛡️ PROTECTED: Content storage impl
│   ├── CoordinatorConcurrencyManager.ts # 🛡️ PROTECTED: Concurrency tracking
│   ├── OllamaClient.ts         # Ollama LLM integration
│   ├── OpenAIClient.ts         # OpenAI LLM integration
│   └── RealmService.ts         # Federated realm management
├── mcp/                        # MCP-compliant servers
│   ├── SimpleMCPServer.ts      # External client integration (JSON-RPC 2.0)
│   └── start-mcp-server.ts     # Standalone MCP server launcher
└── api/                        # REST API routes
    ├── agents.ts               # Agent CRUD endpoints
    ├── coordinators.ts         # Coordination session endpoints
    ├── realms.ts               # Realm management endpoints
    └── models.ts               # Model registry endpoints

frontend/
├── src/
│   ├── pages/                  # React page components
│   │   ├── AgentManagement.tsx
│   │   ├── RealmManagement.tsx
│   │   ├── ModernCoordinationManagement.tsx
│   │   └── Dashboard.tsx
│   ├── components/             # Reusable UI components
│   ├── services/api.ts         # Axios client (REST + MCP)
│   └── App.tsx                 # Main React app with routing
└── package.json                # React 18 + Vite + Tailwind

tests/
├── contract/                   # MCP protocol compliance (5s timeout)
├── integration/                # Multi-agent scenarios (15s timeout)
├── unit/                       # Component isolation (10s timeout)
└── setup.ts                    # Test environment configuration

scripts/
├── dev.sh                      # Docker development management
├── test.sh                     # Testing script
└── health.sh                   # System health checks

docs/
├── MCP_COMPLIANCE_CONSTITUTION.md      # 🛡️ MCP architectural constitution
├── MCP_CLIENT_CONFIGURATION.md         # MCP integration guide
├── BORIS_CHERNY_WORKFLOW_DESIGN.md    # Multi-project workflow design
└── OpenAI-Integration.md               # OpenAI LLM setup
```

## Development Workflow Best Practices

### When Making Changes to Coordination
1. Review the "Concurrent Session Architecture (CONSTITUTIONAL)" section above and "Critical Development Rules > 1." below first
2. Ensure changes preserve session isolation
3. Test with concurrent coordination scenarios
4. Verify cleanup in both success and failure paths

### When Modifying MCP Server
1. Use `/mcp` endpoint for all testing (NOT `/`)
2. Make code changes
3. Rebuild without cache: `docker-compose build druids-mcp --no-cache`
4. Restart service: `docker-compose --env-file .env up -d druids-mcp`
5. Test with curl before external client
6. Monitor logs: `docker logs druids-mcp -f`

### When Adding New Agent Types
1. Update `AgentType` enum in `src/models/Types.ts`
2. Add type-specific configuration models
3. Update `AgentService` validation logic
4. Add UI components in frontend
5. Update API routes and validation schemas
6. Add integration tests for new agent behavior

### When Changing LLM Integration
1. Changes to `AgentService.executeAgentPrompt()` affect entire system
2. Test with both Ollama and OpenAI providers
3. Verify agentic loop behavior if modified
4. Check token optimization strategies
5. Update model registry if adding new models

### Docker Development Iteration Workflow
Standard development cycle when making code changes:

```bash
# 1. Make code changes in your editor

# 2. For hot-reload changes (if supported by service):
docker-compose restart druids-app

# 3. For changes requiring rebuild:
docker-compose build druids-app --no-cache
docker-compose --env-file .env up -d druids-app

# 4. Verify changes:
docker logs druids-app -f
./scripts/health.sh check

# 5. Run type checking:
docker-compose exec druids-app npm run type-check

# 6. Run tests:
docker-compose exec druids-app npm run test:unit
docker-compose exec druids-app npm run test:integration

# Complete iteration cycle with all services:
./scripts/dev.sh stop
docker-compose build --no-cache  # Rebuild all services
./scripts/dev.sh start            # Handles .env automatically
./scripts/health.sh check
docker-compose exec druids-app npm test
```

**Key Principles:**
- Never run `npm start`, `npm run dev`, or `npm test` directly on your host machine. Always use Docker containers via `docker-compose exec` or `docker-compose run`.
- Always include `--env-file .env` flag when using `docker-compose up` directly (the `./scripts/dev.sh` script handles this automatically).

## Common Issues and Solutions

### Issue: Services failing to start or environment variables not loaded
**Root Cause:** Missing or incorrect `.env` file, or `docker-compose up` called without `--env-file .env`
**Solution:**
```bash
# Ensure .env file exists in project root
ls -la .env

# Always use --env-file flag with docker-compose up
docker-compose --env-file .env up -d

# Or use the helper script which handles this automatically
./scripts/dev.sh start
```

### Issue: Code changes not appearing in containers
**Solution:** Rebuild with `--no-cache` flag and verify service name with `docker-compose ps`

### Issue: MCP client serialization errors
**Root Cause:** Incorrect `tools/call` response format
**Solution:** Return `{ content: [{ type: "text", text: JSON.stringify(data) }] }` not raw data

### Issue: Session isolation failures
**Root Cause:** Shared mutable state or bypassing session managers
**Solution:** Review the "Concurrent Session Architecture (CONSTITUTIONAL)" and "Critical Development Rules > 1." sections of this file, and use session-scoped managers

### Issue: Frontend data mapping errors
**Root Cause:** Flat frontend structure vs nested backend structure
**Solution:** Always map form data to nested backend structure (see Data Mapping Pattern above)

### Issue: Test timeouts
**Root Cause:** Wrong test category or expensive operations
**Solution:** Use correct test directory (contract=5s, unit=10s, integration=15s)

### Issue: Ollama model not loading
**Solution:**
```bash
./scripts/health.sh detailed
./scripts/dev.sh logs druids-ollama
./scripts/dev.sh pull-model  # Manually pull if needed
```

## Access Points When Running

- Main API: http://localhost:3000
- MCP Server: http://localhost:3003/mcp
- Frontend UI: http://localhost:3004
- Grafana: http://localhost:3002 (admin:druids_admin)
- Prometheus: http://localhost:9090

## Documentation References

For detailed information, see:
- `README.md` - Comprehensive project overview and setup
- `.github/copilot-instructions.md` - Additional development guidelines
- `docs/MCP_CLIENT_CONFIGURATION.md` - MCP integration guide
- `docs/BORIS_CHERNY_WORKFLOW_DESIGN.md` - Multi-project workflow patterns
- `docs/OpenAI-Integration.md` - OpenAI LLM configuration
