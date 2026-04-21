import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateMessages, buildMessagePrompt } from '../../src/automations/message-generation.js';
import { ConfigError, AuthError } from '../../src/api/errors.js';
import type { Lead, PaginatedLeads, UpdateLeadInput } from '../../src/api/types.js';
import type { MessageGeneratorFn } from '../../src/automations/types.js';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: 'lead-1',
    firstName: 'Sarah',
    lastName: 'Chen',
    profileUrl: 'https://linkedin.com/in/sarah-chen',
    company: 'FinPay',
    jobTitle: 'CEO',
    location: 'San Francisco, CA',
    fit: 'qualified',
    fitScore: 75,
    profileBaseline: 'ICP Score: 75/100\nReasoning: Strong ICP match\nSignals: Recently raised Series A ($8M) | Hiring 3 SDRs | Posted about scaling outbound',
    intentSignals: ['Recently raised Series A ($8M)', 'Hiring 3 SDRs', 'Posted about scaling outbound'],
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeWarmLeads(count: number, scoreBase = 60): Lead[] {
  return Array.from({ length: count }, (_, i) =>
    makeLead({
      id: `lead-${i + 1}`,
      firstName: 'Lead',
      lastName: `${i + 1}`,
      profileUrl: `https://linkedin.com/in/lead-${i + 1}`,
      fit: 'qualified',
      fitScore: scoreBase + i,
      profileBaseline: `ICP Score: ${scoreBase + i}/100\nReasoning: Good match\nSignals: Signal for lead ${i + 1}`,
      intentSignals: [`Signal for lead ${i + 1}`],
    }),
  );
}

function emptyPaginated(): PaginatedLeads {
  return { leads: [], total: 0, page: 1, pageSize: 25 };
}

function paginatedWith(leads: Lead[], total?: number): PaginatedLeads {
  return { leads, total: total ?? leads.length, page: 1, pageSize: leads.length || 25 };
}

type MockClient = {
  searchLeads: ReturnType<typeof vi.fn>;
  getLead: ReturnType<typeof vi.fn>;
  updateLead: ReturnType<typeof vi.fn>;
};

function makeMockClient(overrides: Partial<{
  searchLeads: (filters?: unknown) => Promise<PaginatedLeads>;
  getLead: (id: string) => Promise<Lead>;
  updateLead: (id: string, updates: UpdateLeadInput) => Promise<Lead>;
}> = {}): MockClient {
  return {
    searchLeads: overrides.searchLeads
      ? vi.fn().mockImplementation(overrides.searchLeads)
      : vi.fn().mockResolvedValue(emptyPaginated()),
    getLead: overrides.getLead
      ? vi.fn().mockImplementation(overrides.getLead)
      : vi.fn().mockResolvedValue(makeLead()),
    updateLead: overrides.updateLead
      ? vi.fn().mockImplementation(overrides.updateLead)
      : vi.fn().mockImplementation(async (_id: string, updates: UpdateLeadInput) =>
          makeLead({ ...updates }),
        ),
  };
}

function mockGenerator(message = 'Hey Sarah, saw your Series A raise — congrats! Building outbound? We help fintech founders scale from 0 to booked meetings fast.'): MessageGeneratorFn {
  return vi.fn().mockResolvedValue(message);
}

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Reject run when ICP description is missing
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Reject run when ICP description is missing', () => {
  beforeEach(() => {
    delete process.env.ICP_DESCRIPTION;
  });

  it('throws ConfigError when ICP_DESCRIPTION is not set', async () => {
    await expect(generateMessages()).rejects.toThrow(ConfigError);
  });

  it('ConfigError message instructs founder to set ICP_DESCRIPTION', async () => {
    await expect(generateMessages()).rejects.toThrow(
      'Missing ICP_DESCRIPTION in .env.local — describe your ideal customer first',
    );
  });

  it('throws ConfigError when ICP_DESCRIPTION is empty string', async () => {
    process.env.ICP_DESCRIPTION = '';
    await expect(generateMessages()).rejects.toThrow(ConfigError);
    delete process.env.ICP_DESCRIPTION;
  });

  it('does not generate any messages on ConfigError', async () => {
    const client = makeMockClient();
    await expect(
      generateMessages({ _client: client }),
    ).rejects.toThrow(ConfigError);
    expect(client.searchLeads).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Reject run when VALUE_PROPOSITION is missing
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Reject run when VALUE_PROPOSITION is missing', () => {
  const ICP = 'Series A fintech founders';
  beforeEach(() => {
    delete process.env.VALUE_PROPOSITION;
  });

  it('throws ConfigError when VALUE_PROPOSITION is not set', async () => {
    await expect(generateMessages({ icpDescription: ICP })).rejects.toThrow(ConfigError);
  });

  it('ConfigError message instructs founder to set VALUE_PROPOSITION', async () => {
    await expect(generateMessages({ icpDescription: ICP })).rejects.toThrow(
      /Missing VALUE_PROPOSITION.+so the LLM does not invent one/,
    );
  });

  it('throws ConfigError when VALUE_PROPOSITION is empty string', async () => {
    process.env.VALUE_PROPOSITION = '';
    await expect(generateMessages({ icpDescription: ICP })).rejects.toThrow(ConfigError);
    delete process.env.VALUE_PROPOSITION;
  });

  it('does not hit the GojiBerry API when VALUE_PROPOSITION is missing', async () => {
    const client = makeMockClient();
    await expect(
      generateMessages({ icpDescription: ICP, _client: client }),
    ).rejects.toThrow(ConfigError);
    expect(client.searchLeads).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Prompt includes value prop and forbids inventing other products
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Prompt anchors the LLM to the configured value proposition', () => {
  const ICP = 'Series A fintech founders';
  const VALUE_PROP = 'SalesEdge runs done-for-you outbound sales ops for mid-market trades companies';

  it('includes the value proposition verbatim in the prompt', () => {
    const lead = makeLead();
    const prompt = buildMessagePrompt(lead, ICP, VALUE_PROP, { tone: 'casual', maxLength: 300 });
    expect(prompt).toContain(VALUE_PROP);
  });

  it('includes the ICP description in the prompt', () => {
    const lead = makeLead();
    const prompt = buildMessagePrompt(lead, ICP, VALUE_PROP, { tone: 'casual', maxLength: 300 });
    expect(prompt).toContain(ICP);
  });

  it('explicitly forbids inventing products/platforms in the prompt', () => {
    const lead = makeLead();
    const prompt = buildMessagePrompt(lead, ICP, VALUE_PROP, { tone: 'casual', maxLength: 300 });
    // Prevents the GojiBerry hallucination we saw in production
    expect(prompt).toMatch(/do not invent|do NOT invent/i);
    expect(prompt).toMatch(/product|platform|tool/i);
  });

  it('labels the value prop so the LLM understands it is the offer, not the target', () => {
    const lead = makeLead();
    const prompt = buildMessagePrompt(lead, ICP, VALUE_PROP, { tone: 'casual', maxLength: 300 });
    expect(prompt).toMatch(/your offer/i);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Generate personalized messages for warm leads
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Generate personalized messages for warm leads', () => {
  const ICP = 'Series A SaaS founders in fintech who are actively hiring';
  const VALUE_PROP = 'We help fintech founders fill their outbound pipeline with qualified meetings in 30 days';

  it('fetches warm leads by scoreFrom and generates messages', async () => {
    const leads = [makeLead()];
    const client = makeMockClient({
      searchLeads: async () => paginatedWith(leads),
    });
    const gen = mockGenerator();

    await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, _client: client, _messageGenerator: gen });

    expect(client.searchLeads).toHaveBeenCalledWith(
      expect.objectContaining({ scoreFrom: expect.any(Number) }),
    );
    expect(gen).toHaveBeenCalledWith(leads[0], ICP, VALUE_PROP, expect.objectContaining({ tone: expect.any(String), maxLength: expect.any(Number) }));
  });

  it('stores message via updateLead with personalizedMessages', async () => {
    const lead = makeLead();
    const client = makeMockClient({
      searchLeads: async () => paginatedWith([lead]),
    });
    const message = 'Hey Sarah, your Series A timing is perfect for what we do.';
    const gen = vi.fn().mockResolvedValue(message) as MessageGeneratorFn;

    await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, _client: client, _messageGenerator: gen });

    expect(client.updateLead).toHaveBeenCalledWith(
      lead.id,
      expect.objectContaining({ personalizedMessages: [{ content: message, stepNumber: 1 }] }),
    );
  });

  it('returns generated results with lead and message', async () => {
    const lead = makeLead();
    const client = makeMockClient({
      searchLeads: async () => paginatedWith([lead]),
    });
    const message = 'Hey Sarah, saw your raise — we can help.';
    const gen = vi.fn().mockResolvedValue(message) as MessageGeneratorFn;

    const result = await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, _client: client, _messageGenerator: gen });

    expect(result.generated).toHaveLength(1);
    expect(result.generated[0].lead).toBe(lead);
    expect(result.generated[0].message).toBe(message);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Identify leads that need messages
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Identify leads that need messages', () => {
  const ICP = 'Series A fintech founders';
  const VALUE_PROP = 'We help fintech founders fill their outbound pipeline with qualified meetings in 30 days';

  it('selects leads where fitScore >= MIN_INTENT_SCORE', async () => {
    const warmLead = makeLead({ fitScore: 55 });
    const client = makeMockClient({
      searchLeads: async () => paginatedWith([warmLead]),
    });
    const gen = mockGenerator();

    const result = await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, _client: client, _messageGenerator: gen });

    expect(result.generated).toHaveLength(1);
  });

  it('skips leads that already have personalizedMessages', async () => {
    const alreadyMessaged = makeLead({ personalizedMessages: [{ content: 'existing message', stepNumber: 1 }] });
    const fresh = makeLead({ id: 'lead-2', firstName: 'Bob', lastName: 'Jones', personalizedMessages: undefined });
    const client = makeMockClient({
      searchLeads: async () => paginatedWith([alreadyMessaged, fresh]),
    });
    const gen = mockGenerator();

    const result = await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, _client: client, _messageGenerator: gen });

    expect(result.generated).toHaveLength(1);
    expect(result.generated[0].lead.id).toBe('lead-2');
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].id).toBe(alreadyMessaged.id);
  });

  it('skips leads with no intentSignals (not yet enriched)', async () => {
    const noSignals = makeLead({ profileBaseline: undefined });
    const withSignals = makeLead({ id: 'lead-2', firstName: 'Bob', lastName: 'Jones', profileBaseline: 'ICP Score: 70/100\nReasoning: Good match\nSignals: Active hiring' });
    const client = makeMockClient({
      searchLeads: async () => paginatedWith([noSignals, withSignals]),
    });
    const gen = mockGenerator();

    const result = await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, _client: client, _messageGenerator: gen });

    expect(result.generated).toHaveLength(1);
    expect(result.generated[0].lead.id).toBe('lead-2');
  });

  it('skips leads with undefined intentSignals', async () => {
    const noSignals = makeLead({ profileBaseline: undefined });
    const client = makeMockClient({
      searchLeads: async () => paginatedWith([noSignals]),
    });
    const gen = mockGenerator();

    const result = await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, _client: client, _messageGenerator: gen });

    expect(result.generated).toHaveLength(0);
  });

  it('processes leads in score-descending order (warmest first)', async () => {
    const processOrder: number[] = [];
    const leads = [
      makeLead({ id: 'lead-1', fitScore: 90, profileBaseline: 'ICP Score: 90/100\nReasoning: Strong match\nSignals: Signal A' }),
      makeLead({ id: 'lead-2', fitScore: 75, profileBaseline: 'ICP Score: 75/100\nReasoning: Good match\nSignals: Signal B' }),
      makeLead({ id: 'lead-3', fitScore: 60, profileBaseline: 'ICP Score: 60/100\nReasoning: Good match\nSignals: Signal C' }),
    ];
    const client = makeMockClient({
      searchLeads: async () => paginatedWith(leads),
    });
    const gen: MessageGeneratorFn = vi.fn().mockImplementation(async (lead: Lead) => {
      processOrder.push(lead.fitScore ?? 0);
      return 'test message';
    });

    await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, _client: client, _messageGenerator: gen });

    expect(processOrder).toEqual([90, 75, 60]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Respect message batch size
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Respect message batch size', () => {
  const ICP = 'Series A fintech founders';
  const VALUE_PROP = 'We help fintech founders fill their outbound pipeline with qualified meetings in 30 days';

  it('processes only MESSAGE_BATCH_SIZE leads per run', async () => {
    const leads = makeWarmLeads(40);
    const client = makeMockClient({
      searchLeads: async () => paginatedWith(leads, 40),
    });
    const gen = mockGenerator();

    const result = await generateMessages({
      icpDescription: ICP, valueProposition: VALUE_PROP,
      batchSize: 15,
      _client: client,
      _messageGenerator: gen,
    });

    expect(result.generated).toHaveLength(15);
  });

  it('processes warmest leads first when batch is limited', async () => {
    const leads = makeWarmLeads(40).sort((a, b) => (b.fitScore ?? 0) - (a.fitScore ?? 0)); // scores 99-60 descending
    const client = makeMockClient({
      searchLeads: async () => paginatedWith(leads, 40),
    });
    const gen = mockGenerator();

    const result = await generateMessages({
      icpDescription: ICP, valueProposition: VALUE_PROP,
      batchSize: 15,
      _client: client,
      _messageGenerator: gen,
    });

    const scores = result.generated.map((r) => r.lead.fitScore ?? 0);
    const minScore = Math.min(...scores);
    expect(minScore).toBeGreaterThanOrEqual(85); // top 15 of scores 60-99
  });

  it('sets remaining to count of eligible leads not processed', async () => {
    const leads = makeWarmLeads(40);
    const client = makeMockClient({
      searchLeads: async () => paginatedWith(leads, 40),
    });
    const gen = mockGenerator();

    const result = await generateMessages({
      icpDescription: ICP, valueProposition: VALUE_PROP,
      batchSize: 15,
      _client: client,
      _messageGenerator: gen,
    });

    expect(result.remaining).toBe(25);
  });

  it('reads batch size from MESSAGE_BATCH_SIZE env var', async () => {
    process.env.MESSAGE_BATCH_SIZE = '10';
    const leads = makeWarmLeads(20);
    const client = makeMockClient({
      searchLeads: async () => paginatedWith(leads, 20),
    });
    const gen = mockGenerator();

    const result = await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, _client: client, _messageGenerator: gen });

    expect(result.generated).toHaveLength(10);
    delete process.env.MESSAGE_BATCH_SIZE;
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Use default batch size when not configured
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Use default batch size when not configured', () => {
  const ICP = 'Series A fintech founders';
  const VALUE_PROP = 'We help fintech founders fill their outbound pipeline with qualified meetings in 30 days';

  it('defaults to batch size of 25', async () => {
    delete process.env.MESSAGE_BATCH_SIZE;
    const leads = makeWarmLeads(30);
    const client = makeMockClient({
      searchLeads: async () => paginatedWith(leads, 30),
    });
    const gen = mockGenerator();

    const result = await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, _client: client, _messageGenerator: gen });

    expect(result.generated).toHaveLength(25);
    expect(result.remaining).toBe(5);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Respect MESSAGE_MAX_LENGTH for LinkedIn connection requests
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Respect MESSAGE_MAX_LENGTH for LinkedIn connection requests', () => {
  const ICP = 'Series A fintech founders';
  const VALUE_PROP = 'We help fintech founders fill their outbound pipeline with qualified meetings in 30 days';

  it('passes maxLength to the message generator', async () => {
    process.env.MESSAGE_MAX_LENGTH = '300';
    const lead = makeLead();
    const client = makeMockClient({
      searchLeads: async () => paginatedWith([lead]),
    });
    const gen = mockGenerator() as ReturnType<typeof vi.fn>;

    await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, _client: client, _messageGenerator: gen });

    expect(gen).toHaveBeenCalledWith(
      lead,
      ICP,
      VALUE_PROP,
      expect.objectContaining({ maxLength: 300 }),
    );
    delete process.env.MESSAGE_MAX_LENGTH;
  });

  it('respects maxLength option override', async () => {
    const lead = makeLead();
    const client = makeMockClient({
      searchLeads: async () => paginatedWith([lead]),
    });
    const gen = mockGenerator() as ReturnType<typeof vi.fn>;

    await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, maxLength: 150, _client: client, _messageGenerator: gen });

    expect(gen).toHaveBeenCalledWith(lead, ICP, VALUE_PROP, expect.objectContaining({ maxLength: 150 }));
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Use default MESSAGE_MAX_LENGTH when not configured
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Use default MESSAGE_MAX_LENGTH when not configured', () => {
  const ICP = 'Series A fintech founders';
  const VALUE_PROP = 'We help fintech founders fill their outbound pipeline with qualified meetings in 30 days';

  it('defaults to 300 characters max length', async () => {
    delete process.env.MESSAGE_MAX_LENGTH;
    const lead = makeLead();
    const client = makeMockClient({
      searchLeads: async () => paginatedWith([lead]),
    });
    const gen = mockGenerator() as ReturnType<typeof vi.fn>;

    await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, _client: client, _messageGenerator: gen });

    expect(gen).toHaveBeenCalledWith(lead, ICP, VALUE_PROP, expect.objectContaining({ maxLength: 300 }));
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Respect message tone setting
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Respect message tone setting', () => {
  const ICP = 'Series A fintech founders';
  const VALUE_PROP = 'We help fintech founders fill their outbound pipeline with qualified meetings in 30 days';

  it('passes tone to the message generator', async () => {
    process.env.MESSAGE_TONE = 'professional';
    const lead = makeLead();
    const client = makeMockClient({
      searchLeads: async () => paginatedWith([lead]),
    });
    const gen = mockGenerator() as ReturnType<typeof vi.fn>;

    await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, _client: client, _messageGenerator: gen });

    expect(gen).toHaveBeenCalledWith(lead, ICP, VALUE_PROP, expect.objectContaining({ tone: 'professional' }));
    delete process.env.MESSAGE_TONE;
  });

  it('respects tone option override', async () => {
    const lead = makeLead();
    const client = makeMockClient({
      searchLeads: async () => paginatedWith([lead]),
    });
    const gen = mockGenerator() as ReturnType<typeof vi.fn>;

    await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, tone: 'direct', _client: client, _messageGenerator: gen });

    expect(gen).toHaveBeenCalledWith(lead, ICP, VALUE_PROP, expect.objectContaining({ tone: 'direct' }));
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Use default casual tone when MESSAGE_TONE is not configured
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Use default casual tone when MESSAGE_TONE is not configured', () => {
  const ICP = 'Series A fintech founders';
  const VALUE_PROP = 'We help fintech founders fill their outbound pipeline with qualified meetings in 30 days';

  it('defaults to casual tone', async () => {
    delete process.env.MESSAGE_TONE;
    const lead = makeLead();
    const client = makeMockClient({
      searchLeads: async () => paginatedWith([lead]),
    });
    const gen = mockGenerator() as ReturnType<typeof vi.fn>;

    await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, _client: client, _messageGenerator: gen });

    expect(gen).toHaveBeenCalledWith(lead, ICP, VALUE_PROP, expect.objectContaining({ tone: 'casual' }));
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle lead with minimal intent signals
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle lead with minimal intent signals', () => {
  const ICP = 'Series A fintech founders';
  const VALUE_PROP = 'We help fintech founders fill their outbound pipeline with qualified meetings in 30 days';

  it('generates message for lead with only one intentSignal', async () => {
    const lead = makeLead({ fitScore: 55, intentSignals: ['Active on LinkedIn'], profileBaseline: 'ICP Score: 55/100' });
    const client = makeMockClient({
      searchLeads: async () => paginatedWith([lead]),
    });
    const gen = mockGenerator();

    const result = await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, _client: client, _messageGenerator: gen });

    expect(result.generated).toHaveLength(1);
  });

  it('logs Low signal warning for lead with only one intentSignal', async () => {
    const consoleSpy = vi.spyOn(console, 'log');
    const lead = makeLead({ firstName: 'Sam', lastName: 'Reed', fitScore: 55, intentSignals: ['Active on LinkedIn'], profileBaseline: 'ICP Score: 55/100' });
    const client = makeMockClient({
      searchLeads: async () => paginatedWith([lead]),
    });
    const gen = mockGenerator();

    await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, _client: client, _messageGenerator: gen });

    expect(consoleSpy).toHaveBeenCalledWith(
      'Low signal: Sam Reed — message generated from limited data',
    );
    consoleSpy.mockRestore();
  });

  it('passes the single signal to the generator', async () => {
    const lead = makeLead({ intentSignals: ['Active on LinkedIn'] });
    const client = makeMockClient({
      searchLeads: async () => paginatedWith([lead]),
    });
    const gen = mockGenerator() as ReturnType<typeof vi.fn>;

    await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, _client: client, _messageGenerator: gen });

    expect(gen).toHaveBeenCalledWith(expect.objectContaining({ intentSignals: ['Active on LinkedIn'] }), ICP, VALUE_PROP, expect.any(Object));
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle GojiBerry API errors during message storage
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle GojiBerry API errors during message storage', () => {
  const ICP = 'Series A fintech founders';
  const VALUE_PROP = 'We help fintech founders fill their outbound pipeline with qualified meetings in 30 days';

  it('logs failure and continues when updateLead errors for one lead', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error');
    const leads = [
      makeLead({ id: 'lead-1', firstName: 'Alice', lastName: 'Smith' }),
      makeLead({ id: 'lead-2', firstName: 'Bob', lastName: 'Jones' }),
      makeLead({ id: 'lead-3', firstName: 'Carol', lastName: 'White' }),
    ];
    const failingId = 'lead-2';
    const client = makeMockClient({
      searchLeads: async () => paginatedWith(leads),
      updateLead: async (id: string, updates: UpdateLeadInput) => {
        if (id === failingId) throw new Error('GojiBerry API error: 500 Internal Server Error');
        return makeLead({ ...updates });
      },
    });
    const gen = mockGenerator();

    const result = await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, _client: client, _messageGenerator: gen });

    expect(result.generated).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].lead.id).toBe(failingId);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to save message for: Bob Jones'),
    );
    consoleErrorSpy.mockRestore();
  });

  it('summary includes failure count when saves fail', async () => {
    const consoleSpy = vi.spyOn(console, 'log');
    const consoleErrorSpy = vi.spyOn(console, 'error');
    const leads = [
      makeLead({ id: 'lead-1', firstName: 'Alice', lastName: 'Smith' }),
      makeLead({ id: 'lead-2', firstName: 'Bob', lastName: 'Jones' }),
    ];
    const client = makeMockClient({
      searchLeads: async () => paginatedWith(leads),
      updateLead: async (id: string, updates: UpdateLeadInput) => {
        if (id === 'lead-2') throw new Error('API error');
        return makeLead({ ...updates });
      },
    });
    const gen = mockGenerator();

    const result = await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, _client: client, _messageGenerator: gen });

    expect(result.failed).toHaveLength(1);
    const totalsLine = consoleSpy.mock.calls.flat().find(
      (arg) => typeof arg === 'string' && arg.includes('failed'),
    );
    expect(totalsLine).toBeDefined();
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle authentication failure
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle authentication failure', () => {
  const ICP = 'Series A fintech founders';
  const VALUE_PROP = 'We help fintech founders fill their outbound pipeline with qualified meetings in 30 days';

  it('throws AuthError when searchLeads returns auth failure', async () => {
    const client = makeMockClient({
      searchLeads: async () => { throw new AuthError(); },
    });
    const gen = mockGenerator();

    await expect(
      generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, _client: client, _messageGenerator: gen }),
    ).rejects.toThrow(AuthError);
  });

  it('does not generate messages before auth failure on fetch', async () => {
    const client = makeMockClient({
      searchLeads: async () => { throw new AuthError(); },
    });
    const gen = mockGenerator() as ReturnType<typeof vi.fn>;

    await expect(
      generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, _client: client, _messageGenerator: gen }),
    ).rejects.toThrow(AuthError);

    expect(gen).not.toHaveBeenCalled();
  });

  it('logs AuthError message then rethrows when updateLead fails with AuthError', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error');
    const lead = makeLead();
    const client = makeMockClient({
      searchLeads: async () => paginatedWith([lead]),
      updateLead: async () => { throw new AuthError(); },
    });
    const gen = mockGenerator();

    await expect(
      generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, _client: client, _messageGenerator: gen }),
    ).rejects.toThrow(AuthError);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('GojiBerry API key is invalid or expired'),
    );
    consoleErrorSpy.mockRestore();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle Anthropic API failure during generation
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle Anthropic API failure during generation', () => {
  const ICP = 'Series A fintech founders';
  const VALUE_PROP = 'We help fintech founders fill their outbound pipeline with qualified meetings in 30 days';

  it('logs failure and continues when message generator throws for one lead', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error');
    const leads = [
      makeLead({ id: 'lead-1', firstName: 'Alice', lastName: 'Smith' }),
      makeLead({ id: 'lead-2', firstName: 'Bob', lastName: 'Jones' }),
      makeLead({ id: 'lead-3', firstName: 'Carol', lastName: 'White' }),
    ];
    let callCount = 0;
    const gen: MessageGeneratorFn = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 2) throw new Error('Anthropic rate limit exceeded');
      return 'a message';
    });
    const client = makeMockClient({
      searchLeads: async () => paginatedWith(leads),
    });

    const result = await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, _client: client, _messageGenerator: gen });

    expect(result.generated).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to generate message for: Bob Jones'),
    );
    consoleErrorSpy.mockRestore();
  });

  it('lead with Anthropic failure is counted in failed result', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error');
    const lead = makeLead({ firstName: 'Bob', lastName: 'Jones' });
    const gen: MessageGeneratorFn = vi.fn().mockRejectedValue(new Error('Anthropic API error'));
    const client = makeMockClient({
      searchLeads: async () => paginatedWith([lead]),
    });

    const result = await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, _client: client, _messageGenerator: gen });

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].lead.firstName).toBe('Bob');
    consoleErrorSpy.mockRestore();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Output message generation summary
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Output message generation summary', () => {
  const ICP = 'Series A fintech founders';
  const VALUE_PROP = 'We help fintech founders fill their outbound pipeline with qualified meetings in 30 days';

  it('outputs totals line after successful batch', async () => {
    const consoleSpy = vi.spyOn(console, 'log');
    const leads = makeWarmLeads(3);
    const client = makeMockClient({
      searchLeads: async () => paginatedWith(leads),
    });
    const gen = mockGenerator();

    await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, _client: client, _messageGenerator: gen });

    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('3 messages generated — ready for review in GojiBerry');
    consoleSpy.mockRestore();
  });

  it('outputs "N remaining" when batch does not cover all eligible leads', async () => {
    const consoleSpy = vi.spyOn(console, 'log');
    const leads = makeWarmLeads(40);
    const client = makeMockClient({
      searchLeads: async () => paginatedWith(leads, 40),
    });
    const gen = mockGenerator();

    await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, batchSize: 15, _client: client, _messageGenerator: gen });

    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('15 messages generated (25 remaining — run again to continue)');
    consoleSpy.mockRestore();
  });

  it('includes lead name, company, fitScore, and message preview in summary table', async () => {
    const consoleSpy = vi.spyOn(console, 'log');
    const lead = makeLead({ firstName: 'Sarah', lastName: 'Chen', company: 'FinPay', fitScore: 85 });
    const client = makeMockClient({
      searchLeads: async () => paginatedWith([lead]),
    });
    const message = 'Hey Sarah, saw you just raised your Series A. We help fintech founders scale outbound from zero.';
    const gen = vi.fn().mockResolvedValue(message) as MessageGeneratorFn;

    await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, _client: client, _messageGenerator: gen });

    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Sarah Chen');
    expect(output).toContain('FinPay');
    expect(output).toContain('85');
    expect(output).toContain(message.slice(0, 80));
    consoleSpy.mockRestore();
  });

  it('outputs nothing when no leads to process', async () => {
    const consoleSpy = vi.spyOn(console, 'log');
    const client = makeMockClient({
      searchLeads: async () => emptyPaginated(),
    });
    const gen = mockGenerator();

    await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, _client: client, _messageGenerator: gen });

    // No summary table or totals when nothing to do
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).not.toContain('messages generated');
    consoleSpy.mockRestore();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Generate messages for a specific lead by ID
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Generate messages for a specific lead by ID', () => {
  const ICP = 'Series A fintech founders';
  const VALUE_PROP = 'We help fintech founders fill their outbound pipeline with qualified meetings in 30 days';

  it('fetches lead via getLead when leadId is provided', async () => {
    const lead = makeLead({ id: 'specific-lead' });
    const client = makeMockClient({
      getLead: async () => lead,
    });
    const gen = mockGenerator();

    await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, leadId: 'specific-lead', _client: client, _messageGenerator: gen });

    expect(client.getLead).toHaveBeenCalledWith('specific-lead');
    expect(client.searchLeads).not.toHaveBeenCalled();
  });

  it('generates and stores message for specified lead', async () => {
    const lead = makeLead({ id: 'specific-lead' });
    const client = makeMockClient({
      getLead: async () => lead,
    });
    const message = 'Hey Sarah, congrats on the Series A!';
    const gen = vi.fn().mockResolvedValue(message) as MessageGeneratorFn;

    const result = await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, leadId: 'specific-lead', _client: client, _messageGenerator: gen });

    expect(result.generated).toHaveLength(1);
    expect(client.updateLead).toHaveBeenCalledWith(
      'specific-lead',
      expect.objectContaining({ personalizedMessages: [{ content: message, stepNumber: 1 }] }),
    );
  });

  it('outputs single lead summary with message preview', async () => {
    const consoleSpy = vi.spyOn(console, 'log');
    const lead = makeLead({ id: 'specific-lead', firstName: 'Sarah', lastName: 'Chen' });
    const client = makeMockClient({
      getLead: async () => lead,
    });
    const message = 'Hey Sarah, saw your Series A. Perfect timing for what we do.';
    const gen = vi.fn().mockResolvedValue(message) as MessageGeneratorFn;

    await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, leadId: 'specific-lead', _client: client, _messageGenerator: gen });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Sarah Chen — message ready:'),
    );
    consoleSpy.mockRestore();
  });

  it('validates lead has intentSignals before generating', async () => {
    const lead = makeLead({ fit: 'unknown' });
    const client = makeMockClient({
      getLead: async () => lead,
    });
    const gen = mockGenerator() as ReturnType<typeof vi.fn>;

    await expect(
      generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, leadId: 'lead-1', _client: client, _messageGenerator: gen }),
    ).rejects.toThrow();

    expect(gen).not.toHaveBeenCalled();
  });

  it('validates lead fitScore meets threshold before generating', async () => {
    const lead = makeLead({ fit: 'unknown', fitScore: 20 });
    const client = makeMockClient({
      getLead: async () => lead,
    });
    const gen = mockGenerator() as ReturnType<typeof vi.fn>;

    await expect(
      generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, leadId: 'lead-1', minIntentScore: 50, _client: client, _messageGenerator: gen }),
    ).rejects.toThrow();

    expect(gen).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Regenerate messages (force refresh)
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Regenerate messages (force refresh)', () => {
  const ICP = 'Series A fintech founders';
  const VALUE_PROP = 'We help fintech founders fill their outbound pipeline with qualified meetings in 30 days';

  it('regenerates messages for leads that already have personalizedMessages', async () => {
    const lead = makeLead({ personalizedMessages: [{ content: 'old message', stepNumber: 1 }] });
    const client = makeMockClient({
      searchLeads: async () => paginatedWith([lead]),
    });
    const gen = mockGenerator();

    const result = await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, forceRegenerate: true, _client: client, _messageGenerator: gen });

    expect(result.generated).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  it('overwrites previous messages in GojiBerry when forceRegenerate is true', async () => {
    const lead = makeLead({ personalizedMessages: [{ content: 'old message', stepNumber: 1 }] });
    const client = makeMockClient({
      searchLeads: async () => paginatedWith([lead]),
    });
    const newMessage = 'brand new personalized message';
    const gen = vi.fn().mockResolvedValue(newMessage) as MessageGeneratorFn;

    await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, forceRegenerate: true, _client: client, _messageGenerator: gen });

    expect(client.updateLead).toHaveBeenCalledWith(
      lead.id,
      expect.objectContaining({ personalizedMessages: [{ content: newMessage, stepNumber: 1 }] }),
    );
  });

  it('logs "Regenerated: {name}" for each regenerated lead', async () => {
    const consoleSpy = vi.spyOn(console, 'log');
    const lead = makeLead({ firstName: 'Sarah', lastName: 'Chen', personalizedMessages: [{ content: 'old message', stepNumber: 1 }] });
    const client = makeMockClient({
      searchLeads: async () => paginatedWith([lead]),
    });
    const gen = mockGenerator();

    await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, forceRegenerate: true, _client: client, _messageGenerator: gen });

    expect(consoleSpy).toHaveBeenCalledWith('Regenerated: Sarah Chen');
    consoleSpy.mockRestore();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Skip leads below intent threshold
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Skip leads below intent threshold', () => {
  const ICP = 'Series A fintech founders';
  const VALUE_PROP = 'We help fintech founders fill their outbound pipeline with qualified meetings in 30 days';

  it('does not fetch cold leads when scoreFrom is applied', async () => {
    const client = makeMockClient({
      searchLeads: async () => paginatedWith([]),
    });
    const gen = mockGenerator() as ReturnType<typeof vi.fn>;

    const result = await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, minIntentScore: 50, _client: client, _messageGenerator: gen });

    expect(client.searchLeads).toHaveBeenCalledWith(
      expect.objectContaining({ scoreFrom: 50 }),
    );
    expect(result.generated).toHaveLength(0);
    expect(gen).not.toHaveBeenCalled();
  });

  it('reads MIN_INTENT_SCORE from env when not passed as option', async () => {
    process.env.MIN_INTENT_SCORE = '70';
    const client = makeMockClient({
      searchLeads: async () => paginatedWith([]),
    });
    const gen = mockGenerator();

    await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, _client: client, _messageGenerator: gen });

    expect(client.searchLeads).toHaveBeenCalledWith(
      expect.objectContaining({ scoreFrom: 70 }),
    );
    delete process.env.MIN_INTENT_SCORE;
  });

  it('defaults to MIN_INTENT_SCORE of 50 when not configured', async () => {
    delete process.env.MIN_INTENT_SCORE;
    const client = makeMockClient({
      searchLeads: async () => paginatedWith([]),
    });
    const gen = mockGenerator();

    await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, _client: client, _messageGenerator: gen });

    expect(client.searchLeads).toHaveBeenCalledWith(
      expect.objectContaining({ scoreFrom: 50 }),
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Generate a message that references real buying signals
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Generate a message that references real buying signals', () => {
  const ICP = 'Series A SaaS founders in fintech who are actively hiring';
  const VALUE_PROP = 'We help fintech founders fill their outbound pipeline with qualified meetings in 30 days';

  it('passes lead with intentSignals to the generator', async () => {
    const lead = makeLead({
      firstName: 'Sarah',
      lastName: 'Chen',
      company: 'FinPay',
      jobTitle: 'CEO',
      intentSignals: ['Recently raised Series A ($8M)', 'Hiring 3 SDRs', 'Posted about scaling outbound'],
    });
    const client = makeMockClient({
      searchLeads: async () => paginatedWith([lead]),
    });
    const gen = mockGenerator() as ReturnType<typeof vi.fn>;

    await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, _client: client, _messageGenerator: gen });

    expect(gen).toHaveBeenCalledWith(
      expect.objectContaining({
        intentSignals: ['Recently raised Series A ($8M)', 'Hiring 3 SDRs', 'Posted about scaling outbound'],
      }),
      ICP,
      VALUE_PROP,
      expect.any(Object),
    );
  });

  it('passes full lead profile including name, company, jobTitle to generator', async () => {
    const lead = makeLead({
      firstName: 'Sarah',
      lastName: 'Chen',
      company: 'FinPay',
      jobTitle: 'CEO',
    });
    const client = makeMockClient({
      searchLeads: async () => paginatedWith([lead]),
    });
    const gen = mockGenerator() as ReturnType<typeof vi.fn>;

    await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, _client: client, _messageGenerator: gen });

    expect(gen).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'Sarah', lastName: 'Chen', company: 'FinPay', jobTitle: 'CEO' }),
      ICP,
      VALUE_PROP,
      expect.any(Object),
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle rate limits (client-level — GojiBerry handles automatically)
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle rate limits during batch messaging', () => {
  const ICP = 'Series A fintech founders';
  const VALUE_PROP = 'We help fintech founders fill their outbound pipeline with qualified meetings in 30 days';

  it('processes all leads successfully (rate limiting handled by client)', async () => {
    const leads = makeWarmLeads(25);
    const client = makeMockClient({
      searchLeads: async () => paginatedWith(leads),
    });
    const gen = mockGenerator();

    const result = await generateMessages({ icpDescription: ICP, valueProposition: VALUE_PROP, _client: client, _messageGenerator: gen });

    expect(result.generated).toHaveLength(25);
    expect(result.failed).toHaveLength(0);
  });
});
