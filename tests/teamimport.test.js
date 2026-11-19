const test = require('node:test');
const assert = require('node:assert');
const ti = require('../src/main/teamimport');

const openMaus = `---
botmrr: 1
name: Launch a Measurable Campaign
tagline: Find a sharp position.
summary: A four-agent growth crew.
requirements:
  apps:
    - slug: slack
      label: Slack
      reason: Share briefs.
      optional: true
agents:
  - key: maya
    name: Maya
    title: Growth Lead
    description: Turn goals into bets.
    playbooks:
      - positioning-brief
  - key: lens
    name: Lens
    title: Growth Analyst
    description: Define measurement.
chiefOfStaff: maya
rooms:
  - key: room
    name: Campaign Room
    members:
      - maya
      - lens
    bulletin: Do not fabricate data.
routines:
  - key: weekly
    name: Weekly review
    agent: lens
    prompt: Review.
playbooks:
  - key: positioning-brief
    name: Positioning Brief
    instructions: Clarify the audience: who, why.
---
# Launch
`;
const botteams = `---
slug: new-hire-ramp
name: New-hire 30-60-90
tagline: Turns a role into a plan.
section: Workplace
connectors:
  - Google Docs
bot_roster:
  - name: Ramp planner
    persona: Writes a 30-60-90 from the role brief.
rooms: []
routines:
  - name: Ramp pass
    owner: Ramp planner
    schedule: Every weekday at 09:00
    prompt: Draft the plan.
suggest:
  - text: Never send mail.
    on: true
  - text: Ignore me.
    on: false
---
Body.
`;

test('OpenMausBot team: agents, lead, playbooks, room rules, connectors', () => {
  const p = ti.convert(openMaus);
  assert.deepStrictEqual(p.agents.map((a) => a.name), ['Maya', 'Lens']);
  assert.ok(p.agents[0].lead && !p.agents[1].lead);
  assert.match(p.agents[0].instructions, /Clarify the audience: who, why\./);
  assert.match(p.agents[1].instructions, /Do not fabricate data\./);
  assert.strictEqual(p.connectors[0].name, 'Slack');
  assert.strictEqual(p.routines, 1);
});
test('botteams bot: persona plus only the rules that are on', () => {
  const p = ti.convert(botteams);
  assert.strictEqual(p.agents.length, 1);
  assert.match(p.agents[0].instructions, /Never send mail\./);
  assert.doesNotMatch(p.agents[0].instructions, /Ignore me/);
  assert.strictEqual(p.connectors[0].name, 'Google Docs');
});
test('anything else is not a team', () => {
  assert.strictEqual(ti.convert('# just notes'), null);
  assert.strictEqual(ti.convert('---\nfoo: bar\n---\n'), null);
});
test('GitHub links', () => {
  assert.strictEqual(ti.rawUrl('https://github.com/ellelion/botteams/blob/main/bots/x.md'), 'https://raw.githubusercontent.com/ellelion/botteams/main/bots/x.md');
  assert.ok(ti.isRepoLink('https://github.com/milind-soni/openmausbot-teams'));
  assert.ok(!ti.isRepoLink('https://github.com/a/b/blob/main/x.md'));
});
test('repository listing finds team files', async () => {
  const fake = async () => ({ ok: true, text: async () => JSON.stringify([{ name: 'README.md', type: 'file', download_url: 'https://raw.githubusercontent.com/a/b/main/README.md' }, { name: 'new-hire.md', type: 'file', download_url: 'https://raw.githubusercontent.com/a/b/main/bots/new-hire.md' }]) });
  const list = await ti.listRepo('https://github.com/a/b', fake);
  assert.deepStrictEqual(list.map((t) => t.name), ['New Hire']);
});
