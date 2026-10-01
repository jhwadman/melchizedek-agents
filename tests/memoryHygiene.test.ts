/**
 * Memory-store hygiene — fully offline, no keys, no network, no Supabase.
 *
 * The live store had filled with restatements: one Roth IRA balance recorded
 * six ways, one preference seven, and thirteen EPISODE records narrating the
 * same session with a growing ticker list. Two mechanics caused it — the A2A
 * server re-ingests the WHOLE session after every task, and dedup compared
 * byte-identical strings while the extraction model rephrased on every pass.
 *
 * These tests pin the two replacements, and the asymmetry that governs both:
 * a duplicate costs a shortlist slot, a dropped fact costs the user something
 * they told the desk. So every ambiguous case must resolve toward STORING.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import {
	eventsToIngest,
	isSemanticDuplicate,
	MEMORY_DEDUP_SIMILARITY,
  stripHarnessBlocks,
} from '../lib/memory/supabaseMemoryService.ts';

// ── Incremental ingestion ────────────────────────────────────────────────

test('only turns since the last ingestion are distilled', () => {
	const events = ['u1', 'a1', 'u2', 'a2', 'u3', 'a3'];
	assert.deepEqual(eventsToIngest(events, 0), events);
	assert.deepEqual(eventsToIngest(events, 4), ['u3', 'a3']);
	assert.deepEqual(eventsToIngest(events, 6), []);
});

test('a session with nothing new yields nothing — the N-times-over bug', () => {
	// The exact shape that produced 13 episodes of one conversation: the task
	// completes, ingestion fires, and the session has not grown since.
	const events = ['u1', 'a1'];
	assert.deepEqual(eventsToIngest(events, 2), []);
});

test('a reset watermark re-reads the session rather than skipping it', () => {
	// The in-process counter is lost on restart. Re-reading once is the
	// intended cost — semantic dedup absorbs the batch — but silently
	// skipping the session would lose every fact in it.
	const events = ['u1', 'a1', 'u2', 'a2'];
	assert.deepEqual(eventsToIngest(events, 0), events);
});

test('a shrunken or malformed event list never throws or over-slices', () => {
	assert.deepEqual(eventsToIngest([], 5), []);
	assert.deepEqual(eventsToIngest(['a'], 5), []);
	assert.deepEqual(eventsToIngest(['a', 'b'], -3), ['a', 'b']);
	assert.deepEqual(eventsToIngest(undefined as any, 0), []);
});

// ── Semantic dedup ───────────────────────────────────────────────────────

const near = (similarity: number, over: Partial<{ tag: string; status: string }> = {}) => ({
	tag: 'FACT', status: 'active', similarity, ...over,
});

test('a rephrased restatement is recognised as a duplicate', () => {
	// "The user has $831 in a forgotten Roth IRA" vs "...an $831 balance in a
	// forgotten Roth IRA account" — the pair that landed six times.
	assert.equal(isSemanticDuplicate({ tag: 'FACT' }, [near(0.96)]), true);
});

test('a related but distinct fact is stored', () => {
	// "NVDA closed at $217.50" vs "Wells Fargo put a $315 target on NVDA":
	// same subject, different fact. Must not be swallowed.
	assert.equal(isSemanticDuplicate({ tag: 'FACT' }, [near(0.78)]), false);
	assert.equal(isSemanticDuplicate({ tag: 'FACT' }, [near(0.92)]), false);
});

test('the threshold is inclusive and high enough to be conservative', () => {
	assert.equal(isSemanticDuplicate({ tag: 'FACT' }, [near(MEMORY_DEDUP_SIMILARITY)]), true);
	assert.equal(isSemanticDuplicate({ tag: 'FACT' }, [near(MEMORY_DEDUP_SIMILARITY - 0.0001)]), false);
	assert.ok(MEMORY_DEDUP_SIMILARITY >= 0.9, 'a low threshold would discard real facts');
});

test('tags must match — an episode never suppresses a fact', () => {
	// An EPISODE narrating a discussion of the Roth IRA reads almost the same
	// as the FACT of its balance. Losing the fact would be the bad outcome.
	assert.equal(isSemanticDuplicate({ tag: 'FACT' }, [near(0.99, { tag: 'EPISODE' })]), false);
	assert.equal(isSemanticDuplicate({ tag: 'PREFERENCE' }, [near(0.99, { tag: 'FACT' })]), false);
});

test('a retired row never suppresses a new one', () => {
	// A superseded record is history; the corrected fact may legitimately be
	// asserted again later and must be storable.
	assert.equal(isSemanticDuplicate({ tag: 'FACT' }, [near(0.99, { status: 'superseded' })]), false);
	assert.equal(isSemanticDuplicate({ tag: 'FACT' }, [near(0.99, { status: 'historical' })]), false);
});

test('a missing status is treated as active, a missing tag as no match', () => {
	assert.equal(isSemanticDuplicate({ tag: 'FACT' }, [{ tag: 'FACT', status: null, similarity: 0.97 }]), true);
	assert.equal(isSemanticDuplicate({ tag: 'FACT' }, [{ tag: null, status: 'active', similarity: 0.97 }]), false);
});

test('an empty or absent match set stores the record', () => {
	assert.equal(isSemanticDuplicate({ tag: 'FACT' }, []), false);
});

test('one duplicate among several near misses is enough to skip', () => {
	assert.equal(
		isSemanticDuplicate({ tag: 'FACT' }, [near(0.61), near(0.88), near(0.95)]),
		true,
	);
});

test('harness blocks never reach the memory query or the extraction transcript', () => {
  const msg = '[System Context: Current Date is August 18, 2026]\n'
    + '[Account Payload]\n```json\n{"account":{"equity_usd":1},"positions":{"NKE":{"total_qty":10}}}\n```\n'
    + "whats the read on Nike stock";
  assert.strictEqual(stripHarnessBlocks(msg), 'whats the read on Nike stock');
  // A plain message is untouched; an all-harness message becomes empty (caller falls back).
  assert.strictEqual(stripHarnessBlocks('hello there'), 'hello there');
  // Any `[… Payload]` / `[… Sheet]` label followed by a fenced block is a
  // surface's data, never something the user said; a plain bracket is speech.
  assert.strictEqual(stripHarnessBlocks('[Trade Sheet]\n```\nAAPL 10\n```\nshould I trim?'), 'should I trim?');
  assert.strictEqual(stripHarnessBlocks('[Note] keep this'), '[Note] keep this');
  assert.strictEqual(stripHarnessBlocks('[System Context: Current Date is August 18, 2026]'), '');
});
