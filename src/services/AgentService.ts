import { AgentId } from '../models/Types';
import {
  Agent,
  CreateAgentRequest,
  UpdateAgentRequest,
  AgentSummary,
  AgentQueryFilters,
  DruidPersona,
  RealmAccess
} from '../models/Agent';
import { AgentType } from '../models/Types';
import { identityService } from './IdentityService';
import { OllamaClient, ChatRequest, createDefaultOllamaConfig } from './OllamaClient';
import { OpenAIClient, OpenAIChatRequest, createDefaultOpenAIConfig } from './OpenAIClient';
import { PolicyEngine } from './PolicyEngine';
import { RepositoryManager } from './RepositoryManager';
import { getWorldTreeQueryService } from './WorldTreeQueryService';
import { RealmService } from './RealmService';
import { resolveSearchScope } from './searchScope';
import { isValidUUID, slugifyName, isRealmSentinel, REALM_SENTINEL_SLUG } from '../utils/uuidUtils';
import { grantRealmId, grantRealmIds, grantsIncludeRealm } from '../utils/realmGrants';
import { MCPConfigLoader } from './mcp/MCPConfigLoader';
import { HttpMCPClient } from './mcp/HttpMCPClient';
import { SSEMCPClient } from './mcp/SSEMCPClient';
import { PromptCompositionService } from './PromptCompositionService';
import { selectCarriedStep } from './CoordinationService';
import { PromptSourcesConfig } from '../models/PromptConfig';
import { getSessionPublicationService } from './SessionPublicationService';
import * as fs from 'fs/promises';
import * as path from 'path';

/** An agent's in-scope realm set for retrieval (global is always added by the query). */
function collectAgentRealms(ra?: RealmAccess): string[] {
  const realms = new Set<string>();
  if (ra?.boundRealmId) realms.add(ra.boundRealmId);
  if (ra?.currentRealmId) realms.add(ra.currentRealmId);
  // accessibleRealms may hold bare id strings or { realmId, ... } objects.
  for (const id of grantRealmIds(ra?.accessibleRealms)) realms.add(id);
  return Array.from(realms);
}

/**
 * Agent execution request for LLM operations
 */
interface AgentExecutionRequest {
  prompt: string;
  context?: any;
  systemPrompt?: string;
  temperature?: number;
  // Session ID for session-scoped state management (realm tracking, task queues)
  sessionId?: string;
  // Collaboration context for enhanced persona prompts
  collaborationContext?: {
    scenarioName?: string;
    scenarioType?: string;
    agentRole?: string;
    usePersonaPrompt?: boolean;
  };
}

/**
 * Agent execution response from LLM operations
 */
interface WorldTreeReference {
  documentId: string;
  source: string;
  title: string | null;
  sourceFormat: string | null;
  fetchedAt: string | null;
  checksum: string | null;
}

interface AgentExecutionResponse {
  response: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  executionTime: number;
  toolCalls?: AgentToolCall[];
  // Deterministic provenance: the WorldTree sources actually retrieved via
  // search_worldtree during this execution (not what the model chose to cite).
  references?: WorldTreeReference[];
  metadata?: {
    agenticLoop?: {
      enabled: boolean;
      iterations: number;
      maxIterations: number;
    };
  };
}

/** Harvest deduped WorldTree references from this run's search_worldtree tool calls. */
function harvestWorldTreeReferences(toolCalls: AgentToolCall[]): WorldTreeReference[] {
  const byId = new Map<string, WorldTreeReference>();
  for (const tc of toolCalls) {
    if (tc.tool !== 'search_worldtree') continue;
    const passages = tc.result?.passages;
    if (!Array.isArray(passages)) continue;
    for (const p of passages) {
      const id = p?.documentId;
      if (!id || byId.has(id)) continue;
      byId.set(id, {
        documentId: id,
        source: p.source ?? '',
        title: p.title ?? null,
        sourceFormat: p.sourceFormat ?? null,
        fetchedAt: p.fetchedAt ? String(p.fetchedAt) : null,
        checksum: p.checksum ?? null,
      });
    }
  }
  return Array.from(byId.values());
}

/** Append a deterministic, citable References section reflecting what was retrieved. */
function appendReferencesSection(text: string, refs: WorldTreeReference[]): string {
  if (refs.length === 0) return text;
  const lines = refs.map((r, i) => {
    const label = r.title || r.source || r.documentId;
    const fetched = r.fetchedAt ? new Date(r.fetchedAt).toISOString().slice(0, 10) : 'unknown date';
    const sum = r.checksum ? r.checksum.slice(0, 12) : 'n/a';
    return `${i + 1}. ${label} — ${r.source} (WorldTree doc ${r.documentId.slice(0, 8)}, ${r.sourceFormat || 'doc'}, ingested ${fetched}, sha256:${sum})`;
  });
  return `${text}\n\n## References\n\n_Grounded in the WorldTree corpus (auto-generated from retrieved sources):_\n${lines.join('\n')}`;
}

/**
 * Agent tool call execution result
 */
interface AgentToolCall {
  tool: string;
  params: any;
  result: any;
  success: boolean;
  executionTime: number;
}

/**
 * Processed agent response with tool calls
 */
interface ProcessedAgentResponse {
  finalResponse: string;
  toolCalls: AgentToolCall[];
}

/**
 * Agent validation result
 */
interface AgentValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

/** A tool call located in an agent's response. */
export interface ExtractedToolCall {
  /** The whole span to replace, including the TOOL_CALL: prefix and any markdown wrapper. */
  raw: string;
  /** Just the JSON object, ready for JSON.parse. */
  json: string;
  /** Offset of the TOOL_CALL: prefix in the response. */
  index: number;
}

/**
 * Characters and tokens a model may put between `TOOL_CALL:` and the JSON.
 *
 * Models wrap tool calls in markdown unprompted — fenced blocks, bold, inline
 * code — and which ones they use varies by model, so this cannot be solved by
 * instructing them not to. Only the wrapper vocabulary is skipped: anything
 * else before the brace means this is prose rather than a tool call, and the
 * match is abandoned rather than scanning ahead for an unrelated `{`.
 */
const TOOL_CALL_WRAPPER = /^(?:[\s`*_~]|json\b)*/i;

/** Trailing fence/emphasis left after the closing brace, consumed so it is not orphaned. */
const TOOL_CALL_WRAPPER_END = /^[\s`*_~]*/;

/**
 * Locate tool calls in an agent's response.
 *
 * The JSON is delimited by brace counting rather than a regex, because tool
 * arguments routinely contain braces inside strings — a delegated task carrying
 * a brief, for instance.
 *
 * Previously the extracted span started immediately after `TOOL_CALL:`, so any
 * markdown the model emitted before the opening brace was fed to JSON.parse:
 *
 *     TOOL_CALL: **
 *     ```json
 *     { "tool": "delegate_task", ... }
 *
 *     -> SyntaxError: Unexpected token '*', "**\n```json"... is not valid JSON
 *
 * The brace counter had located the end correctly; only the start was wrong. A
 * dropped call is silent — the agent's structured intent is lost, it is not
 * retried, and the model carries on improvising — so a coordinator could lose
 * delegations and still report success.
 */
export function extractToolCalls(response: string): ExtractedToolCall[] {
  const found: ExtractedToolCall[] = [];
  const prefix = /TOOL_CALL:\s*/g;
  let prefixMatch: RegExpExecArray | null;

  while ((prefixMatch = prefix.exec(response)) !== null) {
    const afterPrefix = prefixMatch.index + prefixMatch[0].length;
    const skip = TOOL_CALL_WRAPPER.exec(response.slice(afterPrefix))?.[0].length ?? 0;
    const jsonStart = afterPrefix + skip;

    if (response[jsonStart] !== '{') {
      // Not a tool call — `TOOL_CALL:` appearing in prose, or a malformed one.
      continue;
    }

    let braceCount = 0;
    let inString = false;
    let escapeNext = false;
    let jsonEnd = -1;

    for (let i = jsonStart; i < response.length; i++) {
      const char = response[i];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (char === '\\') {
        escapeNext = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (char === '{') braceCount++;
        else if (char === '}') {
          braceCount--;
          if (braceCount === 0) {
            jsonEnd = i + 1;
            break;
          }
        }
      }
    }

    if (jsonEnd <= jsonStart) continue;

    // Consume a trailing fence or emphasis, but stop at the last wrapper
    // character rather than running on through the whitespace after it —
    // otherwise replacing `raw` with the tool result welds it to the next word.
    const trail = TOOL_CALL_WRAPPER_END.exec(response.slice(jsonEnd))?.[0] ?? '';
    const lastWrapper = Math.max(
      trail.lastIndexOf('`'),
      trail.lastIndexOf('*'),
      trail.lastIndexOf('_'),
      trail.lastIndexOf('~')
    );
    const trailing = lastWrapper >= 0 ? lastWrapper + 1 : 0;

    found.push({
      raw: response.substring(prefixMatch.index, jsonEnd + trailing),
      json: response.substring(jsonStart, jsonEnd),
      index: prefixMatch.index,
    });
  }

  return found;
}

/**
 * Decide the slug id a new agent will be identified by.
 *
 * Agents are identified by slug (migrations 016 and 018); the agents.id UUID is
 * a deployment-local surrogate that never surfaces above the repository. An
 * explicitly supplied id wins over the display name (after canonicalisation),
 * except when it is UUID-shaped (treated as a legacy surrogate), in which case a slug is derived from the name.
 *
 * The explicit id goes through the *same derivation* as a name rather than being
 * taken verbatim — which is what it used to be. `uq_agents_slug_id` is
 * case-sensitive, so "Facebook-Elemental" and "facebook-elemental" would have
 * been accepted as two distinct agents, and `resolveDbId` is an exact match
 * against that index, so a lookup under either spelling could miss the other.
 *
 * Normalising rather than rejecting is the deliberate choice, and the one
 * `RealmService.createRealm` already makes: a caller supplying a *name* already
 * gets it transformed, so a caller supplying an *id* should not instead meet an
 * error. The derivation is idempotent over its own output, so an
 * already-canonical slug passes through unchanged.
 *
 * Two shapes are rejected rather than normalised, because no normalisation makes
 * them usable as identity.
 *
 * @throws if no alphanumeric content is available to derive a slug from, or if
 *   the resulting slug has the shape of a UUID.
 */
export function resolveAgentSlugId(request: { id?: string; name: string }): string {
  const requestedSlug =
    request.id && !isValidUUID(request.id) ? slugifyName(String(request.id)) : undefined;
  const agentId = requestedSlug || slugifyName(request.name ?? '');

  // '-' is what a name of pure punctuation collapses to, since the derivation
  // deliberately does not trim. It satisfies the lowercase constraint but is not
  // an identity anyone can use, so it is refused alongside the empty string.
  if (!agentId || agentId === '-') {
    throw new Error(
      'Cannot derive an agent slug id: provide an id, or a name containing alphanumeric characters'
    );
  }

  // An agent *named* like a UUID derives a UUID-shaped slug, which every
  // resolver reads as the deployment-local surrogate rather than as identity —
  // AgentRepository.resolveDbId would look it up in the wrong column and miss.
  // Refused here with a comprehensible message, as on the realm path.
  if (isValidUUID(agentId)) {
    throw new Error(
      `"${agentId}" cannot be used as an agent id: it has the shape of an internal ` +
      'identifier. Choose a name or id that is not formatted as a UUID.'
    );
  }

  return agentId;
}

/**
 * Agent Service for managing agent lifecycle, LLM integration, and policy enforcement
 */
export class AgentService {
  private agents: Map<AgentId, Agent> = new Map();
  private repositoryManager: RepositoryManager | null = null;
  private ollamaClient: OllamaClient;
  private openaiClient: OpenAIClient | null = null;
  private policyEngine: PolicyEngine;
  private realmService: RealmService;
  private mcpConfigLoader: MCPConfigLoader;
  private mcpClients: Map<string, HttpMCPClient | SSEMCPClient> = new Map();
  private coordinationService?: any; // Avoid circular import, set via setter
  private promptCompositionService: PromptCompositionService | null = null;

  constructor(ollamaClient?: OllamaClient, policyEngine?: PolicyEngine, openaiClient?: OpenAIClient) {
    this.ollamaClient = ollamaClient || new OllamaClient(createDefaultOllamaConfig());
    this.policyEngine = policyEngine || new PolicyEngine();
    this.realmService = new RealmService();
    
    // Initialize OpenAI client if API key is available
    try {
      this.openaiClient = openaiClient || new OpenAIClient(createDefaultOpenAIConfig());
    } catch (error) {
      console.warn('OpenAI client not initialized (API key missing):', error instanceof Error ? error.message : 'Unknown error');
    }

    // Initialize MCP config loader
    this.mcpConfigLoader = new MCPConfigLoader();
    this.initializeMCPConfig();

    // Initialize prompt composition service
    this.initializePromptComposition().catch(error => {
      console.warn('Failed to initialize prompt composition:', error instanceof Error ? error.message : 'Unknown error');
    });

    this.initializeSystemAgents();

    // Initialize service with dual persistence
    this.initializeService().catch(error => {
      console.warn('Failed to initialize AgentService with database:', error instanceof Error ? error.message : 'Unknown error');
    });
  }

  /**
   * Initialize MCP configuration
   */
  private async initializeMCPConfig(): Promise<void> {
    try {
      await this.mcpConfigLoader.load();

      // Watch for config changes (hot reload) in non-test environments
      if (process.env['NODE_ENV'] !== 'test') {
        this.mcpConfigLoader.watch();
      }

      console.log('✅ MCP config initialized');
    } catch (error) {
      console.error('❌ Failed to initialize MCP config:', error);
      // Continue without MCP support
    }
  }

  /**
   * Initialize prompt composition service
   */
  private async initializePromptComposition(): Promise<void> {
    try {
      // Load prompt sources configuration
      const configPath = path.join(process.cwd(), 'config', 'prompt-sources.json');
      const configContent = await fs.readFile(configPath, 'utf-8');
      const config: PromptSourcesConfig = JSON.parse(configContent);

      this.promptCompositionService = new PromptCompositionService(config);
      console.log('✅ Prompt composition service initialized');
    } catch (error) {
      console.error('❌ Failed to initialize prompt composition:', error);
      // Continue without prompt composition (will use fallback behavior)
    }
  }


  /**
   * Normalise every realm reference on an agent's realmAccess to canonical
   * slugs before it is stored.
   *
   * Migration 021 rewrote the references already held; this stops new ones
   * arriving in the old form. A caller creating or updating an agent with a
   * pre-migration realm UUID would otherwise reintroduce it into
   * agents.realm_access and back onto /api/agents, and every grant, travel and
   * search check compares exactly — so the reference would be present but never
   * match.
   *
   * accessibleRealms is polymorphic: typed as { realmId, permissions, ... }
   * objects but historically written as plain id strings. Both are handled, and
   * object entries keep their metadata.
   */
  private async normalizeRealmAccess(realmAccess: any): Promise<any> {
    if (!realmAccess || typeof realmAccess !== 'object') {
      return realmAccess;
    }

    const toSlug = async (value: unknown): Promise<string | undefined> => {
      if (!value || typeof value !== 'string') return undefined;
      const resolved = await this.realmService.resolveRealmIds([value]);
      return resolved[0] ?? value;
    };

    const normalized: any = { ...realmAccess };

    for (const field of ['boundRealmId', 'currentRealmId'] as const) {
      if (normalized[field]) {
        const slug = await toSlug(normalized[field]);
        if (slug) normalized[field] = slug;
      }
    }

    if (Array.isArray(normalized.accessibleRealms)) {
      normalized.accessibleRealms = await Promise.all(
        normalized.accessibleRealms.map(async (entry: any) => {
          if (entry && typeof entry === 'object') {
            const slug = await toSlug(entry.realmId);
            return slug ? { ...entry, realmId: slug } : entry;
          }
          const slug = await toSlug(entry);
          return slug ?? entry;
        })
      );
    }

    return normalized;
  }

  /**
   * Set the RealmService instance (for shared service injection)
   */
  public setRealmService(realmService: RealmService): void {
    this.realmService = realmService;
    console.log('✅ RealmService instance injected into AgentService');
  }

  /**
   * Set the CoordinationService instance (for session-scoped realm tracking)
   */
  public setCoordinationService(coordinationService: any): void {
    this.coordinationService = coordinationService;
    console.log('✅ CoordinationService instance injected into AgentService');
  }

  private async initializeService(): Promise<void> {
    // Try to initialize database connection
    try {
      this.repositoryManager = await RepositoryManager.initialize();
      console.log('✅ Database connection established for AgentService');
      
      // Database is available - load from database as source of truth
      await this.loadAgentsFromDatabase();
    } catch (error) {
      console.warn('⚠️ Database connection failed, using Redis-only fallback mode:', error instanceof Error ? error.message : 'Unknown error');
      this.repositoryManager = null;
      
      // Only use Redis if database is unavailable (fallback mode)
      await this.loadAgentsFromStorage();
    }
  }

  private async loadAgentsFromDatabase(): Promise<void> {
    if (!this.repositoryManager) {
      return;
    }

    try {
      const dbAgents = await this.repositoryManager.agents.findAll();
      
      // The repository already returns agents keyed by their stored slug id, so
      // there is nothing to derive or map here. Identity comes from the database
      // rather than being recomputed from the display name on every load, which
      // is what previously made a rename silently change an agent's identity.
      for (const dbAgent of dbAgents) {
        this.agents.set(dbAgent.id, dbAgent);
        console.log(`🔄 Loaded agent ${dbAgent.id} from database`);
      }
      
      if (dbAgents.length > 0) {
        console.log(`✅ Loaded ${dbAgents.length} agents from database`);
      } else {
        console.log('⚠️ No agents found in database.');
      }
    } catch (error) {
      console.warn('Failed to load agents from database:', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  /**
   * Create a new agent with LLM configuration and policy validation
   */
  async createAgent(request: CreateAgentRequest): Promise<Agent> {
    // Validate agent configuration
    const validation = await this.validateAgentConfiguration(request);
    if (!validation.isValid) {
      throw new Error(`Agent validation failed: ${validation.errors.join(', ')}`);
    }

    // Check policy permissions for agent creation
    console.log('🔐 Checking access for agent creation:', {
      subjectId: 'system',
      subjectType: 'user',
      resourceType: 'agent',
      resourceId: request.id || 'new',
      operation: 'create',
      requestedAccess: 'write'
    });

    const accessDecision = await this.policyEngine.checkAccess({
      subjectId: 'system',
      subjectType: 'user',
      resourceType: 'agent',
      resourceId: request.id || 'new',
      operation: 'create',
      requestedAccess: 'write'
    });

    console.log('🔐 Access decision result:', accessDecision);

    if (!accessDecision.allowed) {
      throw new Error(`Access denied: ${accessDecision.reason}`);
    }

    const agentId = resolveAgentSlugId(request);

    if (request.id && agentId !== request.id && !isValidUUID(request.id)) {
      console.log(`🔄 Normalised requested agent id "${request.id}" to canonical slug "${agentId}"`);
    }

    const now = Date.now().toString();

    const agent: Agent = {
      id: agentId,
      type: request.type,
      name: request.name,
      description: request.description,
      status: 'inactive',
      capabilities: request.capabilities,
      specialization: request.specialization,
      personality: request.personality,
      mcpTools: request.mcpTools,
      toolPermissions: request.toolPermissions,
      llmConfig: request.llmConfig,
      resourceLimits: request.resourceLimits || {
        maxMemoryMB: 512,
        maxCpuPercent: 50,
        maxConcurrentTasks: 10,
        maxExecutionTimeMs: 300000
      },
      bindings: [],
      ...(request.resourceAccess && { resourceAccess: request.resourceAccess }),
      ...(request.realmAccess && { realmAccess: await this.normalizeRealmAccess(request.realmAccess) }),
      ...(request.promptConfig && { promptConfig: request.promptConfig }),
      tags: request.tags || [],
      metadata: request.metadata || {},
      createdAt: now,
      updatedAt: now
    };

    this.agents.set(agentId, agent);
    
    // Write to database as single source of truth
    if (this.repositoryManager) {
      try {
        await this.repositoryManager.agents.create(agent);
        console.log(`💾 Stored agent ${agentId} in database`);
      } catch (error) {
        // Remove from memory cache if database write fails
        this.agents.delete(agentId);
        console.error('Failed to persist agent to database:', error instanceof Error ? error.message : 'Unknown error');
        throw error; // Fail fast - don't create agent if DB write fails
      }
    } else {
      console.warn('⚠️ Database unavailable, agent only stored in memory (will be lost on restart)');
    }

    // Update realm if agent has realm access
    if (agent.realmAccess) {
      try {
        if (agent.realmAccess.boundRealmId) {
          // For elemental agents, add to single bound realm
          const realm = await this.realmService.getRealm(agent.realmAccess.boundRealmId);
          if (realm) {
            // Update only the agentIds field to avoid schema issues
            const updatedAgentIds = realm.agentIds.includes(agentId) 
              ? realm.agentIds 
              : [...realm.agentIds, agentId];
            // Only update agentIds field to avoid field mapping issues
            await this.realmService.updateRealm(agent.realmAccess.boundRealmId, { 
              agentIds: updatedAgentIds 
            });
            console.log(`🌍 Added agent ${agentId} to bound realm ${agent.realmAccess.boundRealmId}`);
          }
        } else if (agent.realmAccess.accessibleRealms && agent.realmAccess.accessibleRealms.length > 0) {
          // For druid agents, add to all accessible realms
          // Read the id through the helper: entries may be bare strings, in
          // which case `.realmId` was undefined and getRealm(undefined) found
          // nothing — so a druid with string grants was never registered in any
          // of its accessible realms.
          for (const grant of agent.realmAccess.accessibleRealms) {
            const grantRealm = grantRealmId(grant);
            if (!grantRealm) continue;
            const realm = await this.realmService.getRealm(grantRealm);
            if (realm) {
              // Update only the agentIds field to avoid schema issues
              const updatedAgentIds = realm.agentIds.includes(agentId) 
                ? realm.agentIds 
                : [...realm.agentIds, agentId];
              // Only update agentIds field to avoid field mapping issues
              await this.realmService.updateRealm(grantRealm, {
                agentIds: updatedAgentIds
              });
              console.log(`🌍 Added agent ${agentId} to accessible realm ${grantRealm}`);
            }
          }
        }
      } catch (error) {
        console.warn(`⚠️ Failed to update realm with new agent ${agentId}:`, error instanceof Error ? error.message : 'Unknown error');
        // Don't fail agent creation if realm update fails - agent is still valid
      }
    }
    
    console.log(`✅ Created agent ${agentId} with database persistence`);
    return agent;
  }

  /**
   * Get an agent by ID with policy enforcement
   */
  async getAgent(agentId: AgentId, requesterId?: string): Promise<Agent> {
    // 1. Check memory first (fastest)
    let agent = this.agents.get(agentId);
    
    if (!agent) {
      // 2. Read from database as single source of truth
      if (this.repositoryManager) {
        try {
          const dbAgent = await this.repositoryManager.agents.findById(agentId);

          if (dbAgent) {
            agent = dbAgent;

            // Update memory cache
            this.agents.set(agentId, agent);
            console.log(`📥 Database hit: Loaded agent ${agentId} into memory cache`);
          }
        } catch (error) {
          console.warn('Database read failed:', error instanceof Error ? error.message : 'Unknown error');
        }
      } else {
        console.warn('⚠️ Database unavailable for agent lookup');
      }
    }
    
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    // Check read access
    if (requesterId) {
      const accessDecision = await this.policyEngine.checkAccess({
        subjectId: requesterId,
        subjectType: 'user',
        resourceType: 'agent',
        resourceId: agentId,
        operation: 'read',
        requestedAccess: 'read'
      });

      if (!accessDecision.allowed) {
        throw new Error(`Access denied: ${accessDecision.reason}`);
      }
    }

    return agent;
  }

  /**
   * List agents with optional filtering and access control
   */
  async listAgents(filters: AgentQueryFilters = {}, requesterId?: string): Promise<AgentSummary[]> {
    // Use in-memory agents (already loaded from database on startup)
    // No need to refresh from Redis on every call - prevents duplication
    let agents = Array.from(this.agents.values());
    console.log(`🔍 AgentService: Total agents in memory: ${agents.length}`);
    console.log(`🔍 AgentService: Agent IDs:`, agents.map(a => `${a.id}(${a.status})`));

    // Apply filters
    if (filters.type) {
      const types = Array.isArray(filters.type) ? filters.type : [filters.type];
      agents = agents.filter(agent => types.includes(agent.type));
    }

    if (filters.status) {
      const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
      agents = agents.filter(agent => statuses.includes(agent.status));
    }

    if (filters.realmId) {
      // Canonicalise the filter: agent realm references are slugs and this
      // comparison is exact, so a caller passing a pre-migration id would get
      // an empty result set rather than an error.
      const wanted = (await this.realmService.resolveRealmIds([String(filters.realmId)]))[0]
        ?? filters.realmId;
      agents = agents.filter(agent => {
        // Check the agent's realm through multiple possible sources
        const agentRealmId = (agent as any).realmId ||
                           agent.realmAccess?.currentRealmId ||
                           agent.realmAccess?.boundRealmId;
        return agentRealmId === wanted;
      });
    }

    if (filters.capabilities) {
      // Ensure capabilities is always an array
      const capabilities = Array.isArray(filters.capabilities) ? filters.capabilities : [filters.capabilities];
      
      // If capabilities array is empty, it means "any agent matches" (no capability requirements)
      // If capabilities array has items, agent must have at least one of the required capabilities
      if (capabilities.length > 0) {
        agents = agents.filter(agent => 
          capabilities.some(cap => agent.capabilities.includes(cap))
        );
      }
      // If capabilities array is empty ([]), no filtering is applied - all agents match
    }

    if (filters.domain) {
      agents = agents.filter(agent => 
        agent.specialization.domain === filters.domain
      );
    }

    if (filters.tags) {
      agents = agents.filter(agent => 
        filters.tags!.some(tag => agent.tags?.includes(tag))
      );
    }

    // Apply access control if requesterId provided
    if (requesterId) {
      const accessibleAgents: Agent[] = [];
      for (const agent of agents) {
        try {
          const accessDecision = await this.policyEngine.checkAccess({
            subjectId: requesterId,
            subjectType: 'user',
            resourceType: 'agent',
            resourceId: agent.id,
            operation: 'read',
            requestedAccess: 'read'
          });

          if (accessDecision.allowed) {
            accessibleAgents.push(agent);
          }
        } catch (error) {
          console.warn(`Access check failed for agent ${agent.id}:`, error);
        }
      }
      agents = accessibleAgents;
    }

    // Convert to AgentSummary format and sort alphabetically by name
    const summaries = agents.map(agent => {
      const summary: any = {
        id: agent.id,
        name: agent.name,
        type: agent.type,
        status: agent.status,
        capabilities: agent.capabilities,
        domain: agent.specialization.domain,
        lastActive: agent.updatedAt
      };
      
      // Include realmId from multiple possible sources
      const agentRealmId = (agent as any).realmId || 
                          agent.deployment?.realmId || 
                          agent.realmAccess?.currentRealmId || 
                          agent.realmAccess?.boundRealmId;
      if (agentRealmId) {
        summary.realmId = agentRealmId;
      }
      
      // Include realmAccess if it exists
      if (agent.realmAccess) {
        summary.realmAccess = agent.realmAccess;
      }
      
      return summary;
    });

    // Sort alphabetically by name (case-insensitive)
    summaries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

    return summaries;
  }

  /**
   * Update an agent with policy enforcement
   */
  async updateAgent(agentId: AgentId, updateData: UpdateAgentRequest, requesterId?: string): Promise<Agent> {
    const agent = await this.getAgent(agentId, requesterId);

    // Check update access
    if (requesterId) {
      const accessDecision = await this.policyEngine.checkAccess({
        subjectId: requesterId,
        subjectType: 'user',
        resourceType: 'agent',
        resourceId: agentId,
        operation: 'update',
        requestedAccess: 'write'
      });

      if (!accessDecision.allowed) {
        throw new Error(`Access denied: ${accessDecision.reason}`);
      }
    }

    // Resolve optional fields ahead of the object literal so we can conditionally
    // include them — exactOptionalPropertyTypes forbids assigning `undefined` to
    // a `?:`-declared field directly.
    const resolvedResourceAccess = updateData.resourceAccess !== undefined ? updateData.resourceAccess : agent.resourceAccess;
    const resolvedPromptConfig = updateData.promptConfig !== undefined ? updateData.promptConfig : agent.promptConfig;

    // Apply updates safely
    const updatedAgent: Agent = {
      ...agent,
      name: updateData.name || agent.name,
      description: updateData.description || agent.description,
      type: updateData.type || agent.type, // Add support for type updates
      status: updateData.status || agent.status, // Add support for status updates
      capabilities: updateData.capabilities || agent.capabilities,
      specialization: {
        ...agent.specialization,
        ...(updateData.specialization || {})
      },
      personality: {
        ...agent.personality,
        ...(updateData.personality || {})
      },
      mcpTools: updateData.mcpTools !== undefined ? updateData.mcpTools : agent.mcpTools,
      toolPermissions: updateData.toolPermissions || agent.toolPermissions,
      llmConfig: {
        ...agent.llmConfig,
        ...(updateData.llmConfig || {})
      },
      resourceLimits: updateData.resourceLimits || agent.resourceLimits,
      tags: updateData.tags !== undefined ? updateData.tags : (agent.tags || []),
      metadata: updateData.metadata !== undefined ? updateData.metadata : (agent.metadata || {}),
      updatedAt: Date.now().toString(),
      ...(resolvedResourceAccess !== undefined && { resourceAccess: resolvedResourceAccess }),
      ...(resolvedPromptConfig !== undefined && { promptConfig: resolvedPromptConfig }),
      ...(requesterId && { lastModifiedBy: requesterId }),
      // Replace realmAccess completely instead of merging to allow removing fields
      ...(updateData.realmAccess !== undefined && { realmAccess: await this.normalizeRealmAccess(updateData.realmAccess) as RealmAccess })
    };

    console.log(`🔍 DEBUG AgentService: Setting agent ${agentId} with realmAccess:`, updatedAgent.realmAccess);
    this.agents.set(agentId, updatedAgent);
    
    // Write-through cache: Database is source of truth, Redis is cache
    if (this.repositoryManager) {
      try {
        // Update first; if the agent is not in the database, create it. The
        // create is an upsert on the slug, so this fallback can no longer insert
        // a second row for an agent that already exists.
        const updateResult = await this.repositoryManager.agents.update(agentId, updatedAgent);
        if (updateResult === null) {
          console.log(`⚠️ Agent ${agentId} not found in database, creating new entry...`);
          await this.repositoryManager.agents.create(updatedAgent);
          console.log(`💾 Created agent ${agentId} in database`);
        } else {
          console.log(`💾 Updated agent ${agentId} in database`);
        }
        
        // Update cache on successful database write
        try {
          // Redis removed - database is single source of truth
          console.log(`🔄 Cache updated for agent ${agentId}`);
        } catch (cacheError) {
          console.warn(`⚠️ Cache update failed for agent ${agentId}:`, cacheError);
        }
      } catch (error) {
        console.error('Failed to persist agent to database:', error instanceof Error ? error.message : 'Unknown error');
        throw error; // Fail fast - don't update agent if DB write fails
      }
    } else {
      // Fallback to Redis-only if database unavailable
      console.warn('⚠️ Database unavailable, using Redis-only persistence');
      // Redis removed - database is single source of truth
    }
    
    console.log(`✅ Updated agent ${agentId} with write-through cache`);
    return updatedAgent;
  }

  /**
   * Start an agent with LLM initialization
   */
  async startAgent(agentId: AgentId, requesterId?: string): Promise<Agent> {
    const agent = await this.getAgent(agentId, requesterId);

    // Check control access
    if (requesterId) {
      const accessDecision = await this.policyEngine.checkAccess({
        subjectId: requesterId,
        subjectType: 'user',
        resourceType: 'agent',
        resourceId: agentId,
        operation: 'control',
        requestedAccess: 'admin'
      });

      if (!accessDecision.allowed) {
        throw new Error(`Access denied: ${accessDecision.reason}`);
      }
    }

    if (agent.status === 'active') {
      throw new Error(`Agent ${agentId} is already running`);
    }

    // Initialize LLM connection if configured
    if (agent.llmConfig.model) {
      await this.initializeLLMForAgent(agent);
    }

    const updatedAgent: Agent = {
      ...agent,
      status: 'active',
      deployment: {
        // A value is structurally required here (AgentDeployment.realmId), so
        // the reserved sentinel is used rather than a slug-shaped placeholder.
        realmId: agent.deployment?.realmId || REALM_SENTINEL_SLUG,
        deployedAt: Date.now().toString(),
        lastHeartbeat: Date.now().toString(),
        health: 'healthy',
        resourceUsage: {
          memoryMB: 0,
          cpuPercent: 0,
          activeTasks: 0,
          queuedTasks: 0
        },
        performance: {
          tasksCompleted: 0,
          averageTaskTime: 0,
          successRate: 1.0,
          errorCount: 0
        }
      },
      updatedAt: Date.now().toString(),
      ...(requesterId && { lastModifiedBy: requesterId })
    };

    this.agents.set(agentId, updatedAgent);
    
    // Persist status change to storage
    try {
      // Redis removed - database is single source of truth
    } catch (error) {
      console.warn('Failed to persist agent status change to storage:', error instanceof Error ? error.message : 'Unknown error');
    }
    
    return updatedAgent;
  }

  /**
   * Stop an agent
   */
  async stopAgent(agentId: AgentId, requesterId?: string): Promise<Agent> {
    const agent = await this.getAgent(agentId, requesterId);

    // Check control access
    if (requesterId) {
      const accessDecision = await this.policyEngine.checkAccess({
        subjectId: requesterId,
        subjectType: 'user',
        resourceType: 'agent',
        resourceId: agentId,
        operation: 'control',
        requestedAccess: 'admin'
      });

      if (!accessDecision.allowed) {
        throw new Error(`Access denied: ${accessDecision.reason}`);
      }
    }

    const updatedAgent: Agent = {
      ...agent,
      status: 'inactive',
      updatedAt: Date.now().toString(),
      ...(requesterId && { lastModifiedBy: requesterId })
    };

    this.agents.set(agentId, updatedAgent);
    
    // Persist status change to storage
    try {
      // Redis removed - database is single source of truth
    } catch (error) {
      console.warn('Failed to persist agent stop to storage:', error instanceof Error ? error.message : 'Unknown error');
    }
    
    return updatedAgent;
  }

  /**
   * Execute a prompt through an agent's LLM with optional agentic loop for iterative tool usage
   */
  async executeAgentPrompt(agentId: AgentId, request: AgentExecutionRequest, requesterId?: string): Promise<AgentExecutionResponse> {
    const agent = await this.getAgent(agentId, requesterId);

    if (agent.status !== 'active') {
      throw new Error(`Agent ${agentId} is not active`);
    }

    // Check execution access
    if (requesterId) {
      const accessDecision = await this.policyEngine.checkAccess({
        subjectId: requesterId,
        subjectType: 'user',
        resourceType: 'agent',
        resourceId: agentId,
        operation: 'execute',
        requestedAccess: 'admin'
      });

      if (!accessDecision.allowed) {
        throw new Error(`Access denied: ${accessDecision.reason}`);
      }
    }

    const startTime = Date.now();

    // Generate system prompt
    let systemPrompt: string;

    // Collaboration context (present on coordination/delegation calls) is
    // layered on top of whichever base-prompt strategy we choose, so it survives
    // prompt composition rather than short-circuiting it.
    const collab = request.collaborationContext;
    const collaborationContextStr = collab?.usePersonaPrompt && collab.scenarioName
      ? this.generateCollaborationContext(collab.scenarioName, collab.scenarioType, collab.agentRole)
      : '';

    const appendToolInfo = async (prompt: string): Promise<string> => {
      const toolInformation = await this.generateToolAwarenessPrompt(agent);
      return toolInformation ? prompt + toolInformation : prompt;
    };

    if (request.systemPrompt) {
      // Use explicit system prompt override (for backward compatibility)
      systemPrompt = request.systemPrompt;
    } else if (this.promptCompositionService && agent.promptConfig) {
      // Layered prompt composition. Now runs for collaboration calls too (it used
      // to be short-circuited by the persona branch whenever usePersonaPrompt was
      // set) so the realm layer + agent extension apply during coordination.
      // Agents without promptConfig fall through to the unchanged persona/legacy
      // paths below, so this only affects agents that opted into composition.
      try {
        // Session-scoped current realm (reflects in-session travel), NOT the
        // agent's global realm state. The sentinel => no realm layer.
        const currentRealm = this.resolveCurrentRealm(agent, agent.id, request.sessionId);
        const realmId = currentRealm && !isRealmSentinel(currentRealm) ? currentRealm : undefined;

        // DB-backed realm layer (Layer 3): pull the realm's authored prompt layer
        // so composition uses it instead of a file. (RealmService owns realm data;
        // PromptCompositionService stays DB-agnostic and just parses the markdown.)
        let realmLayerMarkdown: string | undefined;
        if (realmId) {
          try {
            const realm = await this.realmService.getRealm(realmId);
            realmLayerMarkdown = realm?.configuration?.promptLayer || undefined;
          } catch (e) {
            console.warn(`Failed to load realm prompt layer for ${realmId}:`, e instanceof Error ? e.message : e);
          }
        }

        const composedPrompt = await this.promptCompositionService.composePrompt(agent, {
          user_id: 'system', // TODO: Pass actual user ID when available
          timestamp: new Date().toISOString(),
          available_tools: agent.mcpTools || [],
          ...(request.sessionId && { session_id: request.sessionId }),
          ...(realmId && { realm_id: realmId }),
          ...(realmLayerMarkdown && { realm_layer_markdown: realmLayerMarkdown })
        });

        systemPrompt = composedPrompt.final_prompt;
        // Layer the coordination/collaboration context on top of the composed base.
        if (collaborationContextStr) systemPrompt += collaborationContextStr;
        // Tell the agent which realm it is operating in, as the persona and
        // legacy paths both do. This was missing only here, so a *successful*
        // composition produced a less realm-aware prompt than a failed one —
        // the catch below falls back to a path that applies it. Layer 3 was
        // meant to carry realm context, but it is sourced from
        // realm.configuration.promptLayer, which no realm populates, so until
        // it does this is the only realm signal a composed agent receives.
        systemPrompt = await this.generateRealmAwareSystemPrompt(agent, systemPrompt, request.sessionId);
        systemPrompt = await appendToolInfo(systemPrompt);

        if (composedPrompt.security_violations.length > 0) {
          console.warn(`⚠️  Agent ${agentId} has ${composedPrompt.security_violations.length} security violations in prompt composition`);
        }
      } catch (error) {
        console.error('Failed to compose prompt, falling back to legacy behavior:', error);
        // Fall back to the same base the non-composition paths would have used.
        const baseSystemPrompt = collaborationContextStr
          ? this.generatePersonaSystemPrompt(agent, collaborationContextStr, collab?.agentRole)
          : (agent.llmConfig.systemPrompt || `You are ${agent.name}. ${agent.description}`);
        systemPrompt = await this.generateRealmAwareSystemPrompt(agent, baseSystemPrompt, request.sessionId);
        systemPrompt = await appendToolInfo(systemPrompt);
      }
    } else if (collaborationContextStr) {
      // Persona-aware prompt for collaborations (no composition configured).
      const baseSystemPrompt = this.generatePersonaSystemPrompt(agent, collaborationContextStr, collab?.agentRole);
      systemPrompt = await this.generateRealmAwareSystemPrompt(agent, baseSystemPrompt, request.sessionId);
      systemPrompt = await appendToolInfo(systemPrompt);
    } else {
      // Legacy behavior: use agent's configured system prompt or fallback
      const baseSystemPrompt = agent.llmConfig.systemPrompt || `You are ${agent.name}. ${agent.description}`;
      systemPrompt = await this.generateRealmAwareSystemPrompt(agent, baseSystemPrompt, request.sessionId);
      systemPrompt = await appendToolInfo(systemPrompt);
    }

    // Check if agentic loop is enabled for this agent
    const agenticLoopEnabled = agent.llmConfig.agenticLoop?.enabled ?? false;

    if (agenticLoopEnabled) {
      // Use agentic loop for iterative tool calling
      return await this.executeAgentPromptWithAgenticLoop(
        agent,
        agentId,
        request,
        systemPrompt,
        startTime,
        requesterId
      );
    } else {
      // Use traditional single-shot execution (backward compatibility)
      return await this.executeAgentPromptSingleShot(
        agent,
        agentId,
        request,
        systemPrompt,
        startTime,
        requesterId
      );
    }
  }

  /**
   * Optimize tool results for context - truncate or summarize large responses
   */
  private optimizeToolResults(
    toolResults: string,
    agent: Agent,
    toolCalls: AgentToolCall[]
  ): string {
    const config = agent.llmConfig.agenticLoop;
    const maxTokens = config?.maxToolResultTokens ?? 1000;
    const shouldSummarize = config?.summarizeToolResults ?? true;

    // Rough token estimate (4 chars ≈ 1 token)
    const estimatedTokens = toolResults.length / 4;

    if (estimatedTokens <= maxTokens) {
      return toolResults; // Small enough, return as-is
    }

    // For GitHub/code review tools, extract key information instead of full JSON
    if (shouldSummarize && toolCalls.some(tc => tc.tool.includes('github'))) {
      return this.summarizeGitHubResults(toolResults, toolCalls);
    }

    // Fallback: truncate with ellipsis
    const charLimit = maxTokens * 4;
    if (toolResults.length > charLimit) {
      return toolResults.substring(0, charLimit) + '\n\n... [truncated ' +
        Math.round((toolResults.length - charLimit) / 1000) + 'KB of output]';
    }

    return toolResults;
  }

  /**
   * Summarize GitHub API results to extract only relevant information for code review
   */
  private summarizeGitHubResults(toolResults: string, _toolCalls: AgentToolCall[]): string {
    try {
      // Try to parse as JSON
      const parsed = JSON.parse(toolResults);

      // Handle array of PRs - ultra-compact format for agentic loop
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].number !== undefined) {
        return `Found ${parsed.length} PR(s):\n` + parsed.map(pr =>
          `#${pr.number}: ${pr.title.substring(0, 60)}${pr.title.length > 60 ? '...' : ''}`
        ).join('\n');
      }

      // Handle single PR details - minimal format
      if (parsed.number !== undefined && parsed.title !== undefined) {
        return `PR #${parsed.number}: ${parsed.title.substring(0, 80)}\n` +
          `${parsed.state} | ${parsed.user?.login} | +${parsed.additions ?? 0}/-${parsed.deletions ?? 0} in ${parsed.changed_files ?? '?'} files`;
      }

      // Handle PR files - ultra-compact, max 20 files shown
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].filename !== undefined) {
        const filesToShow = parsed.slice(0, 20);
        const fileList = filesToShow.map(file =>
          `${file.filename} (+${file.additions}/-${file.deletions})`
        ).join(', ');
        const truncated = parsed.length > 20 ? ` ... +${parsed.length - 20} more` : '';
        return `Files (${parsed.length}): ${fileList}${truncated}`;
      }

      // Fallback: return truncated JSON
      return JSON.stringify(parsed, null, 2).substring(0, 4000) + '\n... [truncated]';
    } catch (e) {
      // Not JSON, return truncated string
      return toolResults.substring(0, 4000) + '\n... [truncated]';
    }
  }

  /**
   * Apply sliding window to conversation history to limit context size
   */
  private applySlidingWindow(
    messages: Array<{ role: string; content: string }>,
    windowSize: number
  ): Array<{ role: string; content: string }> {
    if (messages.length <= windowSize + 1) {
      return messages; // +1 to always keep system message
    }

    // Always keep system message (first) + sliding window of recent messages
    const systemMessage = messages[0];
    if (!systemMessage) {
      return messages; // Safety check
    }

    const recentMessages = messages.slice(-windowSize);
    return [systemMessage, ...recentMessages];
  }

  /**
   * Execute agent prompt with agentic loop - enables iterative tool calling
   * The agent can make tool calls, see results, and decide on next actions in a loop
   */
  private async executeAgentPromptWithAgenticLoop(
    agent: Agent,
    agentId: AgentId,
    request: AgentExecutionRequest,
    systemPrompt: string,
    startTime: number,
    requesterId?: string
  ): Promise<AgentExecutionResponse> {
    const maxIterations = agent.llmConfig.agenticLoop?.maxIterations ?? 10;
    const trackCosts = agent.llmConfig.agenticLoop?.trackCosts ?? true;
    const contextStrategy = agent.llmConfig.agenticLoop?.contextStrategy ?? 'summarized';
    const slidingWindowSize = agent.llmConfig.agenticLoop?.slidingWindowSize ?? 5;

    // Initialize conversation history
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: request.prompt }
    ];

    let totalUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0
    };

    let allToolCalls: AgentToolCall[] = [];
    let finalResponse = '';
    let iteration = 0;

    console.log(`🔄 Starting agentic loop for agent ${agentId} (max ${maxIterations} iterations)`);
    console.log(`📋 Context strategy: ${contextStrategy}, Model: ${agent.llmConfig.model}`);

    try {
      while (iteration < maxIterations) {
        iteration++;
        console.log(`🔄 Agentic loop iteration ${iteration}/${maxIterations}`);

        // Estimate current context size (rough approximation: 4 chars ≈ 1 token)
        const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
        const estimatedTokens = Math.round(totalChars / 4);
        console.log(`📊 Estimated context tokens: ~${estimatedTokens}`);

        // Warn if approaching common context limits and auto-adjust
        if (estimatedTokens > 6000 && agent.llmConfig.model.includes('3.5')) {
          console.warn(`⚠️ Context size (${estimatedTokens} tokens) approaching GPT-3.5 limit (8K). Consider using gpt-4 (128K context) or enabling sliding-window strategy.`);

          // If context is dangerously high, force sliding window to prevent failure
          if (estimatedTokens > 5000 && contextStrategy !== 'sliding-window') {
            console.warn(`⚠️ Auto-applying sliding window to prevent context overflow`);
            const windowedMessages = this.applySlidingWindow(messages, 3);
            messages.length = 0;
            messages.push(...windowedMessages);

            const newEstimate = Math.round(messages.reduce((sum, m) => sum + m.content.length, 0) / 4);
            console.log(`📊 Context reduced from ~${estimatedTokens} to ~${newEstimate} tokens`);
          }
        }

        // Call LLM with current conversation history
        // Dynamically adjust max_tokens based on context size to prevent overflow
        const dynamicTemperature = request.temperature;
        const { response, usage } = await this.callLLM(agent, messages, dynamicTemperature);

        // Accumulate token usage
        if (trackCosts && usage) {
          totalUsage.promptTokens += usage.promptTokens;
          totalUsage.completionTokens += usage.completionTokens;
          totalUsage.totalTokens += usage.totalTokens;
        }

        // Add assistant's response to conversation
        messages.push({ role: 'assistant', content: response });

        // Process any tool calls in the response
        const processedResponse = await this.processAgentToolCalls(agent, response, agentId, request.sessionId, requesterId);
        allToolCalls.push(...processedResponse.toolCalls);

        // If no tool calls were made, this is the final response
        if (processedResponse.toolCalls.length === 0) {
          console.log(`✅ Agentic loop completed - no more tool calls (iteration ${iteration})`);
          finalResponse = response;
          break;
        }

        // Tool calls were made - add results to conversation for next iteration
        console.log(`🔧 Processed ${processedResponse.toolCalls.length} tool call(s) in iteration ${iteration}`);

        // Optimize tool results based on context strategy
        let optimizedResults = processedResponse.finalResponse;
        if (contextStrategy === 'summarized') {
          const originalSize = optimizedResults.length;
          optimizedResults = this.optimizeToolResults(
            optimizedResults,
            agent,
            processedResponse.toolCalls
          );
          const savedBytes = originalSize - optimizedResults.length;
          if (savedBytes > 0) {
            console.log(`📉 Context optimization saved ~${Math.round(savedBytes / 1000)}KB (~${Math.round(savedBytes / 4)} tokens)`);
          }
        }

        // Create a user message with tool results for the next iteration
        const toolResultsMessage = `Tool execution results:\n${optimizedResults}`;
        messages.push({ role: 'user', content: toolResultsMessage });

        // Apply sliding window if configured
        if (contextStrategy === 'sliding-window') {
          const beforeCount = messages.length;
          const windowedMessages = this.applySlidingWindow(messages, slidingWindowSize);
          if (windowedMessages.length < beforeCount) {
            console.log(`🪟 Sliding window reduced context from ${beforeCount} to ${windowedMessages.length} messages`);
            messages.length = 0;
            messages.push(...windowedMessages);
          }
        }

        // Continue loop for next iteration
      }

      // If we exited due to max iterations, use the last response
      if (iteration >= maxIterations && !finalResponse) {
        console.warn(`⚠️ Agentic loop reached max iterations (${maxIterations})`);
        finalResponse = messages[messages.length - 1]?.content || 'Max iterations reached';
      }

      // Deterministic references: harvest what was actually retrieved from the
      // WorldTree (not what the model chose to cite) and append a References
      // section. Provable grounding, independent of the model's citation behavior.
      const references = harvestWorldTreeReferences(allToolCalls);
      finalResponse = appendReferencesSection(finalResponse, references);

      return {
        response: finalResponse,
        usage: totalUsage,
        executionTime: Date.now() - startTime,
        toolCalls: allToolCalls,
        ...(references.length > 0 && { references }),
        metadata: {
          agenticLoop: {
            enabled: true,
            iterations: iteration,
            maxIterations
          }
        }
      };

    } catch (error) {
      console.error(`❌ Agentic loop failed at iteration ${iteration}:`, error);
      throw new Error(`Agentic loop execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Execute agent prompt in single-shot mode (original behavior, no agentic loop)
   */
  private async executeAgentPromptSingleShot(
    agent: Agent,
    agentId: AgentId,
    request: AgentExecutionRequest,
    systemPrompt: string,
    startTime: number,
    requesterId?: string
  ): Promise<AgentExecutionResponse> {
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: request.prompt }
    ];

    try {
      // Call LLM once
      const { response, usage } = await this.callLLM(agent, messages, request.temperature);

      // Process tool calls in the response
      const processedResponse = await this.processAgentToolCalls(agent, response, agentId, request.sessionId, requesterId);

      return {
        response: processedResponse.finalResponse,
        usage,
        executionTime: Date.now() - startTime,
        toolCalls: processedResponse.toolCalls
      };
    } catch (error) {
      throw new Error(`LLM execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Call LLM with message history - abstracted to support both OpenAI and Ollama
   */
  private async callLLM(
    agent: Agent,
    messages: Array<{ role: string; content: string }>,
    temperature?: number
  ): Promise<{ response: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
    if (agent.llmConfig.provider === 'openai') {
      if (!this.openaiClient) {
        throw new Error('OpenAI client not available. Please configure OPENAI_API_KEY.');
      }

      // Calculate dynamic max_tokens based on model context limits
      let maxTokens = agent.llmConfig.maxTokens || 3000;

      // Estimate current context size
      const contextChars = messages.reduce((sum, m) => sum + m.content.length, 0);
      const estimatedContextTokens = Math.round(contextChars / 4);

      // Get model context limit
      const modelContextLimit = agent.llmConfig.model.includes('gpt-4') ? 128000 :
                                agent.llmConfig.model.includes('gpt-3.5') ? 8192 : 8192;

      // Calculate safe max_tokens (leave buffer for model overhead)
      const safeMaxTokens = Math.max(500, modelContextLimit - estimatedContextTokens - 200);

      // Use the smaller of configured or safe limit
      if (maxTokens > safeMaxTokens) {
        console.log(`📉 Adjusting max_tokens from ${maxTokens} to ${safeMaxTokens} (context: ~${estimatedContextTokens} tokens, model limit: ${modelContextLimit})`);
        maxTokens = safeMaxTokens;
      }

      const openaiRequest: OpenAIChatRequest = {
        model: agent.llmConfig.model,
        messages: messages.map(m => ({ role: m.role as any, content: m.content })),
        temperature: temperature || agent.llmConfig.temperature || 0.7,
        max_tokens: maxTokens,
        ...(agent.llmConfig.topP && { top_p: agent.llmConfig.topP }),
        ...(agent.llmConfig.frequencyPenalty && { frequency_penalty: agent.llmConfig.frequencyPenalty }),
        ...(agent.llmConfig.presencePenalty && { presence_penalty: agent.llmConfig.presencePenalty })
      };

      const openaiResponse = await this.openaiClient.chat(openaiRequest);
      return {
        response: openaiResponse.choices[0]?.message?.content || '',
        usage: {
          promptTokens: openaiResponse.usage?.prompt_tokens || 0,
          completionTokens: openaiResponse.usage?.completion_tokens || 0,
          totalTokens: openaiResponse.usage?.total_tokens || 0
        }
      };
    } else {
      // Default to Ollama for 'ollama' provider and fallback
      const chatRequest: ChatRequest = {
        model: agent.llmConfig.model,
        messages: messages.map(m => ({ role: m.role as any, content: m.content })),
        options: {
          temperature: temperature || agent.llmConfig.temperature || 0.7,
          ...(agent.llmConfig.topP && { top_p: agent.llmConfig.topP }),
          ...(agent.llmConfig.maxTokens && { num_predict: agent.llmConfig.maxTokens })
        }
      };

      const ollamaResponse = await this.ollamaClient.chat(chatRequest);
      return {
        response: ollamaResponse.message.content,
        usage: {
          promptTokens: ollamaResponse.prompt_eval_count || 0,
          completionTokens: ollamaResponse.eval_count || 0,
          totalTokens: (ollamaResponse.prompt_eval_count || 0) + (ollamaResponse.eval_count || 0)
        }
      };
    }
  }

  /**
   * Generate tool awareness prompt that informs the agent about available tools
   */
  private async generateToolAwarenessPrompt(agent: Agent): Promise<string> {
    const availableTools = await this.getAvailableToolsForAgent(agent);

    console.log(`🛠️  Generated ${availableTools.length} tools for agent ${agent.id}:`, availableTools.map(t => t.name).join(', '));

    if (availableTools.length === 0) {
      return '';
    }

    let toolPrompt = `

## Available Tools
You have access to the following tools. To use tools, include one or more TOOL_CALL entries in your response with this exact format:
TOOL_CALL: {"tool": "tool_name", "params": {"param1": "value1", "param2": "value2"}}

You can make multiple tool calls in a single response by including multiple TOOL_CALL entries. Each will be executed in sequence.

Available tools:
`;

    for (const tool of availableTools) {
      toolPrompt += `- **${tool.name}**: ${tool.description}\n`;
      if (tool.parameters && Object.keys(tool.parameters).length > 0) {
        toolPrompt += `  Parameters: ${Object.keys(tool.parameters).join(', ')}\n`;
      }
    }

    toolPrompt += `\nOnly use tools that are explicitly listed above. Tool calls will be processed and results will be provided back to you. You can make multiple tool calls in a single response to accomplish complex tasks.

**CRITICAL**: When using file tools:
- list_files returns a "path" field for each file - use this EXACT value with read_file/write_file
- Do NOT modify paths - preserve underscores, hyphens, and special characters exactly as returned
- Example: If list_files returns {"path": "file:///app/data/My_File_Name.md"}, use that exact string`;

    return toolPrompt;
  }

  /**
   * Get list of tools available to a specific agent based on type and permissions
   */
  private async getAvailableToolsForAgent(agent: Agent): Promise<Array<{name: string, description: string, parameters?: any}>> {
    const tools: Array<{name: string, description: string, parameters?: any}> = [];

    console.log(`🔍 Getting tools for agent ${agent.id}:`, {
      hasResourceAccess: !!agent.resourceAccess,
      allowedLocations: agent.resourceAccess?.allowedLocations?.length || 0
    });

    // Universal inter-agent communication tools (all agents)
    tools.push(
      {
        name: 'message_agent',
        description: 'Send a message to another agent and get their response',
        parameters: { agent_id: 'target agent ID', message: 'message text' }
      },
      {
        name: 'delegate_task',
        description: 'Delegate a task to another agent for interactive collaboration (allows back-and-forth)',
        parameters: { agent_id: 'target agent ID', task: 'task description' }
      },
      {
        name: 'assign_simple_task',
        description: 'Assign a task to another agent for immediate completion (no interaction expected)',
        parameters: { agent_id: 'target agent ID', task: 'task description' }
      },
      {
        name: 'get_step_content',
        description:
          'Retrieve research carried into this session by an earlier step. ' +
          'Address it by the agent that produced it, or by a step label — not by number. ' +
          'Returns found:false if there is no match; say what is missing rather than inventing it.',
        parameters: {
          from: 'agent id of the producer, e.g. the coordinator that did the research (optional)',
          role: 'step label to match, e.g. "research" or "positioning" (optional)',
          step: 'step number, only if you genuinely have one (optional)'
        }
      }
    );

    // Universal file and URL access tools (all agents with explicit opt-in via resourceAccess)
    if (agent.resourceAccess && (
      (agent.resourceAccess.allowedLocations && agent.resourceAccess.allowedLocations.length > 0) ||
      (agent.resourceAccess.allowedFilePaths && agent.resourceAccess.allowedFilePaths.length > 0) ||
      (agent.resourceAccess.allowedUrls && agent.resourceAccess.allowedUrls.length > 0)
    )) {
      // Check if agent has file access permissions
      const hasFileAccess = [
        ...(agent.resourceAccess.allowedLocations || []),
        ...(agent.resourceAccess.allowedFilePaths || [])
      ].some(loc => loc.startsWith('file:///'));

      // Check if agent has URL access permissions
      const hasUrlAccess = [
        ...(agent.resourceAccess.allowedLocations || []),
        ...(agent.resourceAccess.allowedUrls || [])
      ].some(loc => loc.startsWith('http://') || loc.startsWith('https://'));

      if (hasFileAccess) {
        console.log(`✅ Agent ${agent.id} has file access - adding file tools including process_files_batch`);
        tools.push(
          {
            name: 'read_file',
            description: 'Read content from a file. Requires file:/// URL with permission. CRITICAL: Use the EXACT path from list_files, preserving underscores and special characters.',
            parameters: { file_url: 'file:/// URL to read (e.g., file:///app/data/file.txt). MUST match exact path from list_files.' }
          },
          {
            name: 'write_file',
            description: 'Write content to a file. Requires file:/// URL with permission. Use exact paths with underscores preserved.',
            parameters: { file_url: 'file:/// URL to write', content: 'content to write to file' }
          },
          {
            name: 'list_files',
            description: 'List files and directories in a directory. Returns array with "path" field containing EXACT file URLs to use with read_file/write_file.',
            parameters: { directory_url: 'file:/// URL to directory (e.g., file:///app/data/)' }
          },
          {
            name: 'process_files_batch',
            description: 'Process multiple files in a directory with automatic iteration. Reads each file, executes processing instructions, and writes outputs. Handles all files automatically - no manual looping needed.',
            parameters: {
              input_directory: 'file:/// URL to input directory',
              output_directory: 'file:/// URL to output directory',
              file_pattern: 'optional glob pattern (e.g., *.md, *.txt)',
              processing_instructions: 'what to do with each file (e.g., "extract key concepts and create learning module")',
              output_filename_template: 'template for output filenames. Supported variables: {basename}, {filename}, {filename_without_extension} (with single or double braces). Example: "{basename}_module.md"'
            }
          }
        );
      } else {
        console.log(`❌ Agent ${agent.id} does NOT have file access - skipping file tools`);
      }

      if (hasUrlAccess) {
        tools.push(
          {
            name: 'fetch_url',
            description: 'Fetch content from one or more HTTP/HTTPS URLs. Requires URL permission. Pass "url" for a single URL or "urls" (array) to fetch multiple in parallel.',
            parameters: { url: 'single HTTP or HTTPS URL to fetch', urls: 'array of HTTP/HTTPS URLs to fetch in parallel', method: 'HTTP method (GET, POST, etc.) — applied to all URLs', body: 'optional request body', headers: 'optional request headers' }
          }
        );
      }
    }

    // Realm navigation tools (druids only)
    if (agent.type === 'druid') {
      tools.push(
        {
          name: 'travel_to_realm',
          description: 'Travel to a different realm (requires realm access permissions)',
          parameters: { target_realm: 'realm ID to travel to' }
        },
        {
          name: 'get_current_realm',
          description: 'Get information about your current realm location'
        },
        {
          name: 'get_realm_elementals',
          description: 'List elemental agents available in a specific realm',
          parameters: { realm_id: 'realm ID to query' }
        }
      );
    }

    // WorldTree corpus retrieval — a DEFAULT-AVAILABLE built-in for every agent
    // (handled in executeBuiltInTool, not the MCP gateway). It is read-only and
    // realm-scoped (an agent only ever sees global ∪ its own realms), so access
    // is controlled by scope, not by withholding the tool. Availability is not a
    // mandate — the model calls it only when the persona/task prompt makes it
    // relevant. (No mcpTools opt-in required; that conflated a built-in with
    // external gateway tools.)
    tools.push({
      name: 'search_worldtree',
      description: 'Search the WorldTree knowledge corpus (ingested documents) for passages relevant to a query. Scope is the shared global corpus plus the realm you are currently in (travel there first with travel_to_realm). To also search other realms you have access to, pass their ids in "realms". Returns the most relevant text chunks with their source and section headings. Use this to ground answers in the ingested corpus.',
      parameters: { query: 'natural-language search query', limit: 'optional max passages to return (default 5)', realms: 'optional array of additional realm ids to include in the search (must be realms you can access)' }
    });

    // MCP tools via gateway (based on agent's mcpTools configuration)
    if (agent.mcpTools && agent.mcpTools.length > 0) {
      // Add tools from agent's MCP configuration
      // These will be validated and routed through the MCP Gateway
      for (const mcpTool of agent.mcpTools) {
        // search_worldtree is a built-in (handled above), not a gateway tool.
        if (mcpTool === 'search_worldtree') continue;
        // Check if this is a wildcard pattern (e.g., "github:*")
        if (mcpTool.endsWith(':*')) {
          // Extract server prefix and discover actual tools
          const serverPrefix = mcpTool.slice(0, -2); // Remove ":*"
          const discoveredTools = await this.discoverMCPTools(agent, serverPrefix);
          tools.push(...discoveredTools);
        } else {
          // Static tool name
          tools.push({
            name: mcpTool,
            description: `Specialized tool: ${mcpTool} (routed via MCP Gateway)`,
            parameters: { /* Parameters will be validated by MCP Gateway */ }
          });
        }
      }
    }

    return tools;
  }

  /**
   * Discover available tools from an MCP server for dynamic tool resolution
   */
  private async discoverMCPTools(agent: Agent, serverPrefix: string): Promise<Array<{name: string, description: string, parameters?: any}>> {
    try {
      // Get agent's realm
      const realmId = agent.realmAccess?.boundRealmId || (agent as any).realmId;
      if (!realmId) {
        console.warn(`Cannot discover MCP tools for agent ${agent.id}: no realm binding`);
        return [];
      }

      // Get realm's MCP servers
      let realmServers: string[] = [];
      try {
        realmServers = await this.realmService.getMCPServers(realmId);
      } catch (error) {
        // Try config fallback
        const realmBinding = this.mcpConfigLoader.getRealmBinding(realmId);
        if (realmBinding && realmBinding.servers) {
          realmServers = realmBinding.servers;
        }
      }

      // Find the MCP server matching the prefix
      const targetServerId = realmServers.find(serverId => serverId === serverPrefix);
      if (!targetServerId) {
        console.warn(`MCP server ${serverPrefix} not found in realm ${realmId}`);
        return [];
      }

      // Get server config
      const serverConfig = this.mcpConfigLoader.getServer(targetServerId);
      if (!serverConfig || !serverConfig.baseUrl) {
        console.warn(`No config found for MCP server ${targetServerId}`);
        return [];
      }

      // Get authentication token
      let token: string | null = null;
      if (serverConfig.authentication.tokenSource === 'env' && serverConfig.authentication.envVar) {
        token = process.env[serverConfig.authentication.envVar] || null;
      }

      // Create appropriate MCP client
      let client: any;
      if (serverConfig.transport === 'sse') {
        const { SSEMCPClient } = await import('./mcp/SSEMCPClient');
        client = new SSEMCPClient(
          serverConfig.baseUrl,
          token,
          serverConfig.authentication.header,
          serverConfig.authentication.prefix,
          (serverConfig as any).customHeaders || {}
        );
      } else {
        const { HttpMCPClient } = await import('./mcp/HttpMCPClient');
        client = new HttpMCPClient(
          serverConfig.baseUrl,
          token,
          serverConfig.authentication.header,
          serverConfig.authentication.prefix
        );
      }

      // Call tools/list to discover available tools
      console.log(`🔍 Discovering tools from MCP server ${targetServerId}...`);
      const mcpResponse: any = await client.listTools();

      // Convert MCP tools to our format
      const tools: Array<{name: string, description: string, parameters?: any}> = [];
      if (Array.isArray(mcpResponse)) {
        // Response is directly an array of tools
        for (const tool of mcpResponse) {
          tools.push({
            name: `${serverPrefix}:${tool.name}`,
            description: tool.description || `Tool: ${tool.name}`,
            parameters: tool.inputSchema?.properties || {}
          });
        }
      } else if (mcpResponse && Array.isArray(mcpResponse.tools)) {
        // Response has a tools property
        for (const tool of mcpResponse.tools) {
          tools.push({
            name: `${serverPrefix}:${tool.name}`,
            description: tool.description || `Tool: ${tool.name}`,
            parameters: tool.inputSchema?.properties || {}
          });
        }
      }

      console.log(`✅ Discovered ${tools.length} tools from ${targetServerId}`);
      return tools;

    } catch (error) {
      console.error(`Failed to discover MCP tools for ${serverPrefix}:`, error instanceof Error ? error.message : 'Unknown error');
      return [];
    }
  }

  /**
   * Generate a realm-aware system prompt that includes realm context when agent is bound to a specific realm
   */
  private async generateRealmAwareSystemPrompt(agent: Agent, baseSystemPrompt: string, sessionId?: string): Promise<string> {
    // Determine which realm the agent is in
    let currentRealmId: string | undefined;

    // Check session-scoped realm state first (takes precedence for concurrent sessions)
    if (sessionId && this.coordinationService) {
      const sessionAgentManager = this.coordinationService.getSessionAgentManager(sessionId);
      if (sessionAgentManager) {
        const sessionState = sessionAgentManager.getAgentSessionState(agent.id);
        if (sessionState) {
          currentRealmId = sessionState.currentRealm;
          console.log(`🔍 Using session-scoped realm for agent ${agent.id} in session ${sessionId}: ${currentRealmId}`);
        }
      }
    }

    // Fall back to global agent realm state if no session context
    if (!currentRealmId) {
      currentRealmId = agent.realmAccess?.currentRealmId || agent.realmAccess?.boundRealmId;
    }

    if (!currentRealmId) {
      // No realm binding, return original system prompt
      return baseSystemPrompt;
    }

    try {
      // Get realm information
      const realm = await this.realmService.getRealm(currentRealmId);
      if (!realm || !realm.description) {
        // Realm not found or no description, return original system prompt
        return baseSystemPrompt;
      }

      // Combine base system prompt with realm context
      const realmContext = `

## Realm Context
You are currently operating within "${realm.name}". ${realm.description}

Your responses and behavior should be appropriate to this realm's context and characteristics while maintaining your core abilities and personality.`;

      return baseSystemPrompt + realmContext;
    } catch (error) {
      console.warn(`Failed to get realm context for agent ${agent.id}:`, error instanceof Error ? error.message : 'Unknown error');
      // Return original prompt if realm lookup fails
      return baseSystemPrompt;
    }
  }

  /**
   * Generate a persona-aware system prompt that incorporates agent's personality,
   * specialization, and collaboration context
   */
  private generatePersonaSystemPrompt(
    agent: Agent,
    collaborationContext?: string,
    agentRole?: string
  ): string {
    const personality = agent.personality;
    const specialization = agent.specialization;
    const agentTypeGuidance = this.getAgentTypePromptSuffix(agent.type);

    let prompt = `You are a ${agent.type} agent named "${agent.name}"`;

    if (collaborationContext) {
      prompt += ` ${collaborationContext}`;
    }

    prompt += `.\n\n`;

    // Include agent's custom system prompt if configured
    // This allows agent-specific guidance (e.g., github-elemental-oss thoroughness requirements)
    if (agent.llmConfig?.systemPrompt) {
      prompt += `AGENT-SPECIFIC INSTRUCTIONS:\n`;
      prompt += agent.llmConfig.systemPrompt;
      prompt += `\n\n`;
    }

    // Role and Specialization Section
    prompt += `ROLE & SPECIALIZATION:\n`;
    if (agentRole) {
      prompt += `- Role: ${agentRole}\n`;
    }
    prompt += `- Domain: ${specialization.domain}\n`;
    prompt += `- Expertise: ${specialization.expertise.join(', ')}\n`;
    if (specialization.skillLevel) {
      prompt += `- Skill Level: ${specialization.skillLevel}\n`;
    }
    prompt += `\n`;

    // Personality Section
    prompt += `PERSONALITY TRAITS:\n`;
    prompt += `- Communication Style: ${personality.communicationStyle}\n`;
    prompt += `- Decision Making: ${personality.decisionMaking}\n`;
    prompt += `- Core Traits: ${personality.traits.join(', ')}\n`;
    if (personality.riskTolerance) {
      prompt += `- Risk Tolerance: ${personality.riskTolerance}\n`;
    }
    if (personality.collaborationPreference) {
      prompt += `- Collaboration Style: ${personality.collaborationPreference}\n`;
    }
    prompt += `\n`;

    // Behavior Guidelines Section
    prompt += `BEHAVIOR GUIDELINES:\n`;
    prompt += this.generateBehaviorGuidelines(personality);
    prompt += `\n`;

    // Agent Type Specific Guidance
    prompt += `AGENT TYPE SPECIALIZATION:\n`;
    prompt += agentTypeGuidance;
    prompt += `\n`;

    // Task Approach Section
    prompt += `TASK APPROACH:\n`;
    prompt += `- Apply your ${agent.type} capabilities systematically\n`;
    prompt += `- Maintain ${personality.communicationStyle} communication standards\n`;
    prompt += `- Use ${personality.decisionMaking} decision-making approach\n`;
    prompt += `- Demonstrate traits: ${personality.traits.join(', ')}\n`;
    if (specialization.expertise.length > 0) {
      prompt += `- Leverage your expertise in: ${specialization.expertise.join(', ')}\n`;
    }

    return prompt;
  }
  
  /**
   * Generate behavior guidelines based on personality traits
   */
  private generateBehaviorGuidelines(personality: DruidPersona): string {
    let guidelines = '';
    
    // Communication style guidelines
    switch (personality.communicationStyle) {
      case 'formal':
        guidelines += '- Communicate with professional formality and clear structure\n';
        break;
      case 'casual':
        guidelines += '- Use approachable, friendly communication style\n';
        break;
      case 'technical':
        guidelines += '- Focus on precise, technical language and detailed explanations\n';
        break;
      case 'concise':
        guidelines += '- Keep responses brief and to-the-point\n';
        break;
      case 'verbose':
        guidelines += '- Provide comprehensive, detailed explanations\n';
        break;
    }
    
    // Decision making guidelines
    switch (personality.decisionMaking) {
      case 'analytical':
        guidelines += '- Approach decisions through systematic analysis and data evaluation\n';
        break;
      case 'intuitive':
        guidelines += '- Trust instincts and pattern recognition in decision making\n';
        break;
      case 'consensus-seeking':
        guidelines += '- Seek input and agreement from collaborators before decisions\n';
        break;
      case 'independent':
        guidelines += '- Make autonomous decisions based on available information\n';
        break;
      case 'rule-based':
        guidelines += '- Follow established procedures and guidelines strictly\n';
        break;
      case 'optimization-focused':
        guidelines += '- Always seek the most efficient and optimal solutions\n';
        break;
    }
    
    // Trait-specific guidelines
    personality.traits.forEach((trait: string) => {
      switch (trait.toLowerCase()) {
        case 'collaborative':
          guidelines += '- Actively engage with other agents and seek collaborative solutions\n';
          break;
        case 'focused':
          guidelines += '- Maintain clear focus on objectives and avoid unnecessary distractions\n';
          break;
        case 'reliable':
          guidelines += '- Deliver consistent, dependable results and follow through on commitments\n';
          break;
        case 'creative':
          guidelines += '- Explore innovative approaches and think outside conventional boundaries\n';
          break;
        case 'methodical':
          guidelines += '- Follow systematic, step-by-step approaches to problem-solving\n';
          break;
        case 'adaptive':
          guidelines += '- Adjust strategies based on changing circumstances and feedback\n';
          break;
      }
    });
    
    return guidelines;
  }
  
  /**
   * Get agent type-specific prompt guidance
   */
  private getAgentTypePromptSuffix(agentType: AgentType): string {
    switch (agentType) {
      case 'druid':
        return 'As a druid, you excel at coordination and high-level reasoning. Provide wise guidance, facilitate collaboration, and maintain harmony between different perspectives. Your strength lies in seeing the bigger picture and orchestrating complex multi-agent interactions.';
      case 'elemental':
        return 'As an elemental, you excel at specialized domain tasks with precision and structure. Focus on accurate execution of specific capabilities, maintain consistency in your approach, and deliver reliable results within your area of expertise.';
      case 'gaia':
        return 'As gaia, you excel at system-wide harmony and collaborative nurturing. Foster team dynamics, ensure balanced outcomes, and maintain the overall health of collaborative processes. Your role is to support and sustain the collaborative ecosystem.';
      case 'worldtree':
        return 'As worldtree, you excel at knowledge synthesis and maintaining contextual connections. Provide comprehensive insights that bridge different domains, maintain context across interactions, and serve as a knowledge hub for the collaboration.';
      default:
        return 'Apply your specialized capabilities systematically while maintaining your unique perspective and approach to problem-solving.';
    }
  }
  
  /**
   * Generate collaboration context description
   */
  private generateCollaborationContext(scenarioName: string, scenarioType?: string, agentRole?: string): string {
    let context = `participating in collaboration "${scenarioName}"`;
    
    if (scenarioType || agentRole) {
      context += '.\n\nCOLLABORATION DETAILS:';
      
      if (scenarioType) {
        context += `\n- Scenario Type: ${scenarioType}`;
      }
      
      if (agentRole) {
        context += `\n- Your Role: ${agentRole}`;
      }
      
      context += `\n- Expected collaboration style: ${scenarioType === 'collaboration' ? 'cooperative and coordinated' : 'professional and goal-oriented'}`;
    }
    
    return context;
  }

  /**
   * Delete an agent
   */
  async deleteAgent(agentId: AgentId, requesterId?: string): Promise<void> {
    const agent = await this.getAgent(agentId, requesterId);

    // Check delete access
    if (requesterId) {
      const accessDecision = await this.policyEngine.checkAccess({
        subjectId: requesterId,
        subjectType: 'user',
        resourceType: 'agent',
        resourceId: agentId,
        operation: 'delete',
        requestedAccess: 'admin'
      });

      if (!accessDecision.allowed) {
        throw new Error(`Access denied: ${accessDecision.reason}`);
      }
    }

    // Stop agent first if running
    if (agent.status === 'active') {
      await this.stopAgent(agentId, requesterId);
    }

    // Delete from database first
    if (this.repositoryManager?.agents) {
      try {
        await this.repositoryManager.agents.delete(agentId);
        console.log(`🗑️ Agent ${agentId} deleted from database`);
      } catch (error) {
        console.error('Failed to delete agent from database:', error instanceof Error ? error.message : 'Unknown error');
        throw new Error(`Failed to delete agent from database: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    } else {
      console.warn('⚠️ Database unavailable for agent deletion');
      throw new Error('Database unavailable for agent deletion');
    }

    // Delete from memory cache
    this.agents.delete(agentId);
    
    console.log(`✅ Agent ${agentId} deleted successfully from both database and memory`);
  }

  /**
   * Validate agent configuration
   */
  private async validateAgentConfiguration(request: CreateAgentRequest): Promise<AgentValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate required fields
    if (!request.name?.trim()) {
      errors.push('Agent name is required');
    }

    if (!request.type) {
      errors.push('Agent type is required');
    }

    if (!request.capabilities?.length) {
      errors.push('At least one capability is required');
    }

    // Validate LLM configuration
    if (request.llmConfig?.model && !request.llmConfig.model.trim()) {
      errors.push('LLM model name cannot be empty');
    }

    if (request.llmConfig?.temperature !== undefined) {
      if (request.llmConfig.temperature < 0 || request.llmConfig.temperature > 2) {
        errors.push('LLM temperature must be between 0 and 2');
      }
    }

    // Validate resource limits
    if (request.resourceLimits?.maxMemoryMB !== undefined && request.resourceLimits.maxMemoryMB < 1) {
      errors.push('Memory limit must be at least 1 MB');
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Initialize LLM connection for an agent
   */
  private async initializeLLMForAgent(agent: Agent): Promise<void> {
    try {
      if (agent.llmConfig.provider === 'openai') {
        if (!this.openaiClient) {
          throw new Error('OpenAI client not available. Please configure OPENAI_API_KEY.');
        }
        // Test OpenAI connectivity
        await this.openaiClient.listModels();
      } else {
        // Test Ollama connectivity (default)
        await this.ollamaClient.listModels();
      }
    } catch (error) {
      throw new Error(`Failed to initialize LLM for agent ${agent.id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Initialize system agents
   */
  private initializeSystemAgents(): void {
    // No automatic test agent creation - require real agents
    console.log('🚀 AgentService initialized. Use the API to create agents.');
    // This would be expanded to create default system agents if needed
    // For now, just ensuring the service is ready
  }

  /**
   * Load agents from persistent storage into memory cache
   */
  private async loadAgentsFromStorage(): Promise<void> {
    // Redis removed - agents are loaded from database during initialization
    // This method is kept for compatibility but no longer loads from Redis cache
    console.log('📥 AgentService: Using database-only persistence, agents loaded during init');
  }

  /**
   * Refresh agent cache from database to get latest updates
   * Useful for concurrent user scenarios where agents may have been 
   * created/updated/deleted by other users
   */
  async refreshAgentCache(): Promise<void> {
    console.log('🔄 Refreshing agent cache from database...');

    // Clear current cache
    this.agents.clear();

    // Reload from database
    await this.loadAgentsFromDatabase();

    console.log(`✅ Agent cache refreshed - now contains ${this.agents.size} agents`);
  }

  /**
   * Extract and parse MCP response content from nested JSON structure
   * MCP responses come in format: { content: [{ type: "text", text: "..." }] }
   * The text field may contain escaped JSON that needs to be parsed
   */
  private extractMCPContent(mcpResponse: any): any {
    // If there's an error flag, return the error content
    if (mcpResponse?.isError) {
      return mcpResponse;
    }

    // Check if this is an MCP-formatted response
    if (mcpResponse?.content && Array.isArray(mcpResponse.content)) {
      // Extract the text from the first content item
      const firstContent = mcpResponse.content[0];
      if (firstContent?.type === 'text' && firstContent.text) {
        const textContent = firstContent.text;

        // Try to parse the text as JSON if it looks like JSON
        if (typeof textContent === 'string' &&
            (textContent.trim().startsWith('[') || textContent.trim().startsWith('{'))) {
          try {
            const parsed = JSON.parse(textContent);
            console.log(`✅ Successfully parsed MCP content JSON`);
            return parsed;
          } catch (parseError) {
            // Not valid JSON, return as-is
            console.log(`⚠️ MCP content text is not valid JSON, returning as string`);
            return textContent;
          }
        }

        // Return text content directly
        return textContent;
      }
    }

    // Not an MCP response format, return as-is
    return mcpResponse;
  }

  /**
   * Process tool calls in an agent's response and execute them
   */
  private async processAgentToolCalls(agent: Agent, response: string, agentId: AgentId, sessionId?: string, requesterId?: string): Promise<ProcessedAgentResponse> {
    const toolCalls: AgentToolCall[] = [];
    let processedResponse = response;

    const matches = extractToolCalls(response).map((m) => ({
      0: m.raw,
      1: m.json,
      index: m.index,
    })) as Array<{ 0: string; 1: string; index: number }>;

    if (matches.length === 0) {
      // No tool calls found, return original response
      return {
        finalResponse: response,
        toolCalls: []
      };
    }

    // Process each tool call
    for (const match of matches) {
      try {
        console.log(`🔍 Raw tool call match: ${match[1]}`);
        const toolCallJson = JSON.parse(match[1]!);
        console.log(`🔍 Parsed tool call JSON:`, JSON.stringify(toolCallJson, null, 2));
        const toolName = toolCallJson.tool;
        const params = toolCallJson.params || {};

        console.log(`🔧 Agent ${agentId} calling tool: ${toolName}`, params);

        const toolCallStart = Date.now();
        let toolResult: any;
        let success = true;

        try {
          // Execute the tool call through internal MCP interface (with session context if available)
          const rawToolResult = await this.executeAgentTool(agent, toolName, params, sessionId, requesterId);

          // Extract and parse MCP response content for better agent consumption
          toolResult = this.extractMCPContent(rawToolResult);

        } catch (error) {
          console.error(`❌ Tool call failed for agent ${agentId}:`, error);
          toolResult = { error: error instanceof Error ? error.message : 'Tool execution failed' };
          success = false;
        }

        const toolCall: AgentToolCall = {
          tool: toolName,
          params,
          result: toolResult,
          success,
          executionTime: Date.now() - toolCallStart
        };

        toolCalls.push(toolCall);

        // Replace the tool call in the response with the result
        // Apply optimization for agentic loop to prevent token explosion
        let toolResultText: string;
        if (!success) {
          toolResultText = `TOOL_ERROR: ${toolResult.error}`;
        } else {
          // Check if agentic loop is enabled and should optimize
          const shouldOptimize = agent.llmConfig.agenticLoop?.enabled &&
            (agent.llmConfig.agenticLoop?.contextStrategy === 'summarized' ||
             agent.llmConfig.agenticLoop?.contextStrategy === undefined);

          if (shouldOptimize) {
            // Optimize tool results before adding to context
            const stringified = JSON.stringify(toolResult, null, 2);
            const optimized = this.optimizeToolResults(stringified, agent, [toolCall]);
            toolResultText = `TOOL_RESULT: ${optimized}`;

            const savedTokens = Math.round((stringified.length - optimized.length) / 4);
            if (savedTokens > 100) {
              console.log(`📉 Tool result optimized: saved ~${savedTokens} tokens`);
            }
          } else {
            // No optimization - original behavior
            toolResultText = `TOOL_RESULT: ${JSON.stringify(toolResult, null, 2)}`;
          }
        }

        processedResponse = processedResponse.replace(match[0], toolResultText);

      } catch (parseError) {
        console.error(`❌ Failed to parse tool call for agent ${agentId}:`, parseError);
        processedResponse = processedResponse.replace(match[0], 'TOOL_ERROR: Invalid tool call format');
      }
    }

    return {
      finalResponse: processedResponse,
      toolCalls
    };
  }

  /**
   * Execute a specific tool call for an agent
   */
  private async executeAgentTool(agent: Agent, toolName: string, params: any, sessionId?: string, requesterId?: string): Promise<any> {
    // Define built-in tools that are handled internally (not via MCP Gateway)
    const builtInTools = [
      'message_agent', 'delegate_task', 'assign_simple_task', 'get_step_content',      // Communication tools (all agents)
      'travel_to_realm', 'get_current_realm', 'get_realm_elementals',  // Realm tools (druids only)
      'read_file', 'write_file', 'list_files', 'process_files_batch', 'fetch_url',  // Resource access tools (opt-in via resourceAccess)
      'search_worldtree'  // WorldTree corpus retrieval (opt-in via mcpTools)
    ];

    // Check if this is a built-in tool
    if (builtInTools.includes(toolName)) {
      return await this.executeBuiltInTool(agent, toolName, params, sessionId, requesterId);
    }

    // All other tools are MCP tools that must go through the gateway
    console.log(`🌐 Routing MCP tool ${toolName} for agent ${agent.id} through MCP Gateway`);
    return await this.routeToolThroughMCPGateway(agent.id, toolName, params);
  }

  /**
   * Execute built-in tools (communication and realm navigation)
   */
  private async executeBuiltInTool(agent: Agent, toolName: string, params: any, sessionId?: string, requesterId?: string): Promise<any> {
    // Define inter-agent communication tools that all agents can access
    const communicationTools = ['message_agent', 'delegate_task', 'assign_simple_task', 'get_step_content'];

    // Define realm navigation tools (for druids)
    const realmTools = ['travel_to_realm', 'get_current_realm', 'get_realm_elementals'];

    // Define resource access tools (all agents with explicit opt-in)
    const resourceAccessTools = ['read_file', 'write_file', 'list_files', 'process_files_batch', 'fetch_url'];

    // WorldTree corpus retrieval (read-only; opt-in via mcpTools).
    const worldtreeTools = ['search_worldtree'];

    // Check access permissions based on agent type and tool category
    if (worldtreeTools.includes(toolName)) {
      // Read-only corpus retrieval — exposure is already opt-in (mcpTools).
      console.log(`✅ Agent ${agent.id} (${agent.type}) accessing WorldTree retrieval tool: ${toolName}`);
    } else if (communicationTools.includes(toolName)) {
      // All agents can use inter-agent communication tools
      console.log(`✅ Agent ${agent.id} (${agent.type}) accessing communication tool: ${toolName}`);
    } else if (realmTools.includes(toolName)) {
      // Only druids can use realm navigation tools
      if (agent.type !== 'druid') {
        throw new Error(`Agent ${agent.id} (${agent.type}) cannot access realm navigation tool: ${toolName}. Only druid agents can navigate realms.`);
      }
      console.log(`✅ Druid agent ${agent.id} accessing realm navigation tool: ${toolName}`);
    } else if (resourceAccessTools.includes(toolName)) {
      // All agents can use resource access tools if they have explicit permissions
      if (!agent.resourceAccess) {
        throw new Error(`Agent ${agent.id} cannot access ${toolName}: no resourceAccess configured. Configure allowedLocations to grant access.`);
      }
      console.log(`✅ Agent ${agent.id} (${agent.type}) accessing resource tool: ${toolName}`);
    } else {
      throw new Error(`Unknown built-in tool: ${toolName}`);
    }

    // Route to appropriate tool implementation
    switch (toolName) {
      case 'message_agent':
        return await this.toolMessageAgent(agent.id, params, sessionId, requesterId);

      case 'delegate_task':
        return await this.toolDelegateTask(agent.id, params, sessionId, requesterId);

      case 'assign_simple_task':
        return await this.toolAssignSimpleTask(agent.id, params, sessionId, requesterId);
      
      case 'get_step_content':
        return await this.toolGetStepContent(params, sessionId, agent.id);
      
      case 'travel_to_realm':
        return await this.toolTravelToRealm(agent.id, params, sessionId);

      case 'get_current_realm':
        return await this.toolGetCurrentRealm(agent.id);
      
      case 'get_realm_elementals':
        return await this.toolGetRealmElementals(agent, params);

      case 'read_file':
        return await this.toolReadFile(agent, params);

      case 'write_file':
        return await this.toolWriteFile(agent, params);

      case 'list_files':
        return await this.toolListFiles(agent, params);

      case 'process_files_batch':
        return await this.toolProcessFilesBatch(agent, params, sessionId);

      case 'fetch_url':
        return await this.toolFetchUrl(agent, params);

      case 'search_worldtree':
        return await this.toolSearchWorldtree(agent, params, sessionId);

      default:
        throw new Error(`Unknown built-in tool: ${toolName}`);
    }
  }

  /**
   * Tool: Discover other agents within the same realm
   * This tool only shows agents that are in the same realm as the requesting agent
   */
  public async toolDiscoverAgents(requestingAgent: Agent, params: { capabilities?: string[] }): Promise<any> {
    // Get the agent's current realm
    const currentRealmId = (requestingAgent as any).realmId || 
                          requestingAgent.realmAccess?.currentRealmId || 
                          requestingAgent.realmAccess?.boundRealmId;
    
    if (!currentRealmId) {
      throw new Error(`Agent ${requestingAgent.name} (${requestingAgent.id}) is not bound to any realm and cannot discover other agents`);
    }

    const filters: AgentQueryFilters = {
      status: ['active'], // Only return active agents
      realmId: currentRealmId // Only agents in the same realm
    };

    // Only apply capability filtering if specific capabilities were requested
    if (params.capabilities && params.capabilities.length > 0) {
      filters.capabilities = params.capabilities;
    }

    console.log(`🔍 Agent ${requestingAgent.name} (${requestingAgent.id}) discovering agents in realm: ${currentRealmId}`);
    const agents = await this.listAgents(filters);
    
    // Remove the requesting agent from the results (agents can't discover themselves)
    const otherAgents = agents.filter(agent => agent.id !== requestingAgent.id);
    
    console.log(`🔍 Found ${otherAgents.length} other agents in realm ${currentRealmId}:`, otherAgents.map(a => `${a.id}(${a.name})`));
    
    return {
      realm: currentRealmId,
      agents: otherAgents.map(agent => ({
        id: agent.id,
        name: agent.name,
        type: agent.type,
        capabilities: agent.capabilities,
        domain: agent.domain,
        realmId: agent.realmId
      })),
      count: otherAgents.length
    };
  }

  /**
   * Resolve agent name to agent ID if needed (similar to CoordinationService)
   */
  private async resolveAgentId(agentIdOrName: string): Promise<string> {
    // First, try to get agent by ID directly
    try {
      const agent = await this.getAgent(agentIdOrName as AgentId);
      if (agent) {
        return agentIdOrName; // It's already an ID
      }
    } catch (error) {
      // Not found by ID, try name resolution
    }

    // Name patterns for common agents
    const namePatterns = [
      { pattern: /pierre robert/i, id: 'pierre-robert' },
      { pattern: /de lint/i, id: 'de-lint' },
      { pattern: /tolkien/i, id: 'tolkien' },
      { pattern: /asimov/i, id: 'asimov' },
      { pattern: /lucas/i, id: 'lucas' },
      { pattern: /colleen/i, id: 'colleen' }
    ];

    // Check for specific agent name patterns
    for (const pattern of namePatterns) {
      if (pattern.pattern.test(agentIdOrName)) {
        try {
          const agent = await this.getAgent(pattern.id as AgentId);
          if (agent) {
            console.log(`🔄 Resolved agent name "${agentIdOrName}" to ID "${pattern.id}"`);
            return pattern.id;
          }
        } catch (error) {
          // Continue to next pattern
        }
      }
    }

    // If no pattern matches, try to find by name from all agents
    try {
      const agents = await this.listAgents({});
      const matchingAgent = agents.find(agent => 
        agent.name.toLowerCase() === agentIdOrName.toLowerCase() ||
        agent.name.toLowerCase().includes(agentIdOrName.toLowerCase()) ||
        agentIdOrName.toLowerCase().includes(agent.name.toLowerCase())
      );
      
      if (matchingAgent) {
        console.log(`🔄 Resolved agent name "${agentIdOrName}" to ID "${matchingAgent.id}"`);
        return matchingAgent.id;
      }
    } catch (error) {
      console.error('❌ Error searching agents by name:', error);
    }

    // If all else fails, return original value
    console.warn(`⚠️ Could not resolve agent identifier "${agentIdOrName}"`);
    return agentIdOrName;
  }

  /**
   * Unified, governed inter-agent message transport.
   *
   * `message_agent`, `delegate_task`, and `assign_simple_task` are all the same
   * operation — send content to another agent, run it once, get one response —
   * differing only in (a) the prompt framing and (b) previously-inconsistent
   * governance. They now route through this single path so realm-presence and
   * user-scoped identity checks are enforced identically for every intent
   * (closing the old `message_agent` bypass). The `intent` selects the prompt
   * template and the recorded action type.
   *
   * SEAM — future coordinator-to-coordinator delegation: today the target runs
   * *without* a session context (no `sessionId` threaded into the sub-call), so
   * a delegated agent's own travel/tools are not session-scoped. Hierarchical
   * delegation to another coordinator should pass a child session context here
   * (and add task-lifecycle tracking) rather than introduce a parallel path.
   */
  private async sendToAgent(
    fromAgentId: AgentId,
    targetIdRaw: string,
    content: string,
    intent: 'message' | 'delegate' | 'assign',
    sessionId?: string,
    requesterId?: string
  ): Promise<{ target_agent: string; response: string; execution_time: number }> {
    const resolvedAgentId = await this.resolveAgentId(targetIdRaw);
    const targetAgent = await this.getAgent(resolvedAgentId as AgentId);

    if (targetAgent.status !== 'active') {
      throw new Error(`Target agent ${resolvedAgentId} is not active`);
    }

    // Governance is uniform across all intents:
    // 1. User-scoped identity guard (transitive via requesterId).
    await this.enforceAssumableForRequester(requesterId, targetAgent, resolvedAgentId);
    // 2. Realm-presence co-location (session-scoped travel aware).
    const fromAgent = await this.getAgent(fromAgentId);
    const fromAgentRealm = this.resolveCurrentRealm(fromAgent, fromAgentId, sessionId);
    const targetAgentRealm = this.resolveCurrentRealm(targetAgent, resolvedAgentId as AgentId, sessionId);
    if (fromAgentRealm !== targetAgentRealm) {
      const verb = intent === 'message' ? 'message' : intent === 'delegate' ? 'delegate to' : 'assign a task to';
      throw new Error(`Cannot ${verb} agent ${resolvedAgentId} in realm ${targetAgentRealm} from realm ${fromAgentRealm}. Agents can only interact with other agents in their current realm.`);
    }

    const { prompt, scenarioName, agentRole, actionType } = this.buildInterAgentMessage(intent, fromAgentId, content);

    const response = await this.executeAgentPrompt(resolvedAgentId as AgentId, {
      prompt,
      // The delegated agent runs inside the same session as the delegator. This
      // was omitted, so a specialist reached through delegate_task executed with
      // no session at all: it could not read research carried into the session,
      // its realm presence fell back to global state rather than session-scoped
      // travel, and its corpus scope lost the session's research realms. Since a
      // realm-bound specialist has no other source of grounding, that left it
      // with nothing but the task string.
      ...(sessionId && { sessionId }),
      collaborationContext: {
        scenarioName,
        ...(agentRole && { agentRole }),
        usePersonaPrompt: true
      }
    }, requesterId);

    await this.recordToolSubContribution({
      sessionId,
      targetAgent,
      actionType,
      description: content,
      content: response.response,
      durationMs: response.executionTime,
    });

    return {
      target_agent: resolvedAgentId,
      response: response.response,
      execution_time: response.executionTime,
    };
  }

  /** Prompt template + persona framing + contribution action type per intent. */
  private buildInterAgentMessage(
    intent: 'message' | 'delegate' | 'assign',
    fromAgentId: AgentId,
    content: string
  ): { prompt: string; scenarioName: string; agentRole?: string; actionType: string } {
    switch (intent) {
      case 'delegate':
        return {
          prompt: `Task delegated from agent ${fromAgentId}: ${content}. Please execute this task and provide your results.`,
          scenarioName: 'Task Delegation',
          agentRole: 'task_executor',
          actionType: 'delegate_task',
        };
      case 'assign':
        return {
          prompt: `SIMPLE TASK ASSIGNMENT from ${fromAgentId}: ${content}

IMPORTANT: This is a simple task assignment that should be completed in a single response. Please:
1. Use your own available tools and capabilities to complete this task
2. Complete the requested task fully
3. Provide your final result/deliverable
4. Do not ask questions or request further input
5. Consider this task complete when you finish your response

Task: ${content}

Please use your available tools to execute this task now and provide your complete result.`,
          scenarioName: 'Simple Task Assignment',
          agentRole: 'task_executor',
          actionType: 'assign_simple_task',
        };
      case 'message':
      default:
        return {
          prompt: `Message from agent ${fromAgentId}: ${content}`,
          scenarioName: 'Inter-agent Communication',
          actionType: 'message_agent',
        };
    }
  }

  /**
   * Tool: Send a message to another agent
   */
  private async toolMessageAgent(
    fromAgentId: AgentId,
    params: { agent_id: string; message: string },
    sessionId?: string,
    requesterId?: string
  ): Promise<any> {
    const result = await this.sendToAgent(fromAgentId, params.agent_id, params.message, 'message', sessionId, requesterId);
    return {
      target_agent: result.target_agent,
      message_sent: params.message,
      response: result.response,
      execution_time: result.execution_time,
    };
  }

  /**
   * Tool: Delegate a task to another agent
   */
  /**
   * User-scoped delegation guard. When a delegation chain is driven by a user
   * (requesterId present), a coordinator/druid may only delegate to a DRUID the
   * user may assume (admins unconstrained; effective set includes group grants).
   * No requesterId → an internal/service/legacy path (e.g. MCP coordination
   * before identity is wired) → not enforced. Non-druid targets are governed by
   * the realm co-location check, not user assumption.
   */
  private async enforceAssumableForRequester(
    requesterId: string | undefined,
    targetAgent: Agent,
    resolvedAgentId: string
  ): Promise<void> {
    if (!requesterId) return;
    if (targetAgent.type !== 'druid') return;
    const allowed = await identityService.mayAssumeDruid(
      requesterId as Parameters<typeof identityService.mayAssumeDruid>[0],
      resolvedAgentId as Parameters<typeof identityService.mayAssumeDruid>[1]
    );
    if (!allowed) {
      throw new Error(
        `Delegation denied: the requesting user may not assume druid ${resolvedAgentId}`
      );
    }
  }

  /**
   * Resolve an agent's *effective* current realm for agent-to-agent realm
   * checks. During a coordination session, travel_to_realm records the move
   * only in the session-scoped SessionAgentManager (not the agent's global
   * realmAccess), so the check must consult that session state first and fall
   * back to the agent's global realm only when outside a session (or when the
   * agent never traveled in-session).
   */
  private resolveCurrentRealm(agent: Agent, agentId: AgentId, sessionId?: string): string {
    if (sessionId && this.coordinationService) {
      const sessionAgentManager = this.coordinationService.getSessionAgentManager(sessionId);
      const sessionRealm = sessionAgentManager?.getAgentSessionState(agentId)?.currentRealm;
      if (sessionRealm && !isRealmSentinel(sessionRealm)) {
        return sessionRealm;
      }
    }
    return agent.realmAccess?.currentRealmId || agent.realmAccess?.boundRealmId || REALM_SENTINEL_SLUG;
  }

  private async toolDelegateTask(
    fromAgentId: AgentId,
    params: { agent_id: string; task: string },
    sessionId?: string,
    requesterId?: string
  ): Promise<any> {
    const result = await this.sendToAgent(fromAgentId, params.agent_id, params.task, 'delegate', sessionId, requesterId);
    return {
      target_agent: result.target_agent,
      task_delegated: params.task,
      result: result.response,
      execution_time: result.execution_time,
    };
  }

  /**
   * Tool: Assign a simple task to another agent (no interactive collaboration)
   */
  private async toolAssignSimpleTask(
    fromAgentId: AgentId,
    params: { agent_id: string; task: string },
    sessionId?: string,
    requesterId?: string
  ): Promise<any> {
    const result = await this.sendToAgent(fromAgentId, params.agent_id, params.task, 'assign', sessionId, requesterId);
    return {
      target_agent: result.target_agent,
      task_assigned: params.task,
      result: result.response,
      execution_time: result.execution_time,
      completion_type: 'simple_assignment',
    };
  }

  /**
   * Record a sub-contribution captured from a delegation/messaging tool.
   * Looks up the parent orchestration step from the active CoordinationService.
   * Best-effort — never throws back into the tool flow.
   */
  private async recordToolSubContribution(args: {
    sessionId: string | undefined;
    targetAgent: { id: AgentId; type?: string };
    actionType: string;
    description: string;
    content: string;
    durationMs?: number | undefined;
  }): Promise<void> {
    if (!args.sessionId) return;
    const parentStep = this.coordinationService?.getActiveStep?.(args.sessionId);
    if (typeof parentStep !== 'number') return;
    try {
      await getSessionPublicationService().recordSubContribution({
        sessionId: args.sessionId,
        parentStepNumber: parentStep,
        agentId: args.targetAgent.id,
        agentRole: args.targetAgent.type ?? null,
        agentType: args.targetAgent.type ?? null,
        actionType: args.actionType,
        description: args.description,
        content: args.content,
        contentFormat: 'markdown',
        durationMs: args.durationMs ?? null,
      });
    } catch (err) {
      console.warn(`Failed to record sub-contribution for session ${args.sessionId}:`, err);
    }
  }

  /**
   * Tool: Get content from a previous coordination step
   */
  /**
   * Retrieve research carried into this session by an earlier step.
   *
   * Session-scoped by construction: `sessionId` comes from the runtime, never
   * from the caller. It used to be parsed out of a `content_id` the model had to
   * construct in the form `step-session-{sessionId}-step-{n}`, which no agent
   * could know — so the tool was unusable, and the coordinator's own prompt
   * instructed it never to call this. It also meant one session could name
   * another's content; now it cannot express the idea.
   *
   * Addressing is by producer or role rather than step number. An agent knows
   * its fellow participants; it does not know which ordinal a plan assigned to
   * the research step, and that ordinal changes per run.
   *
   * Returns `found: false` rather than throwing when nothing matches, so the
   * agent can declare a gap. Silence here is what produced invented content.
   */
  private async toolGetStepContent(
    params: { from?: string; role?: string; step?: number; content_id?: string },
    sessionId?: string,
    callerId?: string
  ): Promise<any> {
    if (!sessionId) {
      return {
        found: false,
        reason: 'no_session',
        message:
          'get_step_content is only available inside a coordination session. ' +
          'State what you are missing rather than inventing it.',
      };
    }

    // Legacy callers pass content_id, the old `step-session-{id}-step-{n}` form.
    // It must not fall through to the no-selector default, which returns the
    // most recent step — that would answer a request for step 1 with step 3 and
    // look successful. Translate the ordinal out of it where possible, and
    // refuse where not.
    const legacyId = (params as { content_id?: string } | undefined)?.content_id;
    let legacyStep: number | undefined;
    if (typeof legacyId === 'string') {
      const n = legacyId.match(/step-(\d+)\s*$/);
      if (n?.[1]) {
        legacyStep = Number(n[1]);
      } else if (params?.from === undefined && params?.role === undefined && params?.step === undefined) {
        return {
          found: false,
          reason: 'unaddressable_content_id',
          message:
            `Cannot resolve content_id "${legacyId}". Address earlier work by the ` +
            'agent that produced it ({"from": "<agent-id>"}) or by a step label ' +
            '({"role": "<label>"}).',
        };
      }
    }

    // Holding a session id is not membership. sendToAgent admits any active,
    // realm co-located target without consulting participantIds, so a
    // participant could delegate outward and the delegate would inherit this
    // session id. Carried research is authorized by membership or not at all.
    if (!this.coordinationService?.mayReadCarriedResearch?.(sessionId, String(callerId))) {
      console.warn(`🔒 get_step_content: ${callerId} is not a member of ${sessionId} — refused`);
      return {
        found: false,
        reason: 'not_a_session_member',
        message:
          'You are not a coordinator or participant of this session, so its ' +
          'carried research is not available to you.',
      };
    }

    const outputs = this.coordinationService?.getCarriedStepOutputs?.(sessionId) ?? [];
    const match = selectCarriedStep(outputs, {
      from: params?.from,
      role: params?.role,
      step: params?.step ?? legacyStep,
    });

    if (!match) {
      const available = Array.from(new Set(outputs.map((o: { agentId: string }) => o.agentId)));
      console.log(`🔍 get_step_content: no match in ${sessionId} (available: ${available.join(', ') || 'none'})`);
      return {
        found: false,
        reason: outputs.length === 0 ? 'no_steps_completed' : 'no_match',
        available_from: available,
        message:
          'No matching earlier step. Say what context you are missing rather ' +
          'than inventing it.',
      };
    }

    console.log(`✅ get_step_content: ${sessionId} step ${match.stepNumber} from ${match.agentId}`);
    return {
      found: true,
      agent_id: match.agentId,
      step_number: match.stepNumber,
      description: match.description,
      timestamp: match.completedAt,
      content: match.output,
    };
  }

  /**
   * Tool: Travel to a different realm (Druid agents only)
   */
  private async toolTravelToRealm(agentId: AgentId, params: { target_realm: string }, sessionId?: string): Promise<any> {
    const agent = await this.getAgent(agentId);

    // Check if agent is a druid (druids inherently have realm travel abilities)
    if (agent.type !== 'druid') {
      throw new Error(`Agent ${agentId} is not a druid and cannot travel between realms`);
    }

    // Resolve the target to a canonical realm slug.
    //
    // This is the travel path agents actually use (the `travel_to_realm` tool),
    // distinct from RealmTravelService which serves the REST route. Grants are
    // slugs since migration 021 and the check below is exact, so an id that is
    // not canonicalised here is both denied and — on the write side — stored
    // back into currentRealmId in the old form.
    let targetRealmId = (await this.realmService.resolveRealmIds([params.target_realm]))[0]
      ?? params.target_realm;

    // A legacy surrogate resolves above. Anything still UUID-shaped names no
    // realm, so fall through to the name lookup rather than trusting it.
    const isUUID = isValidUUID(targetRealmId);

    if (!isUUID) {
      // Try to find realm by name (case-insensitive, handle common variations)
      const realms = await this.realmService.listRealms();

      // Normalize the search term: lowercase, remove common suffixes like " realm"
      const normalizeRealmName = (name: string) => {
        return name
          .toLowerCase()
          .replace(/\s+realm\s*$/i, '') // Remove " realm" suffix
          .replace(/\s+/g, ' ') // Normalize spaces
          .trim();
      };

      const normalizedSearch = normalizeRealmName(params.target_realm);

      const targetRealm = realms.find(realm =>
        normalizeRealmName(realm.name) === normalizedSearch
      );

      if (targetRealm) {
        targetRealmId = targetRealm.id;
      }
    }

    // Compare grants against the canonical form. accessibleRealms is
    // polymorphic — plain id strings in older rows, { realmId, ... } objects in
    // the typed model — and migration 021 preserves both, so each entry is
    // normalised before comparison rather than assuming a shape.
    const grantedSlugs = await this.realmService.resolveRealmIds(
      grantRealmIds(agent.realmAccess?.accessibleRealms)
    );
    const hasAccess = grantedSlugs.includes(targetRealmId);

    if (!hasAccess) {
      throw new Error(`Agent ${agentId} does not have access to realm ${params.target_realm} (resolved: ${targetRealmId})`);
    }

    // Determine previous realm
    const previousRealmId = agent.realmAccess?.currentRealmId || agent.realmAccess?.boundRealmId || REALM_SENTINEL_SLUG;

    // Update realm location - session-aware for concurrent sessions
    if (sessionId && this.coordinationService) {
      // Session-scoped travel: Update SessionAgentManager state only (doesn't affect agent's global state)
      const sessionAgentManager = this.coordinationService.getSessionAgentManager(sessionId);
      if (sessionAgentManager) {
        sessionAgentManager.updateAgentRealmState(agentId, targetRealmId, previousRealmId);
        console.log(`🌍 Session-scoped realm travel: Agent ${agentId} moved to ${targetRealmId} in session ${sessionId}`);
      } else {
        console.warn(`⚠️ SessionAgentManager not found for session ${sessionId}, falling back to global state update`);
        // Fallback to global update if session manager not available
        await this.updateAgent(agentId, {
          realmAccess: {
            ...agent.realmAccess,
            currentRealmId: targetRealmId
          }
        });
      }
    } else {
      // Non-session travel: Update agent's global current realm (original behavior)
      await this.updateAgent(agentId, {
        realmAccess: {
          ...agent.realmAccess,
          currentRealmId: targetRealmId
        }
      });
      console.log(`🌍 Global realm travel: Agent ${agentId} moved to ${targetRealmId}`);
    }

    return {
      agent_id: agentId,
      previous_realm: previousRealmId,
      current_realm: targetRealmId,
      realm_name: params.target_realm,
      travel_time: new Date().toISOString()
    };
  }

  /**
   * Tool: Get current realm location
   */
  private async toolGetCurrentRealm(agentId: AgentId): Promise<any> {
    const agent = await this.getAgent(agentId);
    
    const currentRealm = agent.realmAccess?.currentRealmId ||
                        agent.realmAccess?.boundRealmId ||
                        REALM_SENTINEL_SLUG;

    return {
      agent_id: agentId,
      current_realm: currentRealm,
      agent_type: agent.type,
      can_travel: agent.type === 'druid' && agent.realmAccess?.allowRealmTravel
    };
  }

  /**
   * Tool: Get elemental agents in a specific realm
   */
  /** Whether an agent may operate in / discover a given realm (mirrors travel access). */
  private agentCanAccessRealm(agent: Agent, realmId: string): boolean {
    const ra = agent.realmAccess;
    if (!ra) return false;
    // Callers are expected to pass a canonical slug; see toolGetRealmElementals.
    if (ra.boundRealmId === realmId || ra.currentRealmId === realmId) return true;
    return grantsIncludeRealm(ra.accessibleRealms, realmId);
  }

  private async toolGetRealmElementals(callingAgent: Agent, params: { realm_id: string }): Promise<any> {
    // Normalise the caller-supplied id once: both the access check and the
    // binding comparison below are exact, and bindings are slugs. An external
    // MCP client holding a pre-migration id would otherwise be refused access,
    // or told the realm has no elementals — a wrong answer rather than an error.
    const realmId = (await this.realmService.resolveRealmIds([params.realm_id]))[0] ?? params.realm_id;

    // Realm discovery is scoped: a caller may only enumerate elementals in a
    // realm it can access (prevents cross-realm enumeration of agents the
    // caller could never reach).
    if (!this.agentCanAccessRealm(callingAgent, realmId)) {
      throw new Error(
        `Agent ${callingAgent.id} does not have access to realm ${params.realm_id} and cannot list its elementals`
      );
    }

    // Get full agent data to access realmAccess information
    const allAgents = Array.from(this.agents.values()).filter(agent =>
      agent.type === 'elemental' &&
      agent.status === 'active' &&
      agent.realmAccess?.boundRealmId === realmId
    );

    return {
      realm_id: params.realm_id,
      elementals: allAgents.map(agent => ({
        id: agent.id,
        name: agent.name,
        capabilities: agent.capabilities,
        domain: agent.specialization.domain,
        status: agent.status
      })),
      count: allAgents.length
    };
  }

  /**
   * Route MCP tool calls through the gateway with config-based routing
   */
  private async routeToolThroughMCPGateway(agentId: AgentId, toolName: string, params: any): Promise<any> {
    try {
      // 1. Get agent
      const agent = await this.getAgent(agentId);
      if (!agent) {
        throw new Error(`Agent ${agentId} not found`);
      }

      // 2. Verify agent is elemental
      if (agent.type !== 'elemental') {
        throw new Error(
          `Only elementals can call MCP tools (agent ${agentId} is ${agent.type})`
        );
      }

      // 3. Get realm ID - elementals should have boundRealmId
      const realmId = agent.realmAccess?.boundRealmId || (agent as any).realmId;
      if (!realmId) {
        throw new Error(`Elemental ${agentId} has no realmId (checked realmAccess.boundRealmId and realmId)`);
      }

      // 4. Get realm binding - check which MCP servers are available in this realm
      // First try database, then fall back to config
      let realmServers: string[] = [];

      try {
        // Try to get from database first (primary source)
        realmServers = await this.realmService.getMCPServers(realmId);
        console.log(`🔍 MCP: Got ${realmServers.length} servers from database for realm ${realmId}:`, realmServers);
      } catch (error) {
        // Realm not found in database or error - try config fallback
        console.log(`⚠️ Could not get realm MCP servers from database, trying config fallback. Error:`, error);
      }

      // If no servers in database, try config fallback
      if (realmServers.length === 0) {
        console.log(`🔍 MCP: No servers from database, trying config fallback for realm ${realmId}`);
        const realmBinding = this.mcpConfigLoader.getRealmBinding(realmId);
        console.log(`🔍 MCP: Config realm binding for ${realmId}:`, realmBinding);
        if (realmBinding && realmBinding.servers) {
          realmServers = realmBinding.servers;
          console.log(`🔍 MCP: Using config servers:`, realmServers);
        }
      }

      console.log(`🔍 MCP: Final realmServers array:`, realmServers);
      if (realmServers.length === 0) {
        throw new Error(
          `No MCP servers configured for realm ${realmId}. ` +
          `Add MCP servers to the realm via the UI or config file.`
        );
      }

      // 5. Find which server provides this tool (with wildcard support)
      let targetServerId: string | null = null;
      let targetServerConfig: any = null;

      for (const serverId of realmServers) {
        const serverConfig = this.mcpConfigLoader.getServer(serverId);
        if (serverConfig) {
          // Check if tool is available (support wildcards)
          const toolAvailable = serverConfig.tools.some((toolPattern: string) => {
            if (toolPattern === '*') {
              return true; // Wildcard matches all tools
            }
            if (toolPattern.includes('*')) {
              // Pattern matching (e.g., "get_*", "*_commit")
              const regex = new RegExp('^' + toolPattern.replace(/\*/g, '.*') + '$');
              return regex.test(toolName);
            }
            return toolPattern === toolName; // Exact match
          });

          if (toolAvailable) {
            targetServerId = serverId;
            targetServerConfig = serverConfig;
            break;
          }
        }
      }

      if (!targetServerId || !targetServerConfig) {
        throw new Error(
          `Tool ${toolName} not available in any MCP server for realm ${realmId}. ` +
          `Available servers: ${realmServers.join(', ')}`
        );
      }

      // 6. Validate agent has permission using wildcard pattern matching
      const hasPermission = agent.mcpTools?.some(pattern => {
        // Support both legacy format ("tool_name") and namespaced format ("server:tool_name")
        if (pattern.includes(':')) {
          // Namespaced format: check server and tool pattern
          const [patternServer, toolPattern] = pattern.split(':', 2);

          if (patternServer !== targetServerId) {
            return false; // Server doesn't match
          }

          // Check tool pattern (supports wildcards)
          if (toolPattern === '*') {
            return true; // All tools from this server
          }

          if (toolPattern && toolPattern.includes('*')) {
            // Wildcard pattern matching
            const regex = new RegExp('^' + toolPattern.replace(/\*/g, '.*') + '$');
            return regex.test(toolName);
          }

          return toolPattern === toolName;
        } else {
          // Legacy format: exact tool name match (backward compatibility)
          return pattern === toolName;
        }
      });

      if (!hasPermission) {
        throw new Error(
          `Agent ${agent.name || agentId} not authorized for ${targetServerId}:${toolName}. ` +
          `Agent mcpTools: ${agent.mcpTools?.join(', ') || 'none'}`
        );
      }

      // 7. Get service credential from environment
      const token = this.mcpConfigLoader.getServerToken(targetServerId);
      if (!token && targetServerConfig.authentication.type !== 'none') {
        throw new Error(
          `No token found for MCP server ${targetServerId}. ` +
          `Set ${targetServerConfig.authentication.envVar} in environment.`
        );
      }

      // 8. Get or create MCP client (HTTP or SSE based on transport)
      const clientKey = targetServerId; // One client per server (service credential)
      let client = this.mcpClients.get(clientKey);

      if (!client) {
        // Create appropriate client based on transport type
        if (targetServerConfig.transport === 'sse') {
          console.log(`🔌 Creating SSE MCP client for ${targetServerId}`);
          client = new SSEMCPClient(
            targetServerConfig.baseUrl!,
            token,
            targetServerConfig.authentication.header,
            targetServerConfig.authentication.prefix,
            targetServerConfig.customHeaders || {}
          );
        } else {
          // Default to HTTP transport
          console.log(`🔌 Creating HTTP MCP client for ${targetServerId}`);
          client = new HttpMCPClient(
            targetServerConfig.baseUrl!,
            token,
            targetServerConfig.authentication.header,
            targetServerConfig.authentication.prefix
          );
        }
        this.mcpClients.set(clientKey, client);
      }

      // 9. Strip server prefix from tool name before sending to MCP server
      // Tool names come in as "github:get_commit" but MCP servers expect just "get_commit"
      const actualToolName = toolName.includes(':')
        ? toolName.split(':')[1]!
        : toolName;

      console.log(
        `🌐 MCP Routing: agent=${agent.name || agentId}, tool=${targetServerId}:${actualToolName}, realm=${realmId}`
      );

      const result = await client.callTool(actualToolName, params);

      console.log(`✅ MCP tool ${targetServerId}:${toolName} completed for agent ${agent.name || agentId}`);
      return result;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown';
      console.error(`❌ MCP routing failed for ${toolName}:`, errorMessage);

      // Return error in MCP format
      return {
        content: [{
          type: 'text',
          text: `Error: ${errorMessage}`
        }],
        isError: true
      };
    }
  }

  /**
   * Tool: Read content from a file
   */
  private async toolReadFile(agent: Agent, params: { file_url: string }): Promise<any> {
    const { ResourceAccessValidator } = await import('./ResourceAccessValidator');

    if (!params.file_url) {
      throw new Error('file_url parameter is required');
    }

    // Validate file URL format
    if (!ResourceAccessValidator.isValidFileUrl(params.file_url)) {
      throw new Error('Invalid file URL: must start with file:///');
    }

    // Debug logging for permission checking
    console.log(`🔍 Permission check for agent ${agent.id}:`);
    console.log(`   Requested: ${params.file_url}`);
    console.log(`   Agent resourceAccess:`, JSON.stringify(agent.resourceAccess, null, 2));

    // Check access permissions
    if (!ResourceAccessValidator.hasAccess(agent.resourceAccess, params.file_url)) {
      throw new Error(ResourceAccessValidator.getAccessDeniedMessage(params.file_url, agent.id));
    }

    try {
      const fs = await import('fs/promises');
      const filePath = ResourceAccessValidator.fileUrlToPath(params.file_url);
      const content = await fs.readFile(filePath, 'utf-8');

      console.log(`📖 Agent ${agent.id} read file: ${params.file_url}`);

      return {
        success: true,
        file_url: params.file_url,
        content,
        size: content.length
      };
    } catch (error: any) {
      console.error(`❌ Error reading file ${params.file_url}:`, error.message);
      throw new Error(`Failed to read file: ${error.message}`);
    }
  }

  /**
   * Tool: Write content to a file
   */
  private async toolWriteFile(agent: Agent, params: { file_url: string; content: string }): Promise<any> {
    const { ResourceAccessValidator } = await import('./ResourceAccessValidator');

    if (!params.file_url) {
      throw new Error('file_url parameter is required');
    }

    if (params.content === undefined) {
      throw new Error('content parameter is required');
    }

    // Validate file URL format
    if (!ResourceAccessValidator.isValidFileUrl(params.file_url)) {
      throw new Error('Invalid file URL: must start with file:///');
    }

    // Check access permissions
    if (!ResourceAccessValidator.hasAccess(agent.resourceAccess, params.file_url)) {
      throw new Error(ResourceAccessValidator.getAccessDeniedMessage(params.file_url, agent.id));
    }

    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      const filePath = ResourceAccessValidator.fileUrlToPath(params.file_url);

      // Ensure directory exists
      const dirPath = path.dirname(filePath);
      await fs.mkdir(dirPath, { recursive: true });

      // Write file
      await fs.writeFile(filePath, params.content, 'utf-8');

      console.log(`✍️  Agent ${agent.id} wrote file: ${params.file_url} (${params.content.length} bytes)`);

      return {
        success: true,
        file_url: params.file_url,
        bytes_written: params.content.length
      };
    } catch (error: any) {
      console.error(`❌ Error writing file ${params.file_url}:`, error.message);
      throw new Error(`Failed to write file: ${error.message}`);
    }
  }

  /**
   * Tool: List files and directories in a directory
   */
  private async toolListFiles(agent: Agent, params: { directory_url: string }): Promise<any> {
    const { ResourceAccessValidator } = await import('./ResourceAccessValidator');

    if (!params.directory_url) {
      throw new Error('directory_url parameter is required');
    }

    // Validate directory URL format
    if (!ResourceAccessValidator.isValidFileUrl(params.directory_url)) {
      throw new Error('Invalid directory URL: must start with file:///');
    }

    // Check access permissions for the directory
    if (!ResourceAccessValidator.hasAccess(agent.resourceAccess, params.directory_url)) {
      throw new Error(ResourceAccessValidator.getAccessDeniedMessage(params.directory_url, agent.id));
    }

    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      const dirPath = ResourceAccessValidator.fileUrlToPath(params.directory_url);

      // Check if directory exists
      const stat = await fs.stat(dirPath);
      if (!stat.isDirectory()) {
        throw new Error('Path is not a directory');
      }

      // Read directory contents
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      // Build file list with metadata
      const files = await Promise.all(entries.map(async (entry) => {
        const entryPath = path.join(dirPath, entry.name);
        const entryStat = await fs.stat(entryPath);

        return {
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
          size: entry.isFile() ? entryStat.size : undefined,
          modified: entryStat.mtime.toISOString(),
          path: `file://${entryPath}`  // file:// + absolute path = file:///path (entryPath starts with /)
        };
      }));

      console.log(`📂 Agent ${agent.id} listed directory: ${params.directory_url} (${files.length} entries)`);

      return {
        success: true,
        directory_url: params.directory_url,
        files,
        count: files.length
      };
    } catch (error: any) {
      console.error(`❌ Error listing directory ${params.directory_url}:`, error.message);
      throw new Error(`Failed to list directory: ${error.message}`);
    }
  }

  /**
   * Tool: Process multiple files in batch with automatic iteration
   * This tool eliminates the need for manual looping - it processes ALL files automatically
   */
  private async toolProcessFilesBatch(
    agent: Agent,
    params: {
      input_directory: string;
      output_directory: string;
      file_pattern?: string;
      processing_instructions: string;
      output_filename_template?: string;
    },
    sessionId?: string
  ): Promise<any> {
    // Validate required parameters
    if (!params.input_directory) {
      throw new Error('input_directory parameter is required');
    }
    if (!params.output_directory) {
      throw new Error('output_directory parameter is required');
    }
    if (!params.processing_instructions) {
      throw new Error('processing_instructions parameter is required');
    }

    console.log(`🔄 Starting batch file processing for agent ${agent.id}`);
    console.log(`   Input: ${params.input_directory}`);
    console.log(`   Output: ${params.output_directory}`);
    console.log(`   Instructions: ${params.processing_instructions}`);

    try {
      // List all files in the input directory
      const listResult = await this.toolListFiles(agent, { directory_url: params.input_directory });

      // Filter files by pattern if provided
      let filesToProcess = listResult.files.filter((f: any) => f.type === 'file');
      if (params.file_pattern) {
        const pattern = params.file_pattern.replace(/\*/g, '.*').replace(/\?/g, '.');
        const regex = new RegExp(pattern);
        filesToProcess = filesToProcess.filter((f: any) => regex.test(f.name));
      }

      console.log(`📋 Found ${filesToProcess.length} files to process`);

      const results: any[] = [];
      let successCount = 0;
      let errorCount = 0;

      // Process each file
      for (let i = 0; i < filesToProcess.length; i++) {
        const file = filesToProcess[i];
        const fileNum = i + 1;

        console.log(`📄 Processing file ${fileNum}/${filesToProcess.length}: ${file.name}`);

        try {
          // Read the input file
          const fileContent = await this.toolReadFile(agent, { file_url: file.path });

          // Construct processing prompt for this file
          // CRITICAL: Agent's system prompt defines output format, processing_instructions are SECONDARY guidance
          const processingPrompt = `IMPORTANT: Review your system prompt's "Output Format" or "Domain Expertise" section and apply that EXACT format.

INPUT FILE: ${file.name}
FILE CONTENT:
${fileContent.content}

ADDITIONAL CONTEXT: ${params.processing_instructions}

YOUR TASK:
Transform the file content above using the EXACT OUTPUT FORMAT defined in your system prompt.

- If your system prompt defines learning modules: create a learning module with metadata comments, assessment questions, and practical exercises
- If your system prompt defines a specific markdown structure: use that exact structure
- If your system prompt shows format examples: follow those examples precisely

OUTPUT FILENAME CONTROL:
If you need to specify a custom output filename based on content metadata, include this comment at the VERY START of your response:
<!-- OUTPUT_FILENAME: your-custom-filename.md -->

For example:
<!-- OUTPUT_FILENAME: [Main_Topic]-[Sub_Topic]-[Difficulty_Level]-[Version].md -->

The comment will be automatically removed from the final file.

DO NOT:
- Create generic summaries or cleaned-up markdown
- Say "I've processed..." or describe what you did
- Deviate from your system prompt's specified format

Your entire response will be written to a file. Start with the formatted content immediately:`;

          // Execute processing via agent's LLM (self-processing)
          const processed = await this.executeAgentPrompt(agent.id, {
            prompt: processingPrompt,
            ...(sessionId && { sessionId })
          });

          // Extract agent-specified output filename if present
          let finalContent = processed.response;
          let agentSpecifiedFilename: string | null = null;

          // Check for OUTPUT_FILENAME directive at start of response
          const filenameMatch = finalContent.match(/^<!--\s*OUTPUT_FILENAME:\s*(.+?)\s*-->\s*/);
          if (filenameMatch) {
            const captured = filenameMatch[1];
            const fullMatch = filenameMatch[0];
            if (captured !== undefined && fullMatch !== undefined) {
              agentSpecifiedFilename = captured.trim();
              // Remove the directive from the content
              finalContent = finalContent.substring(fullMatch.length);
              console.log(`   📝 Agent specified custom filename: ${agentSpecifiedFilename}`);
            }
          }

          // Determine output filename
          const path = await import('path');
          let outputFilename: string;

          if (agentSpecifiedFilename) {
            // Use agent-specified filename
            outputFilename = agentSpecifiedFilename;
          } else {
            // Fall back to template-based naming
            const basename = path.basename(file.name, path.extname(file.name));
            const outputTemplate = params.output_filename_template || '{basename}_processed.md';

            // Support multiple template variable formats:
            // {basename}, {{basename}}, {filename}, {{filename}}, {filename_without_extension}, {{filename_without_extension}}
            outputFilename = outputTemplate
              .replace(/\{\{?basename\}\}?/g, basename)
              .replace(/\{\{?filename_without_extension\}\}?/g, basename)
              .replace(/\{\{?filename\}\}?/g, basename);
          }

          // Construct output path
          const outputPath = `${params.output_directory.replace(/\/$/, '')}/${outputFilename}`;

          // Write the processed content (with directive removed if present)
          await this.toolWriteFile(agent, {
            file_url: outputPath,
            content: finalContent
          });

          console.log(`✅ Successfully processed: ${file.name} → ${outputFilename}`);

          results.push({
            input_file: file.name,
            input_path: file.path,
            output_file: outputFilename,
            output_path: outputPath,
            status: 'success',
            processed_at: new Date().toISOString()
          });

          successCount++;

        } catch (error: any) {
          console.error(`❌ Error processing file ${file.name}:`, error.message);

          results.push({
            input_file: file.name,
            input_path: file.path,
            status: 'error',
            error: error.message,
            processed_at: new Date().toISOString()
          });

          errorCount++;
        }
      }

      console.log(`🎉 Batch processing complete: ${successCount} succeeded, ${errorCount} failed`);

      return {
        success: true,
        total_files: filesToProcess.length,
        succeeded: successCount,
        failed: errorCount,
        results
      };

    } catch (error: any) {
      console.error(`❌ Batch processing failed:`, error.message);
      throw new Error(`Batch processing failed: ${error.message}`);
    }
  }

  /**
   * Tool: Fetch content from an HTTP/HTTPS URL
   */
  /**
   * search_worldtree — retrieve passages from the ingested corpus to ground the
   * agent's reasoning (in-session RAG). Semantic/lexical ranking, scoped to the
   * agent's in-scope set: global ∪ the agent's realms (rung #5a).
   */
  private async toolSearchWorldtree(agent: Agent, params: { query?: string; limit?: number; realms?: string[] }, sessionId?: string): Promise<any> {
    const query = typeof params.query === 'string' ? params.query.trim() : '';
    if (!query) {
      return { success: false, error: 'query is required' };
    }
    const limit = typeof params.limit === 'number' && params.limit > 0 ? Math.min(params.limit, 20) : 5;

    // Scoped retrieval: the shared global corpus is always implicit; additional
    // realms are resolved (and grant-clamped) by resolveSearchScope from the
    // session's research scope, the agent's current presence, and any explicitly
    // requested realms. Session-scoped research realms are what keep an
    // unanchored coordinator pinned to the intended campaign's corpus instead of
    // every realm it can reach. See searchScope.ts.
    const accessible = collectAgentRealms(agent.realmAccess);
    const accessibleSet = new Set(accessible);
    const sessionResearchRealms: string[] =
      sessionId && typeof this.coordinationService?.getSessionResearchRealms === 'function'
        ? (this.coordinationService.getSessionResearchRealms(sessionId) ?? [])
        : [];
    // Normalise requested realms to canonical slugs before the grant check.
    // External MCP clients may still pass a pre-migration realm UUID, and the
    // intersection below is exact, so an unnormalised id would be reported as
    // inaccessible and silently dropped from the scope.
    const explicitRealms = Array.isArray(params.realms)
      ? await this.realmService.resolveRealmIds(params.realms.map((r) => String(r)))
      : undefined;
    if (explicitRealms) {
      for (const id of explicitRealms) {
        if (!accessibleSet.has(id)) {
          console.warn(`🔒 search_worldtree: agent ${agent.id} requested realm ${id} it cannot access — ignoring`);
        }
      }
    }
    const realms = resolveSearchScope({
      accessibleRealms: accessible,
      sessionResearchRealms,
      currentRealm: this.resolveCurrentRealm(agent, agent.id, sessionId),
      explicitRealms,
    });
    const qs = getWorldTreeQueryService();
    // Always pass a scope object (even when realms is empty → global-only);
    // omitting scope would search the entire corpus unbounded.
    const results = await qs.searchChunks(query, limit, { realms });
    // Coverage demand signal (rung #5b): in-scope corpus had nothing → record a gap.
    if (results.length === 0) {
      qs.recordKnowledgeGap({ query, realms, agentId: agent.id, sessionId: sessionId ?? null })
        .catch((e) => console.warn('recordKnowledgeGap failed:', e instanceof Error ? e.message : e));
    }
    return {
      success: true,
      query,
      scopeRealms: realms,
      count: results.length,
      passages: results.map((r) => ({
        source: r.sourceUri,
        title: r.title,
        headings: r.headings,
        documentId: r.documentId,
        text: r.text,
        sourceFormat: r.sourceFormat,
        fetchedAt: r.fetchedAt,
        checksum: r.checksum,
      })),
    };
  }

  private async toolFetchUrl(agent: Agent, params: { url?: string; urls?: string[]; method?: string; body?: any; headers?: Record<string, string> }): Promise<any> {
    const { ResourceAccessValidator } = await import('./ResourceAccessValidator');

    const method = (params.method || 'GET').toUpperCase();
    const headers = params.headers || {};

    const fetchOne = async (url: string) => {
      if (!ResourceAccessValidator.isValidHttpUrl(url)) {
        return { success: false, url, error: 'Invalid URL: must start with http:// or https://' };
      }
      if (!ResourceAccessValidator.hasAccess(agent.resourceAccess, url)) {
        return { success: false, url, error: ResourceAccessValidator.getAccessDeniedMessage(url, agent.id) };
      }

      try {
        console.log(`🌐 Agent ${agent.id} fetching URL: ${method} ${url}`);

        const fetchOptions: RequestInit = { method, headers: { ...headers } };

        if (params.body && ['POST', 'PUT', 'PATCH'].includes(method)) {
          fetchOptions.body = typeof params.body === 'string' ? params.body : JSON.stringify(params.body);
          if (!(fetchOptions.headers as Record<string, string>)['Content-Type']) {
            (fetchOptions.headers as Record<string, string>)['Content-Type'] = 'application/json';
          }
        }

        const response = await fetch(url, fetchOptions);
        const contentType = response.headers.get('content-type') || '';
        const responseData = contentType.includes('application/json')
          ? await response.json()
          : await response.text();

        return {
          success: true,
          url,
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          data: responseData
        };
      } catch (error: any) {
        console.error(`❌ Error fetching URL ${url}:`, error.message);
        return { success: false, url, error: error.message };
      }
    };

    // Batch mode: urls array
    if (params.urls && params.urls.length > 0) {
      const results = await Promise.all(params.urls.map(fetchOne));
      return {
        success: results.every(r => r.success),
        total: results.length,
        succeeded: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        results
      };
    }

    // Single mode: url string
    if (!params.url) {
      throw new Error('Either "url" or "urls" parameter is required');
    }
    const result = await fetchOne(params.url);
    if (!result.success) {
      throw new Error(result.error);
    }
    return result;
  }

}
