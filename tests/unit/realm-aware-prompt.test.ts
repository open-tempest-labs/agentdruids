/**
 * Realm-Aware Prompt Tests
 *
 * executeAgentPrompt builds a system prompt down one of four branches:
 * explicit override, layered composition, persona (collaboration), and legacy.
 * Three of them appended realm context; the composition success path did not.
 *
 * The consequence was backwards: a *failed* composition fell back to a path
 * that applied realm context, so a working composition produced the less
 * realm-aware prompt. Delegated specialists take the composition path, so every
 * delegated agent lost the one line telling it where it was operating — a
 * regression introduced when agents opted into composition, a month after the
 * runs these prompts were tuned against.
 *
 * Layer 3 was supposed to carry realm context, but it is sourced from
 * realm.configuration.promptLayer and no realm populates it (deliberately
 * deferred — see docs/implementation/phase-1-elemental-templates.md
 * "Remaining"), so this block is the only realm signal a composed agent gets.
 *
 * These tests pin the decision rather than the branch plumbing, which needs a
 * live AgentService to exercise.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const SOURCE = readFileSync(
  join(__dirname, '../../src/services/AgentService.ts'),
  'utf8'
);

/**
 * The prompt-building branches, identified by the statement that terminates
 * each one. Structural assertions over source are a blunt instrument, but the
 * alternative is standing up AgentService — which opens database connections
 * (see #116) — and the property under test is precisely "every branch does the
 * same thing", which is a structural property.
 */
describe('realm context is applied on every prompt-building branch', () => {
  it('calls generateRealmAwareSystemPrompt four times outside its own definition', () => {
    const calls = SOURCE.split('\n').filter(
      (l) => l.includes('generateRealmAwareSystemPrompt(') && !l.includes('private async')
    );
    // explicit-override has no realm step by design (caller supplied the whole
    // prompt), so four: composition, composition-fallback, persona, legacy.
    expect(calls).toHaveLength(4);
  });

  it('applies it on the composition success path, not only the fallback', () => {
    // The defect: the only call inside the composition branch was in its catch.
    const compositionBranch = SOURCE.slice(
      SOURCE.indexOf('} else if (this.promptCompositionService && agent.promptConfig) {'),
      SOURCE.indexOf('} else if (collaborationContextStr) {')
    );
    const beforeCatch = compositionBranch.slice(0, compositionBranch.indexOf('} catch (error) {'));

    expect(beforeCatch).toContain('generateRealmAwareSystemPrompt');
  });

  it('applies it after the collaboration context, so the realm block is not buried', () => {
    const start = SOURCE.indexOf('systemPrompt = composedPrompt.final_prompt;');
    const compositionBranch = SOURCE.slice(start, SOURCE.indexOf('} catch (error) {', start));
    const collabAt = compositionBranch.indexOf('collaborationContextStr');
    const realmAt = compositionBranch.indexOf('generateRealmAwareSystemPrompt');
    const toolsAt = compositionBranch.indexOf('appendToolInfo');

    expect(collabAt).toBeGreaterThan(-1);
    expect(realmAt).toBeGreaterThan(collabAt);
    expect(toolsAt).toBeGreaterThan(realmAt);
  });

  it('threads the session id, so session-scoped travel wins over global state', () => {
    // An agent that travelled during the session must be told the realm it
    // travelled to, not the one it is bound to.
    const start = SOURCE.indexOf('systemPrompt = composedPrompt.final_prompt;');
    const compositionBranch = SOURCE.slice(start, SOURCE.indexOf('} catch (error) {', start));
    expect(compositionBranch).toMatch(
      /generateRealmAwareSystemPrompt\([^)]*request\.sessionId[^)]*\)/
    );
  });
});
